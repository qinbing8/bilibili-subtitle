# 项目维护文档

## 目的

本文件用于记录本项目在本地开发、联调与日常维护中的高频问题、固定约束与手工操作 Runbook。

## 重复问题记录规则

同一类问题在项目内出现两次及以上时，必须写入本文件，并至少记录以下内容：

- 标题
- 触发信号
- 根因 / 约束
- 正确做法
- 验证方式
- 适用范围

## 当前残留状态

截至 `2026-05-12 17:31 +08:00`，本地 `9091` 仍存在残留监听：

- 监听进程：`node` PID `3912`
- 上层进程：`cmd` PID `9884`
- 启动时间：`2026-05-12 17:19:53`
- 特征：两者在 5 秒采样窗口内 `CPU delta = 0`，属于残留长活链路，不是活跃联调任务

说明：

- 该残留与 Codex 在会话内后台拉起 `dev:backend` 的方式一致。
- `.tmp-verify-backend.pid` 指向的不是最终监听 `9091` 的 `node` 进程，因此不能把 pid 文件视为唯一真相。

## 本地后端手工运行规则

### 1. 先检查 `9091` 是否已被占用

```powershell
netstat -ano | findstr :9091
```

如果有监听，再看占用者：

```powershell
Get-Process -Id <PID>
```

判断原则：

- 如果这是你当前正在使用的手工终端会话，直接复用。
- 如果这是之前残留的 `cmd` / `node` 链路，先由人工清理，再重新启动。
- 不要让 Codex 自动启动新的长活后端去覆盖现有残留。

### 2. 人工清理残留 `9091` 链路

仅在确认是残留进程时，由人工在终端执行：

```powershell
Stop-Process -Id <CMD_PID>,<NODE_PID> -Force
```

再次确认端口已释放：

```powershell
netstat -ano | findstr :9091
```

### 3. 手工启动本地后端

必须在独立终端手工启动，不要通过 Codex 启动：

```powershell
Set-Location D:\workspeace\bilibili-subtitle
npm run dev:backend
```

期望输出：

```text
Server running at http://localhost:9091
```

停止方式：

- 保持该终端窗口打开
- 结束时按 `Ctrl+C`

### 4. 手工健康检查

在另一个终端执行：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9091/api/health'
```

期望返回：

```json
{
  "status": "ok"
}
```

### 5. 代码级健康检查

在项目根目录执行：

```powershell
npm run check
npm test
```

说明：

- `npm run check` 用于确认 TypeScript 类型没有回归
- `npm test` 已固定为显式列出 `*.test.ts`，避免 PowerShell 把 `tests/test_parsing.py` 一起带入 Node 测试
- 这两个命令都可以由 Codex 执行；但 `npm run dev:backend` 仍必须由人工终端启动

## 当前剩余联调步骤

以下步骤用于完成当前公网代理方案下的 4 到 8 链路验证。前提是你已经手工启动本地后端，并准备好：

- `APP_ACCESS_PASSWORD`
- 一个实际可用的 B 站视频链接

### 步骤 0：手工启动 Cloudflare Tunnel

必须在独立终端执行，不要通过 Codex 启动：

```powershell
Set-Location D:\workspeace\bilibili-subtitle
cloudflared tunnel --url http://localhost:9091
```

期望输出：

- 终端出现一个 `https://*.trycloudflare.com`
- 把这个地址写入 `.env.local` 或 `.env` 中的 `PUBLIC_PROXY_BASE_URL`
- 重启后端，让 `/api/transcription/start` 在服务端生成正确的代理回拉地址，并向前端返回正确的 `proxyHost`

快速验证配置：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9091/api/health-with-config'
```

期望返回：

```json
{
  "status": "ok",
  "proxyBaseUrlConfigured": true,
  "proxyBaseHost": "<your tunnel host>"
}
```

建议先在当前终端设置两个变量：

```powershell
$headers = @{ 'X-App-Password' = '<APP_ACCESS_PASSWORD>' }
$payload = @{
  bilibiliUrl = '<BILIBILI_URL>'
  page = 0
} | ConvertTo-Json
```

### 步骤 4：验证下载链路

```powershell
$download = Invoke-RestMethod `
  -Uri 'http://127.0.0.1:9091/api/download-video' `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $payload

$download
```

通过标准：

- `success = true`
- `data.audioUrl` 非空
- `data.fileName` 非空

### 步骤 5：创建转写任务

```powershell
$task = Invoke-RestMethod `
  -Uri 'http://127.0.0.1:9091/api/transcription/start' `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $payload

$task
```

通过标准：

- `success = true`
- `data.taskId` 非空
- `data.proxyHost` 非空
- `data.audioHost` 非空
- `data.metaToken` 非空

### 步骤 6：轮询任务状态

```powershell
$taskId = $task.data.taskId

do {
  Start-Sleep -Seconds 15
  $status = Invoke-RestMethod `
    -Uri "http://127.0.0.1:9091/api/transcription/status?taskId=$taskId" `
    -Headers $headers
  $status
} while ($status.data.status -eq 'ONGOING')
```

通过标准：

- 最终状态为 `COMPLETED`
- 若为 `FAILED`，记录 `errorMessage`

### 步骤 7：下载 `.docx`

```powershell
$meta = [uri]::EscapeDataString($task.data.metaToken)

Invoke-WebRequest `
  -Uri "http://127.0.0.1:9091/api/transcription/download?taskId=$taskId&format=docx&meta=$meta" `
  -Headers $headers `
  -OutFile '.\tingwu-result.docx'
```

通过标准：

- 本地生成 `tingwu-result.docx`
- 文件大小大于 0

### 步骤 8：验证导出文件

```powershell
Get-Item .\tingwu-result.docx | Select-Object Name,Length,LastWriteTime
```

最终人工确认：

- Word / WPS 可正常打开
- 标题、正文、时间段存在
- 无损坏提示

## 当前联调结论（2026-05-12）

本次代码改造后的结论：

- `/api/transcription/start` 不再把 B 站音频直链直接交给听悟；后端内部会使用 `proxyUrl`，前端只看到 `proxyHost`
- 后端已新增 `/api/audio-proxy` 与 `/api/health-with-config`
- 音频代理会校验 HMAC token、TTL、B 站 CDN 白名单，并在回源时自动补 `Referer`
- 当前剩余工作不再是“缺代码”，而是“拿真实公网 tunnel 地址做端到端复测”

当前仍需人工完成的验证：

- 启动 `cloudflared tunnel --url http://localhost:9091`
- 把 tunnel 地址写入 `PUBLIC_PROXY_BASE_URL`
- 重启本地后端
- 重新执行步骤 4 到 8，确认听悟最终状态为 `COMPLETED`

## 重复问题记录

### 记录 001：Codex 启动本地长活后端后会话卡住

触发信号：

- Codex 窗口长期显示 `working`
- 会话文件长时间无新写入
- `9091` 被 `cmd` / `node` 残留链路占用

根因 / 约束：

- Codex 在 `shell_command` 中启动了长期存活的本地后端进程
- 该工具调用没有可靠收尾，导致 Codex 主会话停在等待态
- `Start-Process` + `npm run dev:backend` + 日志重定向 + pid 文件并不能保证 Codex 调用层正常返回

正确做法：

- 长活后端必须由人工在独立终端启动
- Codex 只执行短命令验证，不负责拉起本地服务
- 清理残留时以端口监听和实际进程为准，不以 pid 文件为唯一依据

验证方式：

- 手工终端启动后，`/api/health` 返回 `{"status":"ok"}`
- Codex 只执行短命令，不再出现长时间 `working`
- `9091` 的占用者与人工终端一致，可控、可停止

适用范围：

- 本地开发
- 联调
- 所有需要启动 `dev:backend` 的场景

### 记录 002：B 站音频直链不能直接交给听悟

触发信号：

- `/api/transcription/start` 返回成功，但 `/api/transcription/status` 很快变成 `FAILED`
- 听悟错误信息为 `File cannot be read.`
- 直接请求 B 站音频直链时，无 `Referer` 返回 `403`

根因 / 约束：

- B 站音频直链要求 `Referer: https://www.bilibili.com`
- 通义听悟离线任务只能回拉公网 `http(s)` 地址，不能自带自定义请求头
- 本地 `localhost:9091` 也不能被听悟直接访问

正确做法：

- 不要把 B 站原始音频直链直接交给听悟
- 必须经由 `/api/audio-proxy` 这类会自动补 `Referer` 的代理路由
- 本地联调时，必须再配合 `cloudflared tunnel --url http://localhost:9091` 提供公网入口

验证方式：

- `/api/transcription/start` 返回 `proxyHost`
- `/api/transcription/status` 最终为 `COMPLETED`

适用范围：

- 本地联调
- Vercel 部署
- 所有依赖通义听悟拉取 B 站音频的场景
