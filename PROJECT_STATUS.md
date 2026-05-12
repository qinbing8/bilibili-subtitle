# 项目当前任务状态

更新时间：`2026-05-12`

1. 目标

- 打通完整链路：输入 B 站视频链接，解析出可用音频，交给通义听悟进行语音转文字，最终导出 `.docx` 与 `.txt` 文件。
- 目标架构已经收敛为：`Bilibili URL -> 我们自己的公网音频代理 -> Tongyi Tingwu -> 导出文档`。

2. 关键约束

- B 站音频直链在远端拉取时必须带 `Referer: https://www.bilibili.com`，否则会返回 `403`。
- 通义听悟离线任务只能回拉公网可访问的 `http(s)` 文件地址，不能替我们补 B 站所需请求头。
- 本地 `localhost:9091` 无法被听悟直接访问，因此本地代理地址不能作为最终音频源。
- 项目内已确认：Codex 不得再启动长活本地后端，后端必须由用户在独立终端手工启动。

3. 已完成

- 已补充项目级 [AGENTS.md](/D:/workspeace/bilibili-subtitle/AGENTS.md) 规则，禁止 Codex 拉起长活后端。
- 已补充 [MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md)，记录重复卡住问题、`9091` 残留处理方式和手工联调步骤。
- 已修复通义听悟 `CreateTask` 请求结构问题，相关逻辑已抽到 [api/tingwu-task.ts](/D:/workspeace/bilibili-subtitle/api/tingwu-task.ts)。
- 已新增 [api/audio-proxy.ts](/D:/workspeace/bilibili-subtitle/api/audio-proxy.ts)，实现音频代理 token、白名单、Referer 注入、手动跟跳和流式转发。
- 已扩展 [api/dev-config.ts](/D:/workspeace/bilibili-subtitle/api/dev-config.ts)，支持公网代理地址、代理密钥、TTL 和允许 host 配置。
- 已改造 [api/server.ts](/D:/workspeace/bilibili-subtitle/api/server.ts) 与 [api/index.ts](/D:/workspeace/bilibili-subtitle/api/index.ts)，让 `/api/transcription/start` 返回并使用 `proxyUrl`，同时新增 `/api/audio-proxy` 与 `/api/health-with-config`。
- 已补测试 [tests/tingwu-task.test.ts](/D:/workspeace/bilibili-subtitle/tests/tingwu-task.test.ts)、[tests/dev-config.test.ts](/D:/workspeace/bilibili-subtitle/tests/dev-config.test.ts)、[tests/audio-proxy.test.ts](/D:/workspeace/bilibili-subtitle/tests/audio-proxy.test.ts)，并验证 `npm test` 与 `npm run check` 通过。
- 已验证 `/api/download-video` 可成功返回音频信息，`/api/transcription/start` 可成功创建任务。
- 已在前端 [src/App.tsx](/D:/workspeace/bilibili-subtitle/src/App.tsx) 增加代理配置横幅与调试信息区，方便继续联调。

4. 未完成

- 还没有部署并验证可公网访问的代理服务。
- 还没有完成 cloudflared tunnel + `PUBLIC_PROXY_BASE_URL` 的端到端复测。
- 还没有完成步骤 6 到 8 的闭环验证，即：任务完成、下载 `.docx` / `.txt`、验证导出文件可打开。

5. 关键文件

- [MAINTENANCE.md](/D:/workspeace/bilibili-subtitle/MAINTENANCE.md)：维护 Runbook、重复问题记录、联调步骤和当前结论。
- [AGENTS.md](/D:/workspeace/bilibili-subtitle/AGENTS.md)：项目级代理规则，特别是“禁止 Codex 启动长活后端”。
- [api/server.ts](/D:/workspeace/bilibili-subtitle/api/server.ts)：本地后端入口，下载、转写、导出链路都从这里接入。
- [api/index.ts](/D:/workspeace/bilibili-subtitle/api/index.ts)：服务端接口实现，和转写任务创建逻辑直接相关。
- [api/audio-proxy.ts](/D:/workspeace/bilibili-subtitle/api/audio-proxy.ts)：公网音频代理核心模块。
- [api/dev-config.ts](/D:/workspeace/bilibili-subtitle/api/dev-config.ts)：代理相关配置解析。
- [api/tingwu-task.ts](/D:/workspeace/bilibili-subtitle/api/tingwu-task.ts)：听悟离线任务请求构造的共享逻辑。
- [tests/audio-proxy.test.ts](/D:/workspeace/bilibili-subtitle/tests/audio-proxy.test.ts)：音频代理单元测试。
- [DEPLOYMENT.md](/D:/workspeace/bilibili-subtitle/DEPLOYMENT.md)：部署与公网代理说明。

6. 风险点

- 即使实现了代理，只要代理没有公网可达、稳定返回流式音频，听悟任务仍会失败。
- 免费方案存在配额与时长限制，尤其是大音频、长视频、并发请求时可能触发平台限制。
- 公网代理如果不做签名、过期时间和来源限制，容易变成可被外部滥用的开放代理。
- 代理若没有正确透传 `Content-Type`、`Content-Length`、分段响应或范围请求，听悟侧仍可能报“文件不可读”。
- 如果后续再次让 Codex 直接拉起本地后端，`9091` 残留和会话卡住的问题大概率会再次复现。
