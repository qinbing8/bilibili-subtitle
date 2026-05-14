import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import worker from '../src/index.ts'

function signToken(claims: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function makeToken(
  upstreamUrl: string,
  secret = 'worker-secret',
  extraClaims: Record<string, unknown> = {},
): string {
  const nowSec = Math.floor(Date.now() / 1000)
  return signToken(
    {
      v: 1,
      u: upstreamUrl,
      iat: nowSec,
      exp: nowSec + 1_800,
      srcExp: (nowSec + 6_600) * 1_000,
      ...extraClaims,
    },
    secret,
  )
}

async function workerFetch(request: Request, secret = 'worker-secret'): Promise<Response> {
  return worker.fetch(request, { AUDIO_PROXY_TOKEN_SECRET: secret })
}

test('Worker 暴露健康检查并限制代理路径', async () => {
  const health = await workerFetch(new Request('https://example.workers.dev/health'))
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok')

  const missing = await workerFetch(new Request('https://example.workers.dev/other'))
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'not_found' })
})

test('Worker 拒绝非 GET/HEAD 和缺失 token', async () => {
  const method = await workerFetch(
    new Request('https://example.workers.dev/api/audio-proxy', { method: 'POST' }),
  )
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')

  const missing = await workerFetch(new Request('https://example.workers.dev/api/audio-proxy'))
  assert.equal(missing.status, 401)
  assert.deepEqual(await missing.json(), { error: 'missing' })
})

test('Worker 拒绝 token 内非白名单上游 host', async () => {
  const token = makeToken('https://evil.example/audio.m4s')
  const response = await workerFetch(
    new Request(`https://example.workers.dev/api/audio-proxy?t=${encodeURIComponent(token)}`),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'host_not_allowed' })
})

test('Worker 透传 Range、关键响应头，并把上游音频流返回给调用方', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; range: string | null; referer: string | null }> = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      range: headers.get('range'),
      referer: headers.get('referer'),
    })
    return new Response('abc', {
      status: 206,
      headers: {
        'content-type': 'audio/mp4',
        'content-range': 'bytes 0-2/10',
        'accept-ranges': 'bytes',
      },
    })
  }

  try {
    const token = makeToken('https://upos-sz-mirrorakam.akamaized.net/abc.m4s')
    const response = await workerFetch(
      new Request(`https://example.workers.dev/api/audio-proxy?t=${encodeURIComponent(token)}`, {
        headers: { Range: 'bytes=0-2' },
      }),
    )

    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'audio/mp4')
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/10')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(await response.text(), 'abc')
    assert.deepEqual(calls, [
      {
        url: 'https://upos-sz-mirrorakam.akamaized.net/abc.m4s',
        range: 'bytes=0-2',
        referer: 'https://www.bilibili.com',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Worker 优先使用 token 中声明的音频 MIME 和文件名暴露响应头', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('abc', {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '3',
        'content-range': 'bytes 0-2/3',
      },
    })

  try {
    const token = makeToken('https://upos-sz-mirrorakam.akamaized.net/abc.m4s', 'worker-secret', {
      mime: 'audio/mp4',
      fn: '示例音频.m4a',
    })
    const response = await workerFetch(
      new Request(`https://example.workers.dev/api/audio-proxy?t=${encodeURIComponent(token)}`),
    )

    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'audio/mp4')
    const contentDisposition = response.headers.get('content-disposition') || ''
    assert.match(contentDisposition, /^inline; filename=".*"; filename\*=UTF-8''/)
    assert.match(contentDisposition, new RegExp(encodeURIComponent('示例音频.m4a')))
    assert.equal(await response.text(), 'abc')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Worker 手动跟跳并阻断跳转到非白名单 host', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example/next.m4s' } })

  try {
    const token = makeToken('https://upos-sz-mirrorakam.akamaized.net/abc.m4s')
    const response = await workerFetch(
      new Request(`https://example.workers.dev/api/audio-proxy?t=${encodeURIComponent(token)}`),
    )

    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: 'redirect_host_not_allowed' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
