# 实施计划：公网音频代理 — 让通义听悟可拉取 B 站音频（端到端闭环）

> 版本：v1（2026-05-12）
> 主分支：`main`
> 本计划解决 [PROJECT_STATUS.md](/D:/workspeace/bilibili-subtitle/PROJECT_STATUS.md) 中"未完成"的全部条目；前置 [vercel-fixes.md](/D:/workspeace/bilibili-subtitle/.claude/plan/vercel-fixes.md) 与 [transcription-to-docx.md](/D:/workspeace/bilibili-subtitle/.claude/plan/transcription-to-docx.md) 已落地。

---

## 0. 任务类型

- [x] 后端（→ codex 主导）— 新增代理路由、签名、上游头注入、双入口同步、配置加固
- [x] 前端（→ gemini 主导）— 代理状态横幅、缺配置时的 UX、错误文案
- [x] 全栈（→ Claude 编排）— 测试基线修复、文档更新、联调脚本

---

## 1. 背景与硬约束（来自上下文）

### 1.1 当前症状

`/api/transcription/start` 把 B 站 DASH `.m4s` 直链直接交给通义听悟（`api/server.ts:654-698`），听悟回拉时无 `Referer: https://www.bilibili.com`，被 B 站 / CDN 返回 `403`，最终任务状态变 `FAILED`，错误信息：`File cannot be read.`（[MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md) 联调结论）。

### 1.2 硬约束

| # | 约束 | 来源 |
|---|------|------|
| C1 | 听悟 OpenAPI（`tingwu.cn-beijing.aliyuncs.com`）只接受公网 `http(s)` URL，**不能注入自定义请求头** | 阿里云听悟 API 文档 |
| C2 | B 站音频直链（`*.bilivideo.com` / `*.bilivideo.cn` / `*.akamaized.net` / `*.mcdn.bilivideo.cn`）所有跳转都校验 `Referer`，无 Referer 一律 `403` | `api/server.ts:78-89` 已实证；MAINTENANCE 联调结论 |
| C3 | `localhost:9091` 不可被听悟（cn-beijing）直接访问 | 网络拓扑事实 |
| C4 | **禁止** Codex / 任何 agent 启动长活后端进程（`9091` 残留问题已发生 ≥2 次） | [AGENTS.md](/D:/workspeace/bilibili-subtitle/AGENTS.md) |
| C5 | 项目同时存在 `api/server.ts`（本地入口）与 `api/index.ts`（Vercel 入口，由 `vercel.json:5` 路由），**两套必须同步改造** | `vercel.json:21-25` |
| C6 | Vercel `api/index.ts` 函数 `maxDuration: 300`（5 分钟） — 长视频音频流会被截断 | `vercel.json:16-19` |
| C7 | B 站音频源 URL 自身约 110 分钟过期（`expiresAt`） | `api/server.ts:333` |
| C8 | 现有 `signMeta` / `verifyMeta` HMAC 工具可复用为代理 token 签名同源逻辑 | `api/server.ts:484-507` |
| C9 | 现有命令 `node --experimental-strip-types --test tests/**` 在 PowerShell 下因 glob 把 `tests/test_parsing.py` 引入而失败（codex 实测） | `tests/` 目录 |
| C10 | 听悟可能发起 `HEAD` 与 `Range` 请求探测文件可读性 | 阿里云对象拉取标准实践 |

---

## 2. 技术方案（综合 codex + gemini 双模型分析）

### 2.1 决策矩阵

| 方案 | 大陆可达性 | 大文件支持 | 用户摩擦 | 与 AGENTS.md 兼容 | 抗滥用 | 综合得分 |
|------|----------|----------|---------|------------------|-------|---------|
| Vercel Serverless 流式代理 | ⚠️ 跨境，常被 GFW 限速/阻断 | ❌ 受 `maxDuration:300` 限制 | 低 | ✅ | ✅ | 中 |
| Cloudflare Workers | ⚠️ `workers.dev` 被墙；自定义域不稳 | ✅ | 中 | ✅ | ✅ | 中 |
| **Cloudflare Tunnel → 本地 :9091** | ✅ HK/SG 路由通常可达；Tingwu cn-beijing 实测可拉 trycloudflare.com | ✅ 仅受本机上行带宽限制 | 中（多一步 `cloudflared`） | ✅ 用户已手工启动后端，再开一个独立终端起 tunnel | ✅（本地 HMAC + TTL + host 白名单） | **高** |
| Aliyun OSS 预签名 URL | ✅ 同区域最稳 | ✅ | 高（需 OSS Bucket + RAM 授权 + 失败补偿） | ✅ | ✅ | 中高 |
| 自建 Aliyun ECS in cn-beijing | ✅ | ✅ | 极高（成本 + 长期运维） | ⚠️ 又引入长活进程 | ✅ | 低 |

### 2.2 主方案：Cloudflare Tunnel + 本地流式代理路由

**架构**：
```
B站 URL ──► [前端] ──► [本地 :9091]
                          │
                          ├─ /api/transcription/start
                          │    1. 解析 B 站音频直链
                          │    2. 生成 HMAC 签名 token（嵌入上游 URL + 过期 + bvid/cid）
                          │    3. 组装代理 URL：
                          │       https://<tunnel>.trycloudflare.com/api/audio-proxy?t=<token>
                          │    4. 把代理 URL 传给 Tingwu CreateTask
                          │
                          └─ /api/audio-proxy（GET + HEAD）
                               1. 验证 token（HMAC + TTL + 上游 URL 白名单）
                               2. 用 axios stream + 强制 Referer/UA 拉上游
                               3. 手动跟最多 5 跳重定向，每跳重新注入 Referer
                               4. 流式管道转发到 res（保留 Range / 206 / Content-Range）
                               5. 客户端断开 → 中止上游
                          ▲
                          │ 公网入站
                  [Cloudflare Tunnel]
                          ▲
                          │ Tingwu (cn-beijing) 拉音频
                  [Aliyun 通义听悟]
```

**为什么选它**：
- 无 5 分钟超时硬限（codex 主推 Vercel Serverless 在 `maxDuration:300` 约束下对长音频不可行）
- 大陆可达性比 `*.vercel.app` 更稳（gemini 判断：Vercel 在 GFW 下"unsuitable"）
- 用户已手工启动 `npm run dev:backend`，再多一个独立终端跑 `cloudflared tunnel --url http://localhost:9091` 是单步增量
- 完全本地实现，无新依赖、无新平台账号
- HMAC token + 白名单 + TTL ≤ 30 分钟，杜绝开放代理被滥用

### 2.3 后备方案：Aliyun OSS 预签名 URL（仅当主方案失稳时启用）

**触发条件**：
- Cloudflare Tunnel 在 cn-beijing 被持续阻断（连续 3 次任务失败且日志显示 Tingwu 拉取超时）
- 或单文件 > 200MB 频繁导致 tunnel 中断

**架构纲要**（v2 计划再展开）：
1. 后端拉取 B 站音频到 `/tmp/<uuid>.m4a`（带 Referer）
2. 用阿里云 OSS SDK 上传到 `oss-cn-beijing` Bucket
3. 生成 1 小时签名 URL → 传给 Tingwu
4. 转写完成后异步清理 OSS 对象
5. 新增环境变量：`ALIYUN_OSS_REGION` / `ALIYUN_OSS_BUCKET` / `ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET`

> **本次计划只实现主方案**；后备方案入口保留（`api/audio-proxy.ts` 内的策略选择枚举），实现留给后续 PR。

---

## 3. 实施步骤

### Step 1：测试基线修复（前置阻塞）

**问题**（codex 实测）：`node --experimental-strip-types --test tests/**` 在 PowerShell 下会展开 `tests/`（目录本身）和 `tests/test_parsing.py`（Python 文件），导致 `MODULE_NOT_FOUND` 与 `ERR_UNKNOWN_FILE_EXTENSION`。

**修改**：
- 修改 `package.json`，新增脚本：
  ```json
  "test": "node --experimental-strip-types --test tests/dev-config.test.ts tests/tingwu-task.test.ts tests/audio-proxy.test.ts"
  ```
- 让 `npm test` 显式列出 `*.test.ts`，绕开 glob 把 `.py` 引入
- 同步更新 [MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md) 中的"健康检查"段落，统一使用 `npm test`

**验收**：`npm test` 在 PowerShell 与 bash 下均通过且不引入 `.py`。

---

### Step 2：扩展 `api/dev-config.ts` — 配置层

**新增导出**：

| 函数 | 行为 |
|------|------|
| `resolvePublicProxyBaseUrl(env)` | 读取 `PUBLIC_PROXY_BASE_URL`；trim；强制要求 `https://` 或 `http://`（仅本地开发时允许 http）；末尾去掉 `/`；返回 `string \| null` |
| `resolveAudioProxyTokenSecret(env)` | 读取 `AUDIO_PROXY_TOKEN_SECRET`；空时返回 `null`（生产 fail-fast，开发允许 fallback 到 `META_TOKEN_SECRET` 但发出 `console.warn`） |
| `resolveAudioProxyTtlSec(env)` | 读取 `AUDIO_PROXY_TOKEN_TTL_SEC`；默认 `1800`（30 分钟）；上限 `1800`；非法值降级到默认 |
| `resolveAudioProxyAllowedHosts(env)` | 读取 `AUDIO_PROXY_ALLOWED_HOSTS`；逗号分隔；默认列表见下表 |

**默认 `AUDIO_PROXY_ALLOWED_HOSTS`**（gemini 推荐 + codex 验证，正则形式）：
- `^[a-z0-9-]+\.bilivideo\.com$`
- `^[a-z0-9-]+\.bilivideo\.cn$`
- `^[a-z0-9-]+\.mcdn\.bilivideo\.cn$`
- `^[a-z0-9-]+\.akamaized\.net$`
- `^upos-[a-z0-9-]+\.(bilivideo|akamaized)\.(com|cn|net)$`

> ⚠️ 实现时把"通配子域"统一封装成 `isUpstreamHostAllowed(url, regexList): boolean`，**不允许**直接做字符串 `endsWith` 判断（避免 `evil.bilivideo.com.attacker.io` 绕过）。

---

### Step 3：新增 `api/audio-proxy.ts` — 核心模块（约 200 行）

**导出 4 个函数**：

```typescript
// 1. token 签名 / 验证
export interface AudioProxyClaims {
  v: 1                  // 版本号，将来升级用
  u: string             // 上游音频 URL（B 站直链）
  iat: number           // 签发时间（秒）
  exp: number           // token 过期（秒）
  srcExp: number        // B 站源 URL 过期（毫秒，对齐 expiresAt）
  mime?: string         // 上游 MIME（hint，给前端展示用）
  fn?: string           // 文件名（hint）
  bvid?: string         // 调试用
  cid?: string          // 调试用
}

export function signAudioProxyToken(
  claims: Omit<AudioProxyClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
): string

export function verifyAudioProxyToken(
  token: string,
  secret: string,
  nowSec?: number,
): { ok: true; claims: AudioProxyClaims } | { ok: false; reason: 'missing' | 'malformed' | 'badSig' | 'tokenExpired' | 'sourceExpired' }

// 2. 公网 URL 校验（防止本地 URL 误传给 Tingwu）
export function assertLikelyPublicHttpUrl(url: string): void
// 拒绝：非 http(s)、localhost、127.0.0.1、10./172.16-31./192.168.（IPv4 私网）、::1、fc00::/7、fe80::/10

// 3. 上游 host 白名单
export function isUpstreamHostAllowed(url: string, regexList: RegExp[]): boolean

// 4. Express 处理函数
export interface AudioProxyDeps {
  secret: string                  // 来自 resolveAudioProxyTokenSecret
  allowedHostRegex: RegExp[]      // 来自 resolveAudioProxyAllowedHosts
  upstreamHeaders: () => Record<string, string>  // 复用 server.ts 的 getBilibiliHeaders
  maxRedirects?: number           // 默认 5
  headerTimeoutMs?: number        // 默认 15000
}

export function createAudioProxyHandler(deps: AudioProxyDeps):
  (req: express.Request, res: express.Response) => Promise<void>

// 5. 代理 URL 组装
export function buildAudioProxyUrl(
  baseUrl: string,                // PUBLIC_PROXY_BASE_URL，已 trim
  token: string,
): string
// 形如 https://abc.trycloudflare.com/api/audio-proxy?t=<token>
```

**`createAudioProxyHandler` 行为契约**（伪代码）：

```typescript
return async (req, res) => {
  // 0. 方法白名单
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  // 1. token 验证
  const tokenStr = String(req.query.t || '')
  const result = verifyAudioProxyToken(tokenStr, deps.secret)
  if (!result.ok) {
    const status = result.reason === 'tokenExpired' || result.reason === 'sourceExpired' ? 410 : 401
    return res.status(status).json({ error: result.reason })
  }
  const { claims } = result

  // 2. 上游 URL 二次校验（防 token 颁发时漏掉）
  if (!isUpstreamHostAllowed(claims.u, deps.allowedHostRegex)) {
    return res.status(403).json({ error: 'host_not_allowed' })
  }

  // 3. 手动跟跳，每跳重注 Referer
  let currentUrl = claims.u
  let upstreamResp: AxiosResponse<Readable> | null = null
  let lastStatus = 0
  for (let hop = 0; hop <= (deps.maxRedirects ?? 5); hop++) {
    const resp = await axios.request<Readable>({
      method: req.method as 'GET' | 'HEAD',
      url: currentUrl,
      responseType: 'stream',
      maxRedirects: 0,                 // 自己管
      validateStatus: () => true,      // 拿到原始状态码再决定
      timeout: deps.headerTimeoutMs ?? 15000,
      headers: {
        ...deps.upstreamHeaders(),
        'Accept-Encoding': 'identity',
        ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
        ...(req.headers['if-range'] ? { 'If-Range': String(req.headers['if-range']) } : {}),
      },
    })
    lastStatus = resp.status
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      // 释放 stream 再继续跳
      resp.data?.destroy?.()
      const next = new URL(resp.headers.location, currentUrl).toString()
      if (!isUpstreamHostAllowed(next, deps.allowedHostRegex)) {
        return res.status(502).json({ error: 'redirect_host_not_allowed' })
      }
      currentUrl = next
      continue
    }
    upstreamResp = resp
    break
  }

  if (!upstreamResp) {
    return res.status(502).json({ error: 'too_many_redirects' })
  }

  // 4. 状态码映射
  if (upstreamResp.status === 403) {
    upstreamResp.data?.destroy?.()
    return res.status(502).json({ error: 'upstream_forbidden' })
  }
  if (upstreamResp.status === 404) {
    upstreamResp.data?.destroy?.()
    return res.status(502).json({ error: 'upstream_not_found' })
  }
  if (![200, 206].includes(upstreamResp.status)) {
    upstreamResp.data?.destroy?.()
    return res.status(502).json({ error: 'unexpected_status', status: upstreamResp.status })
  }

  // 5. 响应头透传
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
  for (const h of passthrough) {
    const v = upstreamResp.headers[h]
    if (v) res.setHeader(h, v)
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(upstreamResp.status)

  // 6. HEAD 直接结束
  if (req.method === 'HEAD') {
    upstreamResp.data?.destroy?.()
    return res.end()
  }

  // 7. 流式管道；客户端断开 → 中止上游
  req.on('close', () => upstreamResp!.data?.destroy?.())
  await pipeline(upstreamResp.data, res).catch((err) => {
    // 不重复写 res（已经在管道中）
    console.warn('[audio-proxy] pipeline error', { msg: err.message, bvid: claims.bvid })
  })
}
```

---

### Step 4：改造 `api/server.ts` 与 `api/index.ts`（双入口同步）

**两个文件的改动 1:1 对齐**（C5）。改动点：

1. **导入新模块**（顶部）：
   ```typescript
   import {
     signAudioProxyToken,
     assertLikelyPublicHttpUrl,
     isUpstreamHostAllowed,
     buildAudioProxyUrl,
     createAudioProxyHandler,
   } from './audio-proxy.ts'
   ```

2. **`requireApiAccess` 放行 `/api/audio-proxy`**（`api/server.ts:42-57`）：
   ```typescript
   if (req.path === '/health' || req.originalUrl === '/api/health') return next()
   if (req.path === '/audio-proxy' || req.originalUrl.startsWith('/api/audio-proxy')) return next()
   ```
   > 安全模型：代理路由用 token 自带身份认证，**不再叠加** `X-App-Password`，因为听悟服务器无法注入此头。

3. **挂载代理路由**（在 `/api/health` 之后）：
   ```typescript
   const audioProxyHandler = createAudioProxyHandler({
     secret: resolveAudioProxyTokenSecret(process.env)!,
     allowedHostRegex: resolveAudioProxyAllowedHosts(process.env),
     upstreamHeaders: getBilibiliHeaders,
   })
   app.get('/api/audio-proxy', audioProxyHandler)
   app.head('/api/audio-proxy', audioProxyHandler)
   ```

4. **改造 `/api/transcription/start`**（`api/server.ts:654-698`）：
   - 拿到 `audio = await getBilibiliDashAudioUrl(...)` 后**不再**直接传 `audio.audioUrl`
   - 检查 `PUBLIC_PROXY_BASE_URL`：
     - 未配置 → `503` `{ error: '服务端未配置 PUBLIC_PROXY_BASE_URL，听悟无法读取音频。请配置公网代理地址（推荐 cloudflared tunnel）。' }`
   - 生成 token：
     ```typescript
     const token = signAudioProxyToken(
       {
         v: 1,
         u: audio.audioUrl,
         srcExp: new Date(audio.expiresAt).getTime(),
         mime: audio.mimeType,
         fn: audio.fileName,
         bvid: audio.bvid,
         cid: String(audio.cid),
       },
       resolveAudioProxyTokenSecret(process.env)!,
       resolveAudioProxyTtlSec(process.env),
     )
     const proxyUrl = buildAudioProxyUrl(resolvePublicProxyBaseUrl(process.env)!, token)
     assertLikelyPublicHttpUrl(proxyUrl)   // 防御：本地 URL 不允许传给 Tingwu
     ```
   - 调用 `createTingwuTask(proxyUrl, ...)` 而不是 `audio.audioUrl`
   - 返回体新增字段：
     ```typescript
     {
       success: true,
       data: {
         taskId,
         audioUrl: audio.audioUrl,           // 保留原直链，仅供前端调试展示
         proxyUrl,                           // ★ 新增，给前端显示
         proxyExpiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
         sourceExpiresAt: audio.expiresAt,
         audioFormat, fileName, bandwidth, source, warning, metaToken,
       }
     }
     ```

5. **`/api/download-video`** 保持不变（仍返回原始 B 站直链），用于排障。

---

### Step 5：前端最小变更（`src/`，gemini 主导）

**目标**：让用户在缺少 `PUBLIC_PROXY_BASE_URL` 时立即知情，并把代理 URL 展示在转写进度面板（便于排障）。

> 待 `/ccg:execute` 阶段精确定位前端文件，下面是组件级契约：

1. **新增 `<ProxyConfigBanner />`**（挂在 App 顶部）：
   - 启动时调用 `GET /api/health-with-config`（轻量端点，新增），返回 `{ status: 'ok', proxyBaseUrlConfigured: boolean, proxyBaseHost?: string }`
   - 若 `proxyBaseUrlConfigured === false`：渲染红色横幅
     ```
     ⚠️ 公网代理地址未配置：通义听悟将无法拉取音频文件。
        请在独立终端运行：cloudflared tunnel --url http://localhost:9091
        然后将生成的 https://*.trycloudflare.com 写入 .env 的 PUBLIC_PROXY_BASE_URL，重启后端。
     ```
   - 若已配置：折叠态，显示 `🟢 代理通道：<host>`（点击展开看完整 URL）
2. **转写进度面板** 增加一个折叠的"调试信息"区块：
   - `audio.audioUrl`（原始 B 站直链，方便手动 curl 验证）
   - `proxyUrl`（让用户能直接 curl 测试代理是否可达）
   - `sourceExpiresAt` / `proxyExpiresAt` 倒计时

3. **后端新增端点 `GET /api/health-with-config`**（在 `api/server.ts` + `api/index.ts`）：
   - 与 `/api/health` 同级，不需要密码
   - 返回：`{ status: 'ok', proxyBaseUrlConfigured: !!resolvePublicProxyBaseUrl(process.env), proxyBaseHost: <host or null> }`
   - **不返回**完整 URL（只透出 host），降低被人扫描枚举的风险

---

### Step 6：测试

**新增 `tests/audio-proxy.test.ts`** — 单元测试：

| 用例 | 断言 |
|------|------|
| `signAudioProxyToken` + `verifyAudioProxyToken` 往返 | `ok === true`，claims 完整 |
| `verifyAudioProxyToken` 篡改 payload | `reason === 'badSig'` |
| `verifyAudioProxyToken` token TTL 过期 | `reason === 'tokenExpired'` |
| `verifyAudioProxyToken` srcExp 过期 | `reason === 'sourceExpired'` |
| `verifyAudioProxyToken` 错误 secret | `reason === 'badSig'` |
| `assertLikelyPublicHttpUrl` 拒绝 `http://localhost:9091` | throw |
| `assertLikelyPublicHttpUrl` 拒绝 `http://127.0.0.1` | throw |
| `assertLikelyPublicHttpUrl` 拒绝 `http://192.168.1.1` | throw |
| `assertLikelyPublicHttpUrl` 接受 `https://abc.trycloudflare.com/...` | 通过 |
| `isUpstreamHostAllowed` 对 `xx.bilivideo.com` 通过；对 `evil.com` 拒绝；对 `evil.bilivideo.com.attacker.io` 拒绝 | 全通过 |
| `buildAudioProxyUrl` 末尾斜杠规范化 | URL 不含 `//api` |

**集成测试草案**（`tests/audio-proxy.integration.test.ts`，可留 v2 实现）：
- 用 `node:http` 起一个 fake 上游，验证：
  - 无 Referer → 403 → 代理映射 502
  - 有 Referer → 206 → 代理透传 206 + Content-Range
  - 302 → 跟跳 → 200
  - HEAD 请求只返回头不返回体
  - 客户端断开 → 上游连接被销毁

**集成验证脚本**（`scripts/verify-audio-proxy.mjs`，可选）：
- 启动后端 → 用本地 axios 模拟 Tingwu，对 `/api/audio-proxy?t=<token>` 发 HEAD 与 GET（带 Range）
- 输出报告：上游状态、Content-Length、首字节延迟、是否流式

**验收命令**（更新 MAINTENANCE.md）：
```bash
npm run check
npm test
```

---

### Step 7：文档更新

1. **[.env.example](/D:/workspeace/bilibili-subtitle/.env.example)** 新增：
   ```
   # ─────────── 音频公网代理（必填，用于让通义听悟回拉 B 站音频）───────────
   # 推荐：用 cloudflared 把本地 9091 暴露成公网地址
   #   cloudflared tunnel --url http://localhost:9091
   # 把命令输出的 https://*.trycloudflare.com 填到下面（不要带末尾斜杠）
   PUBLIC_PROXY_BASE_URL=

   # 代理 token 签名密钥（必填；建议 32 字节随机串，不要复用 META_TOKEN_SECRET）
   AUDIO_PROXY_TOKEN_SECRET=

   # token 有效期（秒，默认 1800，上限 1800）
   AUDIO_PROXY_TOKEN_TTL_SEC=1800

   # 允许代理回源的 host 正则（逗号分隔，留空使用内置 B 站 CDN 列表）
   AUDIO_PROXY_ALLOWED_HOSTS=
   ```

2. **[MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md)** 增加章节：
   - "公网音频代理：cloudflared tunnel 启动手册"（首次安装 / 启动 / 配置 / 验证 / 停止）
   - 在"当前剩余联调步骤"前置 Tunnel 启动步骤
   - 在"重复问题记录"新增 002：B 站音频需 Referer，听悟无法注入头部 → 必须经由本地代理 + 公网 Tunnel

3. **[DEPLOYMENT.md](/D:/workspeace/bilibili-subtitle/DEPLOYMENT.md)** 增加段落：
   - 当部署在 Vercel 上时，`PUBLIC_PROXY_BASE_URL` 应指向**部署本身的域名**（`https://your-project.vercel.app`），让代理路由复用 Vercel 函数
   - **重要免责声明**：Vercel `maxDuration:300` 可能截断 > 5 分钟音频流；如果实测频繁失败，请切换到 Cloudflare Tunnel 主方案

4. **[PROJECT_STATUS.md](/D:/workspeace/bilibili-subtitle/PROJECT_STATUS.md)** 更新：完成项追加；未完成项收敛到"端到端联调（步骤 6-8）"

---

## 4. 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `api/audio-proxy.ts` | **新增**（约 200 行） | 核心模块：签名 / 验证 / host 白名单 / 代理 handler / URL 构造 |
| `api/dev-config.ts` | 修改（+4 个 resolver） | 新增配置解析函数 |
| `api/server.ts` | 修改（L42-57 放行；L654-698 改造 start；新增路由 + health-with-config） | 本地后端入口 |
| `api/index.ts` | 修改（与 server.ts 1:1 对齐） | Vercel 入口 |
| `api/tingwu-task.ts` | 修改（轻微，可选） | `createTingwuTask` 内增加 `assertLikelyPublicHttpUrl` 校验，二次防御 |
| `tests/audio-proxy.test.ts` | **新增** | 11 条单元用例 |
| `tests/audio-proxy.integration.test.ts` | **新增**（可后置） | 集成测试 |
| `package.json` | 修改 `scripts.test` | 显式列出 `*.test.ts`，绕开 PowerShell glob 引入 `.py` 的问题 |
| `.env.example` | 追加 4 个变量 | 配置示例 |
| `MAINTENANCE.md` | 追加 cloudflared runbook + 重复问题记录 002 | 运维手册 |
| `DEPLOYMENT.md` | 追加 PUBLIC_PROXY_BASE_URL 说明 + maxDuration 提示 | 部署文档 |
| `PROJECT_STATUS.md` | 状态收敛 | 进度同步 |
| `src/` 前端 | 新增 `<ProxyConfigBanner />`、调试信息折叠区 | 前端 UX |
| `scripts/verify-audio-proxy.mjs` | 可选 | 联调辅助 |

---

## 5. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|------|------|------|------|
| R1 | Cloudflare Tunnel 在 cn-beijing 被偶发阻断 | 中 | 任务失败 | 错误日志带 `upstream_forbidden`/`pipeline_aborted` 标记；后备方案 OSS 入口预留 |
| R2 | B 站 302 到 CDN，CDN 仍校验 Referer | 高 | 整链路失败 | **代理手动跟跳**（`maxRedirects: 0` + 自实现循环），每跳重注 Referer |
| R3 | 上游响应是大文件（> 100MB），代理误用 buffering 撑爆内存 | 中 | OOM | 强制 `responseType: 'stream'` + `pipeline`；不允许 `arrayBuffer` |
| R4 | token 泄露被外部回放 → 开放音频代理 | 低 | 滥用流量 | 短 TTL（≤30 分钟）+ host 白名单 + token 内嵌固定 URL，外部无法替换上游 |
| R5 | B 站源 URL 110 分钟过期，听悟拉取时已失效 | 中 | 任务失败 | `claims.srcExp` 内嵌过期时间，代理直接 `410`；前端 UI 显示倒计时 |
| R6 | 用户忘记启动 cloudflared，生成的 PUBLIC_PROXY_BASE_URL 失效 | 高 | 任务失败 | `<ProxyConfigBanner />` 启动检查；`/start` 内对 PUBLIC_PROXY_BASE_URL 缺失/无效返回明确文案 |
| R7 | Vercel 部署的 `api/index.ts` 未同步改造 | 高 | 线上仍坏 | 计划已显式列出 `api/index.ts` 同步项；review 时双文件对比 diff |
| R8 | 测试命令 `tests/**` 在 PowerShell 下展开失败 | 已发生 | 测试基线坏 | Step 1 显式列出 `*.test.ts` |
| R9 | 听悟可能首先发 HEAD 探测，代理只支持 GET | 中 | 任务失败 | 路由同时挂 `app.get` 和 `app.head` |
| R10 | 代理 URL 被中间层（CDN / 浏览器）缓存 | 低 | 旧 token 错误响应 | `Cache-Control: private, no-store` |

---

## 6. 验收标准

**功能验收**（按 [MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md) 步骤 4-8）：

- [ ] 步骤 4：`/api/download-video` `success=true`
- [ ] 步骤 5：`/api/transcription/start` 返回 `data.proxyUrl`，且 `data.proxyUrl.startsWith('https://')`
- [ ] **新增**：手动 `curl -I "$proxyUrl"` 应返回 `200 OK` 或 `206 Partial Content` + `Content-Type: audio/mp4`（验证代理已能正确补 Referer）
- [ ] 步骤 6：`/api/transcription/status` 最终为 `COMPLETED`（≤ 30 分钟内）
- [ ] 步骤 7：下载 `.docx` 成功，文件 > 0
- [ ] **新增**：下载 `.txt` 成功
- [ ] 步骤 8：Word / WPS 可正常打开 `.docx`

**质量验收**：

- [ ] `npm run check` 通过
- [ ] `npm test` 通过（含 audio-proxy 11 个单元用例）
- [ ] `npm run lint` 无错误（如已配置）
- [ ] `api/server.ts` 与 `api/index.ts` diff 显示 audio-proxy 相关改动 1:1 对齐
- [ ] `.env.example` 示例完整，无空字段说明缺失
- [ ] MAINTENANCE.md 的 cloudflared 启动手册可被一个新人独立执行成功

---

## 7. 执行边界

- ❌ 不实现 Aliyun OSS 后备方案（留给 v2）
- ❌ 不引入新的 npm 包（复用 `axios` / `crypto` / `express`）
- ❌ 不修改 `vercel.json`（保持现有 `maxDuration:300`，由文档警告承担兜底）
- ❌ 不修改 `getBilibiliDashAudioUrl` 的返回结构（仅消费方改造）
- ❌ 不增加 Redis / 数据库（token 是无状态 HMAC，不需要服务端 nonce 表）
- ✅ 允许新增极少量前端组件，但不改动现有路由 / 状态管理结构
- ✅ 测试基线修复独立成 commit，便于回滚

---

## 8. SESSION_ID（供 `/ccg:execute` 使用）

- **CODEX_SESSION**: `019e1bf7-e998-7eb2-972e-3fee15ea6661`
- **GEMINI_SESSION**: `4c53e7b3-7640-4212-99eb-0544f53d9726`

---

## 9. 后续步骤

- 若主方案上线 7 天内出现 ≥3 次 `upstream_forbidden` / 隧道阻断 → 启动 v2（OSS 后备）
- 若实际任务音频 P95 > 5 分钟 → 评估迁移到 Cloudflare Tunnel + 自建中转服务（避开 trycloudflare 共享后端）
