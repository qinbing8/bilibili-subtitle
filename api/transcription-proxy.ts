import crypto from 'node:crypto'

import {
  resolveAudioProxyTokenSecret,
  resolveAudioProxyTtlSec,
  resolvePublicProxyBaseUrl,
} from './dev-config.js'
import { assertLikelyPublicHttpUrl, buildAudioProxyUrl, signAudioProxyToken } from './audio-proxy.js'

export interface TranscriptionAudioInput {
  bvid: string
  audioUrl: string
  audioFormat: string
  mimeType: string
  fileName: string
  expiresAt: string
}

export function buildControlAudioInput(sampleUrl: string, nowMs = Date.now()): TranscriptionAudioInput {
  const parsed = new URL(sampleUrl)
  const pathSegments = parsed.pathname.split('/').filter(Boolean)
  const fileName = pathSegments[pathSegments.length - 1] || 'tingwu-control.m4a'

  return {
    bvid: 'TINGWUCONTROL',
    audioUrl: sampleUrl,
    audioFormat: 'm4a',
    mimeType: 'audio/mp4',
    fileName,
    expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
  }
}

function buildProxyFileName(audio: TranscriptionAudioInput): string {
  const base = audio.bvid.trim() || 'audio'
  const ext = audio.audioFormat.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  return `${base}.${ext}`
}

export function buildAudioProxyTaskPayload(
  audio: TranscriptionAudioInput,
  env: NodeJS.ProcessEnv = process.env,
  ttlSec = resolveAudioProxyTtlSec(env),
  nowSec = Math.floor(Date.now() / 1000),
) {
  const publicProxyBaseUrl = resolvePublicProxyBaseUrl(env)
  if (!publicProxyBaseUrl) {
    throw new Error(
      '服务端未配置 PUBLIC_PROXY_BASE_URL，听悟无法读取音频。请配置公网代理地址（推荐 cloudflared tunnel）。',
    )
  }

  const tokenSecret = resolveAudioProxyTokenSecret(env)
  if (!tokenSecret) {
    throw new Error('服务端未配置 AUDIO_PROXY_TOKEN_SECRET，无法生成音频代理 token。')
  }

  const proxyFileName = buildProxyFileName(audio)
  const token = signAudioProxyToken(
    {
      v: 1,
      u: audio.audioUrl,
      srcExp: new Date(audio.expiresAt).getTime(),
      mime: audio.mimeType,
      fn: proxyFileName,
    },
    tokenSecret,
    ttlSec,
    nowSec,
  )
  const proxyUrl = buildAudioProxyUrl(publicProxyBaseUrl, token)
  assertLikelyPublicHttpUrl(proxyUrl)

  return {
    proxyUrl,
    proxyHost: new URL(proxyUrl).host,
    audioHost: new URL(audio.audioUrl).host,
    proxyExpiresAt: new Date(nowSec * 1000 + ttlSec * 1000).toISOString(),
    sourceExpiresAt: audio.expiresAt,
    proxyUrlLength: proxyUrl.length,
    audioUrlLength: audio.audioUrl.length,
    tokenLength: token.length,
    fileNameBytes: Buffer.byteLength(proxyFileName, 'utf8'),
    proxyUrlHash: crypto.createHash('sha256').update(proxyUrl).digest('hex').slice(0, 16),
  }
}
