import { BILIBILI_HEADERS, DEFAULT_ALLOWED_HOST_PATTERNS } from './config.ts'
import { streamUpstream } from './proxy.ts'
import { verifyAudioProxyToken } from './token.ts'

export interface Env {
  AUDIO_PROXY_TOKEN_SECRET: string
  ALLOWED_HOSTS?: string
  DEBUG_AUDIO_PROXY?: string
}

function jsonResponse(status: number, body: Record<string, unknown>, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function compileAllowedHosts(rawValue?: string): RegExp[] {
  const patterns = (rawValue?.trim() ? rawValue.split(',') : [...DEFAULT_ALLOWED_HOST_PATTERNS])
    .map((item) => item.trim())
    .filter(Boolean)

  const compiled = patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'i')
      } catch {
        return null
      }
    })
    .filter((regex): regex is RegExp => regex instanceof RegExp)

  return compiled.length
    ? compiled
    : DEFAULT_ALLOWED_HOST_PATTERNS.map((pattern) => new RegExp(pattern, 'i'))
}

function isDebugEnabled(rawValue?: string): boolean {
  return rawValue?.trim() === '1'
}

function logDebug(request: Request, enabled: boolean, event: string, details: Record<string, unknown>) {
  if (!enabled) {
    return
  }

  const cf = request.cf ?? {}
  console.log(
    JSON.stringify({
      scope: 'audio-proxy',
      event,
      cfRay: request.headers.get('cf-ray'),
      ...details,
      cf: {
        asOrganization: cf.asOrganization,
        city: cf.city,
        country: cf.country,
        colo: cf.colo,
      },
    }),
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const debugEnabled = isDebugEnabled(env.DEBUG_AUDIO_PROXY)

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 })
    }
    if (url.pathname !== '/api/audio-proxy') {
      return jsonResponse(404, { error: 'not_found' })
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return jsonResponse(405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' })
    }
    if (!env.AUDIO_PROXY_TOKEN_SECRET?.trim()) {
      return jsonResponse(500, { error: 'config_missing', key: 'AUDIO_PROXY_TOKEN_SECRET' })
    }

    logDebug(request, debugEnabled, 'request.inbound', {
      method: request.method,
      host: url.host,
      path: url.pathname,
      range: request.headers.get('range'),
      userAgent: request.headers.get('user-agent'),
    })

    const token = url.searchParams.get('t') ?? ''
    const verified = await verifyAudioProxyToken(token, env.AUDIO_PROXY_TOKEN_SECRET)
    if (!verified.ok) {
      const status =
        verified.reason === 'tokenExpired' || verified.reason === 'sourceExpired' ? 410 : 401
      logDebug(request, debugEnabled, 'request.rejected', {
        status,
        reason: verified.reason,
      })
      return jsonResponse(status, { error: verified.reason })
    }

    const upstream = new URL(verified.claims.u)
    logDebug(request, debugEnabled, 'request.verified', {
      upstreamHost: upstream.host,
      mime: verified.claims.mime,
      filename: verified.claims.fn,
      sourceExpiresAt: verified.claims.srcExp,
      tokenExpiresAt: verified.claims.exp,
    })

    return streamUpstream(request, verified.claims.u, {
      allowedHostRegex: compileAllowedHosts(env.ALLOWED_HOSTS),
      upstreamHeaders: () => BILIBILI_HEADERS,
      preferredContentType: verified.claims.mime,
      fileName: verified.claims.fn,
      debugLog: (event, details) => logDebug(request, debugEnabled, event, details),
    })
  },
} satisfies ExportedHandler<Env>
