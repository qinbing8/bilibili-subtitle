param(
  [string]$BaseUrl = 'https://bilibili-subtitle-theta.vercel.app',
  [string]$SamplePath = '/tingwu-control.m4a',
  [ValidateSet('both', 'direct', 'proxy')]
  [string]$Mode = 'both',
  [string]$Language = 'auto',
  [int]$PollIntervalSec = 15,
  [int]$MaxWaitSec = 180,
  [int]$RequestTimeoutSec = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'verify-tingwu-control.ts'
$nodeArgs = @(
  '--import',
  'tsx',
  $scriptPath,
  '--base-url',
  $BaseUrl,
  '--sample-path',
  $SamplePath,
  '--mode',
  $Mode,
  '--language',
  $Language,
  '--poll-interval-sec',
  $PollIntervalSec,
  '--max-wait-sec',
  $MaxWaitSec,
  '--request-timeout-sec',
  $RequestTimeoutSec
)

& node @nodeArgs
exit $LASTEXITCODE
