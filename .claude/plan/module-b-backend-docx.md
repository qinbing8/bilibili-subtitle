# 模块 B：转写到 docx 后端（docx 计划全部后端工作）

> **窗口**：Codex CLI 窗口 2
> **启动时机**：**必须等模块 A 完成**（看到 `.claude/plan/STATUS.md` 中"模块 A 完成"的记录后再启动）
> **预估时间**：10-20 分钟
> **依赖前置**：模块 A 的所有 helper（`getTingwuConfig`、`getBilibiliDashAudioUrl`、`requireApiAccess`、`@alicloud/openapi-client`、`docx` 依赖）
> **下游依赖者**：模块 C（前端调用的接口由本模块实现）

> **参考文件**（必读）：
> - `.claude/plan/transcription-to-docx.md`（docx 计划，本模块是其后端部分的执行包）
> - `.claude/plan/modular-split.md`（接口契约 §3）
> - `.claude/plan/module-a-backend-infra.md`（确认 A 完成的状态）
>
> **可恢复 Codex Session**：`019e1a61-2fd8-7f33-a27e-ece56463f0dc`（docx 设计上下文）

---

## 0. 启动前检查（必须先完成）

```bash
# 1. 确认模块 A 已完成
cat .claude/plan/STATUS.md
# 期望：能看到 "模块 A 完成 (commit: xxxx)" 这一行

# 2. 确认依赖已安装（docx 是 A 一次性装好的）
grep '"docx"' package.json
# 期望：能看到 "docx": "^9.6.1"

# 3. 确认 A 的 helper 都已存在
grep -E 'getTingwuConfig|getBilibiliDashAudioUrl|requireApiAccess' api/index.ts | head -3
# 期望：三个函数都能匹配到
```

如果以上任一项失败，**停下来报告"模块 A 不完整"**，不要继续。

---

## 1. 本模块的写权限文件

| 文件 | 操作 |
|------|------|
| `api/index.ts` | 增量修改：新增 helper + 新增 3 路由 |
| `api/server.ts` | 大改：与 `api/index.ts` 完全同步（含 A 和 B 全部修改） |
| `vercel.json` | 修改：新增 `functions.maxDuration: 300` |

**严禁修改**：`src/App.tsx`、`tailwind.config.js`、任何前端文件、`package.json`（A 已装好所有依赖）。

---

## 2. Step B1 — 在 `api/index.ts` 新增 helper

在 A 的现有 helper 区段（紧跟 `getBilibiliDashAudioUrl` 之后）追加：

```ts
// ============ docx/txt 类型 ============
type TingwuStatus = 'ONGOING' | 'COMPLETED' | 'FAILED';

interface TingwuJson {
  Paragraphs: Array<{
    ParagraphId: string;
    Sentences: Array<{
      SentenceId: string | number;
      Start: number;        // ms
      End: number;          // ms
      Text: string;
      SpeakerId?: string;
    }>;
  }>;
}

interface ReadingParagraph {
  time: string;
  speaker?: string;
  text: string;
}

interface VideoMeta {
  title: string;
  bvid: string;
  durationMs?: number;
  fileName: string;
  source: '通义听悟';
}

// ============ 听悟 GetTaskInfo ============
async function getTingwuTaskInfo(taskId: string) {
  const cfg = getTingwuConfig();
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
  return resp.body;
}

// ============ 时间格式化 ============
function formatMs(ms: number): string {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// ============ 把 Tingwu JSON 转成可读段落 ============
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

// ============ 渲染 docx ============
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

// ============ 渲染 txt ============
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

// ============ HMAC 签名 metaToken ============
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

> ⚠️ `import crypto from 'crypto'` 应该放到文件顶部 import 区。

---

## 3. Step B2 — 在 `api/index.ts` 新增 3 个路由

放在 `/api/download-video` 路由之后、`export default app` 之前：

### B2.1 `POST /api/transcription/start`

```ts
app.post('/api/transcription/start', async (req, res) => {
  try {
    const { bilibiliUrl, language, page, diarization, textPolish } = req.body || {};
    if (!bilibiliUrl) return res.status(400).json({ success: false, error: '缺少 bilibiliUrl' });

    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0);
    const taskId = await createTingwuTask(audio.audioUrl, language, {
      diarization: !!diarization,
      textPolish: !!textPolish,
    });

    const meta: VideoMeta = {
      title: audio.title,
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
        warning: audio.source === 'durl-fallback'
          ? '降级为 FLV（含视频），听悟可能拒绝。建议配置 BILIBILI_SESSDATA。'
          : null,
        metaToken: signMeta(meta),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : '创建任务失败' });
  }
});
```

### B2.2 `GET /api/transcription/status`

```ts
app.get('/api/transcription/status', async (req, res) => {
  const taskId = String(req.query.taskId || '');
  if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });

  try {
    const info: any = await getTingwuTaskInfo(taskId);
    const raw = info?.Data?.TaskStatus;
    const status: TingwuStatus =
      raw === 'COMPLETED' ? 'COMPLETED' :
      raw === 'FAILED'    ? 'FAILED'    : 'ONGOING';

    let preview: string | undefined;
    if (status === 'COMPLETED' && info?.Data?.Result?.Transcription) {
      try {
        const json = await fetchTingwuJson(info.Data.Result.Transcription);
        const paragraphs = toReadingParagraphs(json);
        preview = paragraphs.slice(0, 2).map(p => p.text).join(' ').slice(0, 200);
      } catch { /* 预览失败不影响主流程 */ }
    }

    res.json({
      success: true,
      data: {
        status,
        errorMessage: status === 'FAILED' ? info?.Data?.ErrorMessage : undefined,
        transcriptionUrl: status === 'COMPLETED' ? info?.Data?.Result?.Transcription : undefined,
        durationMs: info?.Data?.DurationMs,
        preview,
      },
    });
  } catch (e) {
    res.status(502).json({ success: false, error: '查询任务失败，请稍后重试' });
  }
});
```

### B2.3 `GET /api/transcription/download`

```ts
app.get('/api/transcription/download', async (req, res) => {
  try {
    const taskId = String(req.query.taskId || '');
    const format = String(req.query.format || 'docx') as 'docx' | 'txt';
    const meta: VideoMeta = verifyMeta(String(req.query.meta || '')) || {
      title: taskId,
      bvid: '-',
      durationMs: 0,
      fileName: `${taskId}.${format}`,
      source: '通义听悟',
    };

    if (!['docx', 'txt'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format 仅支持 docx 或 txt' });
    }

    const info: any = await getTingwuTaskInfo(taskId);
    if (info?.Data?.TaskStatus === 'FAILED') {
      return res.status(409).json({ success: false, error: info?.Data?.ErrorMessage || '转写失败' });
    }
    if (info?.Data?.TaskStatus !== 'COMPLETED') {
      return res.status(409).json({ success: false, error: '任务尚未完成，请继续轮询' });
    }
    const url = info?.Data?.Result?.Transcription;
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

---

## 4. Step B3 — 更新 `vercel.json`

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

> 注意保留模块 A 已有的 routes 配置；本步骤只新增 `functions` 字段。

---

## 5. Step B4 — 完整同步 `api/server.ts`

`api/server.ts` 必须包含模块 A + 模块 B 的**全部修改**，与 `api/index.ts` 内容**完全一致**（除了 `api/server.ts` 末尾的 `app.listen(port, ...)` 启动代码保留，`api/index.ts` 末尾是 `export default app`）。

**操作方法**：

```bash
# 1. 用 diff 工具对照差异
diff api/index.ts api/server.ts | head -100
# 期望：差异只剩末尾的 export default vs app.listen

# 2. 用文件复制 + 手工保留 listen 块
# （Codex 应该直接生成完整 api/server.ts，按 api/index.ts 镜像即可）
```

---

## 6. 验收清单

```bash
# 1. 类型检查
npm run check
# 期望：无错

# 2. 启动后端
npm run dev:backend

# 3. 提交任务（先在 .env.local 配置好 ALI_* 三个 + APP_ACCESS_PASSWORD）
curl -X POST http://localhost:9090/api/transcription/start \
  -H "Content-Type: application/json" \
  -H "X-App-Password: <pw>" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/<真实BV号>"}'
# 期望：返回 { success: true, data: { taskId, metaToken, audioUrl, ... } }
# 记下 taskId 和 metaToken

# 4. 查询状态（开始时 ONGOING，几分钟后 COMPLETED）
curl "http://localhost:9090/api/transcription/status?taskId=<TASKID>" -H "X-App-Password: <pw>"
# 期望：先返回 { status: 'ONGOING' }，等几分钟后 { status: 'COMPLETED', transcriptionUrl, preview }

# 5. 下载 docx
curl -OJ "http://localhost:9090/api/transcription/download?taskId=<TASKID>&format=docx&meta=<METATOKEN>" -H "X-App-Password: <pw>"
# 期望：保存为 <视频标题>.docx，用 Word 打开能看到正文 + 时间戳

# 6. 下载 txt
curl "http://localhost:9090/api/transcription/download?taskId=<TASKID>&format=txt&meta=<METATOKEN>" -H "X-App-Password: <pw>" -o test.txt
head -20 test.txt
# 期望：纯文本，第一行视频标题，含 [HH:MM:SS] 时间戳

# 7. 错误处理
curl "http://localhost:9090/api/transcription/download?taskId=invalid&format=docx" -H "X-App-Password: <pw>"
# 期望：HTTP 4xx，JSON 错误信息

# 8. api/server.ts 与 api/index.ts 一致性
diff api/index.ts api/server.ts | grep -v "export default app" | grep -v "app.listen"
# 期望：除了启动方式行，无其他差异
```

---

## 7. 完成后通知

```bash
git add -A
git commit -m "feat(backend): add transcription pipeline (start/status/download) with docx renderer"
```

在 `.claude/plan/STATUS.md` 追加：

```
- <YYYY-MM-DD HH:MM> — 模块 B 完成 (commit: <短 hash>)
```

告诉协调者："模块 B 完成。等待模块 C 完成后即可联调。"

---

## 8. 严禁事项

- ❌ 不要修改前端任何文件（`src/App.tsx`、`tailwind.config.js`）
- ❌ 不要改 `package.json`（A 已装好所有依赖）
- ❌ 不要 touch `.env.example`（A 已包含 `META_TOKEN_SECRET` 等所有键）
- ❌ 不要"顺便"加 OSS 中转（那是第三期）
- ❌ 不要"顺便"加 AI 排版模式（那是第二期，本期 download 路由不支持 `mode=ai-formatted`）

如发现 A 的 helper 有 bug，先在本窗口修复，commit message 写 `fix(module-a): ...`，并在 STATUS.md 标注修复。
