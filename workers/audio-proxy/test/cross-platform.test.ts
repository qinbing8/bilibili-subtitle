import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { verifyAudioProxyToken } from '../src/token.ts'

function signWithNodeCrypto(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function encodeClaims(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
}

test('Worker Web Crypto 可验证 Node HMAC-SHA256 生成的 token', async () => {
  const secret = 'test-secret-32-bytes-random'
  const claims = {
    v: 1,
    u: 'https://upos-sz-mirrorakam.akamaized.net/abc.m4s',
    iat: 1_715_000_000,
    exp: 1_715_001_800,
    srcExp: 1_715_006_600_000,
    mime: 'audio/mp4',
    fn: 'a.m4a',
    bvid: 'BV1xxx',
    cid: '123',
  }
  const payload = encodeClaims(claims)
  const token = `${payload}.${signWithNodeCrypto(payload, secret)}`

  const result = await verifyAudioProxyToken(token, secret, 1_715_000_500)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.claims, claims)
  }
})

test('Worker token 验证返回与 Node 版一致的错误 reason', async () => {
  const secret = 'test-secret-32-bytes-random'
  const payload = encodeClaims({
    v: 1,
    u: 'https://upos-sz-mirrorakam.akamaized.net/abc.m4s',
    iat: 1_715_000_000,
    exp: 1_715_000_060,
    srcExp: 1_715_006_600_000,
  })
  const token = `${payload}.${signWithNodeCrypto(payload, secret)}`

  assert.deepEqual(await verifyAudioProxyToken('', secret, 1_715_000_001), {
    ok: false,
    reason: 'missing',
  })
  assert.deepEqual(await verifyAudioProxyToken('abc.def', secret, 1_715_000_001), {
    ok: false,
    reason: 'badSig',
  })
  assert.deepEqual(await verifyAudioProxyToken(token, secret, 1_715_000_061), {
    ok: false,
    reason: 'tokenExpired',
  })
})
