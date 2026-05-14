param(
  [string]$BaseUrl = 'https://bilibili-subtitle-theta.vercel.app',
  [string]$SamplePath = '/tingwu-control.m4a',
  [ValidateSet('both', 'direct', 'proxy')]
  [string]$Mode = 'proxy',
  [string]$Language = 'auto',
  [int]$PollIntervalSec = 15,
  [int]$MaxWaitSec = 45,
  [int]$RequestTimeoutSec = 30,
  [string]$WorkerName = 'bilibili-audio-proxy',
  [string]$WorkerDir = '',
  [string]$VersionId = '',
  [int]$TailWarmupSec = 8,
  [int]$TailCooldownSec = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkerDir) {
  $WorkerDir = Join-Path $repoRoot 'workers\audio-proxy'
}

$wranglerPath = Join-Path $WorkerDir 'node_modules\.bin\wrangler.cmd'
if (-not (Test-Path $wranglerPath)) {
  throw "未找到 wrangler: $wranglerPath"
}

$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$timestamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$tailOut = Join-Path $logDir "$timestamp-tingwu-control-tail.out.log"
$tailErr = Join-Path $logDir "$timestamp-tingwu-control-tail.err.log"

$tailArgs = @('tail', $WorkerName, '--format', 'json')
if ($VersionId) {
  $tailArgs += @('--version-id', $VersionId)
}

$verifyScript = Join-Path $PSScriptRoot 'verify-tingwu-control.ps1'
$pwshPath = (Get-Command pwsh).Source
$verifyArgs = @(
  '-NoProfile',
  '-File',
  $verifyScript,
  '-BaseUrl',
  $BaseUrl,
  '-SamplePath',
  $SamplePath,
  '-Mode',
  $Mode,
  '-Language',
  $Language,
  '-PollIntervalSec',
  $PollIntervalSec,
  '-MaxWaitSec',
  $MaxWaitSec,
  '-RequestTimeoutSec',
  $RequestTimeoutSec
)

Write-Host "[tail] worker=$WorkerName version=$($VersionId ? $VersionId : 'latest')"
Write-Host "[tail] out=$tailOut"
Write-Host "[tail] err=$tailErr"
Write-Host "[tail] 预期: proxy 模式下抓到 Aliyun 对 Worker 的真实请求；direct 模式不会产生 Worker 日志"

$tail = Start-Process `
  -FilePath $wranglerPath `
  -ArgumentList $tailArgs `
  -WorkingDirectory $WorkerDir `
  -RedirectStandardOutput $tailOut `
  -RedirectStandardError $tailErr `
  -PassThru `
  -WindowStyle Hidden

Start-Sleep -Seconds $TailWarmupSec

$verifyExitCode = 1
try {
  & $pwshPath @verifyArgs
  $verifyExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
} finally {
  Start-Sleep -Seconds $TailCooldownSec
  if ($tail -and -not $tail.HasExited) {
    Stop-Process -Id $tail.Id -Force
  }
}

Start-Sleep -Seconds 2

Write-Host '[tail] Aliyun 请求摘要:'
$summary = if (Test-Path $tailOut) {
  Select-String -Path $tailOut -Pattern '"range":|"status":|Lavf/59.16.100|Aliyun Computing Co., LTD'
} else {
  @()
}

if ($summary.Count -eq 0) {
  Write-Host '[tail] 未匹配到阿里云请求摘要，需手工查看完整 tail 输出'
} else {
  $summary | ForEach-Object { Write-Host $_.Line.TrimEnd() }
}

if (Test-Path $tailErr) {
  $tailErrContent = Get-Content $tailErr | Where-Object { $_.Trim() }
  if ($tailErrContent.Count -gt 0) {
    Write-Host '[tail] stderr:'
    $tailErrContent | ForEach-Object { Write-Host $_ }
  }
}

exit $verifyExitCode
