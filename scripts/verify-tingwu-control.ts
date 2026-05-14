import { fileURLToPath } from 'node:url'

import { loadLocalEnv } from '../api/dev-config.ts'
import { createTingwuTask } from '../api/index.ts'
import {
  describeProbe,
  runControlVerification,
  type ControlMode,
  type ControlVerificationConfig,
  type ControlVerificationEvent,
} from './verify-tingwu-control-lib.ts'

const DEFAULT_BASE_URL = 'https://bilibili-subtitle-theta.vercel.app'
const DEFAULT_SAMPLE_PATH = '/tingwu-control.m4a'

function printUsage() {
  console.log(`用法:
  npm run verify:tingwu:control
  npm run verify:tingwu:control -- --mode direct

可选参数:
  --base-url <url>
  --sample-path </tingwu-control.m4a>
  --mode <both|direct|proxy>
  --language <auto|cn|en...>
  --poll-interval-sec <number>
  --max-wait-sec <number>
  --request-timeout-sec <number>`)
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

function parseModes(rawMode: string): ControlMode[] {
  if (rawMode === 'direct') {
    return ['direct']
  }
  if (rawMode === 'proxy') {
    return ['proxy']
  }
  return ['direct', 'proxy']
}

function buildConfig(args: string[]): ControlVerificationConfig {
  let baseUrl = process.env.VERIFY_BASE_URL?.trim() || DEFAULT_BASE_URL
  let samplePath = process.env.VERIFY_CONTROL_SAMPLE_PATH?.trim() || DEFAULT_SAMPLE_PATH
  let mode = process.env.VERIFY_CONTROL_MODE?.trim() || 'both'
  let language = process.env.VERIFY_LANGUAGE?.trim() || 'auto'
  let pollIntervalMs = parseNumber(process.env.VERIFY_POLL_INTERVAL_SEC, 15) * 1000
  let maxWaitMs = parseNumber(process.env.VERIFY_MAX_WAIT_SEC, 180) * 1000
  let requestTimeoutMs = parseNumber(process.env.VERIFY_REQUEST_TIMEOUT_SEC, 30) * 1000

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--base-url') baseUrl = readArgValue(args, i++, arg)
    else if (arg === '--sample-path') samplePath = readArgValue(args, i++, arg)
    else if (arg === '--mode') mode = readArgValue(args, i++, arg)
    else if (arg === '--language') language = readArgValue(args, i++, arg)
    else if (arg === '--poll-interval-sec') pollIntervalMs = parseNumber(readArgValue(args, i++, arg), 15) * 1000
    else if (arg === '--max-wait-sec') maxWaitMs = parseNumber(readArgValue(args, i++, arg), 180) * 1000
    else if (arg === '--request-timeout-sec') requestTimeoutMs = parseNumber(readArgValue(args, i++, arg), 30) * 1000
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
    samplePath,
    language,
    pollIntervalMs,
    maxWaitMs,
    requestTimeoutMs,
    modes: parseModes(mode),
  }
}

function logEvent(event: ControlVerificationEvent) {
  if (event.type === 'preflight') {
    console.log(`[${event.mode}] ${describeProbe(event.payload as any)}`)
    return
  }

  if (event.type === 'start') {
    const start = event.payload as { taskId: string; fileUrl: string }
    const fileUrl = new URL(start.fileUrl)
    console.log(
      `[${event.mode}/start] taskId=${start.taskId} host=${fileUrl.host} path=${fileUrl.pathname} urlLength=${start.fileUrl.length}`,
    )
    return
  }

  const poll = event.payload as { data: { status: string; errorMessage?: string; preview?: string } }
  console.log(
    `[${event.mode}/poll#${event.attempt}] status=${poll.data.status}${poll.data.errorMessage ? ` error=${poll.data.errorMessage}` : ''}${poll.data.preview ? ` preview=${poll.data.preview}` : ''}`,
  )
}

function allRequestedModesCompleted(config: ControlVerificationConfig, result: Awaited<ReturnType<typeof runControlVerification>>) {
  return config.modes.every((mode) => {
    const run = result.runs.find((item) => item.mode === mode)
    return run?.final?.data.status === 'COMPLETED'
  })
}

async function main() {
  loadLocalEnv(process.cwd())
  const config = buildConfig(process.argv.slice(2))

  console.log('预期:')
  console.log('- direct 成功: 说明 Tingwu 项目/账号配置和标准 m4a 样本本身可用')
  if (config.modes.includes('proxy')) {
    console.log('- proxy 也成功: 说明标准 m4a 经过 Worker 没问题，当前 B 站失败更像 m4s/源文件形态问题')
    console.log('- proxy 失败但 direct 成功: 说明问题还在 Worker allowlist / 代理链路，而不是 Tingwu 项目本身')
  }

  const result = await runControlVerification(config, {
    createTask: createTingwuTask,
    onEvent: logEvent,
  })

  for (const run of result.runs) {
    if (run.error) {
      console.log(`[${run.mode}/result] FAIL error=${run.error}`)
      continue
    }
    if (!run.final) {
      console.log(`[${run.mode}/result] FAIL error=missing_final_status`)
      continue
    }
    if (run.final.data.status === 'COMPLETED') {
      console.log(`[${run.mode}/result] PASS`)
      continue
    }
    console.log(
      `[${run.mode}/result] FAIL status=${run.final.data.status} error=${run.final.data.errorMessage || '-'}`,
    )
  }

  console.log(`[conclusion] ${result.conclusion}`)

  if (!allRequestedModesCompleted(config, result)) {
    process.exitCode = 2
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((error) => {
    console.error(`[verify:tingwu:control] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
