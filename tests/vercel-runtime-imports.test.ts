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

test('Vercel 运行时入口的相对 import 必须显式带 .js 后缀（ESM 项目 Node 严格解析）', () => {
  // Node ESM resolver requires explicit file extensions for relative imports.
  // Missing .js extension causes ERR_MODULE_NOT_FOUND at function cold start.
  const relativeImportPattern =
    /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]\s*\)?/g
  for (const filePath of runtimeFiles) {
    const source = readFileSync(filePath, 'utf8')
    let match: RegExpExecArray | null
    while ((match = relativeImportPattern.exec(source)) !== null) {
      const specifier = match[1]
      assert.match(
        specifier,
        /\.js$/,
        `${filePath} 中的相对 import "${specifier}" 缺少 .js 后缀，Node ESM 会抛 ERR_MODULE_NOT_FOUND`,
      )
    }
  }
})
