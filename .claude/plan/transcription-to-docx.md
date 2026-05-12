# 实施计划：B站音频 → 通义听悟 → 下载 .docx / .txt（端到端）

> **依赖前置计划**：本计划基于 `.claude/plan/vercel-fixes.md` v2（通义听悟签名修复、`@alicloud/openapi-client`、共享密码鉴权、B 站 DASH m4a 提取）已被接受为前提。本文件**只补充**"转写 → docx/txt"这条新链路；如果 v2 还没实施，应该在 `/ccg:execute` 时把两个计划合并执行。

---

## 0. 用户两个核心问题的直接回答

### Q1：通义听悟 API 能直接返回 .txt 或 .docx 吗？
**不能。** 阿里云通义听悟 OpenAPI（版本 `2023-09-30`）的能力边界：

| 接口 | 返回内容 | 是否原生 .txt/.docx |
|------|---------|----------------------|
| `PUT /openapi/tingwu/v2/tasks` (CreateTask) | `{ Data: { TaskId, TaskStatus: 'ONGOING' } }` | ❌ |
| `GET /openapi/tingwu/v2/tasks/{TaskId}` (GetTaskInfo) | `{ Data: { TaskStatus: 'COMPLETED', Result: { Transcription: <临时OSS JSON URL> } } }` | ❌ |
| 下载 `Result.Transcription` 指向的 OSS URL | **结构化 JSON**：`{ Paragraphs: [{ ParagraphId, Sentences: [{ SentenceId, Start(ms), End(ms), Text, SpeakerId? }] }] }` | ❌ |
| 通义听悟**网页控制台**的"导出"按钮 | 支持 .txt / .docx / .pdf / .srt | ✅（**控制台特性，不是 API**） |

**结论**：我们必须**自己在服务端**解析 JSON 后用代码（`docx` npm 包）生成 .docx；.txt 直接拼接字符串即可。这是业界做法（没有捷径）。

### Q2：Vercel 上能否实现端到端？
**能，但必须用异步轮询架构。** 一个请求等到底是不可行的：

| 限制 | 数值 | 影响 |
|------|------|------|
| Vercel Hobby + Fluid Compute（2026 新项目默认） | **单函数 300 秒**（5 分钟） | 短视频够，长视频不够 |
| Vercel Hobby（2025 年 4 月前老项目，无 Fluid Compute） | 默认 10 秒 / 最大 60 秒 | 完全不够 |
| 通义听悟离线转写耗时 | 30 秒 ~ 数十分钟 | 长视频随时超过 300 秒 |

> **必须确认**：你的项目是 2026 年部署的，应当默认启用 Fluid Compute（在 Vercel 项目设置的 "Functions" 区可见，开启状态可达 300s）。本计划假设 300s。

唯一可行架构：

```
┌─前端─┐                                            ┌──Vercel 函数──┐  ┌─通义听悟─┐
│      │  POST /api/transcription/start  ─────────► │ start         │─►│ CreateTask│
│      │  ◄────────── { taskId } ────────────────── │ ≤30s          │  └───────────┘
│      │  GET /api/transcription/status?taskId=...  │ status        │─►│ GetTaskInfo│
│      │  每 5/15/30s 轮询，根据 visibility 暂停  ─►│ ≤10s          │  └───────────┘
│      │  ◄── { status:'ONGOING' \| 'COMPLETED' } ─ │               │
│      │  GET /api/transcription/download?format=docx                │  ┌─OSS JSON──┐
│      │  ────────────────────────────────────────► │ download      │─►│ fetch JSON│
│      │                                            │ 拉 JSON+生成  │  │ ←─解析   │
│      │  ◄──────── stream .docx Buffer ─────────── │ ≤300s         │  └───────────┘
└──────┘                                            └────────────────┘
```

---

## 1. 任务类型与路由

- ✅ **后端**（→ codex）：3 个新路由 + docx/txt 渲染 + Tingwu 任务参数 + `vercel.json` maxDuration
- ✅ **前端**（→ gemini）：状态机重构 + 4 步 Stepper + 智能轮询（visibility + 退避） + localStorage 恢复 + 下载按钮
- ❌ 旧的 `POST /api/tingwu-process` 整段删除（含 mock OpenAI Whisper 分支）；前端旧的 `tingwuResult` 显示面板（L429-473）整段删除

---

## 2. 新增 / 修改的环境变量（在 v2 已有基础上）

无新增。沿用 v2 的 `ALI_ACCESS_KEY_ID / ALI_ACCESS_KEY_SECRET / ALI_APP_KEY / LANGUAGE / APP_ACCESS_PASSWORD / BILIBILI_SESSDATA / ALLOWED_ORIGINS / DASHSCOPE_API_KEY`。

**可选新增 1 个**（用于 docx 元数据签名）：

| Name | 必填 | 说明 |
|------|------|------|
| `META_TOKEN_SECRET` | 可选 | 用于给前端 `metaToken` 做 HMAC 签名的密钥；不配则元数据走 URL query 直传（不安全但能用） |

---

## 3. 后端实施步骤

### Step 1 — 新增依赖

```bash
npm install docx@^9.6.1   # codex 验证过当前 npm 最新为 9.6.1，可用；保守可锁 8.5.0
```

### Step 2 — 新增 helper（`api/index.ts` 与 `api/server.ts` 同步）

```ts
// ============ 类型 ============
type TingwuStatus = 'ONGOING' | 'COMPLETED' | 'FAILED';

interface TingwuJson {
  Paragraphs: Array<{
    ParagraphId: string;
    Sentences: Array<{
      SentenceId: string | number;
      Start: number;             // ms
      End: number;               // ms
      Text: string;
      SpeakerId?: string;
    }>;
  }>;
}

interface ReadingParagraph {
  time: string;       // 'HH:MM:SS'
  speaker?: string;   // '说话人 1'
  text: string;
}

interface VideoMeta {
  title: string;
  bvid: string;
  durationMs?: number;
  fileName: string;   // 已清理过 Windows 非法字符
  source: '通义听悟';
}

// ============ 时间/段落 ============
function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function toReadingParagraphs(json: TingwuJson): ReadingParagraph[] {
  const out: ReadingParagraph[] = [];
  for (const p of json.Paragraphs || []) {
    let buf = '', startMs = 0, speaker: string | undefined;
    for (const s of p.Sentences || []) {
      const sp = s.SpeakerId ? `说话人 ${s.SpeakerId}` : undefined;
      const flush = buf && (buf.length + s.Text.length > 200 || sp !== speaker);
      if (flush) {
        out.push({ time: formatMs(startMs), speaker, text: buf.trim() });
        buf = '';
      }
      if (!buf) { startMs = s.Start; speaker = sp; }
      buf += s.Text.trim();
    }
    if (buf) out.push({ time: formatMs(startMs), speaker, text: buf.trim() });
  }
  return out;
}

// ============ 听悟调用（在 v2 基础上新增 GetTaskInfo） ============
async function getTingwuTaskInfo(taskId: string) {
  const cfg = getTingwuConfig();       // v2 中已定义
  const client = new OpenApiClient(new OpenApiConfig({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    endpoint: 'tingwu.cn-beijing.aliyuncs.com',
    protocol: 'https',
  }));
  const params = new Params({
    action: 'GetTaskInfo',
    version: '2023-09-30',
    pathname: `/openapi/tingwu/v2/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'json',
    bodyType: 'json',
  });
  const resp = await client.callApi(params, new OpenApiRequest({}), new RuntimeOptions({}));
  return resp.body;   // { Code, Data: { TaskStatus, ErrorMessage?, Result: { Transcription? } } }
}

// 把 v2 的 createTingwuTask 升级为接受 Parameters
async function createTingwuTask(
  fileUrl: string,
  language?: string,
  opts: { diarization?: boolean; textPolish?: boolean } = {},
): Promise<string> {
  const cfg = getTingwuConfig(language);
  const client = new OpenApiClient(new OpenApiConfig({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    endpoint: 'tingwu.cn-beijing.aliyuncs.com',
    protocol: 'https',
  }));
  const params = new Params({
    action: 'CreateTask',
    version: '2023-09-30',
    pathname: '/openapi/tingwu/v2/tasks',
    method: 'PUT',
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'json',
    bodyType: 'json',
  });
  const request = new OpenApiRequest({
    body: {
      AppKey: cfg.appKey,
      Input: { FileUrl: fileUrl, SourceLanguage: cfg.language },
      Parameters: {
        Transcription: opts.diarization
          ? { DiarizationEnabled: true, Diarization: { SpeakerCount: 0 } }
          : { DiarizationEnabled: false },
        TextPolish: { Switch: !!opts.textPolish },
        AutoChaptersEnabled: false,
        SummarizationEnabled: false,
      },
    },
  });
  const resp = await client.callApi(params, request, new RuntimeOptions({}));
  const taskId = resp.body?.Data?.TaskId || resp.body?.TaskId;
  if (!taskId) throw new Error('听悟返回缺少 TaskId');
  return taskId;
}

// ============ docx / txt 渲染 ============
async function renderDocx(meta: VideoMeta, paragraphs: ReadingParagraph[]): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx');
  const children = [
    new Paragraph({ text: meta.title || '转写结果', heading: HeadingLevel.TITLE }),
    new Paragraph(`BV号：${meta.bvid}`),
    new Paragraph(`时长：${meta.durationMs ? formatMs(meta.durationMs) : '-'}`),
    new Paragraph(`字幕来源：通义听悟`),
    new Paragraph(`转写时间：${new Date().toLocaleString('zh-CN')}`),
    new Paragraph({ text: '正文', heading: HeadingLevel.HEADING_1 }),
    ...paragraphs.map(p => new Paragraph({
      children: [
        new TextRun({ text: `[${p.time}] ` }),
        ...(p.speaker ? [new TextRun({ text: `${p.speaker}：`, bold: true })] : []),
        new TextRun(p.text),
      ],
    })),
  ];
  return await Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function renderTxt(meta: VideoMeta, paragraphs: ReadingParagraph[]): string {
  return [
    meta.title || '转写结果',
    `BV号：${meta.bvid}`,
    `时长：${meta.durationMs ? formatMs(meta.durationMs) : '-'}`,
    `字幕来源：通义听悟`,
    `转写时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    ...paragraphs.map(p => `[${p.time}] ${p.speaker ? `${p.speaker}：` : ''}${p.text}`),
  ].join('\n');
}

// ============ HMAC 签名 metaToken（解决 download 路由拿不到标题的问题） ============
import crypto from 'crypto';
function signMeta(meta: VideoMeta): string {
  const secret = process.env.META_TOKEN_SECRET?.trim() || 'unsafe-dev-key';
  const payload = Buffer.from(JSON.stringify(meta)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyMeta(token: string): VideoMeta | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const secret = process.env.META_TOKEN_SECRET?.trim() || 'unsafe-dev-key';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')); }
  catch { return null; }
}

// ============ 拉 OSS JSON ============
async function fetchTingwuJson(url: string): Promise<TingwuJson> {
  const resp = await axios.get(url, { timeout: 30000, responseType: 'json' });
  return resp.data as TingwuJson;
}
```

### Step 3 — 替换旧路由 / 新增三条新路由

**删除**：旧 `POST /api/tingwu-process`（api/index.ts:366-432 / api/server.ts:413-487 整段）

**新增 3 条路由**（插入位置：删除处的同位置）：

```ts
// ============ 1. 创建转写任务 ============
app.post('/api/transcription/start', async (req, res) => {
  try {
    const { bilibiliUrl, language, page, diarization, textPolish } = req.body || {};
    if (!bilibiliUrl) return res.status(400).json({ success: false, error: '缺少 bilibiliUrl' });

    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0);
    const taskId = await createTingwuTask(audio.audioUrl, language, { diarization, textPolish });

    // 标题与 BV 在 v2 helper 内已取到，这里把 videoInfo 也回带（建议把 getBilibiliDashAudioUrl 返回值扩充 title/durationMs）
    const meta: VideoMeta = {
      title: audio.title || audio.bvid,
      bvid: audio.bvid,
      durationMs: audio.durationMs,
      fileName: audio.fileName,
      source: '通义听悟',
    };

    res.json({
      success: true,
      data: {
        taskId,
        audioUrl: audio.audioUrl,
        audioFormat: audio.audioFormat,
        fileName: audio.fileName,
        expiresAt: audio.expiresAt,
        bandwidth: audio.bandwidth,
        source: audio.source,
        warning: audio.source === 'durl-fallback' ? '降级为 FLV，可能不被听悟接受' : null,
        metaToken: signMeta(meta),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : '创建任务失败' });
  }
});

// ============ 2. 查询任务状态 ============
app.get('/api/transcription/status', async (req, res) => {
  const taskId = String(req.query.taskId || '');
  if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });
  try {
    const info = await getTingwuTaskInfo(taskId);
    const raw = info.Data?.TaskStatus;
    const status: TingwuStatus =
      raw === 'COMPLETED' ? 'COMPLETED' :
      raw === 'FAILED'    ? 'FAILED'    : 'ONGOING';

    // Shadow Preview：完成时附带前 200 字符预览
    let preview: string | undefined;
    if (status === 'COMPLETED' && info.Data?.Result?.Transcription) {
      try {
        const json = await fetchTingwuJson(info.Data.Result.Transcription);
        const paragraphs = toReadingParagraphs(json);
        preview = paragraphs.slice(0, 2).map(p => p.text).join(' ').slice(0, 200);
      } catch { /* 预览失败不影响状态返回 */ }
    }

    res.json({
      success: true,
      data: {
        status,
        errorMessage: status === 'FAILED' ? info.Data?.ErrorMessage : undefined,
        transcriptionUrl: status === 'COMPLETED' ? info.Data?.Result?.Transcription : undefined,
        durationMs: info.Data?.DurationMs,
        preview,
      },
    });
  } catch (e) {
    res.status(502).json({ success: false, error: '查询任务失败，请稍后重试' });
  }
});

// ============ 3. 下载 docx / txt ============
app.get('/api/transcription/download', async (req, res) => {
  try {
    const taskId = String(req.query.taskId || '');
    const format = String(req.query.format || 'docx') as 'docx' | 'txt';
    const meta = verifyMeta(String(req.query.meta || '')) || {
      title: taskId, bvid: '-', durationMs: 0, fileName: `${taskId}.${format}`, source: '通义听悟',
    };

    if (!['docx', 'txt'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format 仅支持 docx 或 txt' });
    }

    const info = await getTingwuTaskInfo(taskId);
    if (info.Data?.TaskStatus === 'FAILED') {
      return res.status(409).json({ success: false, error: info.Data?.ErrorMessage || '转写失败' });
    }
    if (info.Data?.TaskStatus !== 'COMPLETED') {
      return res.status(409).json({ success: false, error: '任务尚未完成，请继续轮询' });
    }
    const url = info.Data?.Result?.Transcription;
    if (!url) return res.status(404).json({ success: false, error: '听悟结果中缺少转写 JSON URL' });

    let json: TingwuJson;
    try {
      json = await fetchTingwuJson(url);
    } catch (err: any) {
      const code = err?.response?.status;
      if (code === 403 || code === 404) {
        return res.status(410).json({ success: false, error: '转写结果已过期（约110分钟），请重新创建任务' });
      }
      return res.status(502).json({ success: false, error: '拉取转写 JSON 失败' });
    }

    const paragraphs = toReadingParagraphs(json);
    const fileBase = (meta.title || taskId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
    const fileName = `${fileBase}.${format}`;

    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      return res.send(renderTxt(meta, paragraphs));
    }

    const buf = await renderDocx(meta, paragraphs);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : '下载失败' });
  }
});
```

### Step 4 — `vercel.json` 增加 maxDuration

```json
{
  "version": 2,
  "builds": [
    { "src": "api/index.ts", "use": "@vercel/node" },
    { "src": "package.json", "use": "@vercel/static-build", "config": { "distDir": "dist" } }
  ],
  "functions": {
    "api/index.ts": { "maxDuration": 300 }
  },
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/index.ts" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```

> 因为整个后端共用一个 `api/index.ts` 函数，无法按路由细化超时。`start` / `status` 本身很快，不会触发 300s 上限；`download` 在极端长稿 + AI 排版时才有可能逼近。如果未来要按路由细分，需拆成 file-based functions（`api/transcription/start.ts` 等），那是另一次重构。

### Step 5 — 在 `getBilibiliDashAudioUrl`（v2 helper）中扩充返回字段

v2 计划返回 `{ bvid, cid, audioUrl, audioFormat, mimeType, bandwidth, fileName, source, expiresAt }`，**新计划要再加 `title` 和 `durationMs`**，用于 docx 元数据：

```ts
// 在 v2 helper 末尾的 return 对象中追加：
return {
  bvid, cid, audioUrl, audioFormat, mimeType, bandwidth, fileName, source, expiresAt,
  title: videoInfo?.data?.title || bvid,
  durationMs: (videoInfo?.data?.duration || 0) * 1000,   // B 站 duration 字段是秒，转毫秒
};
```

---

## 4. 前端实施步骤

### Step 6 — `src/App.tsx` 状态机重构

**删除**（旧 mock 与 OpenAI 路径）：
- L7-12 `ProcessingStatus` interface（替换为下面的 `TaskState`）
- L23-32 `tingwuResult` / `videoFileUrl` 相关 state（已在 v2 移除部分，本次再彻底清理）
- L140-186 `handleTingwuSubmit`（整段重写）
- L263-342 旧"通义听悟"面板（整段重写为 4 步 Stepper + 下载面板）
- L429-473 mock 转写结果显示（整段删除）

**新增**（state machine）：

```tsx
type TaskState =
  | { kind: 'IDLE' }
  | { kind: 'STARTING' }
  | { kind: 'POLLING'; taskId: string; meta: any; startedAt: number; nextDelayMs: number; consecutiveErrors: number }
  | { kind: 'COMPLETED'; taskId: string; meta: any; transcriptionUrl: string; preview?: string }
  | { kind: 'FAILED'; taskId?: string; errorMessage: string };

const [task, setTask] = useState<TaskState>({ kind: 'IDLE' });
const [elapsed, setElapsed] = useState(0);
const pollTimer = useRef<number | null>(null);

// 1. localStorage 恢复
useEffect(() => {
  const saved = localStorage.getItem('tingwu_task');
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (parsed.taskId) {
      setTask({
        kind: 'POLLING',
        taskId: parsed.taskId,
        meta: parsed.meta,
        startedAt: parsed.startedAt || Date.now(),
        nextDelayMs: 5000,
        consecutiveErrors: 0,
      });
      toast.info('检测到未完成的转写任务，已恢复轮询');
    }
  } catch {}
}, []);

// 2. 持久化
useEffect(() => {
  if (task.kind === 'POLLING') {
    localStorage.setItem('tingwu_task', JSON.stringify({
      taskId: task.taskId, meta: task.meta, startedAt: task.startedAt,
    }));
  } else if (task.kind === 'COMPLETED' || task.kind === 'FAILED' || task.kind === 'IDLE') {
    localStorage.removeItem('tingwu_task');
  }
}, [task]);

// 3. 已等待时间计时
useEffect(() => {
  if (task.kind !== 'POLLING') return;
  const id = window.setInterval(() => {
    setElapsed(Math.floor((Date.now() - task.startedAt) / 1000));
  }, 1000);
  return () => clearInterval(id);
}, [task]);

// 4. 轮询（带 visibility + 退避）
useEffect(() => {
  if (task.kind !== 'POLLING') return;
  let cancelled = false;

  const poll = async () => {
    if (cancelled) return;
    if (document.visibilityState === 'hidden') {
      pollTimer.current = window.setTimeout(poll, 10_000);
      return;
    }
    try {
      const { data } = await axios.get(`/api/transcription/status?taskId=${task.taskId}`);
      if (cancelled) return;
      const payload = data.data;
      if (payload.status === 'COMPLETED') {
        setTask({
          kind: 'COMPLETED',
          taskId: task.taskId,
          meta: task.meta,
          transcriptionUrl: payload.transcriptionUrl,
          preview: payload.preview,
        });
        toast.success('转写完成！文件已就绪');
        return;
      }
      if (payload.status === 'FAILED') {
        setTask({ kind: 'FAILED', taskId: task.taskId, errorMessage: payload.errorMessage || '转写失败' });
        return;
      }
      // ONGOING：退避
      const elapsedMs = Date.now() - task.startedAt;
      const next = elapsedMs < 60_000 ? 5000 : elapsedMs < 180_000 ? 15_000 : 30_000;
      setTask(prev => prev.kind === 'POLLING' ? { ...prev, nextDelayMs: next, consecutiveErrors: 0 } : prev);
      pollTimer.current = window.setTimeout(poll, next);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 410) {
        // OSS 过期
        setTask({ kind: 'FAILED', taskId: task.taskId, errorMessage: '任务结果已过期，请重新创建' });
        return;
      }
      setTask(prev => prev.kind === 'POLLING'
        ? { ...prev, consecutiveErrors: prev.consecutiveErrors + 1 }
        : prev);
      if (task.consecutiveErrors >= 2) {
        setTask({ kind: 'FAILED', taskId: task.taskId, errorMessage: '网络异常，已连续 3 次失败' });
        return;
      }
      pollTimer.current = window.setTimeout(poll, task.nextDelayMs);
    }
  };

  pollTimer.current = window.setTimeout(poll, 1000);  // 首次 1 秒后
  return () => {
    cancelled = true;
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
  };
}, [task.kind, task.kind === 'POLLING' ? task.taskId : null]);
```

**4 步 Stepper 组件**（替换旧 status 进度条）：

```tsx
function Stepper({ activeStep, isPolling }: { activeStep: number; isPolling: boolean }) {
  const steps = [
    { id: 1, label: '解析视频' },
    { id: 2, label: '提取音频' },
    { id: 3, label: '听悟转写' },
    { id: 4, label: '可下载' },
  ];
  return (
    <div className="flex justify-between items-center w-full max-w-md mx-auto my-6" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={activeStep}>
      {steps.map((s, i) => (
        <div key={s.id} className="flex flex-col items-center flex-1">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition ${
            activeStep > s.id ? 'bg-green-500 text-white' :
            activeStep === s.id ? `bg-indigo-600 text-white ${isPolling && s.id === 3 ? 'animate-pulse' : ''}` :
            'bg-gray-200 text-gray-500'
          }`}>
            {activeStep > s.id ? '✓' : s.id}
          </div>
          <span className="text-xs mt-1.5 text-gray-600">{s.label}</span>
          {i < steps.length - 1 && <span className="sr-only">→</span>}
        </div>
      ))}
    </div>
  );
}
```

**主面板**（替换 L263-342）：

```tsx
<div className="bg-white rounded-lg shadow-lg p-6 mb-6">
  <h2 className="text-lg font-semibold mb-4">转写到 Word 文档</h2>
  <Stepper
    activeStep={
      task.kind === 'IDLE' ? 0 :
      task.kind === 'STARTING' ? 2 :
      task.kind === 'POLLING' ? 3 :
      task.kind === 'COMPLETED' ? 4 :
      0
    }
    isPolling={task.kind === 'POLLING'}
  />

  {task.kind === 'IDLE' && (
    <button
      onClick={handleStart}
      disabled={!bilibiliUrl.trim()}
      className="w-full py-2.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
      <CloudUpload className="inline w-4 h-4 mr-1.5" />
      提交转写任务
    </button>
  )}

  {task.kind === 'STARTING' && <p className="text-center text-gray-600 py-3">提交中...</p>}

  {task.kind === 'POLLING' && (
    <div className="space-y-3">
      <p className="text-center text-sm text-gray-700" aria-live="polite">
        正在转写中... 已等待 <strong>{formatElapsed(elapsed)}</strong>
      </p>
      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
        <div className="h-2 bg-gradient-to-r from-indigo-500 via-blue-500 to-indigo-500 animate-[shimmer_2s_linear_infinite] bg-[length:200%_100%]" />
      </div>
      <div className="text-xs text-gray-500 flex justify-between">
        <span>任务 ID: {task.taskId.slice(0, 12)}... <button onClick={() => navigator.clipboard.writeText(task.taskId)} className="underline ml-1">复制</button></span>
        <button onClick={() => setTask({ kind: 'IDLE' })} className="text-red-500 underline">放弃轮询</button>
      </div>
    </div>
  )}

  {task.kind === 'COMPLETED' && (
    <div className="space-y-3">
      <p className="text-green-700 text-sm">✅ 转写完成！</p>
      {task.preview && (
        <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded border-l-4 border-indigo-400">
          <strong>预览：</strong>{task.preview}...
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <a
          href={`/api/transcription/download?taskId=${task.taskId}&format=docx&meta=${encodeURIComponent(task.meta.metaToken)}`}
          className="py-2.5 bg-blue-600 text-white rounded-md text-center hover:bg-blue-700">
          <FileText className="inline w-4 h-4 mr-1.5" />
          下载 Word 文档 (.docx)
        </a>
        <a
          href={`/api/transcription/download?taskId=${task.taskId}&format=txt&meta=${encodeURIComponent(task.meta.metaToken)}`}
          className="py-2.5 border border-gray-400 text-gray-700 rounded-md text-center hover:bg-gray-50">
          下载纯文本 (.txt)
        </a>
      </div>
      <button onClick={() => setTask({ kind: 'IDLE' })} className="text-xs text-gray-500 underline w-full text-center">
        开始新的转写
      </button>
    </div>
  )}

  {task.kind === 'FAILED' && (
    <div className="bg-red-50 border-l-4 border-red-500 p-3 rounded">
      <p className="text-red-700 font-medium">❌ 转写失败</p>
      <p className="text-red-600 text-sm mt-1">{task.errorMessage}</p>
      <button onClick={() => setTask({ kind: 'IDLE' })} className="mt-3 text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700">
        重新提交
      </button>
    </div>
  )}
</div>
```

**handleStart 函数**：

```tsx
async function handleStart() {
  if (!bilibiliUrl.trim()) { toast.error('请输入 B 站链接'); return; }
  setTask({ kind: 'STARTING' });
  try {
    const { data } = await axios.post('/api/transcription/start', {
      bilibiliUrl,
      diarization: false,    // 默认关闭说话人分离，加速转写
      textPolish: false,
    });
    if (!data.success) throw new Error(data.error);
    const d = data.data;
    if (d.warning) toast.warning(d.warning);
    setTask({
      kind: 'POLLING',
      taskId: d.taskId,
      meta: { metaToken: d.metaToken, fileName: d.fileName, audioFormat: d.audioFormat },
      startedAt: Date.now(),
      nextDelayMs: 5000,
      consecutiveErrors: 0,
    });
  } catch (e: any) {
    setTask({ kind: 'FAILED', errorMessage: e?.response?.data?.error || e.message || '提交失败' });
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
```

**lucide-react 导入更新**：
```ts
import { FileText, Loader2, HelpCircle, CloudUpload, Check } from 'lucide-react';
// 移除：Video（不再需要）
```

**Tailwind shimmer 动画**（`tailwind.config.js` 加 keyframes）：
```js
module.exports = {
  // ...
  theme: {
    extend: {
      keyframes: {
        shimmer: {
          '0%':   { 'background-position': '200% 0' },
          '100%': { 'background-position': '-200% 0' },
        },
      },
    },
  },
};
```

---

## 5. 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 修改 | 在 v2 基础上再加 `docx@^9.6.1` |
| `vercel.json` | 修改 | 新增 `functions.api/index.ts.maxDuration: 300` |
| `api/index.ts` | 重构 | 删除 `/api/tingwu-process`；新增 `getTingwuTaskInfo` / `formatMs` / `toReadingParagraphs` / `renderDocx` / `renderTxt` / `signMeta` / `verifyMeta` / `fetchTingwuJson`；新增 3 个路由 |
| `api/server.ts` | 重构 | 与 `api/index.ts` 同步 |
| `src/App.tsx` | 重写主面板 | 删除旧 `tingwuResult` 显示 + mock 分支；新增 `TaskState` 状态机、`Stepper`、轮询 `useEffect`、`handleStart`、下载链接 |
| `tailwind.config.js` | 修改 | 新增 `shimmer` keyframes |
| `README.md` | 更新 | 文档"使用流程"段落改为：1. 输入 URL → 2. 提交 → 3. 等待 → 4. 下载 docx |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 听悟拉取 B 站 m4a 仍可能 403（Referer 问题，v2 已识别） | 🔴 高 | 实测确认；若失败必须加 OSS 中转（独立第三期） |
| 长视频转写超过 Vercel 300s | 🟡 中 | 不是问题：转写是在听悟后台做，我们只轮询；只有 `download` 路由有 300s 限制 |
| `download` 路由 + AI 排版 + 长稿 → 接近 300s | 🟡 中 | v1 不做 AI 排版，只生成原始 docx/txt；体量大时 docx 渲染本身 < 5 秒 |
| 转写 OSS URL 110 分钟过期 | 🟡 中 | `status` 路由检测到 410 → 前端 `kind: 'FAILED'` + "重新提交"按钮；用户在状态完成后应尽快下载 |
| localStorage 中残留过期 taskId | 🟢 低 | 轮询若收到 410 自动清除 `tingwu_task` |
| 轮询消耗 Vercel Function Invocations | 🟢 低 | Visibility API 暂停 + 退避 5→15→30s；Hobby 月度配额 100k 次足够个人用 |
| docx npm 包体积（~600KB） | 🟢 低 | 服务端依赖，不进前端 bundle |
| docx 中文文件名在 Safari 上可能乱码 | 🟢 低 | 已用 RFC 5987 `filename*=UTF-8''<encoded>` 格式 |
| `META_TOKEN_SECRET` 未配 → 用 fallback "unsafe-dev-key" | 🟡 中 | 生产环境必须配；不配时计划没破坏功能，只是 meta 可被伪造（影响只是 docx 标题被改） |
| 把假 MP3 / FLV 降级文件交给听悟 → 听悟拒绝 | 🟡 中 | `start` 路由对 `source === 'durl-fallback'` 直接 toast warning；用户可选择重新尝试 |

---

## 7. 验证步骤

```bash
npm install docx@^9.6.1
npm run check
npm run build

# 本地后端
npm run dev:backend
curl http://localhost:9090/api/health
# 期望 {"status":"ok"}

# 1. 提交任务
curl -X POST http://localhost:9090/api/transcription/start \
  -H "Content-Type: application/json" \
  -H "X-App-Password: <pw>" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/BV1xxxx"}'
# 期望：{ success: true, data: { taskId, audioUrl, metaToken, ... } }

# 2. 轮询状态（每 5 秒）
curl "http://localhost:9090/api/transcription/status?taskId=<TASKID>" -H "X-App-Password: <pw>"
# 期望：先 { status: 'ONGOING' }，最终 { status: 'COMPLETED', transcriptionUrl, preview }

# 3. 下载 docx
curl -OJ "http://localhost:9090/api/transcription/download?taskId=<TASKID>&format=docx&meta=<METATOKEN>" -H "X-App-Password: <pw>"
# 期望：本地生成 <视频标题>.docx，用 Word 打开能看到正文

# 4. 下载 txt
curl "http://localhost:9090/api/transcription/download?taskId=<TASKID>&format=txt&meta=<METATOKEN>" -H "X-App-Password: <pw>" -o test.txt
cat test.txt
# 期望：纯文本 + [HH:MM:SS] 时间戳
```

Vercel 部署后：
- ✅ 前端首屏：登录遮罩（v2）
- ✅ 输入 B 站 URL → 点"提交转写任务" → Stepper 推进到第 3 步 → "已等待 1分30秒..."
- ✅ 任务完成 → 第 4 步绿色对勾 → 显示预览 + 2 个下载按钮
- ✅ 点"下载 Word 文档" → 浏览器收到 .docx → Word 打开正常显示中文 + 时间戳
- ✅ 中途刷新页面 → toast "已恢复轮询" + Stepper 继续推进
- ✅ 切换 tab 离开 → 轮询暂停（Network 面板可见）；回到 tab → 立刻续上

---

## 8. 用户需要决策的 3 个问题（codex 提出）

| # | 问题 | 计划默认 | 备选 |
|---|------|----------|------|
| 1 | 是否启用 `metaToken`（HMAC 签名传 title/BV）？ | ✅ 启用（更稳） | 关闭则 docx 标题降级为 taskId |
| 2 | 是否在 v1 加 OSS 中转（绕开听悟拉 B 站 403）？ | ❌ 不加（先实测） | 实测失败后必须加 |
| 3 | AI 排版（DashScope/通义千问）是默认开启还是按钮可选？ | ❌ 不在本期实现 | 第二期作为 download 路由的 `?mode=ai-formatted` 参数 |
| 4 | 听悟参数 `DiarizationEnabled`（说话人分离）？ | ❌ 默认关闭（更快） | 前端加 checkbox 让用户开 |

如需调整，告诉我，我会更新计划。

---

## 9. 与 v2 计划的衔接

执行顺序建议：

1. 先实施 `.claude/plan/vercel-fixes.md` 的 **Step 1-5**（通义听悟签名、共享密码、DASH 音频流、前端登录遮罩 + 视频→音频文案更新）
2. 再实施本计划的 **Step 1-6**（docx 渲染、3 路由、状态机、Stepper）

可以在一次 `/ccg:execute` 中合并执行，告诉执行命令同时读两个 plan 文件即可。

---

## 10. SESSION_ID（供 `/ccg:execute resume <SESSION_ID>` 使用）

- **CODEX_SESSION**: `019e1a61-2fd8-7f33-a27e-ece56463f0dc`
- **GEMINI_SESSION**: `19d1f03a-8088-40b4-9081-9a7f35fde552`

执行命令：

```
/ccg:execute .claude/plan/transcription-to-docx.md
```
