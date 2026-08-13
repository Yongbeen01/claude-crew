# claude-crew 실행기 — 이미 떠 있으면 브라우저만 엽니다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
#   ... -Stop      멈추기
#   ... -Restart   다시 시작
#
# 데몬은 창 없이 백그라운드로 돌아갑니다. 타이머 알림이 브라우저 탭을 닫아도
# 계속 오게 하려면 이 프로세스가 살아 있어야 합니다.

param([switch]$Stop, [switch]$Restart, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$DataDir = if ($env:CLAUDE_CREW_DIR) { $env:CLAUDE_CREW_DIR } else { Join-Path $env:USERPROFILE '.claude-crew' }
$LogDir  = Join-Path $DataDir 'logs'
$PidFile = Join-Path $DataDir 'crew.pid'

$port = 4320
$cfg  = Join-Path $DataDir 'config.json'
if (Test-Path $cfg) {
  try { $p = (Get-Content $cfg -Raw | ConvertFrom-Json).port; if ($p) { $port = [int]$p } } catch {}
}
$url = "http://127.0.0.1:$port"

function Test-Up {
  try { $null = Invoke-WebRequest "$url/healthz" -TimeoutSec 2 -UseBasicParsing; $true } catch { $false }
}

function Stop-Crew {
  $stopped = $false
  if (Test-Path $PidFile) {
    $id = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $stopped = $true }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
  # pid 파일이 없거나 낡았을 수도 있으니 포트를 붙잡고 있는 쪽도 정리합니다.
  $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; $stopped = $true }
  if ($stopped) { Write-Host "  멈췄습니다 (포트 $port)" }
  else { Write-Host '  실행 중이 아니었습니다' }
}

if ($Stop)    { Stop-Crew; return }
if ($Restart) { Stop-Crew; Start-Sleep -Seconds 2 }

if (Test-Up) {
  Write-Host "  이미 실행 중입니다 — $url"
  if (-not $NoBrowser) { Start-Process $url }
  return
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
# Start-Process -Environment is PowerShell 7 only; set it here and let the child
# inherit, so this works on the Windows PowerShell 5.1 everyone already has.
$env:CLAUDE_CREW_NO_OPEN = '1'
$proc = Start-Process -FilePath 'node' `
  -ArgumentList @((Join-Path $Root 'src\index.js')) `
  -WorkingDirectory $Root `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'crew.log') `
  -RedirectStandardError  (Join-Path $LogDir 'crew.err.log')
$proc.Id | Set-Content $PidFile

for ($i = 0; $i -lt 40; $i++) {
  if (Test-Up) { break }
  Start-Sleep -Milliseconds 500
}

if (Test-Up) {
  Write-Host "  떴습니다 — $url"
  if (-not $NoBrowser) { Start-Process $url }
} else {
  Write-Host '  실행에 실패했습니다. 로그를 확인해 주세요:' -ForegroundColor Yellow
  Write-Host "    $LogDir\crew.err.log"
  if (Test-Path (Join-Path $LogDir 'crew.err.log')) {
    Get-Content (Join-Path $LogDir 'crew.err.log') -Tail 15
  }
}
