# B 站音频转写助手部署指南

## 前置要求

1. Node.js 24.x（当前已验证环境：v24.14.1）
2. npm
3. 一个可用的 Vercel 账号
4. 阿里云通义听悟与通义千问相关密钥

## 当前推荐架构

当前仓库的默认部署架构是：

`前端 + API -> Vercel / Node.js`

通义听悟回拉音频时，再通过公网访问：

`PUBLIC_PROXY_BASE_URL + /api/audio-proxy`

这里的 Cloudflare 目前默认承担的是“公网暴露”角色，不是“正式应用托管”角色：

- 本地联调：推荐 `cloudflared tunnel --url http://localhost:9091`
- Vercel 部署：可先直接使用站点域名作为 `PUBLIC_PROXY_BASE_URL`
- 仓库当前没有 `wrangler.toml` / `wrangler.jsonc`，也没有 Cloudflare Worker 入口，因此不属于现成可直接 `wrangler deploy` 的项目

## 部署方式

### 方式一：Vercel 网页界面

1. 将项目推送到 GitHub
2. 在 Vercel 中选择 `Import Project`
3. 选择仓库并保持默认 Vite 构建设置
4. 配置本文下方的环境变量
5. 点击 `Deploy`

### 方式二：Vercel CLI

1. 安装 CLI
   ```bash
   npm install -g vercel
   ```
2. 登录
   ```bash
   vercel login
   ```
3. 在项目根目录执行
   ```bash
   vercel
   ```
4. 生产部署
   ```bash
   vercel --prod
   ```

## 本地验证

部署前建议先确认本地通过以下命令：

```bash
npm install
npm run check
npm test
npm run build
```

## 环境变量配置（必填）

### 核心必填项

- `ALI_ACCESS_KEY_ID`: 阿里云 RAM AccessKey ID
- `ALI_ACCESS_KEY_SECRET`: 阿里云 RAM AccessKey Secret
- `ALI_APP_KEY`: 通义听悟 AppKey
  获取入口：`https://nls-portal.console.aliyun.com/tingwu/projects` -> 我的项目 -> 对应项目的 `Project AppKey`
- `DASHSCOPE_API_KEY`: 通义千问 / DashScope API Key，用于文稿 AI 排版
- `APP_ACCESS_PASSWORD`: 应用访问密码，前端登录页会使用
- `PUBLIC_PROXY_BASE_URL`: 通义听悟回拉音频时使用的公网代理地址
- `AUDIO_PROXY_TOKEN_SECRET`: 音频代理 token 签名密钥，建议与 `META_TOKEN_SECRET` 分开配置

建议补充说明：

- `PUBLIC_PROXY_BASE_URL`
  - 本地联调：填 `cloudflared tunnel` 输出的 `https://*.trycloudflare.com`
  - Vercel 部署：可先填 `https://<your-project>.vercel.app`
- `AUDIO_PROXY_TOKEN_SECRET`
  - 建议使用至少 32 字节随机串
  - 生产环境不要复用 `APP_ACCESS_PASSWORD`
- `APP_ACCESS_PASSWORD`
  - 这是你自己定义的访问口令，不是平台分配的密钥
- `ALI_ACCESS_KEY_ID` / `ALI_ACCESS_KEY_SECRET`
  - 建议使用 RAM 子账号最小权限密钥，不要直接使用主账号长期密钥

### 可选项

- `LANGUAGE`: 默认转写语言，建议设为 `auto`
- `BILIBILI_SESSDATA`: B 站登录态 Cookie，不配时部分视频可能拿不到可用音频
- `ALLOWED_ORIGINS`: CORS 白名单，多个域名用逗号分隔
- `BACKEND_PORT`: 本地后端端口，默认 `9091`
- `META_TOKEN_SECRET`: 下载元数据签名密钥，建议生产环境配置
- `AUDIO_PROXY_TOKEN_TTL_SEC`: 音频代理 token 有效期，默认 `1800`
- `AUDIO_PROXY_MAX_CONCURRENT_PER_TOKEN`: 单 token 并发上限，默认 `1`
- `AUDIO_PROXY_MAX_CONCURRENT_GLOBAL`: 全局并发上限，默认 `4`
- `AUDIO_PROXY_MAX_BYTES_PER_TOKEN`: 单 token 累计字节上限，默认 `524288000`
- `AUDIO_PROXY_MAX_DURATION_MS`: 单 token 生命周期上限，默认 `1800000`
- `AUDIO_PROXY_ALLOWED_HOSTS`: 自定义允许回源的 host 正则，留空走内置 B 站 CDN 白名单

修改环境变量后，需要在 Vercel 控制台重新触发一次部署。

## 公网音频代理说明

### 本地联调推荐

本地 `localhost:9091` 不能被通义听悟直接访问。联调时建议在独立终端运行：

```bash
cloudflared tunnel --url http://localhost:9091
```

把输出的 `https://*.trycloudflare.com` 写入 `PUBLIC_PROXY_BASE_URL`，然后重启本地后端。

### Vercel 部署说明

如果你把项目部署在 Vercel，`PUBLIC_PROXY_BASE_URL` 可以先指向部署域名本身，例如：

```text
PUBLIC_PROXY_BASE_URL=https://your-project.vercel.app
```

这样 `/api/audio-proxy` 会复用 Vercel 函数。

重要免责声明：

- 当前 `vercel.json` 中 `api/index.ts` 的 `maxDuration` 为 `300` 秒
- 大于 5 分钟的音频流，可能在 Vercel 侧被超时截断
- 如果实测频繁失败，应切换回 Cloudflare Tunnel 作为主方案

## Cloudflare CLI 现状说明

如果你问的是“能不能直接像别的项目一样用 Cloudflare CLI 正式发布这个仓库”，当前答案是：`不能直接发`。

原因：

- 后端是按 `Node.js` / `Vercel` 入口组织的
- 当前没有 `wrangler` 配置文件
- 当前没有适配 Cloudflare Workers / Pages Functions 的服务端入口

如果后续要支持 Codex 代你执行 Cloudflare 正式部署，至少还需要：

1. 选定 Cloudflare 目标形态：`Workers` 或 `Pages + Functions`
2. 增加 `wrangler` 配置
3. 改造后端入口以适配 Cloudflare 运行时
4. 配置 Cloudflare 环境变量
5. 再执行 `wrangler deploy`

## 当前安全行为

- `/api/audio-proxy` 会校验 HMAC token、DNS 解析后的公网地址，以及 B 站 CDN host 白名单
- `/api/audio-proxy` 有内存级限流：单 token 并发、全局并发、累计字节数、生命周期时长
- `/api/transcription/start` 返回给前端的是 `audioHost` / `proxyHost`，而不是完整 `audioUrl` / `proxyUrl`
- 前端调试面板只显示 host，不再暴露完整带 token 的代理 URL

## 构建设置

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

## 部署后检查

1. 打开站点首页，确认先出现密码登录遮罩
2. 输入配置的访问密码后进入主界面
3. 提交一个 B 站链接，确认前端会请求 `/api/transcription/start`
4. 在浏览器网络面板确认请求头带有 `X-App-Password`
5. 转写完成后，确认可下载 `.docx` 和 `.txt`

## 常见问题

### 1. 环境变量改了但页面行为没变

通常是因为项目还没重新部署。Vercel 只有在新的 deployment 中才会注入最新变量。

### 2. 提交任务时报 401

检查前端输入的密码是否与 `APP_ACCESS_PASSWORD` 一致。

### 3. 提交任务时报音频相关错误

优先检查：

- `PUBLIC_PROXY_BASE_URL` 是否已配置为公网地址
- `AUDIO_PROXY_TOKEN_SECRET` 是否已配置
- 本地联调时 `cloudflared tunnel --url http://localhost:9091` 是否仍在运行
- `BILIBILI_SESSDATA` 是否配置，以及视频本身是否存在版权或登录限制

### 4. 下载结果时报已过期

转写结果依赖临时地址，任务完成后应尽快下载。
