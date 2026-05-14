export interface VerificationConfig {
  appPassword: string
  baseUrl: string
  bilibiliUrl: string
  language: string
  page: number
  diarization: boolean
  textPolish: boolean
  debugProxy: boolean
  pollIntervalMs: number
  maxWaitMs: number
  requestTimeoutMs: number
}

interface StartDebugProxy {
  proxyUrl: string
  proxyUrlLength?: number
  tokenLength?: number
  audioUrlLength?: number
  proxyUrlHash?: string
}

export interface StartData {
  taskId: string
  proxyHost?: string
  audioHost?: string
  warning?: string | null
  debugProxy?: StartDebugProxy
}

export interface StatusData {
  status: 'ONGOING' | 'COMPLETED' | 'FAILED'
  errorMessage?: string
  preview?: string
}

export interface ApiSuccess<T> {
  success: true
  data: T
}

interface ApiFailure {
  success: false
  error?: string
}

export interface ProxyProbeResult {
  ok: boolean
  status: number | null
  contentType: string | null
  contentRange: string | null
  acceptRanges: string | null
  contentDisposition: string | null
  previewHex: string | null
  previewText: string | null
  error?: string
}

export interface VerificationRunResult {
  start: ApiSuccess<StartData>
  proxyProbe: ProxyProbeResult | null
  polls: Array<ApiSuccess<StatusData>>
  final: ApiSuccess<StatusData>
}

export interface VerificationEvent {
  type: 'start' | 'proxyProbe' | 'poll'
  payload: ApiSuccess<StartData> | ProxyProbeResult | ApiSuccess<StatusData>
  attempt?: number
}

interface VerificationDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  onEvent?: (event: VerificationEvent) => void
}

export interface TaskStatusPollConfig {
  appPassword: string
  baseUrl: string
  taskId: string
  pollIntervalMs: number
  maxWaitMs: number
  requestTimeoutMs: number
}

function truncateText(text: string, maxLength = 180): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
}

function toPreviewHex(chunk: Uint8Array | undefined, maxBytes = 32): string | null {
  if (!chunk || chunk.length === 0) {
    return null
  }
  return Array.from(chunk.slice(0, maxBytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toPreviewText(
  chunk: Uint8Array | undefined,
  contentType: string | null,
  maxBytes = 160,
): string | null {
  if (!chunk || chunk.length === 0 || !contentType) {
    return null
  }

  const normalized = contentType.toLowerCase()
  const isTextLike =
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('html')

  if (!isTextLike) {
    return null
  }

  return new TextDecoder().decode(chunk.slice(0, maxBytes)).replace(/\s+/g, ' ').trim() || null
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${label} 返回了非 JSON 响应: HTTP ${response.status} ${truncateText(text)}`)
  }
}

function assertApiSuccess<T>(body: ApiSuccess<T> | ApiFailure, label: string): ApiSuccess<T> {
  if (!body.success) {
    throw new Error(`${label} 失败: ${body.error || 'unknown_error'}`)
  }
  return body
}

async function requestApi<T>(
  url: string,
  init: RequestInit,
  label: string,
  fetchImpl: typeof fetch,
): Promise<ApiSuccess<T>> {
  const response = await fetchImpl(url, init)
  const body = await parseJsonResponse<ApiSuccess<T> | ApiFailure>(response, label)
  if (!response.ok) {
    const reason = body.success ? 'unexpected_success_body' : body.error || response.statusText
    throw new Error(`${label} 失败: HTTP ${response.status} ${reason}`)
  }
  return assertApiSuccess(body, label)
}

async function startTranscription(
  config: VerificationConfig,
  fetchImpl: typeof fetch,
): Promise<ApiSuccess<StartData>> {
  return requestApi<StartData>(
    `${config.baseUrl}/api/transcription/start`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-password': config.appPassword,
        ...(config.debugProxy ? { 'x-debug-proxy': '1' } : {}),
      },
      body: JSON.stringify({
        bilibiliUrl: config.bilibiliUrl,
        language: config.language,
        page: config.page,
        diarization: config.diarization,
        textPolish: config.textPolish,
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
    '创建转写任务',
    fetchImpl,
  )
}

export async function probeUrl(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  rangeHeader = 'bytes=0-',
) {
  try {
    const headers = rangeHeader ? { Range: rangeHeader } : undefined
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const reader = response.body?.getReader()
    const firstChunk = reader ? await reader.read() : null
    await reader?.cancel()
    const contentType = response.headers.get('content-type')
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
      contentDisposition: response.headers.get('content-disposition'),
      previewHex: toPreviewHex(firstChunk?.value),
      previewText: toPreviewText(firstChunk?.value, contentType),
    } satisfies ProxyProbeResult
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: null,
      contentRange: null,
      acceptRanges: null,
      contentDisposition: null,
      previewHex: null,
      previewText: null,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ProxyProbeResult
  }
}

async function fetchTaskStatus(
  config: Pick<TaskStatusPollConfig, 'appPassword' | 'baseUrl' | 'requestTimeoutMs'>,
  taskId: string,
  fetchImpl: typeof fetch,
): Promise<ApiSuccess<StatusData>> {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/api/transcription/status`)
  url.searchParams.set('taskId', taskId)
  return requestApi<StatusData>(
    url.toString(),
    {
      headers: { 'x-app-password': config.appPassword },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
    '查询转写状态',
    fetchImpl,
  )
}

function createDefaultDeps(overrides: Partial<VerificationDeps>): VerificationDeps {
  return {
    fetch: overrides.fetch ?? fetch,
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? (() => Date.now()),
    onEvent: overrides.onEvent,
  }
}

export async function pollTaskStatusUntilTerminal(
  config: TaskStatusPollConfig,
  overrides: Partial<VerificationDeps> = {},
): Promise<Pick<VerificationRunResult, 'polls' | 'final'>> {
  const deps = createDefaultDeps(overrides)
  const polls: Array<ApiSuccess<StatusData>> = []
  const startedAt = deps.now()
  let attempt = 0

  while (true) {
    attempt += 1
    const status = await fetchTaskStatus(config, config.taskId, deps.fetch)
    polls.push(status)
    deps.onEvent?.({ type: 'poll', payload: status, attempt })

    if (status.data.status !== 'ONGOING') {
      return {
        polls,
        final: status,
      }
    }

    if (deps.now() - startedAt >= config.maxWaitMs) {
      throw new Error(`轮询超时: ${config.maxWaitMs}ms 内未进入 COMPLETED/FAILED`)
    }

    await deps.sleep(config.pollIntervalMs)
  }
}

export async function runVerification(
  config: VerificationConfig,
  overrides: Partial<VerificationDeps> = {},
): Promise<VerificationRunResult> {
  const deps = createDefaultDeps(overrides)
  const start = await startTranscription(config, deps.fetch)
  deps.onEvent?.({ type: 'start', payload: start })

  const proxyUrl = start.data.debugProxy?.proxyUrl
  const proxyProbe =
    config.debugProxy && proxyUrl
      ? await probeUrl(proxyUrl, config.requestTimeoutMs, deps.fetch)
      : null
  if (proxyProbe) {
    deps.onEvent?.({ type: 'proxyProbe', payload: proxyProbe })
  }

  const { polls, final } = await pollTaskStatusUntilTerminal(
    {
      appPassword: config.appPassword,
      baseUrl: config.baseUrl,
      taskId: start.data.taskId,
      pollIntervalMs: config.pollIntervalMs,
      maxWaitMs: config.maxWaitMs,
      requestTimeoutMs: config.requestTimeoutMs,
    },
    deps,
  )

  return {
    start,
    proxyProbe,
    polls,
    final,
  }
}
