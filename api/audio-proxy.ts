import crypto from 'node:crypto'
import { promises as dnsPromises } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

import axios from 'axios'
import type { Request, Response } from 'express'

import type { AudioProxyRateLimits } from './dev-config.js'

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

interface CompactAudioProxyClaims {
  u: string
  i: number
  e: number
  s: number
  m?: string
  f?: string
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

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>

export interface AudioProxyDeps {
  secret: string
  allowedHostRegex: RegExp[]
  upstreamHeaders: () => Record<string, string>
  rateLimits: AudioProxyRateLimits
  maxRedirects?: number
  headerTimeoutMs?: number
  lookup?: DnsLookupFn
  now?: () => number
}

const BLOCKED_V4_SUBNETS: Array<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const BLOCKED_V6_SUBNETS: Array<readonly [string, number]> = [
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]

const BLOCKED_V6_ADDRESSES = ['::', '::1'] as const

export const BLOCKED_IPS = (() => {
  const list = new BlockList()
  const safeAddSubnet = (addr: string, prefix: number, family: 'ipv4' | 'ipv6') => {
    try {
      list.addSubnet(addr, prefix, family)
    } catch (error) {
      console.warn(
        `[audio-proxy] failed to register blocked subnet ${addr}/${prefix} (${family})`,
        (error as Error)?.message ?? error,
      )
    }
  }
  const safeAddAddress = (addr: string, family: 'ipv4' | 'ipv6') => {
    try {
      list.addAddress(addr, family)
    } catch (error) {
      console.warn(
        `[audio-proxy] failed to register blocked address ${addr} (${family})`,
        (error as Error)?.message ?? error,
      )
    }
  }
  for (const [addr, prefix] of BLOCKED_V4_SUBNETS) {
    safeAddSubnet(addr, prefix, 'ipv4')
  }
  for (const [addr, prefix] of BLOCKED_V6_SUBNETS) {
    safeAddSubnet(addr, prefix, 'ipv6')
  }
  safeAddAddress('255.255.255.255', 'ipv4')
  for (const addr of BLOCKED_V6_ADDRESSES) {
    safeAddAddress(addr, 'ipv6')
  }
  return list
})()

export class BlockedHostError extends Error {
  hostname: string
  address: string

  constructor(hostname: string, address: string) {
    super(`hostname ${hostname} resolves to non-public address ${address}`)
    this.name = 'BlockedHostError'
    this.hostname = hostname
    this.address = address
  }
}

export class DnsLookupError extends Error {
  hostname: string

  constructor(hostname: string, cause: unknown) {
    super(`dns lookup failed for ${hostname}: ${(cause as Error)?.message || cause}`)
    this.name = 'DnsLookupError'
    this.hostname = hostname
  }
}

function extractV4FromMappedV6(addr: string): string | null {
  const dotted = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dotted) return dotted[1]
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  if (family === 6) {
    const mapped = extractV4FromMappedV6(address)
    if (mapped) {
      return BLOCKED_IPS.check(mapped, 'ipv4')
    }
    return BLOCKED_IPS.check(address, 'ipv6')
  }
  return BLOCKED_IPS.check(address, 'ipv4')
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeCompareSignature(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length !== actualBuf.length) {
    return false
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf)
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

function toCanonicalClaims(parsed: unknown): AudioProxyClaims | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const claims = parsed as Partial<AudioProxyClaims & CompactAudioProxyClaims>
  if (
    claims.v === 1 &&
    typeof claims.u === 'string' &&
    claims.u.length > 0 &&
    Number.isFinite(claims.iat) &&
    Number.isFinite(claims.exp) &&
    Number.isFinite(claims.srcExp)
  ) {
    const iat = Number(claims.iat)
    const exp = Number(claims.exp)
    const srcExp = Number(claims.srcExp)
    return {
      v: 1,
      u: claims.u,
      iat,
      exp,
      srcExp,
      ...(typeof claims.mime === 'string' ? { mime: claims.mime } : {}),
      ...(typeof claims.fn === 'string' ? { fn: claims.fn } : {}),
      ...(typeof claims.bvid === 'string' ? { bvid: claims.bvid } : {}),
      ...(typeof claims.cid === 'string' ? { cid: claims.cid } : {}),
    }
  }

  if (
    typeof claims.u === 'string' &&
    claims.u.length > 0 &&
    Number.isFinite(claims.i) &&
    Number.isFinite(claims.e) &&
    Number.isFinite(claims.s)
  ) {
    const iat = Number(claims.i)
    const exp = Number(claims.e)
    const srcExp = Number(claims.s)
    return {
      v: 1,
      u: claims.u,
      iat,
      exp,
      srcExp,
      ...(typeof claims.m === 'string' ? { mime: claims.m } : {}),
      ...(typeof claims.f === 'string' ? { fn: claims.f } : {}),
    }
  }

  return null
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

  if (!safeCompareSignature(signPayload(payload, secret), sig)) {
    return { ok: false, reason: 'badSig' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const claims = toCanonicalClaims(parsed)
  if (
    !claims ||
    claims.v !== 1 ||
    claims.exp <= claims.iat
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (claims.exp <= nowSec) {
    return { ok: false, reason: 'tokenExpired' }
  }
  if (claims.srcExp <= nowSec * 1000) {
    return { ok: false, reason: 'sourceExpired' }
  }
  return { ok: true, claims }
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
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('代理地址不能使用 localhost')
  }

  const ipVersion = isIP(hostname)
  if (ipVersion === 4 && isBlockedAddress(hostname, 4)) {
    throw new Error('代理地址不能使用私网/保留 IPv4')
  }
  if (ipVersion === 6 && isBlockedAddress(hostname, 6)) {
    throw new Error('代理地址不能使用本地/保留 IPv6')
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

const defaultDnsLookup: DnsLookupFn = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }))
}

export async function assertHostResolvesToPublic(
  hostname: string,
  lookup: DnsLookupFn = defaultDnsLookup,
): Promise<void> {
  const lowered = hostname.toLowerCase()
  if (!lowered || lowered === 'localhost' || lowered.endsWith('.localhost')) {
    throw new BlockedHostError(hostname, 'localhost')
  }

  const ipVersion = isIP(lowered)
  if (ipVersion === 4 || ipVersion === 6) {
    if (isBlockedAddress(lowered, ipVersion as 4 | 6)) {
      throw new BlockedHostError(hostname, lowered)
    }
    return
  }

  let records: Array<{ address: string; family: 4 | 6 }>
  try {
    records = await lookup(lowered)
  } catch (error) {
    throw new DnsLookupError(hostname, error)
  }

  if (records.length === 0) {
    throw new DnsLookupError(hostname, new Error('no records'))
  }

  for (const record of records) {
    if (isBlockedAddress(record.address, record.family)) {
      throw new BlockedHostError(hostname, record.address)
    }
  }
}

export function buildAudioProxyUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/audio-proxy?t=${encodeURIComponent(token)}`
}

export type RateLimitFailureReason =
  | 'token_concurrency'
  | 'global_concurrency'
  | 'bytes_exceeded'
  | 'duration_exceeded'

interface TokenState {
  active: number
  bytes: number
  firstSeenAt: number
}

export class AudioProxyRateLimiter {
  private globalActive = 0
  private readonly config: AudioProxyRateLimits
  private readonly states = new Map<string, TokenState>()
  private readonly now: () => number

  constructor(config: AudioProxyRateLimits, now?: () => number) {
    this.config = config
    this.now = now ?? (() => Date.now())
  }

  tryAcquire(
    tokenKey: string,
  ): { ok: true } | { ok: false; reason: RateLimitFailureReason } {
    this.gc()
    const now = this.now()
    const existing = this.states.get(tokenKey)
    const state: TokenState = existing ?? { active: 0, bytes: 0, firstSeenAt: now }

    if (existing && now - existing.firstSeenAt > this.config.maxDurationMs) {
      return { ok: false, reason: 'duration_exceeded' }
    }
    if (state.bytes >= this.config.maxBytesPerToken) {
      return { ok: false, reason: 'bytes_exceeded' }
    }
    if (state.active >= this.config.maxConcurrentPerToken) {
      return { ok: false, reason: 'token_concurrency' }
    }
    if (this.globalActive >= this.config.maxConcurrentGlobal) {
      return { ok: false, reason: 'global_concurrency' }
    }

    state.active += 1
    this.globalActive += 1
    if (!existing) {
      this.states.set(tokenKey, state)
    }
    return { ok: true }
  }

  release(tokenKey: string): void {
    const state = this.states.get(tokenKey)
    if (!state) return
    state.active = Math.max(0, state.active - 1)
    this.globalActive = Math.max(0, this.globalActive - 1)
  }

  recordBytes(
    tokenKey: string,
    bytes: number,
  ): { allowed: boolean; total: number } {
    const state = this.states.get(tokenKey)
    if (!state) return { allowed: false, total: 0 }
    state.bytes += bytes
    return { allowed: state.bytes <= this.config.maxBytesPerToken, total: state.bytes }
  }

  snapshot(tokenKey: string): TokenState | undefined {
    const state = this.states.get(tokenKey)
    return state ? { ...state } : undefined
  }

  private gc(): void {
    const now = this.now()
    for (const [key, state] of this.states) {
      if (state.active === 0 && now - state.firstSeenAt > this.config.maxDurationMs) {
        this.states.delete(key)
      }
    }
  }
}

function rateLimitStatus(reason: RateLimitFailureReason): number {
  if (reason === 'bytes_exceeded' || reason === 'duration_exceeded') {
    return 410
  }
  return 429
}

export function createAudioProxyHandler(deps: AudioProxyDeps) {
  const maxRedirects = deps.maxRedirects ?? 5
  const headerTimeoutMs = deps.headerTimeoutMs ?? 15_000
  const lookup = deps.lookup ?? defaultDnsLookup
  const rateLimiter = new AudioProxyRateLimiter(deps.rateLimits, deps.now)

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

    const sigPart = token.split('.')[1] ?? ''
    const tokenKey = crypto.createHash('sha256').update(sigPart).digest('base64url')

    const acquired = rateLimiter.tryAcquire(tokenKey)
    if (!acquired.ok) {
      res.status(rateLimitStatus(acquired.reason)).json({
        error: 'rate_limited',
        reason: acquired.reason,
      })
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
        const parsedCurrent = new URL(currentUrl)
        const currentHost = normalizeHostname(parsedCurrent)

        try {
          await assertHostResolvesToPublic(currentHost, lookup)
        } catch (error) {
          const reason =
            error instanceof BlockedHostError
              ? 'upstream_private_address'
              : 'dns_lookup_failed'
          console.warn('[audio-proxy] dns guard rejected', {
            host: currentHost,
            reason,
            bvid: verified.claims.bvid,
          })
          res.status(502).json({ error: reason })
          return
        }

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

      const counter = new PassThrough()
      let overran = false
      counter.on('data', (chunk: Buffer) => {
        const result = rateLimiter.recordBytes(tokenKey, chunk.length)
        if (!result.allowed && !overran) {
          overran = true
          console.warn('[audio-proxy] bytes exceeded, aborting stream', {
            host: new URL(currentUrl).host,
            total: result.total,
            bvid: verified.claims.bvid,
          })
          upstreamResp?.data?.destroy?.(new Error('bytes_exceeded'))
          counter.destroy(new Error('bytes_exceeded'))
        }
      })

      await pipeline(upstreamResp.data, counter, res).catch((error: Error) => {
        if (overran) {
          return
        }
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
      rateLimiter.release(tokenKey)
    }
  }
}
