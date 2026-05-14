# Bilibili Audio Proxy Worker

这个 Worker 只负责 `/api/audio-proxy`：通义听悟拿到 Vercel 签发的代理 URL 后，会从这里回拉 B 站音频。前端、登录、转写任务创建、状态查询和文件下载仍然在 Vercel。

## 环境变量怎么理解

`AUDIO_PROXY_TOKEN_SECRET` 需要同时存在于两个地方，值必须完全一样：

- Vercel 项目环境变量：后端用它“签名”音频代理 token。
- Cloudflare Worker secret：Worker 用它“验证”这个 token。

如果 Vercel 上已经有 `AUDIO_PROXY_TOKEN_SECRET`，不要改 Vercel 的值。部署 Worker 时只需要在命令行执行 `npx wrangler secret put AUDIO_PROXY_TOKEN_SECRET`，然后把同一个值粘贴进去。这个动作是在设置 Worker 的环境变量，不是在修改 Vercel。

`PUBLIC_PROXY_BASE_URL` 只需要配置在 Vercel。它应该填部署后的 Worker 地址，例如：

```text
https://bilibili-audio-proxy.<你的 Cloudflare account subdomain>.workers.dev
```

不要带末尾斜杠。修改 Vercel 环境变量后，需要重新部署 Vercel 项目才会生效。

`ALLOWED_HOSTS` 是 Worker 侧的可选环境变量，用来覆盖默认上游白名单。默认值只放行 B 站音频域名；如果要做标准 `m4a` 对照实验，让 Worker 代理仓库内静态样本，则需要额外允许样本源站，例如：

```text
^bilibili-subtitle-theta\.vercel\.app$
```

当前仓库已经在 [wrangler.toml](D:\workspeace\bilibili-subtitle\workers\audio-proxy\wrangler.toml) 里把这条规则和默认 B 站白名单一起固化了；后续如果换 Vercel 域名，需要同步更新这里。

## 首次部署

```powershell
Set-Location D:\workspeace\bilibili-subtitle\workers\audio-proxy
npm install
npx wrangler login
npx wrangler secret put AUDIO_PROXY_TOKEN_SECRET
npx wrangler deploy
```

`npx wrangler secret put AUDIO_PROXY_TOKEN_SECRET` 会提示输入 secret。把 Vercel 里当前的 `AUDIO_PROXY_TOKEN_SECRET` 值粘贴进去即可；终端不会把输入内容显示出来，这是正常的。

部署成功后，Wrangler 会输出 Worker URL。把这个 URL 写到 Vercel 的 `PUBLIC_PROXY_BASE_URL`。

## 本地检查

```powershell
npm run check
npm test
npx wrangler deploy --dry-run
```

如果是线上联调，不要只靠手工 `curl`。优先使用根目录自动化命令：

```powershell
npm run verify:transcription
npm run verify:transcription:tail
npm run verify:tingwu:control
npm run verify:tingwu:control:tail
```

当前调试目标、已排除项和下一步排查方向见 [DEBUGGING.md](./DEBUGGING.md)。

## 本地临时运行

本命令会启动短期调试服务，只用于手工测试 Worker，不是项目后端：

```powershell
npx wrangler dev --local
```

常用检查：

```powershell
curl http://localhost:8787/health
curl -i http://localhost:8787/api/audio-proxy
curl -i "http://localhost:8787/api/audio-proxy?t=abc.def"
curl -i -X POST http://localhost:8787/api/audio-proxy
```

期望结果分别是：`200 ok`、`401 {"error":"missing"}`、`401 {"error":"badSig"}` 或 `malformed`、`405 method_not_allowed`。

## 回滚

如果听悟无法访问 `workers.dev`，先不要删除 Worker。把 Vercel 的 `PUBLIC_PROXY_BASE_URL` 改回上一条可用公网代理地址，并重新部署 Vercel。Worker 可以保留，后续换自定义域名或其他部署平台时继续复用这份代码。
