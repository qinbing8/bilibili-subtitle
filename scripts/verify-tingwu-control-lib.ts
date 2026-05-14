import path from 'node:path'

import { buildAudioProxyTaskPayload, type TranscriptionAudioInput } from '../api/transcription-proxy.js'
import {
  pollTaskStatusUntilTerminal,
  probeUrl,
  type ApiSuccess,
  type ProxyProbeResult,
  type StatusData,
} from './verify-transcription-lib.ts'

export type ControlMode = 'direct' | 'proxy'

export interface ControlVerificationConfig {
  appPassword: string
  baseUrl: string
  samplePath: string
  language: string
  pollIntervalMs: number
  maxWaitMs: number
  requestTimeoutMs: number
  modes: ControlMode[]
}

interface ControlVerificationDeps {
  createTask: (fileUrl: string, language?: string) => Promise<string>
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  onEvent?: (event: ControlVerificationEvent) => void
}

type ControlEventMode = 'sample' | ControlMode

export interface ControlVerificationEvent {
  type: 'preflight' | 'start' | 'poll'
  mode: ControlEventMode
  payload: ProxyProbeResult | { taskId: string; fileUrl: string } | ApiSuccess<StatusData>
  attempt?: number
}

export interface ControlRunResult {
  mode: ControlMode
  fileUrl: string
  probe: ProxyProbeResult | null
  taskId: string | null
  polls: Array<ApiSuccess<StatusData>>
  final: ApiSuccess<StatusData> | null
  error: string | null
}

export interface ControlVerificationResult {
  sampleUrl: string
  sampleProbe: ProxyProbeResult
  proxyUrl: string | null
  runs: ControlRunResult[]
  conclusion: string
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeSamplePath(samplePath: string): string {
  const trimmed = samplePath.trim()
  if (!trimmed) {
    return '/tingwu-control-48k.m4a'
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function createDefaultDeps(overrides: Partial<ControlVerificationDeps>): ControlVerificationDeps {
  return {
    createTask:
      overrides.createTask ??
      (async () => {
        throw new Error('missing createTask dependency')
      }),
    fetch: overrides.fetch ?? fetch,
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? (() => Date.now()),
    onEvent: overrides.onEvent,
  }
}

export function buildControlSampleUrl(baseUrl: string, samplePath: string): string {
  return `${normalizeBaseUrl(baseUrl)}${normalizeSamplePath(samplePath)}`
}

export function buildControlAudioInput(sampleUrl: string, nowMs = Date.now()): TranscriptionAudioInput {
  const url = new URL(sampleUrl)
  const fileName = path.posix.basename(url.pathname) || 'tingwu-control.m4a'
  return {
    bvid: 'TINGWUCONTROL',
    audioUrl: sampleUrl,
    audioFormat: 'm4a',
    mimeType: 'audio/mp4',
    fileName,
    expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
  }
}

function isAcceptableAudioProbe(probe: ProxyProbeResult): boolean {
  if (!probe.ok || !probe.status || ![200, 206].includes(probe.status)) {
    return false
  }

  const normalized = probe.contentType?.toLowerCase() || ''
  if (!normalized) {
    return false
  }

  return (
    !normalized.includes('html') &&
    !normalized.includes('json') &&
    !normalized.startsWith('text/')
  )
}

export function describeProbe(probe: ProxyProbeResult): string {
  if (probe.error) {
    return probe.error
  }

  const detail = probe.previewText || probe.previewHex || '-'
  return `status=${probe.status ?? '-'} contentType=${probe.contentType ?? '-'} preview=${detail}`
}

export function summarizeControlConclusion(result: ControlVerificationResult): string {
  const direct = result.runs.find((item) => item.mode === 'direct')
  const proxy = result.runs.find((item) => item.mode === 'proxy')

  if (direct?.error) {
    return `标准 m4a 直连预检或任务创建失败：${direct.error}`
  }
  if (direct?.final?.data.status === 'FAILED') {
    return `标准 m4a 直连听悟仍失败：${direct.final.data.errorMessage || 'unknown_error'}`
  }
  if (direct?.final?.data.status === 'COMPLETED' && !proxy) {
    return '标准 m4a 直连听悟成功；说明听悟项目和基础账号配置基本可用。'
  }
  if (direct?.final?.data.status === 'COMPLETED' && proxy?.error) {
    return `标准 m4a 直连成功，但经 Worker 代理前置检查未通过：${proxy.error}`
  }
  if (direct?.final?.data.status === 'COMPLETED' && proxy?.final?.data.status === 'FAILED') {
    return `标准 m4a 直连成功，但经 Worker 代理后仍失败：${proxy.final.data.errorMessage || 'unknown_error'}`
  }
  if (direct?.final?.data.status === 'COMPLETED' && proxy?.final?.data.status === 'COMPLETED') {
    return '标准 m4a 直连与 Worker 代理都成功；当前 B 站链路失败更像 m4s/源文件形态问题，而不是 Tingwu 项目或基础 Range 语义问题。'
  }

  return '对照实验未收敛，请检查样本部署、Worker 配置和听悟状态轮询。'
}

async function runSingleMode(
  mode: ControlMode,
  fileUrl: string,
  probe: ProxyProbeResult | null,
  config: ControlVerificationConfig,
  deps: ControlVerificationDeps,
): Promise<ControlRunResult> {
  if (probe && !isAcceptableAudioProbe(probe)) {
    return {
      mode,
      fileUrl,
      probe,
      taskId: null,
      polls: [],
      final: null,
      error: describeProbe(probe),
    }
  }

  try {
    const taskId = await deps.createTask(fileUrl, config.language)
    deps.onEvent?.({
      type: 'start',
      mode,
      payload: { taskId, fileUrl },
    })

    const { polls, final } = await pollTaskStatusUntilTerminal(
      {
        appPassword: config.appPassword,
        baseUrl: config.baseUrl,
        taskId,
        pollIntervalMs: config.pollIntervalMs,
        maxWaitMs: config.maxWaitMs,
        requestTimeoutMs: config.requestTimeoutMs,
      },
      {
        fetch: deps.fetch,
        sleep: deps.sleep,
        now: deps.now,
        onEvent: (event) => {
          if (event.type !== 'poll') {
            return
          }
          deps.onEvent?.({
            type: 'poll',
            mode,
            payload: event.payload,
            attempt: event.attempt,
          })
        },
      },
    )

    return {
      mode,
      fileUrl,
      probe,
      taskId,
      polls,
      final,
      error: null,
    }
  } catch (error) {
    return {
      mode,
      fileUrl,
      probe,
      taskId: null,
      polls: [],
      final: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runControlVerification(
  config: ControlVerificationConfig,
  overrides: Partial<ControlVerificationDeps> = {},
): Promise<ControlVerificationResult> {
  const deps = createDefaultDeps(overrides)
  const sampleUrl = buildControlSampleUrl(config.baseUrl, config.samplePath)
  const sampleProbe = await probeUrl(sampleUrl, config.requestTimeoutMs, deps.fetch)
  deps.onEvent?.({ type: 'preflight', mode: 'sample', payload: sampleProbe })

  let proxyUrl: string | null = null
  let proxyProbe: ProxyProbeResult | null = null
  if (config.modes.includes('proxy')) {
    const payload = buildAudioProxyTaskPayload(
      buildControlAudioInput(sampleUrl, deps.now()),
      process.env,
      undefined,
      Math.floor(deps.now() / 1000),
    )
    proxyUrl = payload.proxyUrl
    proxyProbe = await probeUrl(proxyUrl, config.requestTimeoutMs, deps.fetch)
    deps.onEvent?.({ type: 'preflight', mode: 'proxy', payload: proxyProbe })
  }

  const runs: ControlRunResult[] = []
  for (const mode of config.modes) {
    const fileUrl = mode === 'direct' ? sampleUrl : proxyUrl || ''
    const run = await runSingleMode(
      mode,
      fileUrl,
      mode === 'direct' ? sampleProbe : proxyProbe,
      config,
      deps,
    )
    runs.push(run)
  }

  const result: ControlVerificationResult = {
    sampleUrl,
    sampleProbe,
    proxyUrl,
    runs,
    conclusion: '',
  }
  result.conclusion = summarizeControlConclusion(result)
  return result
}
