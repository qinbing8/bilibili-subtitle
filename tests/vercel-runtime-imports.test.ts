import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const runtimeFiles = ['api/index.ts', 'api/server.ts', 'api/audio-proxy.ts'] as const

test('Vercel 运行时入口不应保留相对 .ts import 后缀', () => {
  for (const filePath of runtimeFiles) {
    const source = readFileSync(filePath, 'utf8')
    assert.doesNotMatch(
      source,
      /from\s+['"]\.\.?\/[^'"]+\.ts['"]|import\s*\(\s*['"]\.\.?\/[^'"]+\.ts['"]\s*\)/,
      `${filePath} 仍包含相对 .ts import，Vercel 编译为 .js 后会在冷启动时报错`,
    )
  }
})
