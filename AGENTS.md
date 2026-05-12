# 项目 Agent 规则

## 长活后端进程

- 禁止通过 Codex 启动会长期存活的本地后端进程，包括但不限于：
  - `npm run dev`
  - `npm run dev:backend`
  - `npm run dev:backend:watch`
  - `node --experimental-strip-types api/server.ts`
  - `Start-Process npm.cmd ...`
- 原因：该模式已至少两次导致 Codex 会话长时间停留在 `working`，同时残留 `cmd` / `node` 进程占用 `9091`。
- 需要本地后端时，必须由用户在独立终端手工启动。Codex 只允许：
  - 检查 `9091` 是否已被监听
  - 对已运行的后端执行短命令验证，如 `/api/health`、`/api/download-video`、`/api/transcription/*`
  - 在用户明确需要时给出手工启动或手工清理命令
- 默认不要由 Codex 自动清理 `9091` 监听进程，除非用户明确要求终止该残留进程。

## 重复问题记录

- 同一类问题在项目内出现两次及以上时，必须更新 `MAINTENANCE.md`。
- 记录至少包含：
  - 标题
  - 触发信号
  - 根因 / 约束
  - 正确做法
  - 验证方式
  - 适用范围
