import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import app from '../api/index.ts'
import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS,
  loadLocalEnv,
  resolveAudioProxyAllowedHosts,
  resolveAudioProxyTokenSecret,
  resolveAudioProxyTtlSec,
  resolveBackendPort,
  resolvePublicProxyBaseUrl,
} from '../api/dev-config.ts'

const TEST_ENV_KEYS = [
  'APP_ACCESS_PASSWORD',
  'ALLOWED_ORIGINS',
  'BACKEND_PORT',
  'PORT',
  'PUBLIC_PROXY_BASE_URL',
  'NODE_ENV',
  'AUDIO_PROXY_TOKEN_SECRET',
  'META_TOKEN_SECRET',
  'AUDIO_PROXY_TOKEN_TTL_SEC',
  'AUDIO_PROXY_ALLOWED_HOSTS',
] as const

function withIsolatedEnv(run: () => void) {
  const snapshot = new Map<string, string | undefined>()
  for (const key of TEST_ENV_KEYS) {
    snapshot.set(key, process.env[key])
    delete process.env[key]
  }

  try {
    run()
  } finally {
    for (const key of TEST_ENV_KEYS) {
      const value = snapshot.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withIsolatedEnvAsync(run: () => Promise<void>) {
  const snapshot = new Map<string, string | undefined>()
  for (const key of TEST_ENV_KEYS) {
    snapshot.set(key, process.env[key])
    delete process.env[key]
  }

  try {
    await run()
  } finally {
    for (const key of TEST_ENV_KEYS) {
      const value = snapshot.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withTestServer(run: (baseUrl: string) => Promise<void>) {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await run(baseUrl)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}

test('loadLocalEnv 先读 .env.local，再补 .env 缺失项', () => {
  withIsolatedEnv(() => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bilibili-subtitle-env-'))

    try {
      writeFileSync(
        path.join(tempDir, '.env.local'),
        ['APP_ACCESS_PASSWORD=local-pass', 'BACKEND_PORT=9123'].join('\n'),
      )
      writeFileSync(
        path.join(tempDir, '.env'),
        ['APP_ACCESS_PASSWORD=base-pass', 'ALLOWED_ORIGINS=http://localhost:5173'].join('\n'),
      )

      loadLocalEnv(tempDir)

      assert.equal(process.env.APP_ACCESS_PASSWORD, 'local-pass')
      assert.equal(process.env.BACKEND_PORT, '9123')
      assert.equal(process.env.ALLOWED_ORIGINS, 'http://localhost:5173')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

test('loadLocalEnv 不覆盖外部已注入的环境变量', () => {
  withIsolatedEnv(() => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bilibili-subtitle-env-'))

    try {
      process.env.APP_ACCESS_PASSWORD = 'preset-pass'
      writeFileSync(path.join(tempDir, '.env.local'), 'APP_ACCESS_PASSWORD=local-pass\n')

      loadLocalEnv(tempDir)

      assert.equal(process.env.APP_ACCESS_PASSWORD, 'preset-pass')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

test('resolveBackendPort 优先 BACKEND_PORT，其次 PORT，最后回退默认值', () => {
  assert.equal(resolveBackendPort({ BACKEND_PORT: '9210' }), 9210)
  assert.equal(resolveBackendPort({ PORT: '9211' }), 9211)
  assert.equal(resolveBackendPort({ BACKEND_PORT: 'invalid' }), DEFAULT_BACKEND_PORT)
})

test('resolvePublicProxyBaseUrl 标准化 https 地址并去掉末尾斜杠', () => {
  assert.equal(
    resolvePublicProxyBaseUrl({
      PUBLIC_PROXY_BASE_URL: ' https://abc.trycloudflare.com/ ',
    }),
    'https://abc.trycloudflare.com',
  )
})

test('resolvePublicProxyBaseUrl 仅在非生产环境允许 http', () => {
  assert.equal(
    resolvePublicProxyBaseUrl({
      PUBLIC_PROXY_BASE_URL: 'http://localhost:8787/',
      NODE_ENV: 'development',
    }),
    'http://localhost:8787',
  )
  assert.equal(
    resolvePublicProxyBaseUrl({
      PUBLIC_PROXY_BASE_URL: 'http://localhost:8787/',
      NODE_ENV: 'production',
    }),
    null,
  )
})

test('resolveAudioProxyTokenSecret 优先使用独立密钥，开发环境可回退 META_TOKEN_SECRET', () => {
  assert.equal(
    resolveAudioProxyTokenSecret({
      AUDIO_PROXY_TOKEN_SECRET: 'proxy-secret',
      META_TOKEN_SECRET: 'meta-secret',
      NODE_ENV: 'production',
    }),
    'proxy-secret',
  )
  assert.equal(
    resolveAudioProxyTokenSecret({
      META_TOKEN_SECRET: 'meta-secret',
      NODE_ENV: 'development',
    }),
    'meta-secret',
  )
  assert.equal(
    resolveAudioProxyTokenSecret({
      META_TOKEN_SECRET: 'meta-secret',
      NODE_ENV: 'production',
    }),
    null,
  )
})

test('resolveAudioProxyTtlSec 使用默认值并限制上限', () => {
  assert.equal(resolveAudioProxyTtlSec({}), 1800)
  assert.equal(resolveAudioProxyTtlSec({ AUDIO_PROXY_TOKEN_TTL_SEC: '600' }), 600)
  assert.equal(resolveAudioProxyTtlSec({ AUDIO_PROXY_TOKEN_TTL_SEC: '9999' }), 1800)
  assert.equal(resolveAudioProxyTtlSec({ AUDIO_PROXY_TOKEN_TTL_SEC: 'oops' }), 1800)
})

test('resolveAudioProxyAllowedHosts 默认回退内置正则，支持环境变量覆盖', () => {
  const defaults = resolveAudioProxyAllowedHosts({})
  assert.equal(defaults.length, DEFAULT_AUDIO_PROXY_ALLOWED_HOST_PATTERNS.length)
  assert.match('upos-sz-mirrorcos.bilivideo.com', defaults[0])

  const custom = resolveAudioProxyAllowedHosts({
    AUDIO_PROXY_ALLOWED_HOSTS: '^foo\\.example\\.com$,^bar\\.example\\.com$',
  })
  assert.equal(custom.length, 2)
  assert.match('foo.example.com', custom[0])
  assert.doesNotMatch('evil.com', custom[0])
})

test('携带不匹配的 Origin 时 health-with-config 不应返回 500', async () => {
  await withIsolatedEnvAsync(async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com'

    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health-with-config`, {
        headers: {
          Origin: 'https://bilibili-subtitle-theta.vercel.app',
        },
      })

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('access-control-allow-origin'), null)

      const body = await response.json()
      assert.equal(body.status, 'ok')
    })
  })
})

test('auth-check 仅在密码正确时返回成功', async () => {
  await withIsolatedEnvAsync(async () => {
    process.env.APP_ACCESS_PASSWORD = 'test-password'

    await withTestServer(async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/api/auth-check`)
      assert.equal(unauthorized.status, 401)

      const authorized = await fetch(`${baseUrl}/api/auth-check`, {
        headers: {
          'X-App-Password': 'test-password',
        },
      })

      assert.equal(authorized.status, 200)
      assert.deepEqual(await authorized.json(), {
        success: true,
      })
    })
  })
})
