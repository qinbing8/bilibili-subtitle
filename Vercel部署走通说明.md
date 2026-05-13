# Vercel 部署走通说明

这份文档只回答两个问题：

1. 部署到 Vercel 以后，这个项目为什么能按预期走通链路
2. 具体应该怎么部署，部署完如何验收

如果你只想快速开始，可以先看 [快速部署指南.md](./快速部署指南.md)。
如果你想看更细的变量说明和限制，再看 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 目标链路

你预期的目标是：

`Bilibili 视频链接 -> 获取音频 -> 通义听悟转写 -> 下载 .docx / .txt`

当前项目在 Vercel 上对应的实际链路是：

`Bilibili URL -> Vercel /api/transcription/start -> Vercel /api/audio-proxy -> Tongyi Tingwu -> Vercel /api/transcription/download -> .docx / .txt`

也就是说：

- 前端把 B 站链接交给 Vercel 上的后端
- 后端先解析 B 站音频，优先拿 `m4a`
- 如果拿不到 DASH 音频流，会降级成 `flv`
- 后端不会把 B 站原始音频直链直接交给通义听悟
- 后端会生成一个自己的公网代理地址 `/api/audio-proxy`
- 通义听悟去访问这个代理地址，由代理补齐 B 站需要的 `Referer`
- 转写完成后，前端再从 Vercel 下载 `.docx` 或 `.txt`

## 为什么部署到 Vercel 就能走通

核心原因只有一条：

`通义听悟只能回拉公网可访问的 http(s) 文件地址`

本地开发时，`localhost:9091` 对通义听悟不可见，所以本地才需要 `cloudflared tunnel`。

但如果后端已经部署到 Vercel：

- `https://<your-project>.vercel.app` 本身就是公网地址
- `/api/audio-proxy` 也就天然变成公网可访问地址
- 所以 `PUBLIC_PROXY_BASE_URL` 直接填 Vercel 域名即可

这时链路会变成：

1. 用户在页面输入 B 站链接
2. 前端请求 `POST /api/transcription/start`
3. Vercel 后端解析 B 站音频，生成带签名的 `/api/audio-proxy?t=...`
4. Vercel 后端把这个代理地址提交给通义听悟
5. 通义听悟访问这个代理地址
6. `/api/audio-proxy` 代表通义听悟去请求 B 站真实音频，并自动补 `Referer`
7. 通义听悟完成转写
8. 前端轮询 `GET /api/transcription/status`
9. 前端调用 `GET /api/transcription/download?format=docx|txt`
10. Vercel 后端把转写 JSON 渲染成 `.docx` 或 `.txt` 返回给浏览器

所以，Vercel 方案里不需要再额外跑本地 tunnel，前提是：

- 项目已经真正部署到 Vercel
- `PUBLIC_PROXY_BASE_URL` 填的是这个线上域名
- 通义听悟密钥和代理密钥都已正确配置

## 部署前你需要准备什么

如果你现在的目标是“先跑通程序”，不要把所有变量都当成同一优先级。

先按下面三层理解：

### A. 只把站点部署出来

这一层的目标只是：

- Vercel 部署成功
- 首页能打开

这一层可以先不把业务变量全部配齐。

但这还不算“跑通程序”，因为你还不能真正提交转写任务。

### B. 真正跑通主链路

如果你的目标是：

`输入 B 站链接 -> 创建听悟任务 -> 等待完成 -> 下载 docx/txt`

那么当前真正必填的是：

- `ALI_ACCESS_KEY_ID`
- `ALI_ACCESS_KEY_SECRET`
- `ALI_APP_KEY`
- `APP_ACCESS_PASSWORD`
- `AUDIO_PROXY_TOKEN_SECRET`
- `PUBLIC_PROXY_BASE_URL`

### C. 可选但建议补

- `BILIBILI_SESSDATA`
- `META_TOKEN_SECRET`
- `LANGUAGE`
- `DASHSCOPE_API_KEY`

它们不是“先跑通主链路”的硬门槛，但会影响稳定性、下载体验或附加功能。

## 变量分级说明

### 主链路必填

- 一个 GitHub 仓库
- 一个 Vercel 账号
- 阿里云 `ALI_ACCESS_KEY_ID`
- 阿里云 `ALI_ACCESS_KEY_SECRET`
- 通义听悟 `ALI_APP_KEY`
- 你自己定义的 `APP_ACCESS_PASSWORD`
- 一段随机字符串作为 `AUDIO_PROXY_TOKEN_SECRET`
- `PUBLIC_PROXY_BASE_URL`

### 可选后补

- `BILIBILI_SESSDATA`
- `META_TOKEN_SECRET`
- `LANGUAGE`
- `DASHSCOPE_API_KEY`

变量来源说明：

- `ALI_APP_KEY`
  来自 `https://nls-portal.console.aliyun.com/tingwu/projects`
  进入“我的项目”后，取对应项目的 `Project AppKey`
- `DASHSCOPE_API_KEY`
  来自 DashScope / 通义千问控制台
  当前项目里它只用于“AI 整理 Markdown 笔记”支线，不是通义听悟转写主链路必填
- `BILIBILI_SESSDATA`
  来自已登录 B 站浏览器 Cookie
- `PUBLIC_PROXY_BASE_URL`
  对 Vercel 来说，通常就是你的线上域名，例如：
  `https://<your-project>.vercel.app`

## Vercel 部署步骤

### 步骤 1：先确认本地代码状态

在项目根目录执行：

```powershell
Set-Location D:\workspeace\bilibili-subtitle
npm install
npm run check
npm test
npm run build
```

通过标准：

- `npm run check` 通过
- `npm test` 通过
- `npm run build` 通过

### 步骤 2：推送到 GitHub

```powershell
git push origin main
```

如果还没有远程仓库，先创建 GitHub 仓库并完成 `remote` 绑定。

### 步骤 3：在 Vercel 导入项目

1. 打开 `https://vercel.com`
2. 点击 `New Project`
3. 选择这个 GitHub 仓库
4. 保持默认检测结果

当前项目推荐构建设置：

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

### 步骤 4：配置环境变量

如果你想一次性把主链路跑通，在 Vercel 的 `Environment Variables` 里至少填入：

```text
ALI_ACCESS_KEY_ID=<你的阿里云 AK>
ALI_ACCESS_KEY_SECRET=<你的阿里云 SK>
ALI_APP_KEY=<你的通义听悟项目 AppKey>
APP_ACCESS_PASSWORD=<你自己定义的访问密码>
AUDIO_PROXY_TOKEN_SECRET=<至少 32 字节随机串>
PUBLIC_PROXY_BASE_URL=https://<your-project>.vercel.app
```

可选后补：

```text
BILIBILI_SESSDATA=<你的 B 站 Cookie 值>
META_TOKEN_SECRET=<另一段随机串>
LANGUAGE=auto
DASHSCOPE_API_KEY=<你的 DashScope Key>
```

这里最关键的是：

- `PUBLIC_PROXY_BASE_URL` 必须填 Vercel 线上域名
- 不能填 `localhost`
- 不能留空

如果你想分两次部署，可以这样走：

1. 第一次先不填 `PUBLIC_PROXY_BASE_URL`，只让项目先部署成功，拿到 Vercel 域名
2. 第二次把 `PUBLIC_PROXY_BASE_URL=https://<your-project>.vercel.app` 补进去
3. 重新触发一次 deployment

注意：

- 没有 `PUBLIC_PROXY_BASE_URL` 时，首页可以打开
- 但 `POST /api/transcription/start` 不会成功
- 所以这只能算“站点已上线”，不能算“主链路已跑通”

### 步骤 5：触发部署

填完环境变量后点击 `Deploy`。

如果你是先部署、后补环境变量，那要再触发一次新的 deployment，否则新变量不会生效。

### 步骤 6：验证线上健康状态

部署完成后，先访问：

- `https://<your-project>.vercel.app/`
- `https://<your-project>.vercel.app/api/health`
- `https://<your-project>.vercel.app/api/health-with-config`

通过标准：

- 首页能打开
- 先出现密码登录页
- `/api/health` 返回 `status: ok`
- `/api/health-with-config` 里 `proxyBaseUrlConfigured` 为真

### 步骤 7：提交一条真实转写任务

在首页：

1. 输入 `APP_ACCESS_PASSWORD`
2. 粘贴一个 B 站视频链接
3. 点击“提交转写任务”

期望行为：

- 能成功创建任务
- 页面进入轮询状态
- 能看到 `taskId`
- 若音频不是 DASH，页面可能提示降级为 `flv`

### 步骤 8：等待完成并下载结果

当状态进入 `COMPLETED` 后：

1. 点击 `下载 Word (.docx)`
2. 点击 `下载纯文本 (.txt)`
3. 确认两个文件都能下载
4. 确认 Word / WPS 能正常打开 `.docx`

## 部署成功的验收标准

只要下面 5 条都满足，就可以认为 Vercel 链路走通：

1. 站点首页可打开，并先要求输入访问密码
2. `POST /api/transcription/start` 能成功创建听悟任务
3. 任务状态最终能从 `ONGOING` 进入 `COMPLETED`
4. `.docx` 和 `.txt` 都能成功下载
5. `.docx` 可被 Word / WPS 正常打开，正文不是空文件

## 常见卡点

### 1. 页面能开，但提交任务失败

优先检查：

- `ALI_ACCESS_KEY_ID`
- `ALI_ACCESS_KEY_SECRET`
- `ALI_APP_KEY`
- `APP_ACCESS_PASSWORD`

### 2. 能创建任务，但很快失败

优先检查：

- `PUBLIC_PROXY_BASE_URL` 是否是公网 Vercel 域名
- `AUDIO_PROXY_TOKEN_SECRET` 是否已配置
- `BILIBILI_SESSDATA` 是否缺失

### 3. 结果下载时报过期

这是通义听悟结果地址的时效限制，不是下载接口本身坏了。需要重新提交任务。

### 4. 某些视频拿不到 m4a

当前实现是“优先 `m4a`，必要时降级 `flv`”，不是所有视频都百分百拿到 `m4a`。

如果你要求更高的 `m4a` 命中率，通常需要：

- 配置 `BILIBILI_SESSDATA`
- 换一个受限更少的视频

## 当前限制

- Vercel 当前配置的函数时长上限是 `300` 秒
- 特别长的音频流，可能在 Vercel 侧超时
- 大文件或长视频如果频繁失败，更稳的方案通常是把公网代理拆到独立服务

## 一句话结论

如果你把项目部署到 Vercel，并把 `PUBLIC_PROXY_BASE_URL` 配成自己的 Vercel 域名，这个项目的设计目标就是按下面这条链路运行：

`Bilibili URL -> Vercel 音频代理 -> 通义听悟 -> 下载 docx/txt`
