# 实施计划：Vercel 部署三个问题修复（通义听悟 + 访问控制 + 音频下载）

> **修订记录**
> - v1（初版）：codex + gemini 双模型分析，三个问题的初步方案
> - **v2（本版）**：基于参考脚本 `D:\workspeace\bilibili_onlyddownload_mp3\bilibili_audio_downloader.user.js`（v0.7.0）逐行分析，补充问题三的实战细节：playurl 完整参数、Referer 用根域、`data.durl` FLV 降级、文件名清理、"伪 MP3"陷阱、浏览器下载受 Referer 校验影响的解决方案、新增可选的 `/api/download-audio-proxy` 接口

> 综合 codex（后端权威）+ gemini（前端权威）双模型分析 + 参考脚本印证后由 Claude 整合产出。
> 仅规划，未修改任何文件。
> 用户问题原文：
> - 问题一：部署 Vercel 调用通义听悟 API 404，已在 Vercel Settings 填入 `ALI_ACCESS_KEY_ID / ALI_ACCESS_KEY_SECRET / LANGUAGE` 三个环境变量。
> - 问题二：Vercel 部署没有访问密码，是否任何人打开网址都能用？
> - 问题三：是否可以把"获取下载链接的 `.mp4`"改成纯音频 `.m4a` 或 `.mp3`？

---

## 0. 三个问题的直接回答（在动手前先看）

### Q1：填了环境变量为什么还 404？
**填了不够，并且代码根本没在读这些环境变量**：

| 现状 | 应该是 |
|------|-------|
| 调用 `https://tingwu.aliyuncs.com/api/v1/tasks` | `https://tingwu.cn-beijing.aliyuncs.com/openapi/tingwu/v2/tasks`，方法 `PUT`，API 版本 `2023-09-30` |
| `Authorization: Bearer <accessKey>` | 阿里云 ROA 签名（AccessKey ID + AccessKey Secret 二者一起 HMAC 签名，**不是** Bearer Token） |
| `AppKey: 'test-app-key'`（写死） | 听悟控制台单独申请的真实 AppKey，需要新增第 4 个环境变量 `ALI_APP_KEY` |
| 前端把 AccessKey 经 body 传给后端 | AccessKey 不应出浏览器，全部在服务端读环境变量 |
| 代码完全没有出现 `process.env.ALI_*` | 用 `readRequiredEnv('ALI_ACCESS_KEY_ID' / 'ALI_ACCESS_KEY_SECRET' / 'ALI_APP_KEY')` 真正读取 |

**结论**：404 是端点 + 签名 + AppKey 三件套全错；环境变量是必要不充分条件，代码必须改。同时**漏了一个环境变量 `ALI_APP_KEY`**。

### Q2：没有访问密码 = 谁都能用吗？
**是的**。`api/index.ts:7` 是 `app.use(cors())` 全开，没有任何鉴权。CORS 只是浏览器策略，任何人用 `curl` 或写脚本都能直接打 `/api/process-video`、`/api/tingwu-process`、`/api/download-video` 三个接口，**用掉你阿里云账户的钱**。

可选方案（codex 推荐，与免费 Vercel 单用户场景匹配）：

| 方案 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| **共享密码 Header**（推荐） | 免费 / 实现快 / Serverless 友好 | 密码泄露需轮换 | ✅ 本项目 |
| HTTP Basic Auth | 浏览器原生 | 只保护 API，不保护静态页面 | ❌ |
| Vercel Password Protection | 整站保护，最省心 | Pro 计划付费功能 | ❌（免费版没有） |
| IP 白名单 | 强约束 | 移动/家庭 IP 易变 | ❌ |

### Q3：能否改成纯音频？
**可以，且推荐**。当前 `.mp4` 路径其实是假的（走的是 SnapAny + mock URL，根本下载不到东西）。

**参考实现**：用户脚本 `D:\workspeace\bilibili_onlyddownload_mp3\bilibili_audio_downloader.user.js`（v0.7.0，作者 cheluen）已经在浏览器侧跑通完整链路，本计划直接复刻其核心调用与 fallback 策略到服务端。关键参考点：

| 参考脚本细节 | 行号 | 在本计划中的体现 |
|---|---|---|
| playurl URL 完整参数 `&fnval=16&fourk=1&qn=80` | L318 | Step 3.1 直接采用 |
| Referer 用根域 `https://www.bilibili.com`（**不带** `/video/${bvid}`） | L321 / L364 | Step 3.1 修正 |
| 音频流按 `bandwidth` 降序选最高码率 | L332-333 | Step 3.1 沿用 |
| 字段名兼容 `baseUrl \|\| base_url` | L336 | Step 3.1 沿用 |
| 当 `data.dash.audio` 不可用时 fallback 到 `data.durl[0].url`（FLV） | L337-339 | Step 3.1 **新增 fallback** |
| 下载音频数据时同样需要 `Referer + User-Agent` | L363-365 | 影响"听悟服务器拉取"风险评估 |
| MIME 类型：m4a → `audio/mp4`，mp3 → `audio/mpeg` | L407 | Step 3.2 采用 |
| 文件命名清理（Windows 非法字符 + 控制字符 + 长度限制 180） | L213-249 | Step 3.4 移植为工具函数 |

正确方案：B 站官方 `playurl` API 支持 DASH（`fnval=16`），返回的 `data.dash.audio[]` 直接给 `.m4a` 流。

> ⚠️ **关于"MP3"的真相（来自参考脚本逐行分析）**
> 参考脚本里所谓的"下载 MP3"**根本不做格式转换**（L390-399 的 `processAudioFormat` 只 `setTimeout 200ms`，直接返回原始 ArrayBuffer），只是把文件后缀改成 `.mp3` + MIME 改成 `audio/mpeg`。内容**仍然是 AAC（M4A 容器）**。
> - 对单纯本地播放：浏览器/播放器宽松，能播。
> - 对通义听悟：听悟按文件**实际内容**和 `mimeType` 推断格式，**伪 MP3 可能被识别为格式错误**。
> - **结论**：本项目对接听悟时**只用 `.m4a`**（真实格式），不提供"MP3"选项给听悟；如果用户想本地保存为 `.mp3`，可在前端单独提供"另存为 .mp3"按钮（仅改扩展名 + MIME，数据不变），但**绝不**把这种"伪 MP3 URL"传给听悟。

> ⚠️ **风险预警（codex 提出，已被参考脚本印证）**：参考脚本的下载流程（L363-365）下载音频数据时也带 `Referer: https://www.bilibili.com`，说明 B 站音频 CDN **确实校验 Referer**。当我们把音频直链交给通义听悟去拉取时，听悟服务器**带不上** Referer，**很可能被 B 站 CDN 403**。最稳的链路是：服务端下载音频 → 上传阿里云 OSS → 把 OSS 临时直链给听悟。本项目第一期可以先按"直链给听悟"做，若实测 403，第二期加 OSS 中转。

---

## 1. 任务类型与路由

- ✅ **后端**（→ codex 主导）：通义听悟签名重构、音频流提取重写、访问控制中间件、`api/index.ts` 与 `api/server.ts` 双路径同步
- ✅ **前端**（→ gemini 主导）：登录遮罩 UI、复制 / 变量 / 图标的"视频→音频"语义更新、错误文案
- ✅ **全栈联动**：所有 `/api/*` axios 调用要在 header 加 `X-App-Password`

---

## 2. 环境变量总览（在 Vercel Settings → Environment Variables 配置）

| Name | 必填 | 说明 |
|------|------|------|
| `ALI_ACCESS_KEY_ID` | ✅ | 阿里云 RAM 用户 AccessKey ID |
| `ALI_ACCESS_KEY_SECRET` | ✅ | 阿里云 RAM 用户 AccessKey Secret |
| `ALI_APP_KEY` | ✅ | **当前用户漏配的关键变量**，听悟控制台 → 项目管理 → AppKey |
| `LANGUAGE` | 可选 | 默认 `auto`，传入听悟 `SourceLanguage` |
| `APP_ACCESS_PASSWORD` | ✅ | 共享访问密码（新加） |
| `BILIBILI_SESSDATA` | 可选 | 浏览器 Cookie 里的 `SESSDATA` 值，没有则只能拿低清/可能拿不到音频 |
| `ALLOWED_ORIGINS` | 可选 | 逗号分隔的允许 Origin，例如 `https://你的项目.vercel.app,http://localhost:5173` |

> 配置后 **必须** 在 Vercel Deployments 页面点 "Redeploy"，环境变量才会注入到新一次构建。

---

## 3. 实施步骤（Step-by-step）

### Step 1 — 新增依赖

```bash
npm install @alicloud/openapi-client @alicloud/tea-util
# 若 TS 报 process / crypto 类型缺失
npm install -D @types/node
```

**预期产物**：`package.json` 多出三个依赖项。

---

### Step 2 — 修改 `api/index.ts`（Vercel 入口）和 `api/server.ts`（本地开发）

> ⚠️ 两个文件大量代码重复，本计划要求**同步修改**，避免本地与线上行为漂移。中期建议抽 `api/app.ts` 复用，但本期不做。

#### 2.1 顶部新增：环境变量读取工具 + 听悟客户端工厂

```ts
import OpenApiClient, { Config as OpenApiConfig } from '@alicloud/openapi-client';
import { Params, OpenApiRequest } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';

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
```

#### 2.2 替换 `createTingwuTask`（api/index.ts:105-138 / api/server.ts:106-148）

```ts
async function createTingwuTask(fileUrl: string, language?: string): Promise<string> {
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
    },
  });

  const response = await client.callApi(params, request, new RuntimeOptions({}));
  const taskId = response.body?.Data?.TaskId || response.body?.TaskId;
  if (!taskId) throw new Error('听悟返回缺少 TaskId');
  return taskId;
}
```

#### 2.3 修改路由 `/api/tingwu-process`（api/index.ts:366 / api/server.ts:413）

**关键变更**：
- **删除** `accessKey` 入参与前端传值校验（密钥不再走前端）
- **删除** OpenAI 风格的 mock 分支与 mock 结果
- 创建任务成功后返回 `{ taskId, status: 'submitted' }`，**不再 await 3s 然后假装完成**

```ts
app.post('/api/tingwu-process', async (req, res) => {
  try {
    const { videoUrl, language } = req.body;
    if (!videoUrl) {
      return res.status(400).json({ success: false, error: '缺少音频/视频 URL' });
    }
    const taskId = await createTingwuTask(videoUrl, language);
    res.json({
      success: true,
      data: { taskId, status: 'submitted', message: '听悟任务已创建，请轮询查询结果' },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '通义听悟处理失败',
    });
  }
});
```

> 📝 **延伸（不强制本期实现）**：新增 `GET /api/tingwu-result?taskId=xxx`，让前端轮询。Vercel serverless 函数最长 10 秒（Hobby 免费版），不适合后端长轮询。

#### 2.4 修改 `/api/process-video`（api/index.ts:225 / api/server.ts:261）

`formatWithAI` 现在用浏览器传来的 `accessKey` 调 DashScope。统一也改成读环境变量 `ALI_ACCESS_KEY_SECRET`（DashScope 是另一套 key，实际应当用 `DASHSCOPE_API_KEY`，与听悟 AccessKey **不是同一个**）：

```ts
// 新增环境变量
DASHSCOPE_API_KEY=...  // 通义千问 API Key，从 dashscope.aliyun.com 获取
```

```ts
async function formatWithAI(text: string): Promise<string> {
  const apiKey = readRequiredEnv('DASHSCOPE_API_KEY');
  // 其余 axios 调用不变，但把 Bearer 中的密钥来源换成 apiKey
}
```

路由处不再接受 `accessKey` 入参。

---

### Step 3 — 替换 B 站 mp4 → DASH 音频 m4a

> 本步骤直接复刻参考脚本 `bilibili_audio_downloader.user.js` 的 `getAudioUrl`（L312-352）+ `downloadAudioData`（L355-387）的实现到服务端 TypeScript。

#### 3.1 新增 helper（api/index.ts 文件顶部）

```ts
// 与参考脚本 L320-322 / L363-365 保持一致：Referer 用根域而非 video/${bvid}
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

// 复刻参考脚本 sanitizeFileName（L221-229）+ buildAudioFileName（L232-249）
function sanitizeFileName(name: string, fallback = 'bilibili_audio'): string {
  let r = String(name || '');
  r = r.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  r = r.replace(/[\\/:*?"<>|]/g, '_');      // Windows 非法字符
  r = r.replace(/[\x00-\x1f\x7f]/g, '');    // 控制字符
  r = r.replace(/\s+/g, ' ').trim();
  r = r.replace(/[.\s]+$/g, '');            // 去尾部点/空格
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

async function getBilibiliDashAudioUrl(bilibiliUrl: string, pageIndex = 0) {
  const bvid = extractBVID(bilibiliUrl);
  if (!bvid) throw new Error('无法从链接中提取BV号');
  const videoInfo = await getVideoInfo(bvid);   // 已有，复用
  const cid = pickCID(videoInfo, pageIndex);    // 已有，复用
  if (!cid) throw new Error('无法获取视频CID');

  // 参考脚本 L318：fnval=16（DASH） + fourk=1 + qn=80
  const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1&qn=80`;
  const resp = await axios.get(playUrl, { headers: getBilibiliHeaders(), timeout: 10000 });
  if (resp.data?.code !== 0) {
    throw new Error(`B站 playurl 错误: ${resp.data?.message || resp.data?.code}`);
  }

  const data = resp.data?.data;
  const title: string = videoInfo?.data?.title || bvid;
  const pages = videoInfo?.data?.pages || [];
  const selectedPage = pages[pageIndex] || pages[0] || null;
  const fileName = buildAudioFileName(title, bvid, selectedPage);

  // 路径 A：DASH 优先（参考脚本 L329-336）
  const audioList = data?.dash?.audio || [];
  if (audioList.length > 0) {
    const best = [...audioList].sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const audioUrl = best.baseUrl || best.base_url || best.backupUrl?.[0] || best.backup_url?.[0];
    if (audioUrl) {
      return {
        bvid,
        cid,
        audioUrl,
        audioFormat: 'm4a' as const,
        mimeType: best.mimeType || best.mime_type || 'audio/mp4',
        bandwidth: best.bandwidth || 0,
        fileName,
        source: 'dash' as const,
        expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
      };
    }
  }

  // 路径 B：FLV fallback（参考脚本 L337-339，老视频或无 DASH 权限时）
  if (data?.durl && data.durl.length > 0) {
    return {
      bvid,
      cid,
      audioUrl: data.durl[0].url,
      audioFormat: 'flv' as const,   // 注意：这是含视频的 FLV，仅作降级
      mimeType: 'video/x-flv',
      bandwidth: 0,
      fileName: fileName.replace(/\.m4a$/, '.flv'),
      source: 'durl-fallback' as const,
      expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
    };
  }

  // 两条路径都不通
  if (!process.env.BILIBILI_SESSDATA) {
    throw new Error('B站未返回音频流；该视频可能需要登录，请在 Vercel 配置 BILIBILI_SESSDATA');
  }
  throw new Error('B站未返回任何可用音频流，可能是版权受限视频');
}
```

**关键差异 vs 旧计划**：

| 项 | 旧计划 | 新计划（参考脚本印证后） |
|---|---|---|
| Referer | `https://www.bilibili.com/video/${bvid}` | `https://www.bilibili.com`（根域，参考脚本 L321/L364） |
| playurl 参数 | `&fnval=16&fnver=0&fourk=1` | `&fnval=16&fourk=1&qn=80`（参考脚本 L318） |
| DASH 失败处理 | 直接抛错 | **先 fallback 到 `data.durl[0].url`**（参考脚本 L337-339） |
| 返回字段 | 缺 `fileName / bandwidth / source` | 补齐，便于前端展示码率与"DASH/FLV 降级"提示 |
| 文件名清理 | 无 | 移植参考脚本的 `sanitizeFileName + buildAudioFileName`，正确处理多 P + Windows 非法字符 |
| User-Agent | `'Mozilla/5.0'` | 完整 UA 串，避免 B 站 CDN 拒绝过于简单的 UA |

#### 3.2 替换 `/api/download-video` 路由（api/index.ts:329 / api/server.ts:373）

```ts
app.post('/api/download-video', async (req, res) => {
  try {
    const { bilibiliUrl, page } = req.body;
    if (!bilibiliUrl) return res.status(400).json({ success: false, error: '缺少B站视频链接' });
    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0);

    // 当走 FLV 降级路径时，给前端一个明确警示
    const warning = audio.source === 'durl-fallback'
      ? '⚠️ 未拿到 DASH 音频流，降级为 FLV（含视频）。建议配置 BILIBILI_SESSDATA 或换一个视频。'
      : null;

    res.json({
      success: true,
      data: {
        audioUrl: audio.audioUrl,
        videoUrl: audio.audioUrl,            // 兼容旧前端字段，前端改名后可移除
        audioFormat: audio.audioFormat,      // 'm4a' | 'flv'
        mimeType: audio.mimeType,
        bandwidth: audio.bandwidth,          // 选中的码率，便于前端展示 "192kbps"
        fileName: audio.fileName,            // 已清理过 Windows 非法字符的下载文件名
        source: audio.source,                // 'dash' | 'durl-fallback'
        expiresAt: audio.expiresAt,
        warning,
        message: '音频直链获取成功，可直接用于通义听悟转写',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : '获取音频失败' });
  }
});
```

#### 3.3 删除假实现

- 删除 `getVideoDownloadUrl()`（SnapAny + mock）
- 删除 `extractAudioFromVideo()`（空操作）

#### 3.4 （可选）新增本地代理下载接口 `/api/download-audio-proxy`

> 仅为前端"下载到本地"按钮服务；如果只用于"提交给听悟"，这个接口不是必须的。

参考脚本 `downloadAudioData`（L355-387）下载音频数据时**也带了** `Referer + User-Agent`。这印证了 codex 的怀疑：B 站音频 CDN 校验 Referer。直接把 `baseUrl` 交给浏览器 `<a download>` 标签下载会因 cross-origin Referer 被替换为本网站域名而失败（403 / 0 字节）。

解决方法：前端不直链下载，改用后端代理 stream：

```ts
app.get('/api/download-audio-proxy', async (req, res) => {
  try {
    const { bilibiliUrl, page } = req.query as { bilibiliUrl?: string; page?: string };
    if (!bilibiliUrl) return res.status(400).json({ success: false, error: '缺少 bilibiliUrl' });
    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0);

    // 二次请求音频 URL，附上 Referer
    const upstream = await axios.get(audio.audioUrl, {
      headers: getBilibiliHeaders(),
      responseType: 'stream',
      timeout: 30000,
    });

    res.setHeader('Content-Type', audio.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(audio.fileName)}"`);
    upstream.data.pipe(res);
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : '代理下载失败' });
  }
});
```

⚠️ Vercel Hobby 函数执行时间上限 10s + 响应体大小限制 4.5MB（streamed）。**超过 10 秒的下载会被强制中断**，因此该代理接口**只适合小视频**。长视频建议用户右键复制 `audioUrl`，配合 IDM/aria2 等带 `Referer` 头的下载工具自己下。

---

### Step 4 — 访问控制中间件（共享密码）

在 `api/index.ts:7` / `api/server.ts:8` 的 `app.use(cors())` 上方与下方插入：

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

> 安全注意：`console.log('Received request:', req.body)` 这类语句会把用户传值写入 Vercel 日志，包括旧设计里的 AccessKey。改造后 AccessKey 不再过前端，但仍要清理 `console.log(req.body)`，见 api/index.ts:227。

---

### Step 5 — 前端 `src/App.tsx` 改造

#### 5.1 登录遮罩（Q2）

在 `function App()` 顶部增加：

```tsx
const [isAuthed, setIsAuthed] = useState<boolean>(
  () => !!localStorage.getItem('app_access_password')
);
const [pwInput, setPwInput] = useState('');
const [pwError, setPwError] = useState('');

async function tryLogin() {
  // 用一个轻量验证：调用受保护接口 /api/health 是公开的，所以用 /api/download-video 也可
  // 这里建议加一个 POST /api/auth/verify 接口；如果不想加，直接信任并保存
  localStorage.setItem('app_access_password', pwInput);
  setIsAuthed(true);
}
```

> **codex 与 gemini 一致提醒**：纯前端校验可被 DevTools 绕过，**真正的把关在后端**。前端只是 UX 层。

axios 拦截器（请求头自动带上密码）：

```ts
axios.interceptors.request.use(cfg => {
  const pw = localStorage.getItem('app_access_password');
  if (pw && cfg.url?.startsWith('/api/')) {
    cfg.headers = cfg.headers || {};
    (cfg.headers as any)['X-App-Password'] = pw;
  }
  return cfg;
});
```

`return` 顶部：

```tsx
if (!isAuthed) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-xl p-6 w-80">
        <h2 className="text-xl font-bold mb-2">访问受限</h2>
        <p className="text-sm text-gray-600 mb-4">请输入访问密码</p>
        <input
          type="password"
          value={pwInput}
          onChange={e => setPwInput(e.target.value)}
          placeholder="访问密码"
          className="w-full px-3 py-2 border rounded mb-2"
        />
        {pwError && <p className="text-red-600 text-sm mb-2">{pwError}</p>}
        <button onClick={tryLogin} className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700">
          进入系统
        </button>
      </div>
    </div>
  );
}
```

#### 5.2 视频 → 音频 语义更新（Q3）

> 后端 `/api/download-video` 现在返回 `audioUrl / audioFormat / mimeType / bandwidth / fileName / source / warning`，前端需消费这些新字段。

| 位置（行号近似） | Before | After |
|---|---|---|
| L26 | `const [videoFileUrl, setVideoFileUrl] = useState('')` | `const [audioFileUrl, setAudioFileUrl] = useState('')` |
| L28-32 | `downloadResult: { videoUrl?, audioUrl?, message? }` | `downloadResult: { audioUrl?, audioFormat?, mimeType?, bandwidth?, fileName?, source?, warning?, message? }` |
| L31 | `result.videoUrl?: string`（笔记结果里的"源视频"） | 保留 `videoUrl`（指向原 B 站页面 URL，不是音频 URL），二者**不要混淆** |
| L124 | `setVideoFileUrl(response.data.data.videoUrl)` | `setAudioFileUrl(response.data.data.audioUrl)` |
| L125 | `'视频下载链接获取成功！'` | `'音频下载链接获取成功！'` + 若 `data.warning` 非空，额外 `toast.warning(data.warning)` |
| L160-163 | `axios.post('/api/tingwu-process', { videoUrl: videoFileUrl, accessKey })` | `axios.post('/api/tingwu-process', { videoUrl: audioFileUrl })` —— 删除 `accessKey` 参数（已移到服务端环境变量） |
| L269 | `'步骤1：获取视频下载链接'` | `'步骤1：获取音频下载链接（.m4a）'` |
| L271 | `'点击按钮自动获取当前B站视频的下载链接...'` | `'点击按钮自动获取当前 B 站视频的音频流（.m4a），用于通义听悟转写'` |
| L284 | `'获取视频下载链接'` | `'获取音频下载链接 🎵'`（参考脚本 L164 的 emoji） |
| L288-298 | 显示 `downloadResult.videoUrl` 区块 | 改为 `audioUrl` + 显示 `audioFormat / bandwidth`（如 `M4A · 192kbps`）+ `fileName`；若 `source === 'durl-fallback'` 显示橙色降级提示 |
| L293 | `'视频URL：'` | `'音频URL：'` |
| L305 | `'视频文件URL（需公开可访问）'` | `'音频文件URL（需公开可访问）'` |
| L311 | `placeholder="https://example.com/video.mp4"` | `placeholder="https://example.com/audio.m4a"` |
| L315 | `'可以手动输入视频文件URL，或使用上方按钮自动获取'` | `'可以手动输入音频文件URL，或使用上方按钮自动获取'` |
| L321 | `disabled={isProcessing \|\| !videoFileUrl.trim() \|\| !accessKey.trim()}` | `disabled={isProcessing \|\| !audioFileUrl.trim()}` —— 移除 accessKey 依赖 |
| L362 | `'点击"获取视频下载链接"自动获取当前视频文件URL'` | `'点击"获取音频下载链接"自动获取当前视频的音频流'` |
| `lucide-react` 导入行 | `import { FileText, Video, Loader2, HelpCircle } from 'lucide-react'` | 增加 `Music` 或 `Headphones` 图标 |
| L416-426 | `<Video />` 图标 + `'下载视频'` + `window.open(result.videoUrl, '_blank')` | 见 5.2.1 下方完整代码 |

##### 5.2.1 "下载音频"按钮的正确写法

**直接 `<a href={audioUrl} download>` 会因 Referer 校验失败**（参考脚本通过 `GM_xmlhttpRequest` 绕过同源限制 + 显式带 Referer，浏览器侧的 `<a download>` 没有这个能力）。两个可行选项：

```tsx
{/* 选项 A（推荐，零额外 Vercel 函数调用）：让浏览器在新标签打开音频 URL，用户右键"另存为"
    优点：Vercel 不消耗带宽
    缺点：长视频用户操作多一步；若浏览器自动跳转新标签播放，提示用户右键保存 */}
{downloadResult?.audioUrl && (
  <a
    href={downloadResult.audioUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center px-3 py-1 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-sm"
    title="若浏览器直接播放，请右键『链接另存为』。注意 B 站音频链接 ~120 分钟过期。"
  >
    <Music className="w-4 h-4 mr-1" />
    打开音频流（{downloadResult.audioFormat?.toUpperCase()}）
  </a>
)}

{/* 选项 B（仅小视频，<10s 下载完）：走后端代理，Vercel 流式转发
    使用前提：实现了 Step 3.4 的 /api/download-audio-proxy
    优点：用户体验最好，文件名正确
    缺点：耗 Vercel 函数时间，长视频会被 10s 限制截断 */}
{downloadResult?.audioUrl && (
  <a
    href={`/api/download-audio-proxy?bilibiliUrl=${encodeURIComponent(bilibiliUrl)}`}
    className="inline-flex items-center px-3 py-1 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-sm"
  >
    <Music className="w-4 h-4 mr-1" />
    下载 {downloadResult.fileName || '音频.m4a'}
  </a>
)}
```

第一期建议选 A，避免 Vercel 函数限制；第二期视使用场景再上 B。

#### 5.3 AccessKey 输入框（L233-243）的处理

由于 AccessKey 不再走前端：

- 选项 A（推荐）：**整块删除**该输入框，并把上文提示文案调整为"密钥已由部署者在服务端配置"
- 选项 B：保留作为兼容字段，但加 `disabled` 并写"已迁移到服务端"

我选 A，更干净。

#### 5.4 错误文案（Q1 fallout）

通义听悟 404 / 签名错误后端会抛 `Error.message`，前端 toast 直接展示即可。为了用户体验：

```ts
// L181-183 catch 块
const msg = error.response?.data?.error || error.message || '通义听悟处理失败';
const hint = msg.includes('环境变量') ? '\n（请联系部署者检查 Vercel Environment Variables）' : '';
toast.error(msg + hint);
```

---

## 4. 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 修改 | 新增 `@alicloud/openapi-client`、`@alicloud/tea-util`、`@types/node`（dev） |
| `api/index.ts` | 重构 | Step 2-4 全部改动 |
| `api/server.ts` | 重构 | 与 index.ts 同步（本地开发） |
| `src/App.tsx` | 重构 | Step 5 全部 UI / 文案 / 变量改动 |
| `.env.example` | 新增 | 列出所有需要的环境变量（不含真值），便于他人部署 |
| `README.md` | 更新 | 环境变量列表从 2 个改为 6-7 个；删除"前端输入 AccessKey"段 |
| `DEPLOYMENT.md` | 更新 | 同 README |

---

## 5. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 听悟拉取 B 站 m4a 直链时被 403（缺 Referer） | 🔴 高 | 参考脚本 L363-365 印证 B 站音频 CDN 校验 Referer。第一期先按直链给听悟实测；若 403，第二期加 OSS 中转：服务端拉音频 → 上传 OSS → 给听悟 OSS 临时签名 URL |
| 浏览器直链下载 m4a 失败（同样的 Referer 问题） | 🟡 中 | 前端用"新标签打开 + 右键另存"（选项 A），或经服务端代理流式下载（选项 B，受 10s 限制） |
| DASH URL 120 分钟过期 | 🟢 低 | 让用户在"获取音频链接"后立即点"开始转写"；后端可以把"获取音频 + 提交听悟任务"合并为一个原子接口 |
| 走 FLV 降级路径时实际是含视频的 .flv | 🟡 中 | `data.source === 'durl-fallback'` 时前端橙色 warning 提示；FLV 体积大，听悟拉取慢且失败概率高，提醒用户配 SESSDATA |
| 把"伪 MP3"传给听悟 | 🟡 中 | 后端**只**返回真实的 `.m4a` URL；前端 MP3 按钮（如有）仅用于本地下载，不参与听悟链路 |
| `BILIBILI_SESSDATA` 是敏感 Cookie | 🟡 中 | 只放 Vercel 环境变量；不入仓库；切勿 `console.log`；建议用小号专用，定期轮换 |
| 共享密码被同事/朋友间转发后泄漏 | 🟡 中 | 部署者承担轮换责任；本期不做用户系统 |
| Vercel Hobby 免费版函数最长 10s | 🟡 中 | 听悟任务**只创建不等待**，前端轮询 `GET /api/tingwu-result`（本计划标记为"延伸"，不在第一期） |
| `api/index.ts` 与 `api/server.ts` 双写漂移 | 🟢 低 | 第一期同步改；后续抽 `api/app.ts` 共享（不在本期） |
| 前端密码校验可被 DevTools 绕过 | 🟢 低 | 真正的把关在后端 middleware，前端 UX 而已 |
| `DASHSCOPE_API_KEY`（通义千问）与 `ALI_ACCESS_KEY_*`（听悟）是两套密钥 | 🟡 中 | 必须分别配置；不要混淆 |
| B 站简单 UA `'Mozilla/5.0'` 被风控 | 🟢 低 | 已采用参考脚本使用 `navigator.userAgent` 的精神，写入完整 Chrome UA 串 |

---

## 6. 验证步骤（实施后）

```bash
# 类型与构建
npm run check
npm run build

# 本地后端
npm run dev:backend

# 健康检查（公开）
curl http://localhost:9090/api/health
# 期望：{"status":"ok"}

# 无密码访问受保护接口
curl -X POST http://localhost:9090/api/download-video \
  -H "Content-Type: application/json" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/BV1xxxx"}'
# 期望：401 Unauthorized

# 带密码 + 真实 BV 号
curl -X POST http://localhost:9090/api/download-video \
  -H "Content-Type: application/json" \
  -H "X-App-Password: <你设的密码>" \
  -d '{"bilibiliUrl":"https://www.bilibili.com/video/BV1xxxx"}'
# 期望：返回 {audioUrl, audioFormat: "m4a", ...}

# 提交听悟任务
curl -X POST http://localhost:9090/api/tingwu-process \
  -H "Content-Type: application/json" \
  -H "X-App-Password: <密码>" \
  -d '{"videoUrl":"<上一步返回的 audioUrl>"}'
# 期望：返回真实 taskId（如 "xxxxxxxxxx"），不再是 "openai-xxx" 或 mock
```

Vercel 部署后：
- ✅ 打开 `https://你的项目.vercel.app/` → 显示登录遮罩
- ✅ 输入正确密码 → 进入主界面，未配置时不会再调用听悟
- ✅ 输入 B 站链接 → "获取音频下载链接"按钮返回 `.m4a` 直链
- ✅ "开始转写"按钮 → 返回真实 taskId，**不再 404**
- ✅ Vercel 日志中不出现任何 `ALI_ACCESS_KEY_SECRET` / `BILIBILI_SESSDATA` / `APP_ACCESS_PASSWORD` 明文

---

## 7. 是否要做？（用户决策点）

| 问题 | 必须做？ | 建议 |
|------|---------|------|
| Q1 通义听悟 404 修复 | ✅ 必须 | 否则该功能完全用不了 |
| Q2 访问控制 | ⚠️ 强烈建议 | 如不做，发出去的网址 = 公开提款机 |
| Q3 mp4 → 音频 | ✅ 建议 | 当前 mp4 路径本就是假实现；改成音频后听悟拉取更快、流量更小、合规更稳 |

**建议**：三个一起做。Step 2/3/4 在后端一次性改完；Step 5 在前端一次性改完。预估 1.5-3 小时（含本地与 Vercel 联调）。

---

## 8. 与 `/ccg:execute` 的衔接

### SESSION_ID（供 `/ccg:execute resume <SESSION_ID>` 使用）
- **CODEX_SESSION**: `019e1a34-19ab-7292-89b8-9e044074647a`
- **GEMINI_SESSION**: `e4ecb4b4-c4e7-412b-95d1-303033eb728b`

执行命令：

```
/ccg:execute .claude/plan/vercel-fixes.md
```
