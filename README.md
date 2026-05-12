# B 站音频转写助手

一个用于将 B 站视频提交到通义听悟转写，并导出 `.docx` / `.txt` 文档的 Web 应用。

## 功能特点

- 访问密码登录，避免公开滥用
- 自动提交 B 站视频音频到通义听悟
- 轮询转写状态，支持页面刷新后恢复任务
- 支持下载 Word 文档和纯文本结果
- 响应式界面，兼容桌面与移动端

## 技术栈

- **前端**: React + TypeScript + Vite + TailwindCSS
- **后端**: Express.js (Serverless Functions on Vercel)
- **部署**: Vercel
- **API**: Bilibili API, 通义听悟, 通义千问

## 快速开始

### 本地开发

1. 安装依赖
   ```bash
   npm install
   ```
2. 启动开发服务器
   ```bash
   npm run dev
   ```
   - 前端: http://localhost:5173
   - 后端 API: http://localhost:9090
3. 类型检查
   ```bash
   npm run check
   ```
4. 构建项目
   ```bash
   npm run build
   ```

## 部署到 Vercel

可通过 Vercel 网页界面、CLI 或 GitHub 集成部署，具体步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## API 端点

### `POST /api/download-video`

获取 B 站音频流信息。

**请求体**
```json
{
  "bilibiliUrl": "https://www.bilibili.com/video/BV1234567890",
  "page": 0
}
```

### `POST /api/transcription/start`

创建通义听悟转写任务。

**请求体**
```json
{
  "bilibiliUrl": "https://www.bilibili.com/video/BV1234567890",
  "language": "auto",
  "page": 0,
  "diarization": false,
  "textPolish": false
}
```

### `GET /api/transcription/status?taskId=...`

查询转写任务状态。

### `GET /api/transcription/download?taskId=...&format=docx|txt&meta=...`

下载转写结果。

### `GET /api/health`

健康检查端点。

## 环境变量

### 必填

- `ALI_ACCESS_KEY_ID`: 阿里云 RAM AccessKey ID
- `ALI_ACCESS_KEY_SECRET`: 阿里云 RAM AccessKey Secret
- `ALI_APP_KEY`: 通义听悟 AppKey
- `DASHSCOPE_API_KEY`: 通义千问 API Key
- `APP_ACCESS_PASSWORD`: 应用访问密码

### 可选

- `LANGUAGE`: 默认转写语言，建议设为 `auto`
- `BILIBILI_SESSDATA`: B 站登录态 Cookie，用于提升获取音频成功率
- `ALLOWED_ORIGINS`: CORS 白名单，逗号分隔
- `META_TOKEN_SECRET`: 下载元数据签名密钥

## 使用流程

1. 部署后访问 Vercel URL，输入访问密码（部署者配置的 `APP_ACCESS_PASSWORD`）
2. 粘贴 B 站视频链接
3. 点击「提交转写任务」
4. 等待转写（通常 1-5 分钟，中途可关闭页面，下次回来自动恢复）
5. 完成后点击「下载 Word (.docx)」或「下载纯文本 (.txt)」

## 常见问题

### 1. 页面为什么要求先输入密码？

所有 `/api/*` 请求都受 `APP_ACCESS_PASSWORD` 保护，用于避免公开链接被滥用。

### 2. 为什么有些视频提交后无法拿到音频？

部分视频可能需要登录态才能拿到可用音频流，建议配置 `BILIBILI_SESSDATA`。

### 3. 下载结果为什么会过期？

通义听悟返回的转写结果依赖临时地址，建议任务完成后尽快下载。

## 许可证

MIT License
