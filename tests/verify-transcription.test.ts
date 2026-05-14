import test from 'node:test'
import assert from 'node:assert/strict'

import { runVerification } from '../scripts/verify-transcription-lib.ts'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
}

test('runVerification 在任务完成时返回开始信息、代理探测和最终状态', async () => {
  const calls: string[] = []
  let nowMs = 0

  const result = await runVerification(
    {
      appPassword: 'test-password',
      baseUrl: 'https://example.vercel.app',
      bilibiliUrl: 'https://www.bilibili.com/video/BV1TKoYBmEQU/',
      language: 'auto',
      page: 0,
      diarization: false,
      textPolish: false,
      debugProxy: true,
      pollIntervalMs: 1_000,
      maxWaitMs: 5_000,
      requestTimeoutMs: 5_000,
    },
    {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      fetch: async (input, init) => {
        const url = String(input)
        calls.push(url)

        if (url.endsWith('/api/transcription/start')) {
          assert.equal(init?.method, 'POST')
          assert.equal(new Headers(init?.headers).get('x-debug-proxy'), '1')
          return jsonResponse({
            success: true,
            data: {
              taskId: 'task-123',
              proxyHost: 'bbq13560.dpdns.org',
              audioHost: 'upos-sz-mirrorcosov.bilivideo.com',
              debugProxy: {
                proxyUrl: 'https://bbq13560.dpdns.org/api/audio-proxy?t=token',
                proxyUrlLength: 1035,
                tokenLength: 990,
              },
            },
          })
        }

        if (url.includes('/api/audio-proxy?t=token')) {
          assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-')
          return new Response('abc', {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': 'bytes 0-2/3',
              'accept-ranges': 'bytes',
            },
          })
        }

        if (url.includes('/api/transcription/status?taskId=task-123')) {
          const pollCount = calls.filter((item) => item.includes('/api/transcription/status?')).length
          return jsonResponse({
            success: true,
            data: {
              status: pollCount >= 2 ? 'COMPLETED' : 'ONGOING',
              preview: pollCount >= 2 ? 'done' : undefined,
            },
          })
        }

        throw new Error(`unexpected url: ${url}`)
      },
    },
  )

  assert.equal(result.start.data.taskId, 'task-123')
  assert.equal(result.proxyProbe?.status, 206)
  assert.equal(result.proxyProbe?.contentType, 'video/mp4')
  assert.equal(result.proxyProbe?.previewHex, '616263')
  assert.equal(result.final.data.status, 'COMPLETED')
  assert.deepEqual(
    result.polls.map((item) => item.data.status),
    ['ONGOING', 'COMPLETED'],
  )
})

test('runVerification 在任务失败时返回失败状态和错误信息', async () => {
  const result = await runVerification(
    {
      appPassword: 'test-password',
      baseUrl: 'https://example.vercel.app',
      bilibiliUrl: 'https://www.bilibili.com/video/BV1TKoYBmEQU/',
      language: 'auto',
      page: 0,
      diarization: false,
      textPolish: false,
      debugProxy: false,
      pollIntervalMs: 1_000,
      maxWaitMs: 3_000,
      requestTimeoutMs: 5_000,
    },
    {
      now: () => 0,
      sleep: async () => {},
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/transcription/start')) {
          return jsonResponse({
            success: true,
            data: {
              taskId: 'task-failed',
              proxyHost: 'bbq13560.dpdns.org',
              audioHost: 'upos-sz-mirrorcosov.bilivideo.com',
            },
          })
        }

        if (url.includes('/api/transcription/status?taskId=task-failed')) {
          return jsonResponse({
            success: true,
            data: {
              status: 'FAILED',
              errorMessage: 'Audio file link invalid.',
            },
          })
        }

        throw new Error(`unexpected url: ${url}`)
      },
    },
  )

  assert.equal(result.proxyProbe, null)
  assert.equal(result.final.data.status, 'FAILED')
  assert.equal(result.final.data.errorMessage, 'Audio file link invalid.')
  assert.deepEqual(
    result.polls.map((item) => item.data.status),
    ['FAILED'],
  )
})
