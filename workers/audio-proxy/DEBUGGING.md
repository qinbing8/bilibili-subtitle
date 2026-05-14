# Audio Proxy Debugging

## 当前目标

目标只有一个：让通义听悟通过 `https://bbq13560.dpdns.org/api/audio-proxy` 回拉音频后，`/api/transcription/status` 最终进入 `COMPLETED`。

## 当前已确认的事实

- 自定义域名可达。Cloudflare tail 已看到来自 `Aliyun Computing Co., LTD / Beijing` 的真实请求。
- Worker secret 已恢复，当前不再卡在 `config_missing`。
- `proxy` 模式的 Worker allowlist 已修正，`host_not_allowed` 不再是当前阻塞点。
- 标准 `m4a` 直连 `https://bilibili-subtitle-theta.vercel.app/tingwu-control.m4a` 仍返回 `Audio file link invalid.`。
- 标准 `m4a` 经 Worker 代理后，阿里云真实请求序列已经验证为：
  - `bytes=0-` -> `200`
  - `bytes=9223372036854775799-` -> `416`
  - `bytes=1158-` -> `206`
- 在上述修正全部生效后，听悟仍返回 `Audio file link invalid.`。

## 当前最强怀疑点

当前问题已经不再优先怀疑 `m4s` 容器形态，而更像是 **来源平台 / URL 兼容性**：

- 同一个标准 `m4a`，放在 `vercel.app` 上直连也失败
- 同一个标准 `m4a`，经 Cloudflare Worker 转发后仍失败
- 这说明当前主问题不是“B 站音频是 `m4s`”，而更像“听悟对当前公开 URL 来源还有额外限制”

下一轮最有价值的实验是：把同一个标准 `m4a` 放到 **阿里云 OSS / 其他更贴近听悟网络的静态源站**，继续跑 `direct/proxy` 对照。

## 听悟官方错误关键词

结合阿里云官方错误表，当前链路最相关的关键词有：

- `TSC.AudioFileLink`：`Audio file link invalid`
- `TSC.FileError`：`File cannot be read`
- `TSC.ContentLengthCheckFailed`：文件长度检查失败
- `TSC.AudioFormat`：音频格式与扩展名不匹配
- `TSC.FileType`：文件格式不支持

这几个错误的排查顺序不要混掉：

1. 先排公网可达性和 Worker 命中
2. 再排 Worker secret / allowlist / Range 语义
3. 最后才排 `m4s` / `m4a` / 容器形态

## 自动化命令

端到端验证：

```powershell
npm run verify:transcription
```

隔离阿里云真实请求并联动 tail：

```powershell
npm run verify:transcription:tail
```

如果只想看某个已部署版本：

```powershell
npm run verify:transcription:tail -- -VersionId <worker-version-id>
```

标准 `m4a` 对照实验：

```powershell
npm run verify:tingwu:control
```

只验证直连样本：

```powershell
npm run verify:tingwu:control -- -Mode direct
```

带 Worker tail 的 proxy 对照实验：

```powershell
npm run verify:tingwu:control:tail
```

默认行为：

- `verify:transcription` 会本地探测 `debugProxy.proxyUrl`
- `verify:transcription:tail` 默认关闭本地 probe，避免把本机 `Range: bytes=0-1023` 混进阿里云真实请求序列
- `verify:tingwu:control` 默认先跑 `direct`，再跑 `proxy`
- `verify:tingwu:control:tail` 默认只跑 `proxy`，因为 `direct` 不会命中 Worker

## 读结果的顺序

1. 先看 `verify:transcription` 或 `verify:transcription:tail` 的最终状态
2. 如果 Worker 没命中，先排查 `PUBLIC_PROXY_BASE_URL`、Vercel redeploy 和公网可达性
3. 如果 Worker 命中但报 `config_missing`，先重新 `wrangler secret put AUDIO_PROXY_TOKEN_SECRET`
4. 如果 Worker 命中且请求序列已是 `200 -> 416`，不要再回头折腾 `206` / `Accept-Ranges`，直接转向标准 `m4a` 对照实验

## 标准 m4a 对照实验的判定标准

- `direct PASS` + `proxy PASS`
  - 说明标准 `m4a` 经听悟直连和经 Worker 代理都可用
  - 当前 B 站链路更像 `m4s` / 源文件形态问题
- `direct PASS` + `proxy FAIL`
  - 说明听悟项目本身基本正常，问题还在 Worker allowlist / 代理链路
- `direct FAIL`
  - 若样本源站是 `vercel.app`，优先怀疑 Aliyun 到该源站的可达性，不要直接归因给听悟项目本身

## 当前实验结论

- `direct(Vercel sample)` -> `Audio file link invalid.`
- `proxy(Vercel sample, allowlist fixed, first 0- forced to 200)` -> 仍然 `Audio file link invalid.`
- 这两条证据合起来说明：
  - `m4s` 已经从主嫌疑降级
  - `host_not_allowed` 已排除
  - “首包 206 被拒绝” 已排除
  - 当前更像是听悟对来源平台 / 回源方式仍有额外限制

## proxy 对照实验的额外约束

`proxy` 模式不是直接拿 B 站 URL，而是让 Worker 代理一个仓库内静态样本 `public/tingwu-control.m4a`。因此 Worker 需要允许这个样本源站：

- 当前样本默认部署在 `https://bilibili-subtitle-theta.vercel.app/tingwu-control.m4a`
- Worker 若继续只允许 `*.bilivideo.com`，则 `proxy` 预检会直接报 `host_not_allowed`

此时不要误判成听悟拒绝 `m4a`，而应先给 Worker 配置 `ALLOWED_HOSTS`，至少包含：

```text
^bilibili-subtitle-theta\.vercel\.app$
```
