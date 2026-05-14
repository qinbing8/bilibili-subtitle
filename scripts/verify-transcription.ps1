param(
  [string]$BaseUrl = 'https://bilibili-subtitle-theta.vercel.app',
  [string]$VideoUrl = 'https://www.bilibili.com/video/BV1TKoYBmEQU/',
  [string]$Language = 'auto',
  [int]$Page = 0,
  [switch]$Diarization,
  [switch]$TextPolish,
  [int]$PollIntervalSec = 15,
  [int]$MaxWaitSec = 180,
  [int]$RequestTimeoutSec = 30,
  [switch]$NoDebugProxy
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

Import-LocalEnv -Root (Get-Location).Path

$appPassword = $env:APP_ACCESS_PASSWORD
if (-not $appPassword) {
  throw '未找到 APP_ACCESS_PASSWORD，请检查 .env.local / .env'
}

$baseUrl = $BaseUrl.TrimEnd('/')
$headers = @{ 'X-App-Password' = $appPassword }
if (-not $NoDebugProxy) {
  $headers['X-Debug-Proxy'] = '1'
}

$payload = @{
  bilibiliUrl = $VideoUrl
  language = $Language
  page = $Page
  diarization = [bool]$Diarization
  textPolish = [bool]$TextPolish
} | ConvertTo-Json -Depth 4 -Compress

Write-Host '预期: start 成功，若启用 debug proxy 则可拿到 proxy 调试信息，最终 status=COMPLETED'

$start = Invoke-JsonRequest -Method 'POST' -Uri "$baseUrl/api/transcription/start" -Headers $headers -Body $payload -TimeoutSec $RequestTimeoutSec
if (-not $start.success -or -not $start.data.taskId) {
  throw '创建转写任务失败或缺少 taskId'
}

Write-Host "[start] taskId=$($start.data.taskId) proxyHost=$($start.data.proxyHost) audioHost=$($start.data.audioHost)"
$debugProxy = Get-OptionalPropertyValue -InputObject $start.data -Name 'debugProxy'
if ($debugProxy) {
  Write-Host "[start] proxyUrlLength=$($debugProxy.proxyUrlLength) tokenLength=$($debugProxy.tokenLength) audioUrlLength=$($debugProxy.audioUrlLength) proxyUrlHash=$($debugProxy.proxyUrlHash)"
}

$debugProxyUrl = Get-OptionalPropertyValue -InputObject $debugProxy -Name 'proxyUrl'
if ($debugProxyUrl) {
  try {
    $probe = Invoke-ProbeRequest -Uri $debugProxyUrl -TimeoutSec $RequestTimeoutSec
    $probeContent = if ($probe.Content) { " content=$($probe.Content)" } else { '' }
    Write-Host "[probe] status=$([int]$probe.StatusCode) contentType=$($probe.Headers['Content-Type']) contentRange=$($probe.Headers['Content-Range']) acceptRanges=$($probe.Headers['Accept-Ranges']) contentDisposition=$($probe.Headers['Content-Disposition'])$probeContent"
  } catch {
    Write-Host "[probe] error=$($_.Exception.Message)"
  }
}

$deadline = (Get-Date).AddSeconds($MaxWaitSec)
$attempt = 0

while ($true) {
  $attempt += 1
  $status = Invoke-JsonRequest -Method 'GET' -Uri "$baseUrl/api/transcription/status?taskId=$($start.data.taskId)" -Headers @{ 'X-App-Password' = $appPassword } -TimeoutSec $RequestTimeoutSec
  if (-not $status.success) {
    throw '查询转写状态失败'
  }

  $previewValue = Get-OptionalPropertyValue -InputObject $status.data -Name 'preview'
  $errorValue = Get-OptionalPropertyValue -InputObject $status.data -Name 'errorMessage'
  $preview = if ($previewValue) { " preview=$previewValue" } else { '' }
  $errorText = if ($errorValue) { " error=$errorValue" } else { '' }
  Write-Host "[poll#$attempt] status=$($status.data.status)$errorText$preview"

  if ($status.data.status -eq 'COMPLETED') {
    Write-Host '[result] PASS'
    exit 0
  }

  if ($status.data.status -eq 'FAILED') {
    Write-Host "[result] FAIL status=FAILED error=$errorValue"
    exit 2
  }

  if ((Get-Date) -ge $deadline) {
    Write-Host "[result] FAIL status=TIMEOUT error=超过 ${MaxWaitSec}s 仍未完成"
    exit 3
  }

  Start-Sleep -Seconds $PollIntervalSec
}
