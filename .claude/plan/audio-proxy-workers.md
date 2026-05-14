# 实施计划：方案 P1 — Cloudflare Workers 重写 audio-proxy

> 版本：v1（2026-05-14）
> 主分支：`main`
> 关联：[.claude/plan/audio-proxy.md](./audio-proxy.md) 的方案 §2.1 决策矩阵；本计划取代其中 §2.2 "Cloudflare Tunnel" 主方案的最终落地形式。
> 触发证据：[logs/2026-05-13-2309-vercel.log](../../logs/2026-05-13-2309-vercel.log)、[logs/2026-05-14-0000-vercel.log](../../logs/2026-05-14-0000-vercel.log)、[logs/2026-05-14-0011-vercel.log](../../logs/2026-05-14-0011-vercel.log)

---

## 0. 决策路径与变更说明

### 0.1 触发与诊断结论

- Vercel 端 `/api/audio-proxy` 代码无 bug（ESM 修复已上线、自检 401/204 全通），但**听悟 cn-beijing 在 CreateTask 后 ~3 秒内即报 `TSC.AudioFileLink (Audio file link invalid)`**，Vercel 日志中**完全没有 audio-proxy 路径的命中**。
- 结论：听悟在 CreateTask 阶段做 FileUrl 同步预检（DNS + TCP 探测），探测到 `bilibili-subtitle-theta.vercel.app` 在 cn-beijing 阿里云出口不可达 / 跨境抖动，**根本未发起音频拉取**。
- 这与 [.claude/plan/audio-proxy.md §2.1](./audio-proxy.md) 决策矩阵的预先警告"Vercel 跨境，常被 GFW 限速/阻断"完全吻合。

### 0.2 用户约束（决定方案选择）

| # | 约束 | 排除的候选 |
|---|------|----------|
| U1 | 必须全免费（无年费、无绑卡） | Cloudflare Registrar 域名（¥80/年）、Vercel Pro |
| U2 | 不接受本机长期运行 backend / tunnel | Cloudflare Tunnel + 本机 :9091（原计划主方案）、trycloudflare 临时域 |
| U3 | 必须支持 2-3 小时长音频转写 | Vercel maxDuration:300 端到端中转、OSS/R2 在 Vercel 上做下载-上传中转 |
| U4 | 倾向 CF 生态（已有 CF 托管的免费 DDNS 子域） | 阿里云 FC（要实名 + 绑卡，留作 P2 备选） |

### 0.3 为何先用 `*.workers.dev` 默认子域

用户提供的三个候选域名 `brynn.dpdns.org` / `qbq.qzz.io` / `bbq08.ip-ddns.com` 经 NS 查询确认：

| 父域 | 权威 NS | 能否在 CF 加 zone |
|------|--------|------------------|
| dpdns.org | ns1/ns2/ns3.dpdns.org | ❌ DDNS 服务商自管 NS |
| qzz.io | ns1/ns2/ns3.qzz.io | ❌ DDNS 服务商自管 NS |
| ip-ddns.com | ns61-64.cloudns.* | ❌ ClouDNS 自管 NS |

虽然 A/AAAA 解析到 CF 段 IP（`2606:4700::/32`），但这是 DDNS 服务商内部代理到 CF 边缘的 SaaS 模式，**用户对 zone 无控制权**，无法在 CF Dashboard 把这些 hostname 配为 Workers Custom Domain（CF 会返回 1014）。

零成本路径只剩：**Workers 自动获得的 `<worker-name>.<account-subdomain>.workers.dev` 默认子域**。

### 0.4 已知风险与回退预案

- ⚠️ **`workers.dev` 在大陆普通访问层被 GFW 关键词屏蔽**；但听悟 cn-beijing 是阿里云出口（IDC 国际线路），与普通宽带出口路径不同，**有可能**能到达 workers.dev 边缘。**这是本计划的核心假设，需通过 §5.3 实测验证。**
- 若实测失败，按 §9 切到路径②（买根域绑 CF）或路径③（阿里云 FC）。

---

## 1. 硬约束

| # | 约束 | 来源 |
|---|------|------|
| C1 | Workers 免费 plan：100,000 req/天、CPU 10 ms/req、subrequest ≤ 50/req、response body 无大小限制可流式 | [CF Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| C2 | Workers Runtime 是 Web 标准 API，**没有** `node:crypto` / `node:dns` / `node:net` / `axios` / `express` | CF Workers 文档 |
| C3 | Workers 无法控制 DNS 解析后的 IP，因此 SSRF 防护必须降级到 **hostname 正则白名单**，不再做"DNS 解析后查私网 IP" | Workers Runtime 限制 |
| C4 | HMAC 必须用 Web Crypto API（`crypto.subtle`），与 Node `crypto.createHmac('sha256')` **字节级一致** —— 同一 secret + payload 输出相同 base64url | RFC 2104 兼容性 |
| C5 | Vercel 上的 `AUDIO_PROXY_TOKEN_SECRET` 与 Worker secrets 必须**完全相同**（Vercel 签 Worker 验） | 共享密钥要求 |
| C6 | Vercel 端继续承担前端、`createTingwuTask`、`status`、`download` 等业务路由，**仅 `/api/audio-proxy` 路由迁出**到 Worker | 减少改造面 |
| C7 | Worker 代码必须保持与 Node 版 audio-proxy 同等的语义：token 验证 / host 白名单 / 手动跟跳 + Referer 注入 / Range 透传 / HEAD 支持 | 行为一致性，避免出现 Node 版能跑而 Worker 版断流 |
| C8 | wrangler CLI（`@cloudflare/workers-types` + `wrangler`）作为开发/部署依赖，**仅放在 `workers/audio-proxy/` 子工程**，不污染主 `package.json` | 项目结构清洁 |

---

## 2. 架构与数据流

### 2.1 改造前（已知失败）

```
[浏览器] → Vercel 前端 → Vercel API (/api/transcription/start)
                                       │ buildAudioProxyUrl: https://bilibili-subtitle-theta.vercel.app/api/audio-proxy?t=<token>
                                       ▼
                         createTingwuTask → 听悟 cn-beijing
                                                ❌ 预检 vercel.app 不通 → TSC.AudioFileLink
```

### 2.2 改造后（本计划目标）

```
[浏览器] → Vercel 前端 → Vercel API (/api/transcription/start)
                                       │ buildAudioProxyUrl: https://<worker-name>.<account>.workers.dev/?t=<token>
                                       ▼
                         createTingwuTask(fileUrl=worker URL) → 听悟 cn-beijing
                                                                 │ 同步预检 + 实际拉取
                                                                 ▼
                                                CF 边缘 → [Worker: audio-proxy]
                                                                 │ 1. verify HMAC token (Web Crypto)
                                                                 │ 2. host 白名单 (regex)
                                                                 │ 3. 手动跟跳 ≤ 5 跳，每跳注入 Referer/UA
                                                                 │ 4. 流式 ReadableStream pipe 回 Tingwu
                                                                 ▼
                                                          [B 站 CDN: *.bilivideo.com / akamaized.net]
```

### 2.3 路由分工

| 路由 | 承载方 | 备注 |
|------|------|------|
| 前端 `/` `/login` `/transcribe` 等 | Vercel 前端 | 不变 |
| `/api/health` `/api/health-with-config` `/api/auth-check` | Vercel | 不变 |
| `/api/transcription/start` `/status` `/download/*` | Vercel | 仅 `buildAudioProxyUrl` 切到 worker URL |
| `/api/audio-proxy` (Vercel) | **保留作 503 占位**，不再被 createTingwuTask 引用 | 给未配置 worker URL 时回退报错 |
| `*.workers.dev/?t=<token>` | **Worker** | 唯一被听悟拉取的端点 |

---

## 3. 实施步骤

### Step 1 — 创建 Worker 子工程

**新建目录**：`workers/audio-proxy/`

**文件清单**：

| 文件 | 用途 |
|------|------|
| `workers/audio-proxy/wrangler.toml` | wrangler 配置（Worker 名、入口、兼容性日期） |
| `workers/audio-proxy/package.json` | wrangler + `@cloudflare/workers-types` |
| `workers/audio-proxy/tsconfig.json` | Workers Runtime TS 配置（lib=`webworker`） |
| `workers/audio-proxy/src/index.ts` | Worker 入口（fetch handler） |
| `workers/audio-proxy/src/token.ts` | Web Crypto HMAC 签名/验证 |
| `workers/audio-proxy/src/proxy.ts` | 手动跟跳 + 流式响应 |
| `workers/audio-proxy/src/config.ts` | host 白名单 + 上游 header 常量 |
| `workers/audio-proxy/.gitignore` | `.wrangler/`、`node_modules/` |
| `workers/audio-proxy/README.md` | 部署/secret 配置说明 |

**wrangler.toml 最小配置**：
```toml
name = "bilibili-audio-proxy"
main = "src/index.ts"
compatibility_date = "2025-05-14"
compatibility_flags = ["nodejs_compat_v2"]

# 默认绑定 *.workers.dev；自定义域名通过 Dashboard 后续添加
workers_dev = true
```

> 不在 `wrangler.toml` 里放任何 secret —— 用 `wrangler secret put` 注入。

### Step 2 — 实现 token 验证（Web Crypto 版）

**与 Node 版的兼容矩阵**：

| 操作 | Node (`api/audio-proxy.ts`) | Worker (`workers/audio-proxy/src/token.ts`) | 输出兼容 |
|------|----------------------------|----------------------------------------------|---------|
| HMAC-SHA256 | `crypto.createHmac('sha256', secret).update(payload).digest('base64url')` | `crypto.subtle.importKey('raw', utf8(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign'])` → `sign('HMAC', key, utf8(payload))` → `bufferToBase64Url(arrayBuffer)` | ✅ 字节一致（RFC 2104） |
| base64url decode | `Buffer.from(s, 'base64url')` | 自实现：`base64url → base64 → atob → Uint8Array` | ✅ |
| base64url encode | `Buffer.from(buf).toString('base64url')` | 自实现：`Uint8Array → btoa(String.fromCharCode(...))` → `replace +/= → -_/<empty>` | ✅ |
| timingSafeEqual | `crypto.timingSafeEqual(a, b)` | 自实现：常量时间比较字符 charCode XOR 累积 | ✅ 等价 |
| utf8 编码 | `Buffer.from(s, 'utf8')` | `new TextEncoder().encode(s)` | ✅ |

**token.ts 导出契约**：
```ts
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
  | { ok: false; reason: 'missing' | 'malformed' | 'badSig' | 'tokenExpired' | 'sourceExpired' }

export async function verifyAudioProxyToken(
  token: string,
  secret: string,
  nowSec?: number,
): Promise<VerifyResult>
```

> 注意：Worker 版是 `async`（Web Crypto 全异步），Node 版是同步。前者会向调用方多一层 `await`。

### Step 3 — 实现流式代理（fetch + ReadableStream）

**proxy.ts 导出契约**：
```ts
export interface ProxyDeps {
  allowedHostRegex: RegExp[]
  upstreamHeaders: () => Record<string, string>   // 返回 Referer/UA 等
  maxRedirects?: number   // 默认 5
}

export async function streamUpstream(
  request: Request,
  upstreamUrl: string,
  deps: ProxyDeps,
): Promise<Response>
```

**核心逻辑**：
1. `fetch(currentUrl, { method, redirect: 'manual', headers: 注入 Referer/UA/Range/If-Range })`
2. 若 `status` ∈ [300, 400) 且有 `Location`：
   - `next = new URL(location, currentUrl).toString()`
   - hostname 白名单检查；不通过返回 `502 redirect_host_not_allowed`
   - `currentUrl = next; continue`
3. 状态码映射（与 Node 版一致）：
   - `403` → `502 upstream_forbidden`
   - `404` → `502 upstream_not_found`
   - 非 `[200, 206]` → `502 unexpected_status`
4. 头透传白名单：`content-type` / `content-length` / `content-range` / `accept-ranges` / `etag` / `last-modified`
5. 加 `cache-control: private, no-store`
6. HEAD → `return new Response(null, ...)`（关闭 upstream body）
7. GET → `return new Response(upstream.body, { status, headers })` —— CF 自动 pipe

**与 Node 版的差异**：

| 项 | Node | Worker | 影响 |
|----|------|--------|------|
| DNS 解析后查私网 IP | ✅ `dnsPromises.lookup` + `BlockList` | ❌ 删除 | SSRF 防护仅靠 hostname 白名单（regex 已经够严，allowed list 全部是 B 站 CDN） |
| 限流（per-token / global concurrent / bytes / duration） | ✅ `AudioProxyRateLimiter` | ⏸ 第一版**不实现** | 单 Worker 实例无共享状态；如需可后续接 KV / Durable Objects |
| pipeline 错误回调 | ✅ console.warn | ✅ try/catch + `event.waitUntil` log | 等价 |
| request 取消 → 销毁 upstream | ✅ `req.on('close')` | ✅ `request.signal` + `AbortController` | 等价 |
| 字节计数 / 提前中断 | ✅ `PassThrough` | ⏸ 第一版不实现 | 短期内只有听悟一个用户，风险可接受 |

### Step 4 — Worker 入口与配置

**src/index.ts 骨架**：
```ts
import { verifyAudioProxyToken } from './token'
import { streamUpstream } from './proxy'
import { DEFAULT_ALLOWED_HOST_PATTERNS, BILIBILI_HEADERS } from './config'

export interface Env {
  AUDIO_PROXY_TOKEN_SECRET: string
  ALLOWED_HOSTS?: string   // 可选覆盖默认正则列表
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // 健康检查
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 })
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'application/json' },
      })
    }

    const token = url.searchParams.get('t') ?? ''
    const verified = await verifyAudioProxyToken(token, env.AUDIO_PROXY_TOKEN_SECRET)
    if (!verified.ok) {
      const status = verified.reason === 'tokenExpired' || verified.reason === 'sourceExpired' ? 410 : 401
      return new Response(JSON.stringify({ error: verified.reason }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }

    const allowedHosts = (env.ALLOWED_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_ALLOWED_HOST_PATTERNS).map(p => new RegExp(p, 'i'))

    return await streamUpstream(request, verified.claims.u, {
      allowedHostRegex: allowedHosts,
      upstreamHeaders: () => BILIBILI_HEADERS,
    })
  },
} satisfies ExportedHandler<Env>
```

**src/config.ts**（与 `api/dev-config.ts:6-12` 完全一致，避免漂移）：
```ts
export const DEFAULT_ALLOWED_HOST_PATTERNS = [
  '^[a-z0-9-]+\\.bilivideo\\.com$',
  '^[a-z0-9-]+\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.mcdn\\.bilivideo\\.cn$',
  '^[a-z0-9-]+\\.akamaized\\.net$',
  '^upos-[a-z0-9-]+\\.(bilivideo|akamaized)\\.(com|cn|net)$',
] as const

export const BILIBILI_HEADERS = {
  'Referer': 'https://www.bilibili.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://www.bilibili.com',
}
```

### Step 5 — 部署 Worker

**前置**：
- 已有 Cloudflare 账号
- 本机能跑 `npx wrangler`

**命令序列**（用户执行；本机仅运行一次性 CLI，不需要长期 daemon）：

```bash
cd workers/audio-proxy
npm install
npx wrangler login                                     # 浏览器授权一次
npx wrangler secret put AUDIO_PROXY_TOKEN_SECRET       # 粘贴与 Vercel 同一个 secret
npx wrangler deploy
# 输出形如：https://bilibili-audio-proxy.<account-subdomain>.workers.dev
```

部署后**记下 worker URL**（用于 Step 6）。

### Step 6 — 修改 Vercel 端

**操作**：
1. Vercel Dashboard → Project `bilibili-subtitle-theta` → Settings → Environment Variables
2. 修改 `PUBLIC_PROXY_BASE_URL`：
   - 旧值：`https://bilibili-subtitle-theta.vercel.app`
   - 新值：`https://bilibili-audio-proxy.<account-subdomain>.workers.dev`
   - **不要带末尾斜杠**
3. 保持 `AUDIO_PROXY_TOKEN_SECRET` 与 Worker 中 secret 完全一致
4. 触发 Vercel 重新部署（环境变量改了不会自动 redeploy）

**代码变更（仅一行）**：

`api/audio-proxy.ts` 的 [`buildAudioProxyUrl`](../../api/audio-proxy.ts) 当前实现：
```ts
export function buildAudioProxyUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/audio-proxy?t=${encodeURIComponent(token)}`
}
```

**问题**：Worker 的入口是根路径 `/`，不是 `/api/audio-proxy`。

**修复**：根据 `baseUrl` 自动判断目标形态。两种选项：

**选项 A（推荐）**：让 Worker 的入口路径与 Vercel 端对齐，**都用 `/api/audio-proxy`**
- Worker 内部判断 `if (url.pathname !== '/api/audio-proxy' && url.pathname !== '/health') return 404`
- `buildAudioProxyUrl` 保持不变
- 优势：单一 URL 形态，前端展示和后端拼接都不用判断 base

**选项 B**：Worker 用 `/`，`buildAudioProxyUrl` 多一个 path 参数
- 改动面更大，不推荐

→ **采纳选项 A**。Worker 入口检查放在 §Step 4 的代码 `if (url.pathname === '/health') return ok; if (url.pathname !== '/api/audio-proxy') return 404; ...` 即可。

### Step 7 — 删除/降级 Vercel 端的 `/api/audio-proxy` 路由

**目标**：避免歧义 —— Vercel 端的 `/api/audio-proxy` 路由不再被 createTingwuTask 引用，但保留路由本身作为**配置错误时的 fallback 报错入口**。

**改法**（`api/index.ts` 和 `api/server.ts` 同步）：
- 保留 `app.get('/api/audio-proxy', audioProxyHandler)`
- 但 `audioProxyHandler` 现在依然能工作（不破坏向后兼容） —— 实际上**根本不应被听悟命中**，因为 `PUBLIC_PROXY_BASE_URL` 已切到 worker URL

这一步本质是"什么都不做" —— 让 Vercel 端代码保持现状作为兜底。

> 安全考虑：Vercel 端 audio-proxy 仍持有同一个 secret，仍可验 token 并代理。但既然 `PUBLIC_PROXY_BASE_URL` 已经指向 worker，所有正常签发的 token 内嵌的 URL 都指向 worker 自己。Vercel 端这条路径**事实上死代码**，但留着方便排障。

### Step 8 — 同步代码到 git（与 push）

提交清单：
- `workers/audio-proxy/` 整套新文件
- `.gitignore` 顶层加 `workers/audio-proxy/.wrangler/` `workers/audio-proxy/node_modules/`
- `MAINTENANCE.md` 增章节"音频代理 Worker 部署"
- `.env.example` 顶部追加注释：`PUBLIC_PROXY_BASE_URL 现在应指向 Cloudflare Worker URL`
- 本计划文件本身

提交说明：
```
feat(audio-proxy): 迁移音频代理到 Cloudflare Workers (P1)

听悟 cn-beijing 同步预检无法到达 vercel.app，原 Vercel 端代理
失败（详见 logs/2026-05-14-0011-vercel.log）。

新增 workers/audio-proxy 子工程，使用 Web Crypto + Fetch +
ReadableStream 重写代理逻辑。Vercel 后端通过 PUBLIC_PROXY_BASE_URL
环境变量切换指向 Worker URL，不再改动 createTingwuTask 等业务路由。

回退：保留 Vercel 端 /api/audio-proxy 兼容路由作为兜底。
```

---

## 4. 代码契约（行为级，用于跨平台一致性）

### 4.1 token 字节级兼容性

**测试用例**（必须在 §5 阶段实测，确保 Node 端与 Worker 端互通）：

```
secret = "test-secret-32-bytes-random"
claims = { v:1, u:"https://upos-sz-mirrorakam.akamaized.net/abc.m4s",
           iat:1715000000, exp:1715001800, srcExp:1715006600000,
           mime:"audio/mp4", fn:"a.m4a", bvid:"BV1xxx", cid:"123" }
```

- Node 端 `signAudioProxyToken(claims, secret, 1800, 1715000000)` 输出 `tokenA`
- Worker 端 `verifyAudioProxyToken(tokenA, secret, 1715000500)` 必须返回 `{ ok: true, claims: <equal> }`

### 4.2 状态码契约（Worker 必须复现）

| 输入 | 输出 status | body |
|------|------------|------|
| 无 token / token 空 | 401 | `{"error":"missing"}` |
| token 字段缺失 | 401 | `{"error":"malformed"}` |
| 签名错 | 401 | `{"error":"badSig"}` |
| token 过期 | 410 | `{"error":"tokenExpired"}` |
| srcExp 已过 | 410 | `{"error":"sourceExpired"}` |
| hostname 不在白名单 | 403 | `{"error":"host_not_allowed"}` |
| 上游 403 | 502 | `{"error":"upstream_forbidden"}` |
| 上游 404 | 502 | `{"error":"upstream_not_found"}` |
| 跟跳后 hostname 不在白名单 | 502 | `{"error":"redirect_host_not_allowed"}` |
| 跳 > 5 次 | 502 | `{"error":"too_many_redirects"}` |
| 上游其他状态 | 502 | `{"error":"unexpected_status","status":N}` |
| 上游 200/206 | 200/206 | 流式音频 + 透传 headers |

### 4.3 必须透传的上游 headers

`content-type` `content-length` `content-range` `accept-ranges` `etag` `last-modified`

外加 worker 自加：`cache-control: private, no-store`

### 4.4 上游请求 headers（必须发的）

- `Referer: https://www.bilibili.com`
- `User-Agent`: 与 `api/server.ts` `getBilibiliHeaders()` 同一字符串
- `Origin: https://www.bilibili.com`
- `Accept-Encoding: identity`（**关键，禁止 gzip**，否则 Range 失效）
- 透传 `Range` / `If-Range`（如客户端有发）

---

## 5. 测试与验证

### 5.1 本地 wrangler dev 测试（端口 8787）

```bash
cd workers/audio-proxy
npx wrangler dev --local
```

**手工测试用例**：
```bash
# 1. 健康检查
curl http://localhost:8787/health
# 期望：200 ok

# 2. 无 token
curl -i http://localhost:8787/api/audio-proxy
# 期望：401 {"error":"missing"}

# 3. 假 token
curl -i "http://localhost:8787/api/audio-proxy?t=abc.def"
# 期望：401 {"error":"badSig"} 或 malformed

# 4. 错误方法
curl -i -X POST http://localhost:8787/api/audio-proxy
# 期望：405 + Allow: GET, HEAD
```

### 5.2 Node ↔ Worker token 互通测试

写一个临时脚本：本机起 Node 后端用 `signAudioProxyToken` 生成 token → wrangler dev Worker 收到后用 `verifyAudioProxyToken` 解 → 比对 claims 字段。

**测试在 `workers/audio-proxy/test/cross-platform.test.ts`**（用 vitest 或 `node:test`）。

### 5.3 ⭐ 核心实测：听悟 cn-beijing → workers.dev 可达性

**测试流程**：
1. Worker 部署到 prod（拿到 `https://bilibili-audio-proxy.<sub>.workers.dev`）
2. Vercel 切 `PUBLIC_PROXY_BASE_URL` + 重新部署
3. 浏览器登录前端，输入**一个短视频**（推荐 1-3 分钟，便于快速验证）
4. 点开始转写，**同步**观察：
   - Vercel 日志：`/api/transcription/start` 应 200，返回 taskId
   - CF Dashboard → Workers → bilibili-audio-proxy → Real-time Logs：**关键观察点**
     - 是否有非自己浏览器的 IP 命中？（听悟应该在任务创建后 ~1-5 秒内打过来）
     - 命中的 status 是 200/206 / 401 / 502 / 还是没命中？
5. 等待 `/api/transcription/status` 返回 `COMPLETED` 或 `FAILED + ErrorMessage`

**判读规则**：

| Worker 实时日志命中情况 | 听悟最终状态 | 结论与下一步 |
|------------------------|------------|------------|
| 有命中，status=200/206，转写成功 | COMPLETED | 🎉 P1 完成；进入 §5.4 长音频压测 |
| 有命中，status=200，但听悟报 invalid | FAILED | 协议层问题（如 Content-Type 错、流截断）；查 Worker 日志细化 |
| 有命中，status=401/410 | FAILED | token 签名/验证不一致；查 §4.1 字节级 |
| 有命中，status=502 | FAILED | 上游问题（host 白名单 / B 站 403）；查 §4.2 错误 reason |
| **完全无命中** | FAILED `Audio file link invalid` | 听悟到 workers.dev 仍不通；**触发 §9 回退路径②或③** |

### 5.4 长音频压测（仅在 §5.3 通过后）

1. 选一个 2.5-3 小时的 B 站视频
2. 启动转写，记录：
   - Worker 单次请求 wall clock 时长
   - Worker CPU time 累计（CF Dashboard 显示）
   - 流量出口字节
3. 验收：转写完成，文本完整，Worker 无 OOM / 无超时报错

### 5.5 失败任务的回归保护

在 `tests/audio-proxy-worker.regression.test.ts` 中固化：
- token 字节级 fixture（一份 known-good token + secret）
- 各状态码 → reason 的映射

---

## 6. 文件清单

| 文件 | 操作 | 行数估算 |
|------|------|--------|
| `workers/audio-proxy/src/index.ts` | 新增 | 60 |
| `workers/audio-proxy/src/token.ts` | 新增 | 110 |
| `workers/audio-proxy/src/proxy.ts` | 新增 | 130 |
| `workers/audio-proxy/src/config.ts` | 新增 | 15 |
| `workers/audio-proxy/wrangler.toml` | 新增 | 10 |
| `workers/audio-proxy/package.json` | 新增 | 20 |
| `workers/audio-proxy/tsconfig.json` | 新增 | 15 |
| `workers/audio-proxy/.gitignore` | 新增 | 3 |
| `workers/audio-proxy/README.md` | 新增 | 50 |
| `workers/audio-proxy/test/cross-platform.test.ts` | 新增 | 80 |
| `.gitignore`（顶层） | 追加 | +2 |
| `MAINTENANCE.md` | 追加 Worker 部署章节 | +30 |
| `.env.example` | 注释更新 | +3 |
| `.claude/plan/audio-proxy-workers.md` | **本计划文件** | — |

**预计总新增代码** ~480 行（不含计划/文档）。

---

## 7. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|------|------|------|------|
| R1 | **`workers.dev` 听悟仍拉不通** | 中 | P1 失败 | §9 回退：路径②（买根域 + CF zone）或路径③（阿里云 FC） |
| R2 | Web Crypto HMAC 输出与 Node 不一致（base64url 实现细节） | 低 | token 互验失败 | §4.1 字节级测试 + Vitest fixture |
| R3 | Worker 免费 plan 超额（10w req/天） | 低 | 后续请求失败 | 短期内只有听悟单源；CF Dashboard 配额报警 |
| R4 | 长音频期间 Worker 被 CF 中断 / wall clock 限制 | 低 | 音频流截断 → invalid | §5.4 实测；若中断，分片处理（v2） |
| R5 | B 站 CDN 跳转到新域，**不在白名单**（如新 mirror） | 中 | 502 redirect_host_not_allowed | 监控 Worker 502 日志；`ALLOWED_HOSTS` 环境变量可热更不需要重发布 |
| R6 | Vercel 与 Worker 的 `AUDIO_PROXY_TOKEN_SECRET` 错配 | 中 | 全部 401 badSig | 部署 checklist 强制核对；增加 `/api/health-with-config` 也透出 secret 的 hash 前 8 位 |
| R7 | Worker 部署后 Vercel 忘记 redeploy | 高 | 配置不生效 | 部署文档明确"改环境变量后必须 Redeploy" |
| R8 | `nodejs_compat_v2` 兼容性边界（部分 Node API 还是 stub） | 低 | 代码报错 | 仅用 Web 标准 API，**不依赖** nodejs_compat |
| R9 | 听悟实际拉取行为可能发 HEAD 探测，Worker 返回 200 但 body 关掉 | 低 | 探测失败 | Worker HEAD 路径已实现透传，与 Node 版一致 |

---

## 8. 验收标准

### 8.1 功能验收

- [ ] §5.1 wrangler dev 本地测试 4 个用例全通过
- [ ] §5.2 Node ↔ Worker token 互通测试通过
- [ ] §5.3 短视频（1-3 分钟）转写**端到端成功**
  - Worker 日志可见听悟来源命中
  - `/api/transcription/status` 最终 `COMPLETED`
  - 下载的 `.txt` / `.docx` 内容非空且与音频内容大致符合
- [ ] §5.4 长音频（2-3 小时）转写**端到端成功**
- [ ] Worker CF Dashboard 显示 0 个 5xx 错误（除人为构造的负面测试）

### 8.2 质量验收

- [ ] `npm run check` 在主工程通过
- [ ] `workers/audio-proxy && npm run check` 通过
- [ ] `workers/audio-proxy && npx wrangler deploy --dry-run` 通过
- [ ] `git status` 显示工作树干净（除部署后的 secret 提示）
- [ ] `MAINTENANCE.md` 新章节里的步骤可被一个新人独立执行

### 8.3 文档验收

- [ ] `workers/audio-proxy/README.md` 包含：依赖安装、wrangler login、secret 设置、deploy、本地 dev、回滚
- [ ] `.env.example` 注释引导用户把 `PUBLIC_PROXY_BASE_URL` 设到 worker URL
- [ ] 本计划文件 §0 / §9 的链路图与实际部署一致

---

## 9. 失败回退路径

按 §5.3 实测结果分流：

### 9.1 若 Worker 命中但 401/410/502

- 与 P1 实施无关，是协议层 bug。在 P1 范围内修复，不切方案。

### 9.2 若 Worker **完全无命中**（与 Vercel 一样）

证明听悟 cn-beijing → workers.dev 也不通。三个备选：

| 选项 | 改动 | 何时选 |
|------|------|------|
| **路径②**：Cloudflare Registrar 注册 `.xyz`（~¥6/年）或 `.com`（~¥80/年），改 NS 到 CF，在 CF 加 Worker Custom Domain | 仅环境变量 `PUBLIC_PROXY_BASE_URL` 切到新域名 | 用户接受小额年费 |
| **路径③**：把 audio-proxy 部署到阿里云函数计算 FC cn-beijing，用 `*.fcapp.run` 域名 | 重写 Worker 为 FC handler（Node Runtime，复用 90% `api/audio-proxy.ts`）；改 `PUBLIC_PROXY_BASE_URL` | 用户接受阿里云实名+绑卡 |
| 暂停 | 等待用户决策 | 都不接受时 |

### 9.3 若听悟报 `Audio file link invalid` 但 Worker 实际成功 200

罕见情况，可能是听悟内部白名单 / TLS / 证书校验。先查听悟错误码细化（联系阿里云客服或测试不同视频）。

---

## 10. 后续步骤（v2 范畴）

- 加 KV / Durable Objects 实现 per-token 限流（仅当多人使用时必要）
- Worker 端日志聚合到 CF Logpush（便于排障）
- 用 GitHub Actions 自动部署 Worker（`wrangler deploy` 在 PR merge 后自动跑）
- 路径②的命名隧道方案做成"开箱即用"文档（如 P1 稳定运行 ≥1 个月仍打算固化）

---

## 11. 执行边界

- ✅ 仅迁移 `/api/audio-proxy` 路由，不改其他业务路由
- ✅ Worker 与 Node 版逻辑/状态码/headers 严格对齐（§4.2 ~ §4.4）
- ❌ 第一版**不实现** Worker 端限流（无共享状态环境，需要 KV 才能跨实例）
- ❌ 不引入 R2 / OSS 中转（用户已确认场景不需要）
- ❌ 不迁前端到 CF Pages（保留 Vercel）
- ❌ 不在 Vercel 端删除 `/api/audio-proxy` 旧路由（保留作 fallback）

---

## 12. 关键 SESSION_ID 与依赖

- 本计划由 `/ccg:debug` 流程在阶段 4 用户确认后产生
- 关联诊断证据日志：[logs/2026-05-13-2309-vercel.log](../../logs/2026-05-13-2309-vercel.log)、[logs/2026-05-13-2343-vercel.log](../../logs/2026-05-13-2343-vercel.log)、[logs/2026-05-14-0000-vercel.log](../../logs/2026-05-14-0000-vercel.log)、[logs/2026-05-14-0011-vercel.log](../../logs/2026-05-14-0011-vercel.log)
- 关联前置计划：[.claude/plan/audio-proxy.md](./audio-proxy.md)
