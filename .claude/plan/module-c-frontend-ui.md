# 模块 C：前端全套（v2 + docx 计划的所有前端工作）

> **窗口**：Claude Code worker 窗口（独立的 `claude` 会话）
> **启动时机**：**T=0，与模块 A 并行启动**，完全不依赖后端
> **预估时间**：30-60 分钟
> **依赖前置**：无（凭接口契约工作）
> **下游依赖者**：联调阶段需要 A+B 都完成

> **参考文件**（必读）：
> - `.claude/plan/vercel-fixes.md`（v2 计划的 Step 5 前端部分）
> - `.claude/plan/transcription-to-docx.md`（docx 计划的 Step 6 前端部分）
> - `.claude/plan/modular-split.md`（**接口契约 §3**，本模块严格按此 shape 工作）

---

## 0. 本模块的写权限文件

| 文件 | 操作 |
|------|------|
| `src/App.tsx` | **完整重写**（约 480 行 → 约 600 行） |
| `tailwind.config.js` | 新增 `shimmer` keyframe |
| `README.md` | 更新使用流程 |
| `DEPLOYMENT.md` | 更新环境变量说明 |

**严禁修改**：`api/*`、`package.json`、`vercel.json`、`.env.example`、`tsconfig.json`。

---

## 1. Step C1 — 改造 `tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      keyframes: {
        shimmer: {
          '0%':   { 'background-position': '200% 0' },
          '100%': { 'background-position': '-200% 0' },
        },
      },
      animation: {
        'shimmer-slow': 'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
};
```

> 保留 `content` 等现有字段；本步骤只新增 `keyframes` + `animation`。

---

## 2. Step C2 — 完整重写 `src/App.tsx`

### C2.1 顶部 imports

```tsx
import { useState, useEffect, useRef } from 'react'
import { Toaster, toast } from 'sonner'
import axios from 'axios'
import { FileText, Loader2, HelpCircle, CloudUpload, Music, Headphones } from 'lucide-react'
```

> 移除：`Video`（不再使用）。

### C2.2 类型定义

```tsx
type TaskState =
  | { kind: 'IDLE' }
  | { kind: 'STARTING' }
  | { kind: 'POLLING';   taskId: string; meta: TaskMeta; startedAt: number; nextDelayMs: number; consecutiveErrors: number }
  | { kind: 'COMPLETED'; taskId: string; meta: TaskMeta; transcriptionUrl?: string; preview?: string }
  | { kind: 'FAILED';    taskId?: string; errorMessage: string };

interface TaskMeta {
  metaToken: string;
  fileName: string;
  audioFormat: 'm4a' | 'flv';
  bandwidth?: number;
  source?: 'dash' | 'durl-fallback';
}
```

### C2.3 axios 拦截器（自动加密码 header）

```tsx
axios.interceptors.request.use(cfg => {
  const pw = localStorage.getItem('app_access_password');
  if (pw && cfg.url?.startsWith('/api/')) {
    cfg.headers = cfg.headers || {};
    (cfg.headers as any)['X-App-Password'] = pw;
  }
  return cfg;
});
```

### C2.4 登录遮罩（v2）

```tsx
function App() {
  const [isAuthed, setIsAuthed] = useState<boolean>(
    () => !!localStorage.getItem('app_access_password')
  );
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState('');

  async function tryLogin() {
    if (!pwInput.trim()) { setPwError('请输入密码'); return; }
    localStorage.setItem('app_access_password', pwInput);
    try {
      // 调用一个轻量 API 验证密码；这里用 /api/health（公开）+ /api/download-video（受保护）的策略
      // 简单做法：随便 POST 一个受保护接口，401 则密码错
      const probe = await axios.post('/api/download-video', { bilibiliUrl: 'https://www.bilibili.com/video/BVprobe' });
      // 即使 500（因为 BV 无效），只要不是 401 就算密码对
      setIsAuthed(true);
    } catch (e: any) {
      if (e.response?.status === 401) {
        setPwError('密码错误');
        localStorage.removeItem('app_access_password');
      } else {
        // 其他错误说明密码正确（后端拒绝是因为别的原因）
        setIsAuthed(true);
      }
    }
  }

  if (!isAuthed) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-white rounded-lg shadow-xl p-6 w-80">
          <h2 className="text-xl font-bold mb-2">访问受限</h2>
          <p className="text-sm text-gray-600 mb-4">请输入访问密码</p>
          <input
            type="password"
            value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(''); }}
            onKeyDown={e => e.key === 'Enter' && tryLogin()}
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
  // ... 主界面在下面
}
```

### C2.5 主界面 state & 副作用

```tsx
const [bilibiliUrl, setBilibiliUrl] = useState('');
const [task, setTask] = useState<TaskState>({ kind: 'IDLE' });
const [elapsed, setElapsed] = useState(0);
const pollTimer = useRef<number | null>(null);

// 1. 启动时从 localStorage 恢复任务
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

// 2. 持久化 / 清理
useEffect(() => {
  if (task.kind === 'POLLING') {
    localStorage.setItem('tingwu_task', JSON.stringify({
      taskId: task.taskId, meta: task.meta, startedAt: task.startedAt,
    }));
  } else if (['IDLE', 'COMPLETED', 'FAILED'].includes(task.kind)) {
    localStorage.removeItem('tingwu_task');
  }
}, [task]);

// 3. 已等待时间计时（仅 POLLING 状态）
useEffect(() => {
  if (task.kind !== 'POLLING') { setElapsed(0); return; }
  const id = window.setInterval(() => {
    setElapsed(Math.floor((Date.now() - task.startedAt) / 1000));
  }, 1000);
  return () => clearInterval(id);
}, [task]);

// 4. 轮询（visibility + 退避）
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
      const elapsedMs = Date.now() - task.startedAt;
      const next = elapsedMs < 60_000 ? 5000 : elapsedMs < 180_000 ? 15_000 : 30_000;
      setTask(prev => prev.kind === 'POLLING' ? { ...prev, nextDelayMs: next, consecutiveErrors: 0 } : prev);
      pollTimer.current = window.setTimeout(poll, next);
    } catch (err: any) {
      if (err?.response?.status === 410) {
        setTask({ kind: 'FAILED', taskId: task.taskId, errorMessage: '任务结果已过期，请重新创建' });
        return;
      }
      const ce = (task.kind === 'POLLING' ? task.consecutiveErrors : 0) + 1;
      if (ce >= 3) {
        setTask({ kind: 'FAILED', taskId: task.taskId, errorMessage: '网络异常，连续 3 次失败' });
        return;
      }
      setTask(prev => prev.kind === 'POLLING' ? { ...prev, consecutiveErrors: ce } : prev);
      pollTimer.current = window.setTimeout(poll, task.nextDelayMs);
    }
  };

  pollTimer.current = window.setTimeout(poll, 1000);
  return () => {
    cancelled = true;
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
  };
}, [task.kind, task.kind === 'POLLING' ? task.taskId : null]);

// 5. handleStart：提交转写任务
async function handleStart() {
  if (!bilibiliUrl.trim()) { toast.error('请输入 B 站链接'); return; }
  const bvidMatch = bilibiliUrl.match(/BV[0-9A-Za-z]+/);
  if (!bvidMatch) { toast.error('请输入有效的 B 站视频链接'); return; }

  setTask({ kind: 'STARTING' });
  try {
    const { data } = await axios.post('/api/transcription/start', {
      bilibiliUrl,
      diarization: false,
      textPolish: false,
    });
    if (!data.success) throw new Error(data.error);
    const d = data.data;
    if (d.warning) toast.warning(d.warning);
    setTask({
      kind: 'POLLING',
      taskId: d.taskId,
      meta: {
        metaToken: d.metaToken,
        fileName: d.fileName,
        audioFormat: d.audioFormat,
        bandwidth: d.bandwidth,
        source: d.source,
      },
      startedAt: Date.now(),
      nextDelayMs: 5000,
      consecutiveErrors: 0,
    });
  } catch (e: any) {
    const msg = e?.response?.data?.error || e.message || '提交失败';
    setTask({ kind: 'FAILED', errorMessage: msg });
    toast.error(msg);
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
```

### C2.6 Stepper 组件

```tsx
function Stepper({ activeStep, isPolling }: { activeStep: number; isPolling: boolean }) {
  const steps = [
    { id: 1, label: '解析视频' },
    { id: 2, label: '提取音频' },
    { id: 3, label: '听悟转写' },
    { id: 4, label: '可下载' },
  ];
  return (
    <div className="flex justify-between items-start w-full max-w-md mx-auto my-6" role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={activeStep}>
      {steps.map((s, i) => (
        <div key={s.id} className="flex flex-col items-center flex-1">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition ${
            activeStep > s.id ? 'bg-green-500 text-white' :
            activeStep === s.id ? `bg-indigo-600 text-white ${isPolling && s.id === 3 ? 'animate-pulse' : ''}` :
            'bg-gray-200 text-gray-500'
          }`}>
            {activeStep > s.id ? '✓' : s.id}
          </div>
          <span className="text-xs mt-1.5 text-gray-600 text-center">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
```

### C2.7 主面板渲染

```tsx
return (
  <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
    <Toaster position="top-right" />
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-gray-800 mb-2">B 站音频转写助手</h1>
        <p className="text-gray-600">B站视频 → 音频 → 通义听悟 → Word 文档</p>
        <div className="mt-4 p-4 bg-blue-50 rounded-lg text-left max-w-2xl mx-auto">
          <h3 className="font-semibold text-blue-800 mb-2">💡 使用提示</h3>
          <ul className="text-sm text-blue-700 space-y-1">
            <li>• 服务端已配置阿里云密钥，您无需输入</li>
            <li>• 转写过程会消耗部署者的阿里云配额，请勿滥用</li>
            <li>• 中途可关闭浏览器，下次访问可恢复任务</li>
          </ul>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">B 站视频链接</label>
        <input
          type="url"
          value={bilibiliUrl}
          onChange={e => setBilibiliUrl(e.target.value)}
          placeholder="https://www.bilibili.com/video/BV..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={task.kind !== 'IDLE' && task.kind !== 'FAILED'}
        />

        <Stepper
          activeStep={
            task.kind === 'IDLE' ? 0 :
            task.kind === 'STARTING' ? 2 :
            task.kind === 'POLLING' ? 3 :
            task.kind === 'COMPLETED' ? 4 : 0
          }
          isPolling={task.kind === 'POLLING'}
        />

        {(task.kind === 'IDLE' || task.kind === 'FAILED') && (
          <button
            onClick={handleStart}
            disabled={!bilibiliUrl.trim()}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center"
          >
            <CloudUpload className="w-4 h-4 mr-2" />
            提交转写任务
          </button>
        )}

        {task.kind === 'STARTING' && (
          <p className="text-center text-gray-600 py-3 flex items-center justify-center">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            正在提交...
          </p>
        )}

        {task.kind === 'POLLING' && (
          <div className="space-y-3 mt-2">
            <p className="text-center text-sm text-gray-700" aria-live="polite">
              正在转写中... 已等待 <strong>{formatElapsed(elapsed)}</strong>
            </p>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 animate-shimmer-slow"
                style={{
                  background: 'linear-gradient(90deg, #6366f1 0%, #3b82f6 50%, #6366f1 100%)',
                  backgroundSize: '200% 100%',
                }}
              />
            </div>
            <div className="text-xs text-gray-500 flex justify-between">
              <span>
                任务 ID: {task.taskId.slice(0, 12)}...
                <button onClick={() => { navigator.clipboard.writeText(task.taskId); toast.success('已复制'); }} className="underline ml-1">复制</button>
              </span>
              <button onClick={() => setTask({ kind: 'IDLE' })} className="text-red-500 underline">放弃轮询</button>
            </div>
          </div>
        )}

        {task.kind === 'COMPLETED' && (
          <div className="space-y-3 mt-2">
            <p className="text-green-700 text-sm font-medium">✅ 转写完成！</p>
            {task.preview && (
              <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded border-l-4 border-indigo-400">
                <strong>预览：</strong>{task.preview}...
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <a
                href={`/api/transcription/download?taskId=${task.taskId}&format=docx&meta=${encodeURIComponent(task.meta.metaToken)}`}
                className="py-2.5 bg-blue-600 text-white rounded-md text-center hover:bg-blue-700 flex items-center justify-center"
              >
                <FileText className="w-4 h-4 mr-1.5" />
                下载 Word (.docx)
              </a>
              <a
                href={`/api/transcription/download?taskId=${task.taskId}&format=txt&meta=${encodeURIComponent(task.meta.metaToken)}`}
                className="py-2.5 border border-gray-400 text-gray-700 rounded-md text-center hover:bg-gray-50 flex items-center justify-center"
              >
                <FileText className="w-4 h-4 mr-1.5" />
                下载纯文本 (.txt)
              </a>
            </div>
            <button onClick={() => { setTask({ kind: 'IDLE' }); setBilibiliUrl(''); }} className="text-xs text-gray-500 underline w-full text-center">
              开始新的转写
            </button>
          </div>
        )}

        {task.kind === 'FAILED' && (
          <div className="bg-red-50 border-l-4 border-red-500 p-3 rounded mt-2">
            <p className="text-red-700 font-medium">❌ 转写失败</p>
            <p className="text-red-600 text-sm mt-1">{task.errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  </div>
);
```

### C2.8 ⚠️ axios baseURL（**注意**！）

> ⚠️ **重要**：上面 axios 拦截器里的 `cfg.url?.startsWith('/api/')` 默认情况下只对**相对路径**的请求生效。如果未来换成 axios 实例 + baseURL 配置，要相应调整判断逻辑。
> 由于现有代码用相对路径（依赖 Vite dev server 的 `/api` proxy），保持不变即可。

---

## 3. Step C3 — 更新 `README.md`

把"使用流程"段落改为：

```markdown
## 使用流程

1. 部署后访问 Vercel URL，输入访问密码（部署者配置的 `APP_ACCESS_PASSWORD`）
2. 粘贴 B 站视频链接
3. 点击「提交转写任务」
4. 等待转写（通常 1-5 分钟，中途可关闭页面，下次回来自动恢复）
5. 完成后点击「下载 Word (.docx)」或「下载纯文本 (.txt)」
```

环境变量章节改为完整列表（详见 `.env.example`）。

---

## 4. Step C4 — 更新 `DEPLOYMENT.md`

把"环境变量配置（可选）"章节改为"环境变量配置（**必填**）"，列出 6 个必填项与 3 个可选项（详见 `.env.example`）。

---

## 5. 验收清单

```bash
# 1. 类型 + 构建
npm run check
npm run build
# 期望：无错

# 2. 启动前端
npm run dev:frontend
# 浏览器打开 http://localhost:5173

# 3. 视觉验证（在浏览器）
# - 首屏：登录遮罩 + 输入框
# - 输入任意密码 → 进入主界面（即使后端没起，也应该能进入；密码错只在后端 401 时回退）
# - 输入 B 站 URL → 点"提交转写任务" → 应该看到 Network 中发出 POST /api/transcription/start
# - 在 DevTools Network 中确认请求 header 包含 `X-App-Password`
# - 模拟轮询：用浏览器 console 直接 setTask 到 POLLING 状态 → Stepper 第 3 步亮起，倒计时启动
# - 切换 tab 离开 → Network 面板应看到轮询暂停；回到 tab 立即续上

# 4. localStorage 持久化
# - 进入 POLLING 状态后 Application → Local Storage 应有 'tingwu_task' 键
# - 刷新页面 → toast 显示"已恢复轮询"

# 5. 编辑器搜索：确认旧代码已删除
grep -rn "tingwuResult\|videoFileUrl\|setVideoFileUrl" src/
# 期望：无匹配（旧字段已全部清理）
grep -rn "accessKey" src/
# 期望：无匹配（前端不再持有 AccessKey）
```

---

## 6. 完成后通知

```bash
git add -A
git commit -m "feat(frontend): rewrite with auth gate, polling state machine and docx download"
```

在 `.claude/plan/STATUS.md` 追加：

```
- <YYYY-MM-DD HH:MM> — 模块 C 完成 (commit: <短 hash>)
```

告诉协调者："模块 C 完成，可以联调。"

---

## 7. 严禁事项

- ❌ 不要修改 `api/*` 任何文件
- ❌ 不要修改 `package.json` / `vercel.json` / `.env.example`
- ❌ 不要假设后端返回的字段比 `.claude/plan/modular-split.md` §3 多
- ❌ 不要在前端硬编码任何密钥
- ❌ 不要"顺便"加 AI 排版按钮（第二期）

如发现接口契约 §3 描述不清楚或不可实现，**暂停并报告**，不要自行扩展契约。

---

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 后端 A/B 还没完成，无法联调 | 用 Chrome DevTools 的 "Network → Block request" 模拟 401/410；或者用 MSW（mock service worker）拦截 |
| Stepper 在窄屏（< 360px）挤压变形 | 用 `flex-1` + `text-center` 配合 `text-xs` 已可适应；如还窄就用 `overflow-x-auto` |
| 轮询消耗用户网络/电量 | 已用 Visibility API + 退避（5s/15s/30s） |
| 用户在转写完成前关闭浏览器 | localStorage 持久化 + 自动恢复 |
| .docx 大文件下载阻塞 UI | 用 `<a href download>` 让浏览器原生下载（非 fetch + blob） |
