import { useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import axios from 'axios'
import {
  AlertTriangle,
  FileText,
  Headphones,
  HelpCircle,
  Loader2,
  Music,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'

type TaskState =
  | { kind: 'IDLE' }
  | { kind: 'STARTING' }
  | {
      kind: 'POLLING'
      taskId: string
      meta: TaskMeta
      startedAt: number
      nextDelayMs: number
      consecutiveErrors: number
    }
  | {
      kind: 'COMPLETED'
      taskId: string
      meta: TaskMeta
      transcriptionUrl?: string
      preview?: string
    }
  | { kind: 'FAILED'; taskId?: string; errorMessage: string }

interface TaskMeta {
  metaToken: string
  fileName: string
  audioFormat: 'm4a' | 'flv'
  bandwidth?: number
  source?: 'dash' | 'durl-fallback'
  audioHost?: string
  proxyHost?: string
  sourceExpiresAt?: string
  proxyExpiresAt?: string
}

interface ProxyConfigState {
  loaded: boolean
  configured: boolean
  host: string | null
  error?: string
}

function toDisplayError(error: unknown, fallback = '请求失败'): string {
  if (typeof error === 'string') {
    const trimmed = error.trim()
    return trimmed || fallback
  }

  if (error instanceof Error) {
    const trimmed = error.message.trim()
    return trimmed || fallback
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const nestedError = record.error
    if (typeof nestedError === 'string' && nestedError.trim()) {
      return nestedError.trim()
    }
    const nestedMessage = record.message
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim()
    }
  }

  return fallback
}

let hasPasswordHeaderInterceptor = false

if (!hasPasswordHeaderInterceptor) {
  axios.interceptors.request.use((config) => {
    const password = localStorage.getItem('app_access_password')
    if (password && config.url?.startsWith('/api/')) {
      const headers = config.headers ?? {}
      ;(headers as Record<string, string>)['X-App-Password'] = password
      config.headers = headers
    }
    return config
  })
  hasPasswordHeaderInterceptor = true
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  return minutes > 0 ? `${minutes}分${remainSeconds}秒` : `${remainSeconds}秒`
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function readOptionalHost(value: unknown): string | undefined {
  const raw = readOptionalString(value)
  if (!raw) {
    return undefined
  }

  try {
    return new URL(raw).host || undefined
  } catch {
    return raw
  }
}

function normalizeTaskMeta(raw: unknown): TaskMeta | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const meta = raw as Record<string, unknown>
  const metaToken = readOptionalString(meta.metaToken)
  const fileName = readOptionalString(meta.fileName)
  const audioFormat = meta.audioFormat === 'm4a' || meta.audioFormat === 'flv' ? meta.audioFormat : null

  if (!metaToken || !fileName || !audioFormat) {
    return null
  }

  return {
    metaToken,
    fileName,
    audioFormat,
    bandwidth: typeof meta.bandwidth === 'number' && Number.isFinite(meta.bandwidth) ? meta.bandwidth : undefined,
    source: meta.source === 'dash' || meta.source === 'durl-fallback' ? meta.source : undefined,
    audioHost: readOptionalHost(meta.audioHost ?? meta.audioUrl),
    proxyHost: readOptionalHost(meta.proxyHost ?? meta.proxyUrl),
    sourceExpiresAt: readOptionalString(meta.sourceExpiresAt ?? meta.expiresAt),
    proxyExpiresAt: readOptionalString(meta.proxyExpiresAt),
  }
}

function formatTimeRemaining(isoTime?: string): string {
  if (!isoTime) {
    return '未知'
  }

  const diffMs = new Date(isoTime).getTime() - Date.now()
  if (!Number.isFinite(diffMs)) {
    return isoTime
  }
  if (diffMs <= 0) {
    return '已过期'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分`
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  }
  return `${seconds}秒`
}

function ProxyConfigBanner({ proxyConfig }: { proxyConfig: ProxyConfigState }) {
  if (!proxyConfig.loaded) {
    return null
  }

  if (proxyConfig.error) {
    return (
      <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        无法读取公网代理配置状态：{proxyConfig.error}
      </div>
    )
  }

  if (!proxyConfig.configured) {
    return (
      <div className="mb-4 rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-sm">
        <div className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4" />
          公网代理地址未配置
        </div>
        <p className="mt-2">
          通义听悟将无法拉取音频文件。请在独立终端运行
          <code className="mx-1 rounded bg-rose-100 px-1 py-0.5 text-xs">
            cloudflared tunnel --url http://localhost:9091
          </code>
          ，再把生成的 <code className="rounded bg-rose-100 px-1 py-0.5 text-xs">https://*.trycloudflare.com</code>{' '}
          写入 <code className="rounded bg-rose-100 px-1 py-0.5 text-xs">PUBLIC_PROXY_BASE_URL</code> 并重启后端。
        </p>
      </div>
    )
  }

  return (
    <details className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <ShieldCheck className="h-4 w-4" />
        代理通道已配置：{proxyConfig.host || '已隐藏'}
      </summary>
      <p className="mt-2 text-xs text-emerald-800">
        前端仅展示 host，完整带 token 的代理 URL 不会回传浏览器。任务创建后，可在下方“调试信息”里确认本次使用的代理 host。
      </p>
    </details>
  )
}

function DebugInfoPanel({
  meta,
  taskId,
}: {
  meta: TaskMeta
  taskId?: string
}) {
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
      <summary className="cursor-pointer font-medium text-slate-800">
        调试信息
      </summary>
      <div className="mt-3 space-y-3">
        {taskId && (
          <div>
            <div className="font-medium text-slate-600">任务 ID</div>
            <code className="break-all text-[11px] text-slate-800">{taskId}</code>
          </div>
        )}
        {meta.audioHost && (
          <div>
            <div className="font-medium text-slate-600">原始音频 Host</div>
            <code className="break-all text-[11px] text-slate-800">{meta.audioHost}</code>
          </div>
        )}
        {meta.proxyHost && (
          <div>
            <div className="font-medium text-slate-600">代理 Host</div>
            <code className="break-all text-[11px] text-slate-800">{meta.proxyHost}</code>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="font-medium text-slate-600">源地址过期</div>
            <div>{meta.sourceExpiresAt || '未知'}</div>
            <div className="text-slate-500">
              剩余：{formatTimeRemaining(meta.sourceExpiresAt)}
            </div>
          </div>
          <div>
            <div className="font-medium text-slate-600">代理 token 过期</div>
            <div>{meta.proxyExpiresAt || '未知'}</div>
            <div className="text-slate-500">
              剩余：{formatTimeRemaining(meta.proxyExpiresAt)}
            </div>
          </div>
        </div>
      </div>
    </details>
  )
}

function getActiveStep(task: TaskState): number {
  if (task.kind === 'STARTING') {
    return 2
  }

  if (task.kind === 'POLLING') {
    return 3
  }

  if (task.kind === 'COMPLETED') {
    return 4
  }

  return 0
}

function Stepper({
  activeStep,
  isPolling,
}: {
  activeStep: number
  isPolling: boolean
}) {
  const steps = [
    { id: 1, label: '解析视频' },
    { id: 2, label: '提取音频' },
    { id: 3, label: '听悟转写' },
    { id: 4, label: '可下载' },
  ]

  return (
    <div className="overflow-x-auto">
      <div
        className="mx-auto my-6 flex min-w-[320px] max-w-md items-start justify-between"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={4}
        aria-valuenow={activeStep === 0 ? 1 : activeStep}
        aria-valuetext={
          activeStep === 0 ? '任务尚未开始' : `当前第 ${activeStep} 步，共 4 步`
        }
      >
        {steps.map((step) => (
          <div key={step.id} className="flex flex-1 flex-col items-center">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition ${
                activeStep > step.id
                  ? 'bg-emerald-500 text-white'
                  : activeStep === step.id
                    ? `bg-cyan-600 text-white ${
                        isPolling && step.id === 3 ? 'animate-pulse' : ''
                      }`
                    : 'bg-slate-200 text-slate-500'
              }`}
            >
              {activeStep > step.id ? '✓' : step.id}
            </div>
            <span className="mt-1.5 text-center text-xs text-slate-600">
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function App() {
  const [isAuthed, setIsAuthed] = useState<boolean>(
    () => !!localStorage.getItem('app_access_password')
  )
  const [pwInput, setPwInput] = useState('')
  const [pwError, setPwError] = useState('')
  const [bilibiliUrl, setBilibiliUrl] = useState('')
  const [task, setTask] = useState<TaskState>({ kind: 'IDLE' })
  const [elapsed, setElapsed] = useState(0)
  const [proxyConfig, setProxyConfig] = useState<ProxyConfigState>({
    loaded: false,
    configured: false,
    host: null,
  })
  const pollTimer = useRef<number | null>(null)
  const latestTaskRef = useRef<TaskState>({ kind: 'IDLE' })

  useEffect(() => {
    latestTaskRef.current = task
  }, [task])

  useEffect(() => {
    if (!isAuthed) {
      return
    }

    let cancelled = false

    void axios
      .get('/api/health-with-config')
      .then(({ data }) => {
        if (cancelled) {
          return
        }

        setProxyConfig({
          loaded: true,
          configured: !!data.proxyBaseUrlConfigured,
          host: data.proxyBaseHost || null,
        })
      })
      .catch((error: any) => {
        if (cancelled) {
          return
        }

        setProxyConfig({
          loaded: true,
          configured: false,
          host: null,
          error: toDisplayError(error?.response?.data, toDisplayError(error, '请求失败')),
        })
      })

    return () => {
      cancelled = true
    }
  }, [isAuthed])

  async function tryLogin() {
    if (!pwInput.trim()) {
      setPwError('请输入密码')
      return
    }

    localStorage.setItem('app_access_password', pwInput)

    try {
      await axios.get('/api/auth-check')
      setIsAuthed(true)
    } catch (error: any) {
      if (error.response?.status === 401) {
        setPwError('密码错误')
        localStorage.removeItem('app_access_password')
        return
      }

      setPwError(toDisplayError(error?.response?.data, toDisplayError(error, '登录校验失败')))
      localStorage.removeItem('app_access_password')
    }
  }

  useEffect(() => {
    const savedTask = localStorage.getItem('tingwu_task')
    if (!savedTask) {
      return
    }

    try {
      const parsed = JSON.parse(savedTask) as {
        taskId?: string
        meta?: unknown
        startedAt?: number
      }
      const meta = normalizeTaskMeta(parsed.meta)

      if (parsed.taskId && meta) {
        setTask({
          kind: 'POLLING',
          taskId: parsed.taskId,
          meta,
          startedAt: parsed.startedAt || Date.now(),
          nextDelayMs: 5000,
          consecutiveErrors: 0,
        })
        toast.info('检测到未完成的转写任务，已恢复轮询')
      }
    } catch {
      localStorage.removeItem('tingwu_task')
    }
  }, [])

  useEffect(() => {
    if (task.kind === 'POLLING') {
      localStorage.setItem(
        'tingwu_task',
        JSON.stringify({
          taskId: task.taskId,
          meta: task.meta,
          startedAt: task.startedAt,
        })
      )
      return
    }

    localStorage.removeItem('tingwu_task')
  }, [task])

  useEffect(() => {
    if (task.kind !== 'POLLING') {
      setElapsed(0)
      return
    }

    setElapsed(Math.floor((Date.now() - task.startedAt) / 1000))
    const timerId = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - task.startedAt) / 1000))
    }, 1000)

    return () => window.clearInterval(timerId)
  }, [task.kind, task.kind === 'POLLING' ? task.startedAt : 0])

  useEffect(() => {
    if (task.kind !== 'POLLING') {
      return
    }

    let cancelled = false

    const schedulePoll = (delayMs: number) => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current)
      }
      pollTimer.current = window.setTimeout(() => {
        void poll()
      }, delayMs)
    }

    const poll = async () => {
      if (cancelled) {
        return
      }

      const currentTask = latestTaskRef.current
      if (currentTask.kind !== 'POLLING') {
        return
      }

      if (document.visibilityState === 'hidden') {
        schedulePoll(10000)
        return
      }

      try {
        const { data } = await axios.get(
          `/api/transcription/status?taskId=${currentTask.taskId}`
        )

        if (cancelled) {
          return
        }

        const payload = data.data
        if (payload.status === 'COMPLETED') {
          setTask({
            kind: 'COMPLETED',
            taskId: currentTask.taskId,
            meta: currentTask.meta,
            transcriptionUrl: payload.transcriptionUrl,
            preview: payload.preview,
          })
          toast.success('转写完成！文件已就绪')
          return
        }

        if (payload.status === 'FAILED') {
          setTask({
            kind: 'FAILED',
            taskId: currentTask.taskId,
            errorMessage: payload.errorMessage || '转写失败',
          })
          return
        }

        const elapsedMs = Date.now() - currentTask.startedAt
        const nextDelayMs =
          elapsedMs < 60_000 ? 5000 : elapsedMs < 180_000 ? 15_000 : 30_000

        setTask((prevTask) =>
          prevTask.kind === 'POLLING'
            ? {
                ...prevTask,
                nextDelayMs,
                consecutiveErrors: 0,
              }
            : prevTask
        )
        schedulePoll(nextDelayMs)
      } catch (error: any) {
        if (error?.response?.status === 410) {
          setTask({
            kind: 'FAILED',
            taskId: currentTask.taskId,
            errorMessage: '任务结果已过期，请重新创建',
          })
          return
        }

        const consecutiveErrors = currentTask.consecutiveErrors + 1
        if (consecutiveErrors >= 3) {
          setTask({
            kind: 'FAILED',
            taskId: currentTask.taskId,
            errorMessage: '网络异常，连续 3 次失败',
          })
          return
        }

        setTask((prevTask) =>
          prevTask.kind === 'POLLING'
            ? {
                ...prevTask,
                consecutiveErrors,
              }
            : prevTask
        )
        schedulePoll(currentTask.nextDelayMs)
      }
    }

    const handleVisibilityChange = () => {
      if (cancelled) {
        return
      }

      if (document.visibilityState === 'visible') {
        schedulePoll(0)
      }
    }

    schedulePoll(1000)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [task.kind, task.kind === 'POLLING' ? task.taskId : null])

  async function handleStart() {
    if (!bilibiliUrl.trim()) {
      toast.error('请输入 B 站链接')
      return
    }

    const bvidMatch = bilibiliUrl.match(/BV[0-9A-Za-z]+/)
    if (!bvidMatch) {
      toast.error('请输入有效的 B 站视频链接')
      return
    }

    setTask({ kind: 'STARTING' })

    try {
      const { data } = await axios.post('/api/transcription/start', {
        bilibiliUrl,
        diarization: false,
        textPolish: false,
      })

      if (!data.success) {
        throw new Error(data.error || '提交失败')
      }

      const taskData = data.data
      if (taskData.warning) {
        toast.warning(taskData.warning)
      }

      const meta = normalizeTaskMeta({
        metaToken: taskData.metaToken,
        fileName: taskData.fileName,
        audioFormat: taskData.audioFormat,
        bandwidth: taskData.bandwidth,
        source: taskData.source,
        audioHost: taskData.audioHost ?? taskData.audioUrl,
        proxyHost: taskData.proxyHost ?? taskData.proxyUrl,
        sourceExpiresAt: taskData.sourceExpiresAt ?? taskData.expiresAt,
        proxyExpiresAt: taskData.proxyExpiresAt,
      })

      if (!meta) {
        throw new Error('服务端返回的任务元数据不完整')
      }

      setTask({
        kind: 'POLLING',
        taskId: taskData.taskId,
        meta,
        startedAt: Date.now(),
        nextDelayMs: 5000,
        consecutiveErrors: 0,
      })
    } catch (error: any) {
      const errorMessage = toDisplayError(error?.response?.data, toDisplayError(error, '提交失败'))
      setTask({ kind: 'FAILED', errorMessage })
      toast.error(errorMessage)
    }
  }

  const canEditUrl = task.kind === 'IDLE' || task.kind === 'FAILED'
  const activeStep = getActiveStep(task)

  if (!isAuthed) {
    return (
      <div className="min-h-screen bg-slate-950">
        <Toaster position="top-right" />
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-2 flex items-center gap-2 text-slate-900">
              <Headphones className="h-5 w-5 text-cyan-700" />
              <h2 className="text-xl font-bold">访问受限</h2>
            </div>
            <p className="mb-4 text-sm text-slate-600">请输入访问密码</p>
            <input
              type="password"
              value={pwInput}
              onChange={(event) => {
                setPwInput(event.target.value)
                setPwError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void tryLogin()
                }
              }}
              placeholder="访问密码"
              className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
            />
            {pwError && <p className="mb-2 text-sm text-rose-600">{pwError}</p>}
            <button
              onClick={() => {
                void tryLogin()
              }}
              className="w-full rounded-lg bg-cyan-700 py-2 text-white transition hover:bg-cyan-800"
            >
              进入系统
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-sky-50 to-cyan-100">
      <Toaster position="top-right" />

      <div className="mx-auto max-w-3xl px-4 py-8">
        <ProxyConfigBanner proxyConfig={proxyConfig} />

        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200">
            <Headphones className="h-4 w-4 text-cyan-700" />
            通义听悟转写工作台
          </div>
          <h1 className="mt-4 text-4xl font-bold text-slate-900">
            B 站音频转写助手
          </h1>
          <p className="mt-2 text-slate-600">
            B站视频 -&gt; 音频 -&gt; 通义听悟 -&gt; Word 文档
          </p>

          <div className="mx-auto mt-4 max-w-2xl rounded-2xl bg-white/85 p-4 text-left shadow-sm ring-1 ring-slate-200">
            <div className="mb-2 flex items-center gap-2 font-semibold text-sky-900">
              <HelpCircle className="h-4 w-4" />
              使用提示
            </div>
            <ul className="space-y-1 text-sm text-slate-700">
              <li>服务端已配置阿里云密钥，您无需输入</li>
              <li>转写过程会消耗部署者的阿里云配额，请勿滥用</li>
              <li>中途可关闭浏览器，下次访问可恢复任务</li>
            </ul>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
          <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
            <Music className="h-4 w-4 text-cyan-700" />
            B 站视频链接
          </label>
          <input
            type="url"
            value={bilibiliUrl}
            onChange={(event) => setBilibiliUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canEditUrl) {
                event.preventDefault()
                void handleStart()
              }
            }}
            placeholder="https://www.bilibili.com/video/BV..."
            className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
            disabled={!canEditUrl}
          />

          <Stepper activeStep={activeStep} isPolling={task.kind === 'POLLING'} />

          {(task.kind === 'IDLE' || task.kind === 'FAILED') && (
            <button
              onClick={() => {
                void handleStart()
              }}
              disabled={!bilibiliUrl.trim()}
              className="flex w-full items-center justify-center rounded-lg bg-cyan-700 py-2.5 text-white transition hover:bg-cyan-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UploadCloud className="mr-2 h-4 w-4" />
              提交转写任务
            </button>
          )}

          {task.kind === 'STARTING' && (
            <p className="flex items-center justify-center py-3 text-center text-slate-600">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在提交...
            </p>
          )}

          {task.kind === 'POLLING' && (
            <div className="mt-2 space-y-3">
              <p className="text-center text-sm text-slate-700" aria-live="polite">
                正在转写中... 已等待 <strong>{formatElapsed(elapsed)}</strong>
              </p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-2 animate-shimmer-slow"
                  style={{
                    background:
                      'linear-gradient(90deg, #155e75 0%, #06b6d4 50%, #155e75 100%)',
                    backgroundSize: '200% 100%',
                  }}
                />
              </div>
              <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  任务 ID: {task.taskId.slice(0, 12)}...
                  <button
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(task.taskId)
                        .then(() => toast.success('已复制'))
                        .catch(() => toast.error('复制失败'))
                    }}
                    className="ml-1 underline underline-offset-2"
                  >
                    复制
                  </button>
                </span>
                <button
                  onClick={() => setTask({ kind: 'IDLE' })}
                  className="text-left text-rose-600 underline underline-offset-2 sm:text-right"
                >
                  放弃轮询
                </button>
              </div>
              <DebugInfoPanel meta={task.meta} taskId={task.taskId} />
            </div>
          )}

          {task.kind === 'COMPLETED' && (
            <div className="mt-2 space-y-3">
              <p className="text-sm font-medium text-emerald-700">✓ 转写完成！</p>
              {task.preview && (
                <div className="rounded-lg border-l-4 border-cyan-400 bg-slate-50 p-3 text-xs text-slate-600">
                  <strong>预览：</strong>
                  {task.preview}...
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <a
                  href={`/api/transcription/download?taskId=${
                    task.taskId
                  }&format=docx&meta=${encodeURIComponent(task.meta.metaToken)}`}
                  className="flex items-center justify-center rounded-lg bg-cyan-700 py-2.5 text-white transition hover:bg-cyan-800"
                >
                  <FileText className="mr-1.5 h-4 w-4" />
                  下载 Word (.docx)
                </a>
                <a
                  href={`/api/transcription/download?taskId=${
                    task.taskId
                  }&format=txt&meta=${encodeURIComponent(task.meta.metaToken)}`}
                  className="flex items-center justify-center rounded-lg border border-slate-400 py-2.5 text-slate-700 transition hover:bg-slate-50"
                >
                  <FileText className="mr-1.5 h-4 w-4" />
                  下载纯文本 (.txt)
                </a>
              </div>
              <DebugInfoPanel meta={task.meta} taskId={task.taskId} />
              <button
                onClick={() => {
                  setTask({ kind: 'IDLE' })
                  setBilibiliUrl('')
                }}
                className="w-full text-center text-xs text-slate-500 underline underline-offset-2"
              >
                开始新的转写
              </button>
            </div>
          )}

          {task.kind === 'FAILED' && (
            <div className="mt-2 rounded-lg border-l-4 border-rose-500 bg-rose-50 p-3">
              <p className="font-medium text-rose-700">转写失败</p>
              <p className="mt-1 text-sm text-rose-600">{task.errorMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
