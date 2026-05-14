export interface ProxyDeps {
  allowedHostRegex: RegExp[]
  upstreamHeaders: () => Record<string, string>
  maxRedirects?: number
  preferredContentType?: string
  fileName?: string
  force200ForInitialRange?: boolean
  debugLog?: (event: string, details: Record<string, unknown>) => void
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status: number, headers: Headers): Response {
  return new Response(null, { status, headers })
}

function normalizeHostname(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function logDebug(
  deps: ProxyDeps,
  event: string,
  details: Record<string, unknown>,
): void {
  deps.debugLog?.(event, details)
}

function isUpstreamHostAllowed(url: string, regexList: RegExp[]): boolean {
  try {
    const parsed = new URL(url)
    const protocol = parsed.protocol.toLowerCase()
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      regexList.some((regex) => regex.test(normalizeHostname(parsed)))
    )
  } catch {
    return false
  }
}

function buildUpstreamHeaders(request: Request, deps: ProxyDeps): Headers {
  const headers = new Headers(deps.upstreamHeaders())
  headers.set('Accept-Encoding', 'identity')

  const range = request.headers.get('range')
  if (range && !shouldForceFullResponse(request, deps)) {
    headers.set('Range', range)
  }

  const ifRange = request.headers.get('if-range')
  if (ifRange) {
    headers.set('If-Range', ifRange)
  }

  return headers
}

function shouldForceFullResponse(request: Request, deps: ProxyDeps): boolean {
  return deps.force200ForInitialRange === true &&
    request.method === 'GET' &&
    request.headers.get('range') === 'bytes=0-'
}

function parseOpenEndedRangeStart(rangeHeader: string | null): number | null {
  if (!rangeHeader) {
    return null
  }

  const match = /^bytes=(\d+)-$/.exec(rangeHeader.trim())
  if (!match) {
    return null
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function buildContentDisposition(fileName: string): string {
  const normalized = fileName.replace(/[\r\n"]/g, '_').trim() || 'audio.m4a'
  const asciiFallback = normalized.replace(/[^\x20-\x7e]/g, '_')
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(normalized)}`
}

function copyResponseHeaders(upstream: Response, deps: ProxyDeps): Headers {
  const headers = new Headers()
  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(header)
    if (value) {
      headers.set(header, value)
    }
  }
  if (!headers.get('accept-ranges')) {
    headers.set('accept-ranges', 'bytes')
  }
  if (deps.preferredContentType) {
    headers.set('content-type', deps.preferredContentType)
  }
  if (deps.fileName) {
    headers.set('content-disposition', buildContentDisposition(deps.fileName))
  }
  headers.set('cache-control', 'private, no-store')
  return headers
}

function mapUpstreamError(upstream: Response): Response | null {
  if (upstream.status === 403) {
    return jsonResponse(502, { error: 'upstream_forbidden' })
  }
  if (upstream.status === 404) {
    return jsonResponse(502, { error: 'upstream_not_found' })
  }
  if (![200, 206].includes(upstream.status)) {
    return jsonResponse(502, { error: 'unexpected_status', status: upstream.status })
  }
  return null
}

function mapUnsatisfiedRange(
  request: Request,
  upstream: Response,
  headers: Headers,
  deps: ProxyDeps,
): Response | null {
  const rangeStart = parseOpenEndedRangeStart(request.headers.get('range'))
  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10)
  if (rangeStart === null || !Number.isFinite(contentLength) || rangeStart < contentLength) {
    return null
  }

  headers.delete('content-length')
  headers.delete('content-range')
  headers.set('accept-ranges', 'bytes')
  headers.set('content-range', `bytes */${contentLength}`)
  logDebug(deps, 'proxy.range_unsatisfied', {
    requestedRange: request.headers.get('range'),
    contentLength,
  })
  return emptyResponse(416, headers)
}

function buildUpstream416Response(upstream: Response): Response {
  const headers = new Headers()
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) {
    headers.set('content-range', contentRange)
  }
  headers.set('accept-ranges', upstream.headers.get('accept-ranges') || 'bytes')
  return emptyResponse(416, headers)
}

function bindAbortSignal(request: Request): AbortController {
  const controller = new AbortController()
  if (request.signal.aborted) {
    controller.abort()
    return controller
  }

  request.signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

async function fetchFollowingRedirects(
  request: Request,
  upstreamUrl: string,
  deps: ProxyDeps,
): Promise<{ upstream: Response; finalUrl: string; redirectCount: number } | { error: Response }> {
  let currentUrl = upstreamUrl
  const maxRedirects = deps.maxRedirects ?? 5
  const controller = bindAbortSignal(request)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const upstream = await fetch(currentUrl, {
      method: request.method,
      redirect: 'manual',
      headers: buildUpstreamHeaders(request, deps),
      signal: controller.signal,
    })

    logDebug(deps, 'proxy.upstream_hop', {
      hop,
      url: currentUrl,
      status: upstream.status,
      location: upstream.headers.get('location'),
      forwardedRange: buildUpstreamHeaders(request, deps).get('range'),
    })

    const location = upstream.headers.get('location')
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      await upstream.body?.cancel()
      const redirectUrl = new URL(location, currentUrl).toString()
      if (!isUpstreamHostAllowed(redirectUrl, deps.allowedHostRegex)) {
        return { error: jsonResponse(502, { error: 'redirect_host_not_allowed' }) }
      }
      currentUrl = redirectUrl
      continue
    }

    return {
      upstream,
      finalUrl: currentUrl,
      redirectCount: hop,
    }
  }

  return { error: jsonResponse(502, { error: 'too_many_redirects' }) }
}

function formatChunkPreview(chunk: Uint8Array, maxBytes = 32): string {
  return Array.from(chunk.slice(0, maxBytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function instrumentResponseStream(
  request: Request,
  upstream: Response,
  headers: Headers,
  finalUrl: string,
  redirectCount: number,
  deps: ProxyDeps,
): Response {
  if (!upstream.body || !deps.debugLog) {
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  const startedAt = Date.now()
  let totalBytes = 0
  let firstByteMs: number | null = null
  let previewHex: string | null = null
  let clientCanceled = request.signal.aborted

  request.signal.addEventListener(
    'abort',
    () => {
      clientCanceled = true
      logDebug(deps, 'proxy.client_abort', {
        finalUrl,
        redirectCount,
        totalBytes,
        firstByteMs,
        durationMs: Date.now() - startedAt,
      })
    },
    { once: true },
  )

  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (firstByteMs === null) {
          firstByteMs = Date.now() - startedAt
        }
        totalBytes += chunk.byteLength
        if (!previewHex) {
          previewHex = formatChunkPreview(chunk)
        }
        controller.enqueue(chunk)
      },
      flush() {
        logDebug(deps, 'proxy.stream_complete', {
          finalUrl,
          redirectCount,
          totalBytes,
          firstByteMs,
          previewHex,
          clientCanceled,
          durationMs: Date.now() - startedAt,
        })
      },
    }),
  )

  return new Response(body, { status: upstream.status, headers })
}

export async function streamUpstream(
  request: Request,
  upstreamUrl: string,
  deps: ProxyDeps,
): Promise<Response> {
  if (!isUpstreamHostAllowed(upstreamUrl, deps.allowedHostRegex)) {
    logDebug(deps, 'proxy.host_blocked', { upstreamUrl })
    return jsonResponse(403, { error: 'host_not_allowed' })
  }

  const result = await fetchFollowingRedirects(request, upstreamUrl, deps)
  if ('error' in result) {
    return result.error
  }

  logDebug(deps, 'proxy.upstream_response', {
    finalUrl: result.finalUrl,
    finalHost: new URL(result.finalUrl).host,
    redirectCount: result.redirectCount,
    status: result.upstream.status,
    contentType: result.upstream.headers.get('content-type'),
    contentLength: result.upstream.headers.get('content-length'),
    contentRange: result.upstream.headers.get('content-range'),
    acceptRanges: result.upstream.headers.get('accept-ranges'),
    etag: result.upstream.headers.get('etag'),
    lastModified: result.upstream.headers.get('last-modified'),
  })

  if (result.upstream.status === 416) {
    const response = buildUpstream416Response(result.upstream)
    await result.upstream.body?.cancel()
    return response
  }

  const mappedError = mapUpstreamError(result.upstream)
  if (mappedError) {
    await result.upstream.body?.cancel()
    return mappedError
  }

  const headers = copyResponseHeaders(result.upstream, deps)
  const unsatisfiedRange = mapUnsatisfiedRange(request, result.upstream, headers, deps)
  if (unsatisfiedRange) {
    await result.upstream.body?.cancel()
    return unsatisfiedRange
  }
  logDebug(deps, 'proxy.response_headers', {
    servedContentType: headers.get('content-type'),
    contentDisposition: headers.get('content-disposition'),
    contentLength: headers.get('content-length'),
    contentRange: headers.get('content-range'),
  })
  if (request.method === 'HEAD') {
    await result.upstream.body?.cancel()
    logDebug(deps, 'proxy.head_complete', {
      finalUrl: result.finalUrl,
      redirectCount: result.redirectCount,
      status: result.upstream.status,
    })
    return new Response(null, { status: result.upstream.status, headers })
  }

  return instrumentResponseStream(
    request,
    result.upstream,
    headers,
    result.finalUrl,
    result.redirectCount,
    deps,
  )
}
