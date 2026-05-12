import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

import axios from 'axios'
import type { Request, Response } from 'express'

export interface AudioProxyClaims {
  v: 1
  u: string
  iat: number
  exp: number
  srcExp: number
  mime?: string
  fn?: string
  bvid?: string
  cid?: string
}

type AudioProxyVerifyFailure =
  | 'missing'
  | 'malformed'
  | 'badSig'
  | 'tokenExpired'
  | 'sourceExpired'

type AudioProxyVerifyResult =
  | { ok: true; claims: AudioProxyClaims }
  | { ok: false; reason: AudioProxyVerifyFailure }

export interface AudioProxyDeps {
  secret: string
  allowedHostRegex: RegExp[]
  upstreamHeaders: () => Record<string, string>
  maxRedirects?: number
  headerTimeoutMs?: number
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

function normalizeHostname(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function signAudioProxyToken(
  claims: Omit<AudioProxyClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      iat: nowSec,
      exp: nowSec + ttlSec,
    } satisfies AudioProxyClaims),
  ).toString('base64url')

  return `${payload}.${signPayload(payload, secret)}`
}

export function verifyAudioProxyToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): AudioProxyVerifyResult {
  if (!token) {
    return { ok: false, reason: 'missing' }
  }

  const [payload, sig] = token.split('.')
  if (!payload || !sig) {
    return { ok: false, reason: 'malformed' }
  }

  if (signPayload(payload, secret) !== sig) {
    return { ok: false, reason: 'badSig' }
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AudioProxyClaims
    if (!claims || claims.v !== 1 || !claims.u || !claims.iat || !claims.exp || !claims.srcExp) {
      return { ok: false, reason: 'malformed' }
    }
    if (claims.exp <= nowSec) {
      return { ok: false, reason: 'tokenExpired' }
    }
    if (claims.srcExp <= nowSec * 1000) {
      return { ok: false, reason: 'sourceExpired' }
    }
    return { ok: true, claims }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

export function assertLikelyPublicHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('代理地址必须是合法的公网 http(s) URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
    throw new Error('代理地址必须使用 http 或 https')
  }

  const hostname = normalizeHostname(parsed)
  if (!hostname || hostname === 'localhost') {
    throw new Error('代理地址不能使用 localhost')
  }

  const ipVersion = isIP(hostname)
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    throw new Error('代理地址不能使用私网 IPv4')
  }
  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    throw new Error('代理地址不能使用本地 IPv6')
  }
}

export function isUpstreamHostAllowed(url: string, regexList: RegExp[]): boolean {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
      return false
    }

    const hostname = normalizeHostname(parsed)
    return regexList.some((regex) => regex.test(hostname))
  } catch {
    return false
  }
}

export function buildAudioProxyUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/audio-proxy?t=${encodeURIComponent(token)}`
}

export function createAudioProxyHandler(deps: AudioProxyDeps) {
  const maxRedirects = deps.maxRedirects ?? 5
  const headerTimeoutMs = deps.headerTimeoutMs ?? 15_000

  return async function audioProxyHandler(req: Request, res: Response): Promise<void> {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD')
      res.status(405).json({ error: 'method_not_allowed' })
      return
    }

    const rawToken = Array.isArray(req.query.t) ? req.query.t[0] : req.query.t
    const token = typeof rawToken === 'string' ? rawToken : ''
    const verified = verifyAudioProxyToken(token, deps.secret)
    if (!verified.ok) {
      const status =
        verified.reason === 'tokenExpired' || verified.reason === 'sourceExpired' ? 410 : 401
      res.status(status).json({ error: verified.reason })
      return
    }

    if (!isUpstreamHostAllowed(verified.claims.u, deps.allowedHostRegex)) {
      res.status(403).json({ error: 'host_not_allowed' })
      return
    }

    const controller = new AbortController()
    const handleClose = () => controller.abort()
    req.on('close', handleClose)

    try {
      let currentUrl = verified.claims.u
      let upstreamResp:
        | Awaited<ReturnType<typeof axios.request<Readable>>>
        | null = null

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const upstream = await axios.request<Readable>({
          method: req.method as 'GET' | 'HEAD',
          url: currentUrl,
          responseType: 'stream',
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: headerTimeoutMs,
          signal: controller.signal,
          headers: {
            ...deps.upstreamHeaders(),
            'Accept-Encoding': 'identity',
            ...(typeof req.headers.range === 'string' ? { Range: req.headers.range } : {}),
            ...(typeof req.headers['if-range'] === 'string'
              ? { 'If-Range': req.headers['if-range'] }
              : {}),
          },
        })

        if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.location) {
          upstream.data?.destroy?.()
          const redirectUrl = new URL(upstream.headers.location, currentUrl).toString()
          if (!isUpstreamHostAllowed(redirectUrl, deps.allowedHostRegex)) {
            res.status(502).json({ error: 'redirect_host_not_allowed' })
            return
          }
          currentUrl = redirectUrl
          continue
        }

        upstreamResp = upstream
        break
      }

      if (!upstreamResp) {
        res.status(502).json({ error: 'too_many_redirects' })
        return
      }

      if (upstreamResp.status === 403) {
        upstreamResp.data?.destroy?.()
        res.status(502).json({ error: 'upstream_forbidden' })
        return
      }
      if (upstreamResp.status === 404) {
        upstreamResp.data?.destroy?.()
        res.status(502).json({ error: 'upstream_not_found' })
        return
      }
      if (![200, 206].includes(upstreamResp.status)) {
        upstreamResp.data?.destroy?.()
        res.status(502).json({ error: 'unexpected_status', status: upstreamResp.status })
        return
      }

      for (const header of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ]) {
        const value = upstreamResp.headers[header]
        if (value) {
          res.setHeader(header, value)
        }
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.status(upstreamResp.status)

      if (req.method === 'HEAD') {
        upstreamResp.data?.destroy?.()
        res.end()
        return
      }

      await pipeline(upstreamResp.data, res).catch((error: Error) => {
        console.warn('[audio-proxy] pipeline error', {
          message: error.message,
          bvid: verified.claims.bvid,
        })
      })
    } catch (error: any) {
      if (controller.signal.aborted || res.headersSent) {
        return
      }

      console.warn('[audio-proxy] request failed', { message: error?.message })
      res.status(502).json({ error: 'proxy_request_failed' })
    } finally {
      req.off('close', handleClose)
    }
  }
}
