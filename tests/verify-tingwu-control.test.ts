import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildControlAudioInput,
  buildControlSampleUrl,
  runControlVerification,
} from '../scripts/verify-tingwu-control-lib.ts'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
}

test('buildControlSampleUrl 与 buildControlAudioInput 构造标准 m4a 样本信息', () => {
  const sampleUrl = buildControlSampleUrl('https://example.vercel.app/', 'tingwu-control.m4a')
  assert.equal(sampleUrl, 'https://example.vercel.app/tingwu-control.m4a')

  const audio = buildControlAudioInput(sampleUrl, Date.UTC(2026, 4, 14, 0, 0, 0))
  assert.equal(audio.bvid, 'TINGWUCONTROL')
  assert.equal(audio.audioUrl, sampleUrl)
  assert.equal(audio.audioFormat, 'm4a')
  assert.equal(audio.mimeType, 'audio/mp4')
  assert.equal(audio.fileName, 'tingwu-control.m4a')
  assert.match(audio.expiresAt, /^2026-05-15T00:00:00\.000Z$/)
})

test('runControlVerification 在 direct/proxy 都成功时输出 m4s 形态结论', async () => {
  const previousBaseUrl = process.env.PUBLIC_PROXY_BASE_URL
  const previousSecret = process.env.AUDIO_PROXY_TOKEN_SECRET
  process.env.PUBLIC_PROXY_BASE_URL = 'https://bbq13560.dpdns.org'
  process.env.AUDIO_PROXY_TOKEN_SECRET = 'proxy-secret'

  try {
    const taskUrls: string[] = []
    const result = await runControlVerification(
      {
        appPassword: 'test-password',
        baseUrl: 'https://example.vercel.app',
        samplePath: '/tingwu-control.m4a',
        language: 'auto',
        pollIntervalMs: 1_000,
        maxWaitMs: 3_000,
        requestTimeoutMs: 5_000,
        modes: ['direct', 'proxy'],
      },
      {
        now: () => Date.UTC(2026, 4, 14, 0, 0, 0),
        sleep: async () => {},
        createTask: async (fileUrl) => {
          taskUrls.push(fileUrl)
          return taskUrls.length === 1 ? 'direct-task' : 'proxy-task'
        },
        fetch: async (input) => {
          const url = String(input)

          if (url === 'https://example.vercel.app/tingwu-control.m4a') {
            return new Response('m4a!', {
              status: 206,
              headers: {
                'content-type': 'audio/mp4',
                'content-length': '4',
                'content-range': 'bytes 0-3/4',
                'accept-ranges': 'bytes',
              },
            })
          }

          if (url.startsWith('https://bbq13560.dpdns.org/api/audio-proxy?t=')) {
            return new Response('m4a!', {
              status: 200,
              headers: {
                'content-type': 'audio/mp4',
                'content-length': '4',
                'accept-ranges': 'bytes',
              },
            })
          }

          if (url.includes('/api/transcription/status?taskId=direct-task')) {
            return jsonResponse({
              success: true,
              data: {
                status: 'COMPLETED',
                preview: 'direct ok',
              },
            })
          }

          if (url.includes('/api/transcription/status?taskId=proxy-task')) {
            return jsonResponse({
              success: true,
              data: {
                status: 'COMPLETED',
                preview: 'proxy ok',
              },
            })
          }

          throw new Error(`unexpected url: ${url}`)
        },
      },
    )

    assert.equal(result.sampleUrl, 'https://example.vercel.app/tingwu-control.m4a')
    assert.equal(result.proxyUrl?.startsWith('https://bbq13560.dpdns.org/api/audio-proxy?t='), true)
    assert.deepEqual(taskUrls, [
      'https://example.vercel.app/tingwu-control.m4a',
      result.proxyUrl,
    ])
    assert.equal(result.runs.every((item) => item.final?.data.status === 'COMPLETED'), true)
    assert.match(result.conclusion, /m4s\/源文件形态问题/)
  } finally {
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_PROXY_BASE_URL
    else process.env.PUBLIC_PROXY_BASE_URL = previousBaseUrl
    if (previousSecret === undefined) delete process.env.AUDIO_PROXY_TOKEN_SECRET
    else process.env.AUDIO_PROXY_TOKEN_SECRET = previousSecret
  }
})

test('runControlVerification 在 proxy 预检被 Worker 拦截时返回 allowlist 线索', async () => {
  const previousBaseUrl = process.env.PUBLIC_PROXY_BASE_URL
  const previousSecret = process.env.AUDIO_PROXY_TOKEN_SECRET
  process.env.PUBLIC_PROXY_BASE_URL = 'https://bbq13560.dpdns.org'
  process.env.AUDIO_PROXY_TOKEN_SECRET = 'proxy-secret'

  try {
    const taskUrls: string[] = []
    const result = await runControlVerification(
      {
        appPassword: 'test-password',
        baseUrl: 'https://example.vercel.app',
        samplePath: '/tingwu-control.m4a',
        language: 'auto',
        pollIntervalMs: 1_000,
        maxWaitMs: 3_000,
        requestTimeoutMs: 5_000,
        modes: ['direct', 'proxy'],
      },
      {
        now: () => Date.UTC(2026, 4, 14, 0, 0, 0),
        sleep: async () => {},
        createTask: async (fileUrl) => {
          taskUrls.push(fileUrl)
          return 'direct-task'
        },
        fetch: async (input) => {
          const url = String(input)

          if (url === 'https://example.vercel.app/tingwu-control.m4a') {
            return new Response('m4a!', {
              status: 206,
              headers: {
                'content-type': 'audio/mp4',
                'content-length': '4',
                'content-range': 'bytes 0-3/4',
                'accept-ranges': 'bytes',
              },
            })
          }

          if (url.startsWith('https://bbq13560.dpdns.org/api/audio-proxy?t=')) {
            return new Response(JSON.stringify({ error: 'host_not_allowed' }), {
              status: 403,
              headers: {
                'content-type': 'application/json',
              },
            })
          }

          if (url.includes('/api/transcription/status?taskId=direct-task')) {
            return jsonResponse({
              success: true,
              data: {
                status: 'COMPLETED',
                preview: 'direct ok',
              },
            })
          }

          throw new Error(`unexpected url: ${url}`)
        },
      },
    )

    assert.deepEqual(taskUrls, ['https://example.vercel.app/tingwu-control.m4a'])
    const proxyRun = result.runs.find((item) => item.mode === 'proxy')
    assert.equal(proxyRun?.taskId, null)
    assert.match(proxyRun?.error || '', /host_not_allowed/)
    assert.match(result.conclusion, /Worker 代理前置检查未通过/)
  } finally {
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_PROXY_BASE_URL
    else process.env.PUBLIC_PROXY_BASE_URL = previousBaseUrl
    if (previousSecret === undefined) delete process.env.AUDIO_PROXY_TOKEN_SECRET
    else process.env.AUDIO_PROXY_TOKEN_SECRET = previousSecret
  }
})
