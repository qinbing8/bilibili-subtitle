# B 站音频转写助手部署指南

## 前置要求

1. Node.js 18+
2. npm
3. 一个可用的 Vercel 账号
4. 阿里云通义听悟与通义千问相关密钥

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
npm run build
```

## 环境变量配置（必填）

### 必填项（5 个）

- `ALI_ACCESS_KEY_ID`: 阿里云 RAM AccessKey ID
- `ALI_ACCESS_KEY_SECRET`: 阿里云 RAM AccessKey Secret
- `ALI_APP_KEY`: 通义听悟 AppKey
- `DASHSCOPE_API_KEY`: 通义千问 API Key
- `APP_ACCESS_PASSWORD`: 应用访问密码，前端登录页会使用

### 可选项（4 个）

- `LANGUAGE`: 默认转写语言，建议设为 `auto`
- `BILIBILI_SESSDATA`: B 站登录态 Cookie，不配时部分视频可能拿不到可用音频
- `ALLOWED_ORIGINS`: CORS 白名单，多个域名用逗号分隔
- `META_TOKEN_SECRET`: 下载元数据签名密钥，建议生产环境配置

修改环境变量后，需要在 Vercel 控制台重新触发一次部署。

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

优先检查 `BILIBILI_SESSDATA` 是否配置，以及视频本身是否存在版权或登录限制。

### 4. 下载结果时报已过期

转写结果依赖临时地址，任务完成后应尽快下载。
