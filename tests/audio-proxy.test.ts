import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  assertHostResolvesToPublic,
  assertLikelyPublicHttpUrl,
  AudioProxyRateLimiter,
  BlockedHostError,
  buildAudioProxyUrl,
  DnsLookupError,
  isUpstreamHostAllowed,
  signAudioProxyToken,
  verifyAudioProxyToken,
} from '../api/audio-proxy'
import { DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS } from '../api/dev-config'

const allowedHosts = DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS.map((pattern) => new RegExp(pattern, 'i'))

test('signAudioProxyToken 与 verifyAudioProxyToken 可往返恢复 claims', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
      mime: 'audio/mp4',
      fn: 'sample.m4a',
      bvid: 'BV1xx411c7mD',
      cid: '123456',
    },
    'proxy-secret',
    600,
    1_700_000_000,
  )

  const result = verifyAudioProxyToken(token, 'proxy-secret', 1_700_000_100)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.claims.v, 1)
    assert.equal(result.claims.u, 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s')
    assert.equal(result.claims.exp, 1_700_000_600)
    assert.equal(result.claims.iat, 1_700_000_000)
    assert.equal(result.claims.fn, 'sample.m4a')
  }
})

test('verifyAudioProxyToken 检测被篡改的 payload', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
    },
    'proxy-secret',
    600,
    1_700_000_000,
  )

  const [payload, sig] = token.split('.')
  const tamperedPayload = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      u: 'https://evil.com/audio.m4s',
    }),
  ).toString('base64url')

  assert.deepEqual(verifyAudioProxyToken(`${tamperedPayload}.${sig}`, 'proxy-secret', 1_700_000_100), {
    ok: false,
    reason: 'badSig',
  })
})

test('verifyAudioProxyToken 检测 token TTL 过期', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
    },
    'proxy-secret',
    60,
    1_700_000_000,
  )

  assert.deepEqual(verifyAudioProxyToken(token, 'proxy-secret', 1_700_000_061), {
    ok: false,
    reason: 'tokenExpired',
  })
})

test('verifyAudioProxyToken 检测源地址过期', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_700_000_000_000,
    },
    'proxy-secret',
    600,
    1_699_999_500,
  )

  assert.deepEqual(verifyAudioProxyToken(token, 'proxy-secret', 1_700_000_001), {
    ok: false,
    reason: 'sourceExpired',
  })
})

test('verifyAudioProxyToken 使用错误 secret 会返回 badSig', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
    },
    'proxy-secret',
    600,
    1_700_000_000,
  )

  assert.deepEqual(verifyAudioProxyToken(token, 'wrong-secret', 1_700_000_001), {
    ok: false,
    reason: 'badSig',
  })
})

test('verifyAudioProxyToken 在签名长度不匹配时安全返回 badSig', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
    },
    'proxy-secret',
    600,
    1_700_000_000,
  )

  const [payload] = token.split('.')
  assert.deepEqual(verifyAudioProxyToken(`${payload}.x`, 'proxy-secret', 1_700_000_001), {
    ok: false,
    reason: 'badSig',
  })
})

test('verifyAudioProxyToken 严格校验 claims 结构', () => {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      iat: 1_700_000_000,
      exp: 1_700_000_000,
      srcExp: 1_900_000_000_000,
    }),
  ).toString('base64url')
  const sig = crypto.createHmac('sha256', 'proxy-secret').update(payload).digest('base64url')

  assert.deepEqual(verifyAudioProxyToken(`${payload}.${sig}`, 'proxy-secret', 1_700_000_001), {
    ok: false,
    reason: 'malformed',
  })
})

test('assertLikelyPublicHttpUrl 拒绝 localhost', () => {
  assert.throws(() => assertLikelyPublicHttpUrl('http://localhost:9091/api/audio-proxy?t=x'))
})

test('assertLikelyPublicHttpUrl 拒绝 127.0.0.1', () => {
  assert.throws(() => assertLikelyPublicHttpUrl('http://127.0.0.1:9091/api/audio-proxy?t=x'))
})

test('assertLikelyPublicHttpUrl 拒绝私网 IPv4', () => {
  assert.throws(() => assertLikelyPublicHttpUrl('http://192.168.1.1/api/audio-proxy?t=x'))
})

test('assertLikelyPublicHttpUrl 接受 trycloudflare 地址', () => {
  assert.doesNotThrow(() =>
    assertLikelyPublicHttpUrl('https://abc.trycloudflare.com/api/audio-proxy?t=x'),
  )
})

test('assertHostResolvesToPublic 拒绝解析到私网地址的域名', async () => {
  await assert.rejects(
    () =>
      assertHostResolvesToPublic('upos.example.com', async () => [
        { address: '10.0.0.8', family: 4 },
      ]),
    (error) => {
      assert.equal(error instanceof BlockedHostError, true)
      assert.equal((error as BlockedHostError).address, '10.0.0.8')
      return true
    },
  )
})

test('assertHostResolvesToPublic 拒绝 IPv4-mapped IPv6 私网地址', async () => {
  await assert.rejects(
    () =>
      assertHostResolvesToPublic('upos.example.com', async () => [
        { address: '::ffff:127.0.0.1', family: 6 },
      ]),
    (error) => {
      assert.equal(error instanceof BlockedHostError, true)
      assert.equal((error as BlockedHostError).address, '::ffff:127.0.0.1')
      return true
    },
  )
})

test('assertHostResolvesToPublic 在 DNS 失败时抛出 DnsLookupError', async () => {
  await assert.rejects(
    () =>
      assertHostResolvesToPublic('upos.example.com', async () => {
        throw new Error('lookup failed')
      }),
    (error) => {
      assert.equal(error instanceof DnsLookupError, true)
      assert.equal((error as DnsLookupError).hostname, 'upos.example.com')
      return true
    },
  )
})

test('assertHostResolvesToPublic 对公网 IP 字面量不再额外 lookup', async () => {
  let called = false

  await assert.doesNotReject(() =>
    assertHostResolvesToPublic('1.2.3.4', async () => {
      called = true
      return [{ address: '1.2.3.4', family: 4 }]
    }),
  )

  assert.equal(called, false)
})

test('isUpstreamHostAllowed 正确校验 host 白名单', () => {
  assert.equal(
    isUpstreamHostAllowed('https://upos-sz-mirrorcos.bilivideo.com/audio.m4s', allowedHosts),
    true,
  )
  assert.equal(isUpstreamHostAllowed('https://evil.com/audio.m4s', allowedHosts), false)
  assert.equal(
    isUpstreamHostAllowed('https://evil.bilivideo.com.attacker.io/audio.m4s', allowedHosts),
    false,
  )
})

test('buildAudioProxyUrl 规范化 baseUrl 末尾斜杠', () => {
  assert.equal(
    buildAudioProxyUrl('https://abc.trycloudflare.com/', 'token-value'),
    'https://abc.trycloudflare.com/api/audio-proxy?t=token-value',
  )
})

test('signAudioProxyToken 使用紧凑字段但 verify 仍恢复 MIME 和文件名', () => {
  const token = signAudioProxyToken(
    {
      v: 1,
      u: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s',
      srcExp: 1_900_000_000_000,
      mime: 'audio/mp4',
      fn: 'sample.m4a',
    },
    'proxy-secret',
    600,
    1_700_000_000,
  )

  const [payload] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  assert.equal(decoded.m, 'audio/mp4')
  assert.equal(decoded.f, 'sample.m4a')
  assert.equal('mime' in decoded, false)
  assert.equal('fn' in decoded, false)
  assert.equal('bvid' in decoded, false)
  assert.equal('cid' in decoded, false)

  const verified = verifyAudioProxyToken(token, 'proxy-secret', 1_700_000_100)
  assert.equal(verified.ok, true)
  if (verified.ok) {
    assert.equal(verified.claims.mime, 'audio/mp4')
    assert.equal(verified.claims.fn, 'sample.m4a')
  }
})

test('AudioProxyRateLimiter 命中 per-token 与 global 并发限制', () => {
  const limiter = new AudioProxyRateLimiter({
    maxConcurrentPerToken: 1,
    maxConcurrentGlobal: 2,
    maxBytesPerToken: 1024,
    maxDurationMs: 60_000,
  })

  assert.deepEqual(limiter.tryAcquire('token-a'), { ok: true })
  assert.deepEqual(limiter.tryAcquire('token-a'), {
    ok: false,
    reason: 'token_concurrency',
  })
  assert.deepEqual(limiter.tryAcquire('token-b'), { ok: true })
  assert.deepEqual(limiter.tryAcquire('token-c'), {
    ok: false,
    reason: 'global_concurrency',
  })

  limiter.release('token-a')
  assert.deepEqual(limiter.tryAcquire('token-c'), { ok: true })
})

test('AudioProxyRateLimiter 命中字节上限后拒绝重入', () => {
  const limiter = new AudioProxyRateLimiter({
    maxConcurrentPerToken: 1,
    maxConcurrentGlobal: 2,
    maxBytesPerToken: 100,
    maxDurationMs: 60_000,
  })

  assert.deepEqual(limiter.tryAcquire('token-a'), { ok: true })
  assert.deepEqual(limiter.recordBytes('token-a', 60), { allowed: true, total: 60 })
  assert.deepEqual(limiter.recordBytes('token-a', 50), { allowed: false, total: 110 })

  limiter.release('token-a')
  assert.deepEqual(limiter.tryAcquire('token-a'), {
    ok: false,
    reason: 'bytes_exceeded',
  })
})

test('AudioProxyRateLimiter 命中持续时长上限', () => {
  let now = 0
  const limiter = new AudioProxyRateLimiter(
    {
      maxConcurrentPerToken: 2,
      maxConcurrentGlobal: 2,
      maxBytesPerToken: 1024,
      maxDurationMs: 100,
    },
    () => now,
  )

  assert.deepEqual(limiter.tryAcquire('token-a'), { ok: true })
  now = 150
  assert.deepEqual(limiter.tryAcquire('token-a'), {
    ok: false,
    reason: 'duration_exceeded',
  })
})
