import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertLikelyPublicHttpUrl,
  buildAudioProxyUrl,
  isUpstreamHostAllowed,
  signAudioProxyToken,
  verifyAudioProxyToken,
} from '../api/audio-proxy.ts'
import { DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS } from '../api/dev-config.ts'

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
