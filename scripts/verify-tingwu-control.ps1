param(
  [string]$BaseUrl = 'https://bilibili-subtitle-theta.vercel.app',
  [string]$SamplePath = '/tingwu-control-48k.m4a',
  [ValidateSet('both', 'direct', 'proxy')]
  [string]$Mode = 'both',
  [string]$Language = 'auto',
  [switch]$Diarization,
  [switch]$TextPolish,
  [int]$PollIntervalSec = 15,
  [int]$MaxWaitSec = 180,
  [int]$RequestTimeoutSec = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Import-LocalEnv {
  param([string]$Root)

  foreach ($fileName in @('.env.local', '.env')) {
    $filePath = Join-Path $Root $fileName
    if (-not (Test-Path $filePath)) {
      continue
    }

    foreach ($line in Get-Content $filePath) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('#')) {
        continue
      }

      $parts = $trimmed -split '=', 2
      if ($parts.Count -ne 2) {
        continue
      }

      $key = $parts[0].Trim()
      $value = $parts[1].Trim().Trim("'`"")
      if (-not (Get-Item -Path "Env:$key" -ErrorAction SilentlyContinue)) {
        Set-Item -Path "Env:$key" -Value $value
      }
    }
  }
}

function Read-ResponseText {
  param($Response)

  if (-not $Response) {
    return ''
  }

  if ($Response.Content) {
    return [string]$Response.Content
  }

  if ($Response.GetResponseStream) {
    $reader = [System.IO.StreamReader]::new($Response.GetResponseStream())
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  }

  return ''
}

function Get-OptionalMemberValue {
  param(
    $InputObject,
    [string]$Name
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $member = $InputObject.PSObject.Members[$Name]
  if ($null -eq $member) {
    return $null
  }

  return $member.Value
}

function Get-OptionalPropertyValue {
  param(
    $InputObject,
    [string]$Name
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers,
    [string]$Body = $null,
    [int]$TimeoutSec = 30
  )

  try {
    if ($null -ne $Body) {
      return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -ContentType 'application/json' -Body $Body -TimeoutSec $TimeoutSec
    }
    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -TimeoutSec $TimeoutSec
  } catch {
    $message = $_.Exception.Message
    $response = Get-OptionalMemberValue -InputObject $_.Exception -Name 'Response'
    if ($response) {
      $statusCode = [int]$response.StatusCode
      $text = Read-ResponseText $response
      throw "HTTP $statusCode $message $text".Trim()
    }
    throw $message
  }
}

function Invoke-ProbeRequest {
  param(
    [string]$Uri,
    [int]$TimeoutSec = 30
  )

  return Invoke-WebRequest -Uri $Uri -Headers @{ Range = 'bytes=0-1023' } -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
}

function Resolve-SampleUrl {
  param(
    [string]$RootUrl,
    [string]$AssetPath
  )

  $normalizedRoot = $RootUrl.TrimEnd('/')
  $normalizedPath = if ($AssetPath.StartsWith('/')) { $AssetPath } else { "/$AssetPath" }
  return "$normalizedRoot$normalizedPath"
}

function Test-ProbeLooksAudio {
  param($Probe)

  if (-not $Probe) {
    return $false
  }

  $status = [int]$Probe.StatusCode
  $contentType = [string]$Probe.Headers['Content-Type']
  if ($status -ne 200 -and $status -ne 206) {
    return $false
  }
  if (-not $contentType) {
    return $false
  }

  return -not (
    $contentType.StartsWith('text/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $contentType.IndexOf('json', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $contentType.IndexOf('html', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Write-ProbeSummary {
  param(
    [string]$Label,
    $Probe
  )

  $content = if ($Probe.Content) { " content=$($Probe.Content)" } else { '' }
  Write-Host "[$Label] status=$([int]$Probe.StatusCode) contentType=$($Probe.Headers['Content-Type']) contentRange=$($Probe.Headers['Content-Range']) acceptRanges=$($Probe.Headers['Accept-Ranges']) contentDisposition=$($Probe.Headers['Content-Disposition'])$content"
}

function Invoke-ControlRun {
  param(
    [string]$RunMode,
    [string]$ApiBaseUrl,
    [string]$ResolvedSampleUrl,
    [string]$Password,
    [string]$TaskLanguage,
    [bool]$EnableDiarization,
    [bool]$EnableTextPolish,
    [int]$PollSec,
    [int]$WaitSec,
    [int]$TimeoutSec
  )

  $headers = @{ 'X-App-Password' = $Password }
  if ($RunMode -eq 'proxy') {
    $headers['X-Debug-Proxy'] = '1'
  }

  $payload = @{
    sampleUrl = $ResolvedSampleUrl
    mode = $RunMode
    language = $TaskLanguage
    diarization = $EnableDiarization
    textPolish = $EnableTextPolish
  } | ConvertTo-Json -Depth 4 -Compress

  $start = Invoke-JsonRequest -Method 'POST' -Uri "$ApiBaseUrl/api/transcription/control-start" -Headers $headers -Body $payload -TimeoutSec $TimeoutSec
  if (-not $start.success -or -not $start.data.taskId) {
    throw '创建 control 转写任务失败或缺少 taskId'
  }

  Write-Host "[$RunMode/start] taskId=$($start.data.taskId) sampleHost=$($start.data.sampleHost) mode=$($start.data.mode)"
  $debugProxy = Get-OptionalPropertyValue -InputObject $start.data -Name 'debugProxy'
  if ($debugProxy) {
    Write-Host "[$RunMode/start] proxyUrlLength=$($debugProxy.proxyUrlLength) tokenLength=$($debugProxy.tokenLength) audioUrlLength=$($debugProxy.audioUrlLength) proxyUrlHash=$($debugProxy.proxyUrlHash)"
  }

  $debugProxyUrl = Get-OptionalPropertyValue -InputObject $debugProxy -Name 'proxyUrl'
  if ($debugProxyUrl) {
    try {
      $probe = Invoke-ProbeRequest -Uri $debugProxyUrl -TimeoutSec $TimeoutSec
      Write-ProbeSummary -Label "$RunMode/probe" -Probe $probe
      if (-not (Test-ProbeLooksAudio -Probe $probe)) {
        return @{
          mode = $RunMode
          status = 'FAILED'
          error = "proxy probe unusable: status=$([int]$probe.StatusCode) contentType=$($probe.Headers['Content-Type'])"
        }
      }
    } catch {
      return @{
        mode = $RunMode
        status = 'FAILED'
        error = "proxy probe error: $($_.Exception.Message)"
      }
    }
  }

  $deadline = (Get-Date).AddSeconds($WaitSec)
  $attempt = 0
  while ($true) {
    $attempt += 1
    $status = Invoke-JsonRequest -Method 'GET' -Uri "$ApiBaseUrl/api/transcription/status?taskId=$($start.data.taskId)" -Headers @{ 'X-App-Password' = $Password } -TimeoutSec $TimeoutSec
    if (-not $status.success) {
      throw '查询转写状态失败'
    }

    $previewValue = Get-OptionalPropertyValue -InputObject $status.data -Name 'preview'
    $errorValue = Get-OptionalPropertyValue -InputObject $status.data -Name 'errorMessage'
    $preview = if ($previewValue) { " preview=$previewValue" } else { '' }
    $errorText = if ($errorValue) { " error=$errorValue" } else { '' }
    Write-Host "[$RunMode/poll#$attempt] status=$($status.data.status)$errorText$preview"

    if ($status.data.status -eq 'COMPLETED') {
      return @{
        mode = $RunMode
        status = 'COMPLETED'
        error = $null
      }
    }

    if ($status.data.status -eq 'FAILED') {
      return @{
        mode = $RunMode
        status = 'FAILED'
        error = $errorValue
      }
    }

    if ((Get-Date) -ge $deadline) {
      return @{
        mode = $RunMode
        status = 'TIMEOUT'
        error = "超过 ${WaitSec}s 仍未完成"
      }
    }

    Start-Sleep -Seconds $PollSec
  }
}

Import-LocalEnv -Root (Get-Location).Path

$appPassword = $env:APP_ACCESS_PASSWORD
if (-not $appPassword) {
  throw '未找到 APP_ACCESS_PASSWORD，请检查 .env.local / .env'
}

$baseUrl = $BaseUrl.TrimEnd('/')
$sampleUrl = Resolve-SampleUrl -RootUrl $baseUrl -AssetPath $SamplePath

Write-Host '预期:'
Write-Host '- sample probe 应返回 200/206 且 content-type 为 audio/mp4'
Write-Host '- direct 成功: 说明 Tingwu 项目/账号配置和标准 m4a 样本本身可用'
if ($Mode -eq 'both' -or $Mode -eq 'proxy') {
  Write-Host '- proxy 也成功: 说明标准 m4a + Worker 正常，当前 B 站失败更像 m4s/源文件形态问题'
}

try {
  $sampleProbe = Invoke-ProbeRequest -Uri $sampleUrl -TimeoutSec $RequestTimeoutSec
  Write-ProbeSummary -Label 'sample' -Probe $sampleProbe
  if (-not (Test-ProbeLooksAudio -Probe $sampleProbe)) {
    Write-Host '[sample/result] FAIL'
    exit 2
  }
} catch {
  Write-Host "[sample/result] FAIL error=$($_.Exception.Message)"
  exit 2
}

$modes = if ($Mode -eq 'both') { @('direct', 'proxy') } else { @($Mode) }
$results = @()

foreach ($runMode in $modes) {
  $result = Invoke-ControlRun `
    -RunMode $runMode `
    -ApiBaseUrl $baseUrl `
    -ResolvedSampleUrl $sampleUrl `
    -Password $appPassword `
    -TaskLanguage $Language `
    -EnableDiarization ([bool]$Diarization) `
    -EnableTextPolish ([bool]$TextPolish) `
    -PollSec $PollIntervalSec `
    -WaitSec $MaxWaitSec `
    -TimeoutSec $RequestTimeoutSec

  $results += $result
  if ($result.status -eq 'COMPLETED') {
    Write-Host "[$($result.mode)/result] PASS"
  } else {
    Write-Host "[$($result.mode)/result] FAIL status=$($result.status) error=$($result.error)"
  }
}

$directResult = $results | Where-Object { $_.mode -eq 'direct' } | Select-Object -First 1
$proxyResult = $results | Where-Object { $_.mode -eq 'proxy' } | Select-Object -First 1

if ($directResult -and $directResult.status -eq 'COMPLETED' -and $proxyResult -and $proxyResult.status -eq 'COMPLETED') {
  Write-Host '[conclusion] 标准 m4a 直连与 Worker 代理都成功；当前 B 站失败更像 m4s/源文件形态问题。'
  exit 0
}
if ($directResult -and $directResult.status -eq 'COMPLETED' -and $proxyResult) {
  Write-Host "[conclusion] 标准 m4a 直连成功，但 Worker 代理仍失败：$($proxyResult.error)"
  exit 2
}
if ($directResult -and $directResult.status -ne 'COMPLETED') {
  Write-Host "[conclusion] 标准 m4a 直连仍失败：$($directResult.error)"
  exit 2
}
if ($proxyResult -and $proxyResult.status -eq 'COMPLETED') {
  Write-Host '[conclusion] 标准 m4a 经 Worker 代理成功。'
  exit 0
}

Write-Host '[conclusion] 对照实验未收敛，请检查样本部署、Vercel redeploy 和 Worker 配置。'
exit 2
