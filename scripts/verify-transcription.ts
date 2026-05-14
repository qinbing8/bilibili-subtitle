import { fileURLToPath } from 'node:url'

import { loadLocalEnv } from '../api/dev-config.ts'
import {
  runVerification,
  type VerificationConfig,
  type VerificationEvent,
  type VerificationRunResult,
} from './verify-transcription-lib.ts'

const DEFAULT_BASE_URL = 'https://bilibili-subtitle-theta.vercel.app'
const DEFAULT_VIDEO_URL = 'https://www.bilibili.com/video/BV1TKoYBmEQU/'

function printUsage() {
  console.log(`用法:
  npm run verify:transcription
  npm run verify:transcription -- --video-url https://www.bilibili.com/video/BV...

可选参数:
  --base-url <url>
  --video-url <url>
  --language <auto|cn|en...>
  --page <number>
  --diarization
  --text-polish
  --poll-interval-sec <number>
  --max-wait-sec <number>
  --request-timeout-sec <number>
  --no-debug-proxy`)
}

function readArgValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} 缺少值`)
  }
  return value
}

function parseNumber(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function buildConfig(args: string[]): VerificationConfig {
  let baseUrl = process.env.VERIFY_BASE_URL?.trim() || DEFAULT_BASE_URL
  let bilibiliUrl = process.env.VERIFY_BILIBILI_URL?.trim() || DEFAULT_VIDEO_URL
  let language = process.env.VERIFY_LANGUAGE?.trim() || 'auto'
  let page = parseNumber(process.env.VERIFY_PAGE, 0)
  let diarization = false
  let textPolish = false
  let debugProxy = true
  let pollIntervalMs = parseNumber(process.env.VERIFY_POLL_INTERVAL_SEC, 15) * 1000
  let maxWaitMs = parseNumber(process.env.VERIFY_MAX_WAIT_SEC, 180) * 1000
  let requestTimeoutMs = parseNumber(process.env.VERIFY_REQUEST_TIMEOUT_SEC, 30) * 1000

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--base-url') baseUrl = readArgValue(args, i++, arg)
    else if (arg === '--video-url') bilibiliUrl = readArgValue(args, i++, arg)
    else if (arg === '--language') language = readArgValue(args, i++, arg)
    else if (arg === '--page') page = parseNumber(readArgValue(args, i++, arg), 0)
    else if (arg === '--poll-interval-sec') pollIntervalMs = parseNumber(readArgValue(args, i++, arg), 15) * 1000
    else if (arg === '--max-wait-sec') maxWaitMs = parseNumber(readArgValue(args, i++, arg), 180) * 1000
    else if (arg === '--request-timeout-sec') requestTimeoutMs = parseNumber(readArgValue(args, i++, arg), 30) * 1000
    else if (arg === '--diarization') diarization = true
    else if (arg === '--text-polish') textPolish = true
    else if (arg === '--no-debug-proxy') debugProxy = false
    else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }

  const appPassword = process.env.APP_ACCESS_PASSWORD?.trim()
  if (!appPassword) {
    throw new Error('未找到 APP_ACCESS_PASSWORD，请检查 .env.local / .env')
  }

  return {
    appPassword,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    bilibiliUrl,
    language,
    page,
    diarization,
    textPolish,
    debugProxy,
    pollIntervalMs,
    maxWaitMs,
    requestTimeoutMs,
  }
}

function logEvent(event: VerificationEvent) {
  if (event.type === 'start') {
    const start = event.payload as VerificationRunResult['start']
    console.log(`[start] taskId=${start.data.taskId} proxyHost=${start.data.proxyHost || '-'} audioHost=${start.data.audioHost || '-'}`)
    const debugProxy = start.data.debugProxy
    if (debugProxy) {
      console.log(
        `[start] proxyUrlLength=${debugProxy.proxyUrlLength ?? '-'} tokenLength=${debugProxy.tokenLength ?? '-'} audioUrlLength=${debugProxy.audioUrlLength ?? '-'} proxyUrlHash=${debugProxy.proxyUrlHash ?? '-'}`,
      )
    }
    return
  }

  if (event.type === 'proxyProbe') {
    const probe = event.payload as VerificationRunResult['proxyProbe']
    console.log(
      `[probe] ok=${probe?.ok} status=${probe?.status ?? '-'} contentType=${probe?.contentType ?? '-'} contentRange=${probe?.contentRange ?? '-'} acceptRanges=${probe?.acceptRanges ?? '-'} contentDisposition=${probe?.contentDisposition ?? '-'} previewHex=${probe?.previewHex ?? '-'}${probe?.error ? ` error=${probe.error}` : ''}`,
    )
    return
  }

  const poll = event.payload as VerificationRunResult['final']
  console.log(
    `[poll#${event.attempt}] status=${poll.data.status}${poll.data.errorMessage ? ` error=${poll.data.errorMessage}` : ''}${poll.data.preview ? ` preview=${poll.data.preview}` : ''}`,
  )
}

async function main() {
  loadLocalEnv(process.cwd())
  const config = buildConfig(process.argv.slice(2))
  console.log('预期: start 成功，若启用 debug proxy 则可拿到 proxy 调试信息，最终 status=COMPLETED')
  const result = await runVerification(config, { onEvent: logEvent })
  if (result.final.data.status === 'COMPLETED') {
    console.log('[result] PASS')
    return
  }
  console.log(`[result] FAIL status=${result.final.data.status} error=${result.final.data.errorMessage || '-'}`)
  process.exitCode = 2
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((error) => {
    console.error(`[verify:transcription] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
