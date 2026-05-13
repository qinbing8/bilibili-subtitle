import express from 'express'
import cors from 'cors'
import axios from 'axios'
import crypto from 'crypto'
import OpenApiClientModule, {
  Config as OpenApiConfig,
  Params,
  OpenApiRequest,
} from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import {
  resolveAudioProxyAllowedHosts,
  resolveAudioProxyRateLimits,
  resolveAudioProxyTokenSecret,
  resolveAudioProxyTtlSec,
  resolvePublicProxyBaseUrl,
} from './dev-config'
import {
  assertLikelyPublicHttpUrl,
  buildAudioProxyUrl,
  createAudioProxyHandler,
  signAudioProxyToken,
} from './audio-proxy'
import { buildCreateTaskRequestBody, buildCreateTaskRequestQuery } from './tingwu-task'

const app = express()

const OpenApiClient =
  typeof OpenApiClientModule === 'function'
    ? OpenApiClientModule
    : ((OpenApiClientModule as any).default ?? OpenApiClientModule)

const audioProxySecret = resolveAudioProxyTokenSecret(process.env)
const audioProxyHandler = audioProxySecret
  ? createAudioProxyHandler({
      secret: audioProxySecret,
      allowedHostRegex: resolveAudioProxyAllowedHosts(process.env),
      rateLimits: resolveAudioProxyRateLimits(process.env),
      upstreamHeaders: getBilibiliHeaders,
    })
  : async (_req: express.Request, res: express.Response) => {
      res.status(503).json({
        error: 'audio_proxy_not_configured',
        message: '服务端未配置 AUDIO_PROXY_TOKEN_SECRET，音频代理不可用。',
      })
    }

// /api/audio-proxy must be mounted BEFORE global CORS so no Access-Control-* headers
// are exposed to browsers. Tingwu calls it server-side and does not need CORS.
app.options('/api/audio-proxy', (_req, res) => {
  res.status(204).end()
})
app.get('/api/audio-proxy', audioProxyHandler)
app.head('/api/audio-proxy', audioProxyHandler)

const corsOptions = {
  origin(origin: string | undefined, cb: (error: Error | null, allow?: boolean) => void) {
    const allowed = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      return cb(null, true)
    }
    return cb(null, false)
  },
  allowedHeaders: ['Content-Type', 'X-App-Password', 'Authorization'],
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
}

app.use(cors(corsOptions))
app.use(express.json())

export function requireApiAccess(req: any, res: any, next: any) {
  if (req.method === 'OPTIONS') return next()
  if (req.path === '/health' || req.originalUrl === '/api/health') return next()
  if (req.path === '/health-with-config' || req.originalUrl === '/api/health-with-config') {
    return next()
  }

  const expected = process.env.APP_ACCESS_PASSWORD?.trim()
  if (!expected) {
    return res.status(503).json({ success: false, error: '服务端未配置 APP_ACCESS_PASSWORD' })
  }

  const provided = req.get('X-App-Password') || ''
  if (provided !== expected) {
    return res.status(401).json({ success: false, error: '未授权访问' })
  }

  next()
}

app.use('/api', requireApiAccess)

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`服务端缺少环境变量 ${name}`)
  }
  return value
}

export function getTingwuConfig(language?: string) {
  return {
    accessKeyId: readRequiredEnv('ALI_ACCESS_KEY_ID'),
    accessKeySecret: readRequiredEnv('ALI_ACCESS_KEY_SECRET'),
    appKey: readRequiredEnv('ALI_APP_KEY'),
    language: language || process.env.LANGUAGE || 'auto',
  }
}

function getBilibiliHeaders() {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Referer: 'https://www.bilibili.com',
  }
  const sessdata = process.env.BILIBILI_SESSDATA?.trim()
  if (sessdata) {
    headers.Cookie = sessdata.startsWith('SESSDATA=') ? sessdata : `SESSDATA=${sessdata}`
  }
  return headers
}

function buildHealthWithConfigResponse(env: NodeJS.ProcessEnv = process.env) {
  const proxyBaseUrl = resolvePublicProxyBaseUrl(env)
  let proxyBaseHost: string | null = null

  if (proxyBaseUrl) {
    try {
      proxyBaseHost = new URL(proxyBaseUrl).host
    } catch {
      proxyBaseHost = null
    }
  }

  return {
    status: 'ok' as const,
    proxyBaseUrlConfigured: Boolean(proxyBaseUrl),
    proxyBaseHost,
  }
}

function sanitizeFileName(name: string, fallback = 'bilibili_audio'): string {
  let result = String(name || '')
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  result = result.replace(/[\\/:*?"<>|]/g, '_')
  result = result.replace(/[\x00-\x1f\x7f]/g, '')
  result = result.replace(/\s+/g, ' ').trim()
  result = result.replace(/[.\s]+$/g, '')
  if (result.length > 180) {
    result = result.slice(0, 180).trim().replace(/[.\s]+$/g, '')
  }
  return result || fallback
}

function buildAudioFileName(
  title: string,
  bvid: string,
  page?: { page: number; part: string } | null,
): string {
  const main = sanitizeFileName(title, bvid)
  if (page && page.page > 1) {
    const part = sanitizeFileName(page.part || '', '')
    const suffix = part && part !== main ? ` - P${page.page} ${part}` : ` - P${page.page}`
    return `${sanitizeFileName(main + suffix, main)}.m4a`
  }
  return `${main}.m4a`
}

function extractBVID(url: string): string | null {
  const match = url.match(/BV[0-9A-Za-z]+/)
  return match ? match[0] : null
}

async function getVideoInfo(bvid: string) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  const response = await axios.get(url, { headers: getBilibiliHeaders() })
  return response.data
}

function pickCID(videoInfo: any, pageIndex: number = 0): string | null {
  const pages = videoInfo.data?.pages || []
  if (!pages.length) {
    return videoInfo.data?.cid
  }
  const idx = Math.max(0, Math.min(pageIndex, pages.length - 1))
  return pages[idx]?.cid || null
}

async function getPlayerSubtitles(bvid: string, cid: string) {
  const url = `https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`
  const response = await axios.get(url, { headers: getBilibiliHeaders() })
  return response.data
}

function collectSubtitles(playerData: any) {
  const subtitles = playerData.data?.subtitle?.subtitles || []
  return subtitles.map((sub: any) => ({
    lan: sub.lan,
    lan_doc: sub.lan_doc,
    url: sub.subtitle_url,
  }))
}

function chooseSubtitle(subtitles: any[], prefer: string = 'ai') {
  if (!subtitles.length) return null

  if (prefer === 'ai') {
    const aiSub = subtitles.find((subtitle) => subtitle.lan?.includes('ai'))
    if (aiSub) return aiSub
  }

  const zhSub = subtitles.find(
    (subtitle) =>
      (subtitle.lan_doc && /中文|简体/.test(subtitle.lan_doc)) || subtitle.lan === 'zh-CN',
  )
  return zhSub || subtitles[0]
}

async function getSubtitleContent(url: string) {
  const response = await axios.get(url, { headers: getBilibiliHeaders() })
  return response.data
}

function parseSubtitleSegments(body: any) {
  const items = body.body || []
  return items.map((item: any) => ({
    start: parseFloat(item.from || 0),
    end: parseFloat(item.to || 0),
    text: String(item.content || '').trim(),
  }))
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function generateMarkdown(meta: any, segments: any[], source: string): string {
  const lines: string[] = []
  lines.push(`# ${meta.title || ''}`)
  lines.push('')
  lines.push(`- 来源: ${meta.url || ''}`)
  lines.push(`- 作者: ${meta.owner || ''}`)
  lines.push(`- BV号: ${meta.bvid || ''}`)
  lines.push(`- 字幕来源: ${source}`)
  lines.push('')
  lines.push('## 正文')
  segments.forEach((seg: any) => {
    lines.push(`- \`${formatTimestamp(seg.start)}\`–\`${formatTimestamp(seg.end)}\` ${seg.text}`)
  })
  return lines.join('\n')
}

export async function createTingwuTask(
  fileUrl: string,
  language?: string,
  opts: { diarization?: boolean; textPolish?: boolean } = {},
): Promise<string> {
  const cfg = getTingwuConfig(language)
  const client = new OpenApiClient(
    new OpenApiConfig({
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      endpoint: 'tingwu.cn-beijing.aliyuncs.com',
      protocol: 'https',
    }),
  )
  const params = new Params({
    action: 'CreateTask',
    version: '2023-09-30',
    pathname: '/openapi/tingwu/v2/tasks',
    method: 'PUT',
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'json',
    bodyType: 'json',
  })
  const request = new OpenApiRequest({
    query: buildCreateTaskRequestQuery(),
    body: buildCreateTaskRequestBody({
      appKey: cfg.appKey,
      fileUrl,
      language: cfg.language,
      diarization: opts.diarization,
      textPolish: opts.textPolish,
    }),
  })
  const response = await client.callApi(params, request, new RuntimeOptions({}))
  const taskId = response.body?.Data?.TaskId || response.body?.TaskId
  if (!taskId) {
    throw new Error('听悟返回缺少 TaskId')
  }
  return taskId
}

async function formatWithAI(text: string): Promise<string> {
  const apiKey = readRequiredEnv('DASHSCOPE_API_KEY')

  try {
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: 'qwen-plus',
        messages: [
          {
            role: 'system',
            content:
              '你是一个专业的学习笔记整理助手。请将提供的视频字幕内容整理成结构清晰、易于学习的Markdown格式笔记。要求：1. 生成内容摘要和大纲；2. 根据语义进行智能分段；3. 添加合适的标题；4. 优化标点和错别字；5. 保持时间戳信息。',
          },
          {
            role: 'user',
            content: text,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    )

    return response.data.choices[0]?.message?.content || text
  } catch (error) {
    console.error('AI formatting failed:', error)
    return text
  }
}

export async function getBilibiliDashAudioUrl(bilibiliUrl: string, pageIndex = 0) {
  const bvid = extractBVID(bilibiliUrl)
  if (!bvid) {
    throw new Error('无法从链接中提取BV号')
  }

  const videoInfo = await getVideoInfo(bvid)
  const cid = pickCID(videoInfo, pageIndex)
  if (!cid) {
    throw new Error('无法获取视频CID')
  }

  const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1&qn=80`
  const response = await axios.get(playUrl, {
    headers: getBilibiliHeaders(),
    timeout: 10000,
  })

  if (response.data?.code !== 0) {
    throw new Error(`B站 playurl 错误: ${response.data?.message || response.data?.code}`)
  }

  const data = response.data?.data
  const title: string = videoInfo?.data?.title || bvid
  const durationMs = (videoInfo?.data?.duration || 0) * 1000
  const pages = videoInfo?.data?.pages || []
  const selectedPage = pages[pageIndex] || pages[0] || null
  const fileName = buildAudioFileName(title, bvid, selectedPage)

  const audioList = data?.dash?.audio || []
  if (audioList.length > 0) {
    const best = [...audioList].sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
    const audioUrl =
      best.baseUrl || best.base_url || best.backupUrl?.[0] || best.backup_url?.[0]
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
        title,
        durationMs,
        expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
      }
    }
  }

  if (data?.durl && data.durl.length > 0) {
    return {
      bvid,
      cid,
      audioUrl: data.durl[0].url,
      audioFormat: 'flv' as const,
      mimeType: 'video/x-flv',
      bandwidth: 0,
      fileName: fileName.replace(/\.m4a$/, '.flv'),
      source: 'durl-fallback' as const,
      title,
      durationMs,
      expiresAt: new Date(Date.now() + 110 * 60 * 1000).toISOString(),
    }
  }

  if (!process.env.BILIBILI_SESSDATA) {
    throw new Error('B站未返回音频流；该视频可能需要登录，请在 Vercel 配置 BILIBILI_SESSDATA')
  }
  throw new Error('B站未返回任何可用音频流，可能是版权受限视频')
}

type TingwuStatus = 'ONGOING' | 'COMPLETED' | 'FAILED'

interface TingwuJson {
  Paragraphs: Array<{
    ParagraphId: string
    Sentences: Array<{
      SentenceId: string | number
      Start: number
      End: number
      Text: string
      SpeakerId?: string
    }>
  }>
}

interface ReadingParagraph {
  time: string
  speaker?: string
  text: string
}

interface VideoMeta {
  title: string
  bvid: string
  durationMs?: number
  fileName: string
  source: '通义听悟'
}

async function getTingwuTaskInfo(taskId: string) {
  const cfg = getTingwuConfig()
  const client = new OpenApiClient(
    new OpenApiConfig({
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      endpoint: 'tingwu.cn-beijing.aliyuncs.com',
      protocol: 'https',
    }),
  )
  const params = new Params({
    action: 'GetTaskInfo',
    version: '2023-09-30',
    pathname: `/openapi/tingwu/v2/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'json',
    bodyType: 'json',
  })
  const resp = await client.callApi(params, new OpenApiRequest({}), new RuntimeOptions({}))
  return resp.body
}

function formatMs(ms: number): string {
  const total = Math.floor((ms || 0) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':')
}

function toReadingParagraphs(json: TingwuJson): ReadingParagraph[] {
  const out: ReadingParagraph[] = []
  for (const paragraph of json.Paragraphs || []) {
    let buf = ''
    let startMs = 0
    let speaker: string | undefined
    for (const sentence of paragraph.Sentences || []) {
      const text = sentence.Text?.trim() || ''
      if (!text) continue
      const nextSpeaker = sentence.SpeakerId ? `说话人 ${sentence.SpeakerId}` : undefined
      const shouldFlush = Boolean(buf) && (buf.length + text.length > 200 || nextSpeaker !== speaker)
      if (shouldFlush) {
        out.push({ time: formatMs(startMs), speaker, text: buf.trim() })
        buf = ''
      }
      if (!buf) {
        startMs = sentence.Start
        speaker = nextSpeaker
      }
      buf += text
    }
    if (buf) {
      out.push({ time: formatMs(startMs), speaker, text: buf.trim() })
    }
  }
  return out
}

async function renderDocx(meta: VideoMeta, paragraphs: ReadingParagraph[]): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx')
  const children = [
    new Paragraph({ text: meta.title || '转写结果', heading: HeadingLevel.TITLE }),
    new Paragraph(`BV号：${meta.bvid}`),
    new Paragraph(`时长：${meta.durationMs ? formatMs(meta.durationMs) : '-'}`),
    new Paragraph(`字幕来源：通义听悟`),
    new Paragraph(`转写时间：${new Date().toLocaleString('zh-CN')}`),
    new Paragraph({ text: '正文', heading: HeadingLevel.HEADING_1 }),
    ...paragraphs.map(
      (paragraph) =>
        new Paragraph({
          children: [
            new TextRun({ text: `[${paragraph.time}] ` }),
            ...(paragraph.speaker
              ? [new TextRun({ text: `${paragraph.speaker}：`, bold: true })]
              : []),
            new TextRun(paragraph.text),
          ],
        }),
    ),
  ]
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}

function renderTxt(meta: VideoMeta, paragraphs: ReadingParagraph[]): string {
  return [
    meta.title || '转写结果',
    `BV号：${meta.bvid}`,
    `时长：${meta.durationMs ? formatMs(meta.durationMs) : '-'}`,
    `字幕来源：通义听悟`,
    `转写时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    ...paragraphs.map((paragraph) =>
      `[${paragraph.time}] ${paragraph.speaker ? `${paragraph.speaker}：` : ''}${paragraph.text}`,
    ),
  ].join('\n')
}

function signMeta(meta: VideoMeta): string {
  const secret = process.env.META_TOKEN_SECRET?.trim() || 'unsafe-dev-key'
  const payload = Buffer.from(JSON.stringify(meta)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyMeta(token: string): VideoMeta | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const secret = process.env.META_TOKEN_SECRET?.trim() || 'unsafe-dev-key'
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  if (sig !== expected) return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
}

function buildAudioProxyTaskPayload(audio: Awaited<ReturnType<typeof getBilibiliDashAudioUrl>>) {
  const publicProxyBaseUrl = resolvePublicProxyBaseUrl(process.env)
  if (!publicProxyBaseUrl) {
    throw new Error(
      '服务端未配置 PUBLIC_PROXY_BASE_URL，听悟无法读取音频。请配置公网代理地址（推荐 cloudflared tunnel）。',
    )
  }

  const tokenSecret = resolveAudioProxyTokenSecret(process.env)
  if (!tokenSecret) {
    throw new Error('服务端未配置 AUDIO_PROXY_TOKEN_SECRET，无法生成音频代理 token。')
  }

  const ttlSec = resolveAudioProxyTtlSec(process.env)
  const token = signAudioProxyToken(
    {
      v: 1,
      u: audio.audioUrl,
      srcExp: new Date(audio.expiresAt).getTime(),
      mime: audio.mimeType,
      fn: audio.fileName,
      bvid: audio.bvid,
      cid: String(audio.cid),
    },
    tokenSecret,
    ttlSec,
  )
  const proxyUrl = buildAudioProxyUrl(publicProxyBaseUrl, token)
  assertLikelyPublicHttpUrl(proxyUrl)

  return {
    proxyUrl,
    proxyHost: new URL(proxyUrl).host,
    audioHost: new URL(audio.audioUrl).host,
    proxyExpiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
    sourceExpiresAt: audio.expiresAt,
  }
}

async function fetchTingwuJson(url: string): Promise<TingwuJson> {
  const resp = await axios.get(url, { timeout: 30000, responseType: 'json' })
  return resp.data as TingwuJson
}

app.post('/api/process-video', async (req, res) => {
  try {
    const { url } = req.body || {}

    if (!url) {
      return res.status(400).json({
        success: false,
        error: '缺少必要的参数：视频链接',
      })
    }

    const bvid = extractBVID(url)
    if (!bvid) {
      return res.status(400).json({
        success: false,
        error: '无法从链接中提取BV号',
      })
    }

    const videoInfo = await getVideoInfo(bvid)
    const cid = pickCID(videoInfo)
    if (!cid) {
      return res.status(400).json({
        success: false,
        error: '无法获取视频CID',
      })
    }

    const playerData = await getPlayerSubtitles(bvid, cid)
    const subtitles = collectSubtitles(playerData)

    let markdownContent: string
    let source: string

    if (subtitles.length > 0) {
      const chosenSubtitle = chooseSubtitle(subtitles)
      if (!chosenSubtitle?.url) {
        return res.status(400).json({
          success: false,
          error: '未找到可用字幕地址',
        })
      }

      const subtitleContent = await getSubtitleContent(chosenSubtitle.url)
      const segments = parseSubtitleSegments(subtitleContent)
      const meta = {
        title: videoInfo.data?.title || '',
        owner: videoInfo.data?.owner?.name || '',
        bvid,
        url,
      }

      source = chosenSubtitle.lan_doc || chosenSubtitle.lan || '内置字幕'
      markdownContent = generateMarkdown(meta, segments, source)

      try {
        markdownContent = await formatWithAI(markdownContent)
      } catch (_error) {
        console.warn('AI enhancement failed, using original content')
      }
    } else {
      const subtitleInfo = playerData.data?.subtitle
      return res.status(400).json({
        success: false,
        error:
          `该视频暂无内置字幕。\n\n视频标题: ${videoInfo.data?.title || '未知'}\n\n` +
          '替代方案：\n1. 使用通义听悟API进行语音转写\n2. 先获取视频音频直链，再提交给通义听悟\n3. 寻找其他带有"CC"标识的视频\n\n' +
          '下一步操作：\n1. 使用“获取音频下载链接”拿到音频流\n2. 联系部署者确认服务端已配置通义听悟环境变量\n3. 在转写流程中提交音频链接',
        step: 'no-subtitles',
        details: {
          title: videoInfo.data?.title,
          hasBuiltInSubtitles: false,
          subtitleInfo,
          alternative: 'tingwu',
          message: '该视频无内置字幕，建议使用通义听悟API进行语音转写',
        },
      })
    }

    return res.json({
      success: true,
      data: {
        title: videoInfo.data?.title || '学习笔记',
        markdown: markdownContent,
        videoUrl: url,
      },
    })
  } catch (error) {
    console.error('Video processing error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '处理视频时发生错误',
    })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/health-with-config', (_req, res) => {
  res.json(buildHealthWithConfigResponse())
})

app.get('/api/auth-check', (_req, res) => {
  res.json({ success: true })
})

app.post('/api/download-video', async (req, res) => {
  try {
    const { bilibiliUrl, page } = req.body || {}
    if (!bilibiliUrl) {
      return res.status(400).json({
        success: false,
        error: '缺少B站视频链接',
      })
    }

    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0)
    const warning =
      audio.source === 'durl-fallback'
        ? '⚠️ 未拿到 DASH 音频流，降级为 FLV（含视频）。建议配置 BILIBILI_SESSDATA 或换一个视频。'
        : null

    return res.json({
      success: true,
      data: {
        audioUrl: audio.audioUrl,
        videoUrl: audio.audioUrl,
        audioFormat: audio.audioFormat,
        mimeType: audio.mimeType,
        bandwidth: audio.bandwidth,
        fileName: audio.fileName,
        source: audio.source,
        expiresAt: audio.expiresAt,
        warning,
        message: '音频直链获取成功',
      },
    })
  } catch (error) {
    console.error('Video download error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取音频失败',
    })
  }
})

app.post('/api/transcription/start', async (req, res) => {
  try {
    const { bilibiliUrl, language, page, diarization, textPolish } = req.body || {}
    if (!bilibiliUrl) {
      return res.status(400).json({ success: false, error: '缺少 bilibiliUrl' })
    }

    const audio = await getBilibiliDashAudioUrl(bilibiliUrl, Number(page) || 0)
    const { proxyUrl, proxyHost, audioHost, proxyExpiresAt, sourceExpiresAt } =
      buildAudioProxyTaskPayload(audio)
    const taskId = await createTingwuTask(proxyUrl, language, {
      diarization: !!diarization,
      textPolish: !!textPolish,
    })

    const meta: VideoMeta = {
      title: audio.title,
      bvid: audio.bvid,
      durationMs: audio.durationMs,
      fileName: audio.fileName,
      source: '通义听悟',
    }

    res.setHeader('Cache-Control', 'no-store')
    return res.json({
      success: true,
      data: {
        taskId,
        audioHost,
        proxyHost,
        proxyExpiresAt,
        sourceExpiresAt,
        audioFormat: audio.audioFormat,
        mimeType: audio.mimeType,
        fileName: audio.fileName,
        expiresAt: audio.expiresAt,
        bandwidth: audio.bandwidth,
        source: audio.source,
        warning:
          audio.source === 'durl-fallback'
            ? '降级为 FLV（含视频），听悟可能拒绝。建议配置 BILIBILI_SESSDATA。'
            : null,
        metaToken: signMeta(meta),
      },
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建任务失败',
    })
  }
})

app.get('/api/transcription/status', async (req, res) => {
  const taskId = String(req.query.taskId || '')
  if (!taskId) {
    return res.status(400).json({ success: false, error: '缺少 taskId' })
  }

  try {
    const info: any = await getTingwuTaskInfo(taskId)
    const raw = info?.Data?.TaskStatus
    const status: TingwuStatus =
      raw === 'COMPLETED' ? 'COMPLETED' : raw === 'FAILED' ? 'FAILED' : 'ONGOING'

    let preview: string | undefined
    if (status === 'COMPLETED' && info?.Data?.Result?.Transcription) {
      try {
        const json = await fetchTingwuJson(info.Data.Result.Transcription)
        const paragraphs = toReadingParagraphs(json)
        preview = paragraphs
          .slice(0, 2)
          .map((paragraph) => paragraph.text)
          .join(' ')
          .slice(0, 200)
      } catch {
        // 预览失败不影响主流程
      }
    }

    return res.json({
      success: true,
      data: {
        status,
        errorMessage: status === 'FAILED' ? info?.Data?.ErrorMessage : undefined,
        transcriptionUrl: status === 'COMPLETED' ? info?.Data?.Result?.Transcription : undefined,
        durationMs: info?.Data?.DurationMs,
        preview,
      },
    })
  } catch {
    return res.status(502).json({ success: false, error: '查询任务失败，请稍后重试' })
  }
})

app.get('/api/transcription/download', async (req, res) => {
  try {
    const taskId = String(req.query.taskId || '')
    const format = String(req.query.format || 'docx') as 'docx' | 'txt'
    const meta: VideoMeta = verifyMeta(String(req.query.meta || '')) || {
      title: taskId,
      bvid: '-',
      durationMs: 0,
      fileName: `${taskId}.${format}`,
      source: '通义听悟',
    }

    if (!taskId) {
      return res.status(400).json({ success: false, error: '缺少 taskId' })
    }
    if (!['docx', 'txt'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format 仅支持 docx 或 txt' })
    }

    const info: any = await getTingwuTaskInfo(taskId)
    if (info?.Data?.TaskStatus === 'FAILED') {
      return res.status(409).json({
        success: false,
        error: info?.Data?.ErrorMessage || '转写失败',
      })
    }
    if (info?.Data?.TaskStatus !== 'COMPLETED') {
      return res.status(409).json({ success: false, error: '任务尚未完成，请继续轮询' })
    }
    const url = info?.Data?.Result?.Transcription
    if (!url) {
      return res.status(404).json({ success: false, error: '听悟结果中缺少转写 JSON URL' })
    }

    let json: TingwuJson
    try {
      json = await fetchTingwuJson(url)
    } catch (error: any) {
      const code = error?.response?.status
      if (code === 403 || code === 404) {
        return res.status(410).json({
          success: false,
          error: '转写结果已过期（约110分钟），请重新创建任务',
        })
      }
      return res.status(502).json({ success: false, error: '拉取转写 JSON 失败' })
    }

    const paragraphs = toReadingParagraphs(json)
    const fileBase = (meta.title || taskId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)
    const fileName = `${fileBase}.${format}`

    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      return res.send(renderTxt(meta, paragraphs))
    }

    const buf = await renderDocx(meta, paragraphs)
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    return res.send(buf)
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '下载失败',
    })
  }
})

export default app
