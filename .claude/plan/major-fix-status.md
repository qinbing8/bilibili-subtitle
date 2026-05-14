# audio-proxy Major Fix · 进度快照

> 修复审查发现的 Major #1–#3（token 暴露、SSRF DNS 复核缺失、滥用控制缺失）

## 1. 目标

在不破坏 `/transcription/start → /audio-proxy → 通义听悟回拉 → 转写` 主链路的前提下，把提交 `67e34dd` 中的 3 个 Major 安全问题修复到公网可上线水位：

- **Major #1** 阻止 `proxyUrl`（含 HMAC token）泄漏到前端 DOM 与浏览器 CORS 通道
- **Major #2** 给上游 host 加 DNS 解析后的私网/保留段复核（每跳重定向都做）
- **Major #3** 给公开的 `/api/audio-proxy` 路由加 in-memory 限流（per-token / global concurrency + bytes + duration）

## 2. 关键约束

- 后端双入口（`api/server.ts` 本地 + `api/index.ts` Vercel）必须保持行为一致
- 不引入外部依赖（无 redis / 无 ratelimit lib），仅用 Node 内置（`net.BlockList`、`dns.promises`、`crypto.timingSafeEqual`、`PassThrough`）
- 默认阈值：per-token 并发 1 / global 4 / bytes 500 MB / duration 30 min，全部可由 env 覆盖
- 调试面板：后端不再回完整 URL，前端只渲染 host
- Tingwu 作为服务端调用方不受 CORS 影响，故把 `/api/audio-proxy` 路由前置到全局 CORS 之前

## 3. 已完成

| Task | 文件 | 摘要 |
|---|---|---|
| #1 dev-config resolver | `api/dev-config.ts` | 新增 `resolveAudioProxyRateLimits` + `AudioProxyRateLimits` 类型 + 4 个默认常量 |
| #2 HMAC timing-safe | `api/audio-proxy.ts` | `signPayload` 比较改用 `timingSafeEqual`；claims 加 `typeof`/`Number.isFinite`/`exp>iat` 校验 |
| #4 DNS 私网复核 | `api/audio-proxy.ts` | 新增 `BLOCKED_IPS`（含 0.0.0.0/8、100.64/10、198.18/15、IPv4-mapped IPv6 处理）、`assertHostResolvesToPublic`、`BlockedHostError`、`DnsLookupError`，handler 每跳都跑 |
| #6 In-memory 限流 | `api/audio-proxy.ts` | 新增 `AudioProxyRateLimiter`（per-token + global + bytes + duration），handler 入口 acquire / finally release / PassThrough 计数 / 超额销毁流 |
| #3a server.ts 改造 | `api/server.ts` | audio-proxy 路由前置（CORS 之前）、`requireApiAccess` 去掉 audio-proxy 放行、`buildAudioProxyTaskPayload` 返回 `proxyHost`/`audioHost`、`/transcription/start` 响应去 `proxyUrl`/`audioUrl` + `Cache-Control: no-store` |
| #3b index.ts 改造 | `api/index.ts` | 已镜像 server.ts：audio-proxy 路由前置、接入 `resolveAudioProxyRateLimits`、移除旧 URL 回传、`Cache-Control: no-store` |
| #9 前端 DebugInfoPanel | `src/App.tsx` | `TaskMeta` 改为 `audioHost`/`proxyHost`，面板仅显示 host，`handleStart`/localStorage 对旧 `audioUrl`/`proxyUrl` 做兼容归一 |
| #5 测试补充 | `tests/audio-proxy.test.ts` | 已补 DNS 复核、IPv4-mapped IPv6、签名长度不匹配、claims 强校验、per-token/global/bytes/duration 限流用例 |
| #8 .env.example | 根目录 | 已追加 4 个 `AUDIO_PROXY_MAX_*` 配置示例 |

## 4. 未完成

| Task | 文件 | 说明 |
|---|---|---|
| #7 验证 | — | `npm run check` ✅、`npm test` ✅；`npm run lint` ❌，失败原因是仓库当前缺少 ESLint 配置文件，不是本次业务改动引入 |

## 5. 关键文件 / 引用位置

```
api/audio-proxy.ts          # 整体重写（396 行），核心
  - BLOCKED_IPS (net.BlockList)
  - assertHostResolvesToPublic / BlockedHostError / DnsLookupError
  - AudioProxyRateLimiter
  - verifyAudioProxyToken (timing-safe + strong claims)
  - createAudioProxyHandler (acquire → DNS guard 每跳 → axios stream → PassThrough 字节计数)

api/dev-config.ts           # +50 行
  - DEFAULT_AUDIO_PROXY_MAX_* 4 个常量
  - AudioProxyRateLimits 接口
  - resolveAudioProxyRateLimits + resolvePositiveInt helper

api/server.ts               # 已改 5 处
  - line ~37  audio-proxy handler 提前定义 + 路由前置 + OPTIONS 兜底
  - line ~65  requireApiAccess 去掉 audio-proxy 放行
  - line ~547 buildAudioProxyTaskPayload 返回 proxyHost/audioHost
  - line ~700 删除重复的 app.get('/api/audio-proxy', ...) 注册
  - line ~755 /transcription/start 响应脱敏 + Cache-Control: no-store

api/index.ts                # 待镜像 server.ts 同样 5 处改动
src/App.tsx                 # 待改 TaskMeta + DebugInfoPanel + handleStart
tests/audio-proxy.test.ts   # 待补 7 个新用例
.env.example                # 待加 4 行 AUDIO_PROXY_MAX_*
```

## 6. 风险点

1. **Lint 基线缺失**：仓库当前没有 ESLint 配置文件，`npm run lint` 无法完成。若要补齐需新增根级 lint 配置，这超出本次业务修复原范围。
2. **限流 bytes 累积语义**：同一 token 累计字节超 500 MB 即拒绝，意味着同一 token 完整拉过一次后无法重拉。Tingwu 正常用例是「HEAD → GET 一次」，符合设计；若 Tingwu 重试导致字节翻倍可能命中上限，已留 ~2.5x 余量。
3. **DNS lookup 无 IP pinning**：`assertHostResolvesToPublic` 通过后 axios 会再次解析，存在 TOCTOU 窗口。本次先做静态拒绝（覆盖 99% 的错配/CNAME 内网风险），未来如需更强防护要改用自定义 `lookup` + 钉死 IP。
4. **`assertHostResolvesToPublic` 对 IP 字面量直跳过 DNS**：`http://1.2.3.4` 会走同步 BlockList 检查不调用 lookup；这是正确行为，测试已补覆盖。
