# B 站音频转写助手

一个把 B 站视频音频提交给通义听悟转写，并导出 `.docx` / `.txt` 的 Web 应用。当前链路已经收敛为：

`Bilibili URL -> /api/audio-proxy -> Tongyi Tingwu -> 文档导出`

也就是说，项目不再把 B 站原始音频直链直接暴露给前端或听悟，而是通过带签名的代理路由回拉音频。

## 当前能力

- 访问密码登录，避免公开滥用
- 自动解析 B 站音频并提交到通义听悟
- 页面刷新后可恢复轮询中的转写任务
- 支持导出 `.docx` 与 `.txt`
- 前端只展示音频源 host / 代理 host，不回传完整带 token 的代理 URL
- `/api/audio-proxy` 已增加 host 白名单、DNS 私网复核、per-token / global 限流

## 文档导航

- [快速部署指南.md](./快速部署指南.md)：最短路径快速开始，适合第一次跑通
- [DEPLOYMENT.md](./DEPLOYMENT.md)：Vercel 部署与公网代理细节
- [MAINTENANCE.md](./MAINTENANCE.md)：本地联调 runbook、端口残留处理、重复问题记录
- [PROJECT_STATUS.md](./PROJECT_STATUS.md)：当前项目状态与剩余验证项

## 运行前提

- Node.js `24.x`（当前验证环境：`v24.14.1`）
- npm `11+`
- 阿里云通义听悟密钥
- 通义千问 `DASHSCOPE_API_KEY`
- 一个可用的公网代理地址
  - 本地联调推荐 `cloudflared tunnel --url http://localhost:9091`
  - Vercel 部署可先用站点域名本身作为 `PUBLIC_PROXY_BASE_URL`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制一份 `.env.example` 为 `.env.local`，至少填写下面这些变量：

- `ALI_ACCESS_KEY_ID`
- `ALI_ACCESS_KEY_SECRET`
- `ALI_APP_KEY`
- `DASHSCOPE_API_KEY`
- `APP_ACCESS_PASSWORD`
- `PUBLIC_PROXY_BASE_URL`
- `AUDIO_PROXY_TOKEN_SECRET`

建议同时配置：

- `BILIBILI_SESSDATA`
- `META_TOKEN_SECRET`

完整变量说明见 [.env.example](./.env.example) 与 [DEPLOYMENT.md](./DEPLOYMENT.md)。

### 3. 本地联调时准备公网代理

如果你是在本机把音频交给通义听悟，`localhost:9091` 对听悟不可见，因此必须先在独立终端运行：

```bash
cloudflared tunnel --url http://localhost:9091
```

把输出的 `https://*.trycloudflare.com` 写入 `PUBLIC_PROXY_BASE_URL`，再启动后端。

### 4. 启动后端

建议在独立终端运行，方便看日志和手动停止：

```bash
npm run dev:backend
```

默认端口是 `9091`。如果本机已有代理工具占用 `9090`，保持默认值即可；如需改端口，在 `.env.local` 里设置 `BACKEND_PORT=<端口>`。

### 5. 启动前端

```bash
npm run dev:frontend
```

打开 `http://localhost:5173`，输入 `APP_ACCESS_PASSWORD` 后即可使用。

### 6. 验证基本可用性

```bash
npm run check
npm test
```

如果要做最小接口确认，可额外访问：

- `GET /api/health`
- `GET /api/health-with-config`

## 核心接口

### `POST /api/download-video`

解析 B 站音频流，返回 `audioUrl`、`fileName`、`audioFormat` 等信息，主要用于排障和手工验证。

### `POST /api/transcription/start`

创建通义听悟转写任务。当前返回的是脱敏后的：

- `taskId`
- `audioHost`
- `proxyHost`
- `proxyExpiresAt`
- `sourceExpiresAt`
- `metaToken`

前端不再收到完整 `proxyUrl`。

### `GET /api/transcription/status?taskId=...`

轮询转写状态，直到 `COMPLETED` 或 `FAILED`。

### `GET /api/transcription/download?taskId=...&format=docx|txt&meta=...`

下载导出的 Word / 纯文本结果。

### `GET /api/health-with-config`

返回代理配置状态，用于前端横幅和手工联调。

## 部署说明

推荐优先看 [快速部署指南.md](./快速部署指南.md)，再按需补充阅读 [DEPLOYMENT.md](./DEPLOYMENT.md)。

已知部署约束：

- `api/index.ts` 在 Vercel 上的 `maxDuration` 当前是 `300` 秒
- 特别长的音频流可能因平台时长限制被截断
- 如果大文件频繁失败，优先考虑把 `PUBLIC_PROXY_BASE_URL` 切到独立的 tunnel / 代理服务

## 常见问题

### 为什么页面要求先输入密码？

所有 `/api/*` 请求都受 `APP_ACCESS_PASSWORD` 保护，用于减少公开滥用。

### 为什么有些视频提交后拿不到音频？

常见原因有两个：

- 视频本身受版权或登录限制
- 未配置 `BILIBILI_SESSDATA`

### 为什么本地跑通了下载，听悟却仍然失败？

通常不是下载逻辑坏了，而是听悟无法访问你的音频地址。优先检查：

- `PUBLIC_PROXY_BASE_URL` 是否是公网 `http(s)` 地址
- 本地 tunnel 是否仍在运行
- `AUDIO_PROXY_TOKEN_SECRET` 是否已配置

### 为什么结果下载会过期？

通义听悟结果依赖临时地址，建议任务完成后尽快下载。

## 许可证

MIT License
