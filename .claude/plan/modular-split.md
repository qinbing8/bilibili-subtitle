# 模块化拆分策略：3 窗口并行执行 v2 + docx 计划

> **目标**：把 `.claude/plan/vercel-fixes.md`（v2）+ `.claude/plan/transcription-to-docx.md`（docx）的总工作量拆分为 **3 个可在不同窗口独立执行的子计划**，最大化并行度。
>
> **窗口配置**（用户提供）：
> - 窗口 1：Codex CLI（后端 A：基础设施）
> - 窗口 2：Codex CLI（后端 B：转写 docx）
> - 窗口 3：Claude Code worker（前端全套）

---

## 0. 拆分原则

1. **文件级互斥锁**：任何文件在任一时刻**只有一个窗口拥有写权限**。`api/index.ts` 是最大的冲突点，必须严格控制。
2. **接口契约预约定**：3 个窗口对齐的依据是**本文档第 3 节定义的 API 响应 shape**，前端不需要等后端完成，凭契约工作即可。
3. **依赖顺序**：B 依赖 A 的 helper（`getTingwuConfig`、`getBilibiliDashAudioUrl`、`requireApiAccess`），所以 B 必须在 A 完成后启动。
4. **依赖前置**：模块 A 一次性安装**所有**npm 依赖（包括 B 才用到的 `docx`），避免 `package.json` 后续冲突。

---

## 1. 模块划分总览

| 模块 | 窗口 | 启动时机 | 主要工作 | 写权限文件 |
|------|------|---------|---------|-----------|
| **A：后端基础设施** | Codex 窗口 1 | **T=0 立即开始** | v2 全部后端工作 | `api/index.ts`（一次性大改） + `api/server.ts`（同步） + `package.json` + `.env.example` |
| **B：转写到 docx** | Codex 窗口 2 | **必须等 A 完成** | docx 计划全部后端工作 | `api/index.ts`（增量） + `api/server.ts`（同步） + `vercel.json` |
| **C：前端全套** | Claude Code worker | **T=0 立即开始**，与 A 并行 | v2 + docx 的所有前端工作 | `src/App.tsx`（完整重写） + `tailwind.config.js` + `README.md` + `DEPLOYMENT.md` |

### 时间线

```
T=0   ┌─ 窗口 1 (Codex A) ─────────┐    ┌─ 窗口 3 (Claude worker C) ──────────────┐
      │ 安装依赖 + 改 api 文件     │    │ 重写 src/App.tsx + tailwind + 文档       │
      │ ≈ 10-20 分钟              │    │ ≈ 30-60 分钟                            │
T=15  └─→ A 完成 ─→ 启动窗口 2     │    │                                         │
                                  │    │                                         │
T=15  ┌─ 窗口 2 (Codex B) ─────────┤    │                                         │
      │ 新增 3 路由 + docx 渲染   │    │                                         │
      │ ≈ 10-20 分钟              │    │                                         │
T=35  └─→ B 完成 ←────────────────┴────┴─→ C 完成                                  │

T=35  联调（如有问题，回到对应窗口修补）
```

**实际并行度**：`总耗时 ≈ max(A+B, C) = max(35min, 60min) = 60min`，相比串行执行的 `A+B+C ≈ 95min`，节省约 **35%**。

---

## 2. 文件级互斥锁矩阵

| 文件 | 写权限轨迹 | 备注 |
|------|-----------|------|
| `package.json` | A 一次性写完所有依赖 | B/C 不再 touch |
| `package-lock.json` | A 提交 | 包含 docx 的锁 |
| `api/index.ts` | A 占有 → B 接手（A 完成后） | **不允许同时打开** |
| `api/server.ts` | A 占有 → B 接手（A 完成后） | 同上 |
| `vercel.json` | B 占有 | 仅 B 修改 maxDuration |
| `.env.example` | A 创建 | B/C 不改（必要时通过 PR 评论提建议） |
| `src/App.tsx` | C 独占 | A/B 不读不写 |
| `tailwind.config.js` | C 独占 | 仅 C 加 shimmer keyframe |
| `README.md` / `DEPLOYMENT.md` | C 独占 | 文档更新 |
| `tsconfig.json` | 不动 | 现有配置满足 |

**冲突规避机制**：
- 模块 A 完成后**必须明确通知**（在第 3 节列出的验收命令全部通过 + 提交 commit）
- 模块 B 接手时**第一件事**：`git pull`（或在同一 worktree 中确认 A 的修改已保存）
- 模块 C 全程独立，但**最终联调时**需要拉取 A+B 的修改

---

## 3. 接口契约（C 独立工作的依据）

模块 C 不需要等后端完成，凭以下契约工作即可。**A 和 B 必须严格按这个 shape 实现响应**。

### 3.1 鉴权
所有 `/api/*` 请求（除 `/api/health`）必须携带 header：
```
X-App-Password: <用户在登录页输入的密码>
```
后端 401 = 密码错误。

### 3.2 `POST /api/transcription/start`
**请求体**：
```json
{ "bilibiliUrl": "https://www.bilibili.com/video/BV...", "language": "auto", "page": 0, "diarization": false, "textPolish": false }
```
**响应**：
```ts
{
  success: true,
  data: {
    taskId: string,           // 通义听悟 TaskId
    audioUrl: string,         // B 站 .m4a 直链
    audioFormat: 'm4a' | 'flv',
    fileName: string,         // 已清理的下载文件名
    expiresAt: string,        // ISO 8601，约 110 分钟后
    bandwidth: number,        // 音频码率（bps）
    source: 'dash' | 'durl-fallback',
    warning: string | null,   // 降级或异常的提示
    metaToken: string,        // HMAC 签名的元数据，给 download 路由用
  }
}
```
失败：`{ success: false, error: string }` + HTTP 4xx/5xx。

### 3.3 `GET /api/transcription/status?taskId=xxx`
**响应**：
```ts
{
  success: true,
  data: {
    status: 'ONGOING' | 'COMPLETED' | 'FAILED',
    errorMessage?: string,
    transcriptionUrl?: string,
    durationMs?: number,
    preview?: string,         // 完成时返回前 ~200 字符预览
  }
}
```
HTTP 410 = OSS 已过期 → 前端清 localStorage + 提示重新创建。

### 3.4 `GET /api/transcription/download?taskId=xxx&format=docx|txt&meta=<metaToken>`
**响应**：二进制流，`Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`（docx）或 `text/plain; charset=utf-8`（txt），`Content-Disposition: attachment; filename*=UTF-8''<encoded>`。

失败：JSON `{ success: false, error: string }` + HTTP 409/410/500。

### 3.5 `POST /api/download-video`（v2 路由，保留）
**请求体**：`{ bilibiliUrl, page? }`  
**响应**：与 `/api/transcription/start.data` 几乎一致，但**不创建听悟任务**，仅返回音频流信息（用于"只下载音频"的场景）。

### 3.6 `POST /api/process-video`（v2 路由，保留）
仍存在，用于 B 站内置字幕路径（不走听悟）。**Body 不再接受 `accessKey`**（已迁移到服务端环境变量 `DASHSCOPE_API_KEY`）。

---

## 4. 三个独立可执行 plan 文件

每个文件可在对应窗口直接 `/ccg:execute` 或粘贴给 Codex 执行：

| 子计划文件 | 对应窗口 | 命令 |
|------------|---------|------|
| `.claude/plan/module-a-backend-infra.md` | Codex 窗口 1 | `/ccg:execute .claude/plan/module-a-backend-infra.md` |
| `.claude/plan/module-b-backend-docx.md` | Codex 窗口 2（A 完成后启动） | `/ccg:execute .claude/plan/module-b-backend-docx.md` |
| `.claude/plan/module-c-frontend-ui.md` | Claude Code worker 窗口 | `/ccg:execute .claude/plan/module-c-frontend-ui.md` |

> 三个子计划都引用本文件作为"契约 + 边界"声明，**不会**自行扩展边界。

---

## 5. 协调机制（防冲突）

### 5.1 git worktree 隔离（**强烈推荐**）

若用户熟悉 git worktree，最干净的方案是：

```bash
# 在主仓库目录执行
git worktree add ../bilibili-subtitle-A -b module-a
git worktree add ../bilibili-subtitle-B -b module-b
git worktree add ../bilibili-subtitle-C -b module-c
```

每个窗口在对应目录工作。完成后合并：

```bash
git checkout main
git merge module-a
git merge module-c       # C 与 A 不冲突，可先合
# 等 B 完成后
git merge module-b
```

**优点**：物理隔离，绝无冲突。
**缺点**：要会用 worktree；A+B 都改 api 文件，合并时需手工解决（但因为时序串行，B 是 rebase 而不是 merge，冲突可控）。

### 5.2 单仓库串行（更简单，推荐新手）

3 个窗口共享同一目录，但严格按时序：

1. **T=0**：窗口 1 (A) 启动 + 窗口 3 (C) 启动。窗口 2 (B) **保持空闲**。
2. **T=A 完成**：用户在窗口 1 看到"模块 A 完成"提示 → 提交 commit → 在窗口 2 (B) 输入 `/ccg:execute .claude/plan/module-b-backend-docx.md` 启动。
3. **T=B 完成**：用户提交 commit。
4. **T=C 完成**：用户提交 commit。
5. **联调**：在主仓库验证。

**优点**：不需要 worktree 知识。
**缺点**：必须严格遵守"A 完成前 B 不启动"，否则 api/index.ts 会冲突。

### 5.3 看板（手动 status）

每个模块完成时，在 `.claude/plan/STATUS.md` 写一行：

```
- 2026-05-12 14:23 — 模块 A 完成 (commit: abc1234)
- 2026-05-12 14:55 — 模块 C 完成 (commit: def5678)
- 2026-05-12 15:08 — 模块 B 完成 (commit: ghi9012)
```

供 3 个窗口的协调者（Claude Code 主窗口）观察进度。

---

## 6. 验收顺序

1. **模块 A 验收**：
   - `npm run check` 通过
   - 本地 `npm run dev:backend` 启动
   - `curl http://localhost:9090/api/health` 返回 ok
   - 不带密码访问 `/api/download-video` 返回 401
   - 带密码 + 真实 BV 号访问 `/api/download-video` 返回 `audioUrl` 是真实的 B 站 m4a 直链
2. **模块 B 验收**（A 完成后）：
   - `npm run check` 通过
   - 带密码访问 `POST /api/transcription/start` 返回 `taskId` 与 `metaToken`
   - 带密码轮询 `GET /api/transcription/status?taskId=xxx` 直到 `COMPLETED`
   - 带密码下载 `GET /api/transcription/download?taskId=xxx&format=docx&meta=xxx`，得到合法 .docx 文件
3. **模块 C 验收**（独立）：
   - `npm run check` 通过
   - `npm run build` 通过
   - 首屏：登录遮罩
   - 输入密码后：主界面
   - 输入 B 站 URL → 点击"提交转写任务"：发起 `POST /api/transcription/start` 请求（Mock 也可以，看 Network 是否正确）
   - Stepper 4 步 + 倒计时正常
   - localStorage 中存在 `tingwu_task`
   - 切换 tab → 轮询暂停（Network 面板可见）
4. **联调**（全部完成后）：
   - 完整流程：B 站 URL → 提交 → 等待 → 下载 docx → Word 打开正常

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 窗口 1 和 窗口 2 同时打开 `api/index.ts` 导致冲突 | 严格遵守 §5.2 时序；用 IDE 的"显示文件谁在编辑"功能（如果有）；或直接用 §5.1 worktree |
| 接口契约理解偏差，前后端对不上 | 联调时用 `curl` 对照本文件 §3 验证接口 shape |
| 模块 C 提前完成等待后端 | 先 mock 接口（用 MSW 或简单 `axios.interceptors`）；或先做静态 UI 截图 |
| 模块 A 比预期慢，模块 B 启动延后 | B 启动时再做 docx 设计，A 的延迟不浪费 B 的时间 |
| 模块 B 改 `api/server.ts` 时漏掉 A 的某些改动（mirror 不全） | B 的子计划明确"用 diff 工具对照 `api/index.ts` 和 `api/server.ts`，确保完全一致" |

---

## 8. 用户决策点

| # | 问题 | 默认 | 备选 |
|---|------|------|------|
| 1 | 是否使用 git worktree 隔离？ | ❌ 用 §5.2 时序 | ✅ 用 worktree（如果熟悉）|
| 2 | 3 个 commit 还是 1 个总 commit？ | 3 个独立 commit（方便回滚） | 1 个总 commit（更整洁） |
| 3 | Claude Code worker 是新开 `claude` 命令窗口，还是同一会话的 sub-agent？ | 新开命令窗口（隔离更彻底） | sub-agent（共享上下文，但可能干扰）|

---

## 9. SESSION_ID 继承

继承自前两个计划，可被 3 个子计划复用：

- **CODEX_SESSION**（音频流 + 听悟签名）：`019e1a34-19ab-7292-89b8-9e044074647a`
- **CODEX_SESSION**（docx + 3 路由）：`019e1a61-2fd8-7f33-a27e-ece56463f0dc`
- **GEMINI_SESSION**（前端音频文案）：`e4ecb4b4-c4e7-412b-95d1-303033eb728b`
- **GEMINI_SESSION**（前端状态机）：`19d1f03a-8088-40b4-9081-9a7f35fde552`

模块 A/B 可用 `resume <codex-session-id>` 复用上下文；模块 C 用 Claude Code worker 直接读子计划文件即可。

---

## 10. 启动顺序速查

**用户操作**：

1. 打开 3 个终端（或 IDE 标签）。
2. **窗口 1（Codex）**：执行 `/ccg:execute .claude/plan/module-a-backend-infra.md`
3. **窗口 3（Claude Code worker）**：另起一个 Claude Code 会话，执行 `/ccg:execute .claude/plan/module-c-frontend-ui.md`
4. **窗口 2（Codex）**：**等窗口 1 报告 "模块 A 完成" 后**，执行 `/ccg:execute .claude/plan/module-b-backend-docx.md`
5. **任意窗口**：3 个全部完成后，跑联调验收（见 §6.4）
