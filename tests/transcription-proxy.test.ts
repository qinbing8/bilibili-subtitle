import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAudioProxyTaskPayload, buildControlAudioInput } from '../api/transcription-proxy.js'
import { verifyAudioProxyToken } from '../api/audio-proxy'

test('buildAudioProxyTaskPayload 用短 ASCII 文件名恢复 mime/fn 并控制 token 长度', () => {
  const payload = buildAudioProxyTaskPayload(
    {
      bvid: 'BV1TKoYBmEQU',
      audioUrl: 'https://upos-sz-mirrorcosov.bilivideo.com/audio.m4s?foo=bar',
      audioFormat: 'm4a',
      mimeType: 'audio/mp4',
      fileName: '即将解锁摸托车.m4a',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    {
      PUBLIC_PROXY_BASE_URL: 'https://bbq13560.dpdns.org',
      AUDIO_PROXY_TOKEN_SECRET: 'proxy-secret',
    },
    1_800,
    1_700_000_000,
  )

  assert.equal(payload.proxyHost, 'bbq13560.dpdns.org')
  assert.ok(payload.tokenLength > 0)
  assert.ok(payload.tokenLength < 1_100)

  const token = new URL(payload.proxyUrl).searchParams.get('t') || ''
  const verified = verifyAudioProxyToken(token, 'proxy-secret', 1_700_000_001)
  assert.equal(verified.ok, true)
  if (verified.ok) {
    assert.equal(verified.claims.mime, 'audio/mp4')
    assert.equal(verified.claims.fn, 'BV1TKoYBmEQU.m4a')
  }
})

test('buildControlAudioInput 构造标准 m4a 对照样本输入', () => {
  const audio = buildControlAudioInput(
    'https://bilibili-subtitle-theta.vercel.app/tingwu-control.m4a',
    Date.UTC(2026, 4, 14, 0, 0, 0),
  )

  assert.deepEqual(audio, {
    bvid: 'TINGWUCONTROL',
    audioUrl: 'https://bilibili-subtitle-theta.vercel.app/tingwu-control.m4a',
    audioFormat: 'm4a',
    mimeType: 'audio/mp4',
    fileName: 'tingwu-control.m4a',
    expiresAt: '2026-05-15T00:00:00.000Z',
  })
})
