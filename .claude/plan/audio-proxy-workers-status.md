# Audio Proxy Workers 当前任务摘要

更新时间：2026-05-14

1. 目标

- 将通义听悟使用的音频代理从 `vercel.app` 迁移到 Cloudflare Worker，避免 `cn-beijing` 在 `CreateTask` 阶段预检 `FileUrl` 时访问不到 Vercel。
- 保持现有前端、Vercel API、听悟任务创建与下载链路不变，只迁出 `/api/audio-proxy` 这一条公网回拉路径。

2. 关键约束

- 必须免费，不引入长期常驻的本机 tunnel 或后端守护进程。
- Worker 与 Vercel 必须共用同一个 `AUDIO_PROXY_TOKEN_SECRET`；Vercel 负责签名，Worker 负责验签。
- Worker 行为要与 Node 版 `api/audio-proxy.ts` 基本对齐：`GET/HEAD`、HMAC token、B 站域名白名单、手动跟跳、`Range` 透传、流式返回。
- 不删除 Vercel 端旧 `/api/audio-proxy`，保留为兼容兜底。

3. 已完成

- 已新增 `workers/audio-proxy/` 子工程，包含 `wrangler.toml`、`package.json`、`tsconfig.json`、Worker 入口、token 验证、流式代理实现。
- 已补 Worker 侧测试草案：Node HMAC 与 Worker Web Crypto 互通测试、基础路由测试、白名单拦截、`Range` 透传、跳转拦截。
- 已更新配套文档与配置提示：`.env.example`、`.gitignore`、`MAINTENANCE.md`、`workers/audio-proxy/README.md`。
- 已在 `workers/audio-proxy/` 目录完成本地检查：`npm install`、`npm run check`、`npm test`、`npm run deploy:dry-run` 均已跑通。
- 已收口两处本地验证问题：Worker 入口改为显式 `.ts` 相对导入并在 `tsconfig.json` 开启 `allowImportingTsExtensions`；`worker.test.ts` 的 token 夹具改为基于当前时间生成，避免固定过期时间导致误报 `410`。
- 已完成 Wrangler 登录验证，当前 Cloudflare 账号可正常执行 `whoami` / `deploy`。
- 已成功部署 Worker：`https://bilibili-audio-proxy.quasarbrynn.workers.dev`，`/health` 公网检查返回 `ok`。
- 已修复一次真实部署阻塞：Cloudflare 不接受未来 `compatibility_date`，现已把 `wrangler.toml` 与主计划示例同步改为 `2025-05-14` 后重新部署成功。
- 已确认自定义域名 `https://bbq13560.dpdns.org` 与 `workers.dev` 命中同一 Worker：`/health` 返回 `200 ok`，`/api/audio-proxy` 在注入 secret 后返回 `401 {"error":"missing"}`。
- 已确认 Vercel 生产环境重部署已生效：`/api/health-with-config` 返回 `proxyBaseHost: "bbq13560.dpdns.org"`。
- 已完成两次真实 `transcription/start` 验证：Vercel 能成功创建听悟任务，返回的 `proxyHost` 为 `bbq13560.dpdns.org`。
- 已通过 `wrangler tail` 抓到听悟实际回拉证据：请求来自阿里云北京出口（`asOrganization: Aliyun Computing Co., LTD`，`city: Beijing`），对 `https://bbq13560.dpdns.org/api/audio-proxy?t=...` 发起 `GET` + `Range: bytes=0-`，Worker 返回 `206`。
- 已在 Worker 中补上可开关的最小调试日志层，默认只在 `DEBUG_AUDIO_PROXY=1` 时启用，覆盖入口请求、验签结果、上游响应头、首包字节预览、总发送字节数和客户端中断信号。
- 已完成 Worker 调试版回归验证：`workers/audio-proxy/` 下 `npm run check`、`npm test` 均通过。
- 已部署带 `DEBUG_AUDIO_PROXY=1` 的临时调试版 Worker，版本 ID：`0f3c02f6-fb3a-4410-9492-426451a5cdc4`。
- 已复查部署后的公网状态：`workers.dev` 与 `https://bbq13560.dpdns.org/health` 均返回 `200 ok`，`https://bbq13560.dpdns.org/api/audio-proxy` 未带 token 时返回 `401 {"error":"missing"}`。
- 已拿到一轮关键调试证据：听悟北京出口完整拉取了一个 `206` 音频代理响应，`totalBytes` 与 `content-length` 一致，`clientCanceled=false`，说明不是“刚探测就断开”。
- 已发现当前最可疑信号：token 声明 `mime=audio/mp4`，但上游实际返回 `content-type=video/mp4`。
- 已完成第二轮最小修正：Worker 现在会优先使用 token 中的 `mime` 覆盖对外 `Content-Type`，并基于 `fn` 增加 `Content-Disposition`，同时保留原有流式行为不变。
- 已部署新的调试版 Worker，版本 ID：`05ec1e9f-8a00-4d19-a2cd-ad7d5e26584a`；部署后自定义域 `/health` 仍为 `200 ok`，未带 token 的 `/api/audio-proxy` 仍为 `401 {"error":"missing"}`。
- 已确认 `wrangler tail` 本身工作正常：手工请求 `https://bbq13560.dpdns.org/api/audio-proxy` 时可稳定看到 `request.inbound` / `request.rejected`。
- 已确认存在第二类失败：`/api/transcription/start` 返回 `success=true`、`proxyHost=bbq13560.dpdns.org`，但对应任务 `FAILED` 且 Worker 完全无命中日志，说明听悟在真正回拉前就拒绝了该 `fileUrl`。
- 已在 Vercel 侧 `transcription/start` 路由补最小调试输出：支持通过 `X-Debug-Proxy: 1` 返回 `debugProxy` 字段，并在服务端日志记录 `proxyUrlLength`、`audioUrlLength`、`tokenLength`、`fileNameBytes`、`proxyUrlHash`，用于判断是否是 `fileUrl` 长度或内容格式触发听悟预检拒绝。
- 已确认一条失败样本的调试值：`proxyUrlLength=1159`、`audioUrlLength=637`、`tokenLength=1114`、`fileNameBytes=25`，且该任务在 Worker 完全无命中日志的情况下直接 `Audio file link invalid.`。
- 已完成第三轮最小修正：Vercel 端现在只在 token 中保留 `v/u/srcExp/iat/exp` 最小 claims 集合，移除 `mime`、`fn`、`bvid`、`cid`，用于优先验证 `fileUrl` 长度是否是第二类失败主因。
- 已完成本地回归验证：主工程 `npm run check`、`npm test` 通过，Worker 子工程 `npm run check`、`npm test` 通过。

4. 未完成

- 听悟任务虽然已经能实际打到 Worker，但最终状态仍为 `FAILED`，错误为 `Audio file link invalid.`。
- 还没有拿到新一轮真实回拉日志，因此尚未确认问题究竟落在响应头兼容、音频内容格式识别，还是流式传输行为。
- 还没有验证“强制 `audio/mp4` + `Content-Disposition`”是否足以让听悟接受该链接。
- 还没有拿到 Vercel 新调试字段对应的生产返回值，因此当前还不能确认第二类失败是否由 `fileUrl` 长度或 token 负载触发。
- 还没有拿到“缩短 token 后”的生产 `debugProxy` 返回值，因此暂时无法确认第二类失败是否会随 `proxyUrlLength` 下降而消失。
- 还没有做长视频端到端验证。

5. 关键文件

- 方案基线：[audio-proxy-workers.md](/D:/workspeace/bilibili-subtitle/.claude/plan/audio-proxy-workers.md)
- 当前摘要：[audio-proxy-workers-status.md](/D:/workspeace/bilibili-subtitle/.claude/plan/audio-proxy-workers-status.md)
- Node 基线实现：[audio-proxy.ts](/D:/workspeace/bilibili-subtitle/api/audio-proxy.ts)
- Worker 入口：[index.ts](/D:/workspeace/bilibili-subtitle/workers/audio-proxy/src/index.ts)
- Worker token 验证：[token.ts](/D:/workspeace/bilibili-subtitle/workers/audio-proxy/src/token.ts)
- Worker 代理逻辑：[proxy.ts](/D:/workspeace/bilibili-subtitle/workers/audio-proxy/src/proxy.ts)
- Worker 测试：[cross-platform.test.ts](/D:/workspeace/bilibili-subtitle/workers/audio-proxy/test/cross-platform.test.ts) 、[worker.test.ts](/D:/workspeace/bilibili-subtitle/workers/audio-proxy/test/worker.test.ts)

6. 风险点

- `workers.dev` / 自定义域名可达性问题已经基本排除：听悟出口已实际命中 Worker 并收到 `206` 响应。
- `AUDIO_PROXY_TOKEN_SECRET` 不一致风险当前已基本排除，否则 Worker 不会进入有效回拉并返回 `206`。
- 当前主要风险已转移到协议/内容兼容层：即使 Worker 被命中且返回 `206`，听悟仍把该链接判成 `Audio file link invalid.`。
- 仓库当前有用户自己的未提交改动，后续验证与提交时要继续避免误碰无关文件。
