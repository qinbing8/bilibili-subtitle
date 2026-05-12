import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_BACKEND_PORT = 9091
export const DEFAULT_AUDIO_PROXY_TOKEN_TTL_SEC = 1800
export const DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS = [
  '^[a-z0-9-]+\\.bilivideo\\.com$',
  '^[a-z0-9-]+\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.mcdn\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.akamaized\\.net$',
  '^upos-[a-z0-9-]+\\.(bilivideo|akamaized)\\.(com|cn|net)$',
] as const

const ENV_FILES = ['.env.local', '.env']
let warnedAudioProxySecretFallback = false

function setEnvValue(key: string, value: string) {
  if (process.env[key] === undefined) {
    process.env[key] = value
  }
}

function parseEnvLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }

  const separator = trimmed.indexOf('=')
  if (separator <= 0) {
    return null
  }

  const key = trimmed.slice(0, separator).trim()
  let value = trimmed.slice(separator + 1).trim()

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }

  return { key, value }
}

function loadEnvFileFallback(filePath: string) {
  const content = readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line)
    if (!entry) continue
    setEnvValue(entry.key, entry.value)
  }
}

export function loadLocalEnv(cwd = process.cwd()) {
  for (const fileName of ENV_FILES) {
    const filePath = path.join(cwd, fileName)
    if (!existsSync(filePath)) {
      continue
    }

    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(filePath)
      continue
    }

    loadEnvFileFallback(filePath)
  }
}

export function resolveBackendPort(env: NodeJS.ProcessEnv = process.env): number {
  const rawPort = env.BACKEND_PORT?.trim() || env.PORT?.trim() || ''
  const parsed = Number.parseInt(rawPort, 10)

  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed
  }

  return DEFAULT_BACKEND_PORT
}

export function resolvePublicProxyBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawValue = env.PUBLIC_PROXY_BASE_URL?.trim()
  if (!rawValue) {
    return null
  }

  try {
    const parsed = new URL(rawValue)
    const protocol = parsed.protocol.toLowerCase()
    const isProduction = env.NODE_ENV === 'production'
    if (protocol === 'https:') {
      return rawValue.replace(/\/+$/, '')
    }
    if (protocol === 'http:' && !isProduction) {
      return rawValue.replace(/\/+$/, '')
    }
  } catch {
    return null
  }

  return null
}

export function resolveAudioProxyTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.AUDIO_PROXY_TOKEN_SECRET?.trim()
  if (secret) {
    return secret
  }

  const fallback = env.META_TOKEN_SECRET?.trim()
  if (!fallback || env.NODE_ENV === 'production') {
    return null
  }

  if (!warnedAudioProxySecretFallback) {
    warnedAudioProxySecretFallback = true
    console.warn('[audio-proxy] AUDIO_PROXY_TOKEN_SECRET 未配置，开发环境回退到 META_TOKEN_SECRET')
  }

  return fallback
}

export function resolveAudioProxyTtlSec(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AUDIO_PROXY_TOKEN_TTL_SEC?.trim() || '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_AUDIO_PROXY_TOKEN_TTL_SEC
  }

  return Math.min(parsed, DEFAULT_AUDIO_PROXY_TOKEN_TTL_SEC)
}

export function resolveAudioProxyAllowedHosts(env: NodeJS.ProcessEnv = process.env): RegExp[] {
  const raw = env.AUDIO_PROXY_ALLOWED_HOSTS?.trim() || ''
  const patterns = (raw ? raw.split(',') : [...DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS])
    .map((item) => item.trim())
    .filter(Boolean)

  const compiled = patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'i')
      } catch {
        console.warn(`[audio-proxy] 忽略非法 host 正则: ${pattern}`)
        return null
      }
    })
    .filter((item): item is RegExp => item instanceof RegExp)

  if (compiled.length > 0) {
    return compiled
  }

  return DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS.map((pattern) => new RegExp(pattern, 'i'))
}
