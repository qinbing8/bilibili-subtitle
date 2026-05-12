# 模块 A：后端基础设施（v2 计划全部后端工作）

> **窗口**：Codex CLI 窗口 1
> **启动时机**：T=0，可与模块 C 并行
> **预估时间**：10-20 分钟
> **依赖前置**：无
> **下游依赖者**：模块 B（必须等本模块完成）

> **参考文件**（必读）：
> - `.claude/plan/vercel-fixes.md`（v2 计划，本模块是其后端部分的执行包）
> - `.claude/plan/modular-split.md`（拆分策略 + 接口契约）
>
> **可恢复 Codex Session**：`019e1a34-19ab-7292-89b8-9e044074647a`（包含前期签名 + 音频流分析）

---

## 0. 本模块的写权限文件（**只允许动这些文件**）

| 文件 | 操作 |
|------|------|
| `package.json` | 修改：一次性加全部 npm 依赖（含 docx，给模块 B 用） |
| `.env.example` | 新建 |
| `api/index.ts` | 大改：写完整 v2 改造 |
| `api/server.ts` | 大改：与 `api/index.ts` 完全同步 |

**严禁修改**：`src/App.tsx`、`tailwind.config.js`、`vercel.json`、`README.md`、`DEPLOYMENT.md`、任何前端文件。

---

## 1. Step A1 — 安装依赖（一次性，含模块 B 的依赖）

```bash
npm install @alicloud/openapi-client @alicloud/tea-util docx
npm install -D @types/node
```

> ⚠️ 注意 `docx` 是给模块 B 用的，但在这里一次性装好可以避免后续 `package.json` 冲突。`docx@^9.6.1` 是 codex 验证过的当前最新版。

---

## 2. Step A2 — 创建 `.env.example`

```bash
# 阿里云通义听悟（必填，全部 3 个）
ALI_ACCESS_KEY_ID=
ALI_ACCESS_KEY_SECRET=
ALI_APP_KEY=

# 通义听悟语言（可选，默认 auto）
LANGUAGE=auto

# 通义千问（DashScope，用于 B 站字幕的 AI 排版；与听悟密钥不同）
DASHSCOPE_API_KEY=

# 共享访问密码（必填，用户在登录页输入此密码）
APP_ACCESS_PASSWORD=

# B 站 SESSDATA Cookie（可选，但建议配；不配的视频可能拿不到高清音频）
BILIBILI_SESSDATA=

# CORS 允许的来源（可选，逗号分隔）
ALLOWED_ORIGINS=https://your-project.vercel.app,http://localhost:5173

# 元数据签名密钥（可选；模块 B 才会用到，但在这里一次性预设）
META_TOKEN_SECRET=
```

---

## 3. Step A3 — 改造 `api/index.ts`

按 `.claude/plan/vercel-fixes.md` 的 Step 2-4 + Step 3.1 全部执行。具体清单：

### A3.1 顶部新增（在 `import` 之后）

```ts
import OpenApiClient, { Config as OpenApiConfig, Params, OpenApiRequest } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';

// ============ 环境变量读取 ============
function readRequiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`服务端缺少环境变量 ${name}`);
  return v;
}

function getTingwuConfig(language?: string) {
  return {
    accessKeyId: readRequiredEnv('ALI_ACCESS_KEY_ID'),
    accessKeySecret: readRequiredEnv('ALI_ACCESS_KEY_SECRET'),
    appKey: readRequiredEnv('ALI_APP_KEY'),
    language: language || process.env.LANGUAGE || 'auto',
  };
}

// ============ B 站请求 headers（参考脚本风格） ============
function getBilibiliHeaders() {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
  };
  const sessdata = process.env.BILIBILI_SESSDATA?.trim();
  if (sessdata) {
    headers.Cookie = sessdata.startsWith('SESSDATA=') ? sessdata : `SESSDATA=${sessdata}`;
  }
  return headers;
}

function sanitizeFileName(name: string, fallback = 'bilibili_audio'): string {
  let r = String(name || '');
  r = r.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  r = r.replace(/[\\/:*?"<>|]/g, '_');
  r = r.replace(/[\x00-\x1f\x7f]/g, '');
  r = r.replace(/\s+/g, ' ').trim();
  r = r.replace(/[.\s]+$/g, '');
  if (r.length > 180) r = r.slice(0, 180).trim().replace(/[.\s]+$/g, '');
  return r || fallback;
}

function buildAudioFileName(title: string, bvid: string, page?: { page: number; part: string } | null): string {
  const main = sanitizeFileName(title, bvid);
  if (page && page.page > 1) {
    const part = sanitizeFileName(page.part || '', '');
    const suffix = part && part !== main ? ` - P${page.page} ${part}` : ` - P${page.page}`;
    return `${sanitizeFileName(main + suffix, main)}.m4a`;
  }
  return `${main}.m4a`;
}
```

### A3.2 替换 `createTingwuTask`（删除 L105-138 整段）

```ts
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
```

### A3.3 替换 `formatWithAI`（删除 accessKey 入参）

```ts
async function formatWithAI(text: string): Promise<string> {
  const apiKey = readRequiredEnv('DASHSCOPE_API_KEY');
  try {
    const response = await axios.post('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: '你是一个专业的学习笔记整理助手。请将提供的视频字幕内容整理成结构清晰、易于学习的Markdown格式笔记。要求：1. 生成内容摘要和大纲；2. 根据语义进行智能分段；3. 添加合适的标题；4. 优化标点和错别字；5. 保持时间戳信息。' },
        { role: 'user', content: text },
      ],
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    return response.data.choices[0]?.message?.content || text;
  } catch (error) {
    console.error('AI formatting failed:', error);
    return text;
  }
}
```

### A3.4 替换 B 站音频获取（删除 `getVideoDownloadUrl` + `extractAudioFromVideo`）

```ts
async function getBilibiliDashAudioUrl(bilibiliUrl: string, pageIndex = 0) {
  const bvid = extractBVID(bilibiliUrl);
  if (!bvid) throw new Error('无法从链接中提取BV号');
  const videoInfo = await getVideoInfo(bvid);
  const cid = pickCID(videoInfo, pageIndex);
  if (!cid) throw new Error('无法获取视频CID');

  const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1&qn=80`;
  const resp = await axios.get(playUrl, { headers: getBilibiliHeaders(), timeout: 10000 });
  if (resp.data?.code !== 0) {
    throw new Error(`B站 playurl 错误: ${resp.data?.message || resp.data?.code}`);
  }

  const data = resp.data?.data;
  const title: string = videoInfo?.data?.title || bvid;
  const durationMs = (videoInfo?.data?.duration || 0) * 1000;
  const pages = videoInfo?.data?.pages || [];
  const selectedPage = pages[pageIndex] || pages[0] || null;
  const fileName = buildAudioFileName(title, bvid, selectedPage);

  // 路径 A：DASH 优先
  const audioList = data?.dash?.audio || [];
  if (audioList.length > 0) {
    const best = [...audioList].sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const audioUrl = best.baseUrl || best.base_url || best.backupUrl?.[0] || best.backup_url?.[0];
    if (audioUrl) {
      return {
        bvid, cid, audioUrl,
        audioFormat: 'm4a' as const,
        mimeType: best.mimeType || best.mime_type || 'audio/mp4',
        bandwidth: best.bandwidth || 0,
        fileName,
        source: 'dash' as const,
        title,
        durationMs,
        expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
      };
    }
  }

  // 路径 B：FLV fallback
  if (data?.durl && data.durl.length > 0) {
    return {
      bvid, cid,
      audioUrl: data.durl[0].url,
      audioFormat: 'flv' as const,
      mimeType: 'video/x-flv',
      bandwidth: 0,
      fileName: fileName.replace(/\.m4a$/, '.flv'),
      source: 'durl-fallback' as const,
      title,
      durationMs,
      expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
    };
  }

  if (!process.env.BILIBILI_SESSDATA) {
    throw new Error('B站未返回音频流；该视频可能需要登录，请在 Vercel 配置 BILIBILI_SESSDATA');
  }
  throw new Error('B站未返回任何可用音频流，可能是版权受限视频');
}
```

### A3.5 替换 CORS + 访问控制（在 `app.use(cors())` 处）

```ts
const corsOptions = {
  origin(origin: string | undefined, cb: any) {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  allowedHeaders: ['Content-Type', 'X-App-Password', 'Authorization'],
  methods: ['GET', 'POST', 'OPTIONS'],
};
app.use(cors(corsOptions));
app.use(express.json());

function requireApiAccess(req: any, res: any, next: any) {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/api/health') return next();
  const expected = process.env.APP_ACCESS_PASSWORD?.trim();
  if (!expected) {
    return res.status(503).json({ success: false, error: '服务端未配置 APP_ACCESS_PASSWORD' });
  }
  const provided = req.get('X-App-Password') || '';
  if (provided !== expected) {
    return res.status(401).json({ success: false, error: '未授权访问' });
  }
  next();
}
app.use('/api', requireApiAccess);
```

### A3.6 改造 `/api/download-video` 路由

```ts
app.post('/api/download-video', async (req, res) => {
  try {
    const { bilibiliUrl, page } = req.body || {};
    if (!bilibiliUrl) return res.status(400).json({ success: false, error: '缺少B站视频链接' });
    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0);
    const warning = audio.source === 'durl-fallback'
      ? '⚠️ 未拿到 DASH 音频流，降级为 FLV（含视频）。建议配置 BILIBILI_SESSDATA 或换一个视频。'
      : null;
    res.json({
      success: true,
      data: {
        audioUrl: audio.audioUrl,
        videoUrl: audio.audioUrl,             // 兼容字段
        audioFormat: audio.audioFormat,
        mimeType: audio.mimeType,
        bandwidth: audio.bandwidth,
        fileName: audio.fileName,
        source: audio.source,
        expiresAt: audio.expiresAt,
        warning,
        message: '音频直链获取成功',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : '获取音频失败' });
  }
});
```

### A3.7 改造 `/api/process-video` 路由

把 `req.body.accessKey` 的使用全部移除；`formatWithAI(markdownContent)` 不再传 `accessKey`。

### A3.8 删除 `/api/tingwu-process` 路由（整段）

**A 模块的范围里不需要重新实现这个路由——模块 B 会在新位置加 3 个新路由 `/api/transcription/start|status|download`。** A 直接删干净。

### A3.9 清理日志

删除 `console.log('Received request:', req.body)`（L227 附近），避免泄露用户输入。

---

## 4. Step A4 — 同步 `api/server.ts`

`api/server.ts` 是本地开发副本，**必须与 `api/index.ts` 完全一致**。逐行 mirror 上述所有修改。

> ⚠️ 模块 B 也会改 `api/server.ts`，但 B 启动时本模块已完成。模块 B 的工作里有"再次完整同步" step，确保最终一致。

---

## 5. 验收清单（必须全部通过才能告诉用户"A 完成"）

```bash
# 1. 类型检查
npm run check
# 期望：无错

# 2. 启动本地后端
npm run dev:backend
# 期望：监听 9090 端口，无未捕获异常

# 3. Health check（公开，无需密码）
curl http://localhost:9090/api/health
# 期望：{"status":"ok"}

# 4. 无密码访问 /api/download-video（受保护）
curl -X POST http://localhost:9090/api/download-video \
  -H "Content-Type: application/json" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/BV1xxxx"}'
# 期望：HTTP 401，{ success: false, error: "未授权访问" }

# 5. 错误密码
curl -X POST http://localhost:9090/api/download-video \
  -H "Content-Type: application/json" \
  -H "X-App-Password: wrong" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/BV1xxxx"}'
# 期望：HTTP 401

# 6. 正确密码 + 真实 BV 号
# 先在 .env.local 或 shell 中配置环境变量
curl -X POST http://localhost:9090/api/download-video \
  -H "Content-Type: application/json" \
  -H "X-App-Password: <你设的密码>" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/<真实BV号>"}'
# 期望：返回 audioUrl 是真实的 B 站 m4a 直链（包含 .bilivideo.com 域名）
#       字段齐全：audioUrl, audioFormat, bandwidth, fileName, source
```

---

## 6. 完成后的通知

执行 commit 并在 `.claude/plan/STATUS.md` 追加一行（如不存在则创建）：

```
- <YYYY-MM-DD HH:MM> — 模块 A 完成 (commit: <短 hash>)
```

然后告诉协调者："模块 A 已完成。模块 B 可启动。"

---

## 7. 严禁事项

- ❌ 不要修改 `src/App.tsx`、`tailwind.config.js`、`README.md`、`DEPLOYMENT.md`
- ❌ 不要改 `vercel.json`（模块 B 负责）
- ❌ 不要新增 `/api/transcription/*` 路由（模块 B 负责）
- ❌ 不要写 `docx` 相关代码（模块 B 负责，依赖已经预装好）
- ❌ 不要尝试"顺便"重构其他不相关的代码

如发现本计划范围外的紧急修改需求，**暂停并报告**，由协调者决定是否扩大范围。
