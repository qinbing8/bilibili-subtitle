export interface AudioProxyClaims {
  v: 1
  u: string
  iat: number
  exp: number
  srcExp: number
  mime?: string
  fn?: string
  bvid?: string
  cid?: string
}

export type VerifyResult =
  | { ok: true; claims: AudioProxyClaims }
  | {
      ok: false
      reason: 'missing' | 'malformed' | 'badSig' | 'tokenExpired' | 'sourceExpired'
    }

const encoder = new TextEncoder()

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function safeCompare(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) {
    return false
  }

  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  }
  return diff === 0
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return bytesToBase64Url(new Uint8Array(signature))
}

function parseClaims(payload: string): AudioProxyClaims | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as AudioProxyClaims
  } catch {
    return null
  }
}

function isValidClaims(value: AudioProxyClaims | null): value is AudioProxyClaims {
  return Boolean(
    value &&
      value.v === 1 &&
      typeof value.u === 'string' &&
      value.u.length > 0 &&
      Number.isFinite(value.iat) &&
      Number.isFinite(value.exp) &&
      Number.isFinite(value.srcExp) &&
      value.exp > value.iat,
  )
}

export async function verifyAudioProxyToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!token) {
    return { ok: false, reason: 'missing' }
  }

  const [payload, sig] = token.split('.')
  if (!payload || !sig) {
    return { ok: false, reason: 'malformed' }
  }

  if (!safeCompare(await signPayload(payload, secret), sig)) {
    return { ok: false, reason: 'badSig' }
  }

  const claims = parseClaims(payload)
  if (!isValidClaims(claims)) {
    return { ok: false, reason: 'malformed' }
  }
  if (claims.exp <= nowSec) {
    return { ok: false, reason: 'tokenExpired' }
  }
  if (claims.srcExp <= nowSec * 1000) {
    return { ok: false, reason: 'sourceExpired' }
  }
  return { ok: true, claims }
}
