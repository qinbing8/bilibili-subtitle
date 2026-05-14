# Audio Proxy Debugging

## 当前目标

目标只有一个：让通义听悟通过 `https://bbq13560.dpdns.org/api/audio-proxy` 回拉音频后，`/api/transcription/status` 最终进入 `COMPLETED`。

## 当前已确认的事实

- 自定义域名可达。Cloudflare tail 已看到来自 `Aliyun Computing Co., LTD / Beijing` 的真实请求。
- Worker secret 已恢复，当前不再卡在 `config_missing`。
- 首个 `Range: bytes=0-` 已实验为 `200`，不是“听悟拒绝首个 206”。
- 超大越界 `Range` 已从错误的 `502` 修正为标准 `416`。
- 在上述修正全部生效后，听悟仍返回 `Audio file link invalid.`。

## 当前最强怀疑点

当前问题已经基本从 HTTP 状态码和基础响应头，收敛到音频文件形态本身：

- 当前代理源还是 Bilibili DASH 音频片段（`m4s`）
- 即便 Worker 对外呈现为 `audio/mp4`
- 听悟仍可能不接受这种封装形态

下一轮最有价值的实验是：提供一个标准 `m4a` 对照样本，验证听悟是否能在同一链路下成功拉取。

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
  - 说明先不要继续折腾 Worker；先检查样本部署、听悟项目配置和基础账号状态

## proxy 对照实验的额外约束

`proxy` 模式不是直接拿 B 站 URL，而是让 Worker 代理一个仓库内静态样本 `public/tingwu-control.m4a`。因此 Worker 需要允许这个样本源站：

- 当前样本默认部署在 `https://bilibili-subtitle-theta.vercel.app/tingwu-control.m4a`
- Worker 若继续只允许 `*.bilivideo.com`，则 `proxy` 预检会直接报 `host_not_allowed`

此时不要误判成听悟拒绝 `m4a`，而应先给 Worker 配置 `ALLOWED_HOSTS`，至少包含：

```text
^bilibili-subtitle-theta\.vercel\.app$
```
