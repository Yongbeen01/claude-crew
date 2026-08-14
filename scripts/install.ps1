# claude-crew 설치 — 이 한 줄이면 됩니다.
#
#   irm https://raw.githubusercontent.com/Yongbeen01/claude-crew/main/scripts/install.ps1 | iex
#
# 하는 일: Node 와 Claude Code 를 확인해서 없으면 설치하고, 앱을 받고, 바탕화면
# 바로가기를 만들고, Claude 로그인 상태를 확인한 뒤 실행합니다.
# 업무 이력·지침은 %USERPROFILE%\.claude-crew 에 따로 있으므로 재설치해도 남습니다.

$ErrorActionPreference = 'Stop'
$Repo    = if ($env:CREW_REPO) { $env:CREW_REPO } else { 'https://github.com/Yongbeen01/claude-crew.git' }
$Branch  = if ($env:CREW_BRANCH) { $env:CREW_BRANCH } else { 'main' }
$AppDir  = Join-Path $env:LOCALAPPDATA 'claude-crew'
$DataDir = Join-Path $env:USERPROFILE '.claude-crew'

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Has($cmd)  { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "  claude-crew" -ForegroundColor White
Write-Host "  여러 클로드에게 일을 시키고 한 화면에서 지켜보는 개인 비서" -ForegroundColor DarkGray

# ── 1. Node ──────────────────────────────────────────────────────────────────
Step 'Node 확인'
$nodeOk = $false
if (Has node) {
  $v = (node --version) -replace '^v', ''
  $nodeOk = [int]($v.Split('.')[0]) -ge 20
  if ($nodeOk) { Say "Node $v — 그대로 씁니다" } else { Warn "Node $v 는 너무 낮습니다 (20 이상 필요)" }
}
if (-not $nodeOk) {
  if (-not (Has winget)) { throw 'Node 20 이상이 필요한데 자동 설치를 못 합니다. https://nodejs.org 에서 LTS 를 설치한 뒤 다시 실행해 주세요.' }
  Say 'Node LTS 를 설치합니다…'
  winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Has node)) { throw 'Node 를 설치했지만 이 창에서는 인식되지 않습니다. PowerShell 을 새로 열고 다시 실행해 주세요.' }
}

# ── 1b. git ──────────────────────────────────────────────────────────────────
# 없어도 압축본으로 설치는 되지만, git 이 있어야 앱이 스스로 업데이트할 수 있습니다.
# GitHub 계정은 필요 없습니다 — 공개 저장소라 익명으로 받습니다.
Step 'git 확인'
if (Has git) {
  Say "$((git --version)) — 그대로 씁니다"
} elseif (Has winget) {
  Say 'git 을 설치합니다 (자동 업데이트에 필요합니다)…'
  winget install --id Git.Git --silent --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (Has git) { Say '설치했습니다' } else { Warn 'git 을 인식하지 못했습니다 — 압축본으로 설치하고 자동 업데이트는 꺼집니다' }
} else {
  Warn 'git 이 없어 압축본으로 설치합니다 — 자동 업데이트 대신 이 설치 한 줄을 다시 실행하시면 됩니다'
}

# ── 2. Claude Code ───────────────────────────────────────────────────────────
Step 'Claude Code 확인'
if (Has claude) {
  Say "$((claude --version) -split ' ' | Select-Object -First 1) — 그대로 씁니다"
} else {
  Say 'Claude Code 를 설치합니다…'
  irm https://claude.ai/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  if (-not (Has claude)) { throw 'Claude Code 설치를 확인하지 못했습니다. https://claude.com/claude-code 안내대로 설치한 뒤 다시 실행해 주세요.' }
}

# ── 3. 앱 받기 ───────────────────────────────────────────────────────────────
Step '앱 받기'
if (Test-Path (Join-Path $AppDir '.git')) {
  Say "이미 있습니다 — 최신으로 맞춥니다 ($AppDir)"
  git -C $AppDir fetch --quiet origin $Branch
  git -C $AppDir reset --quiet --hard "origin/$Branch"
} elseif (Has git) {
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  git clone --quiet --branch $Branch --depth 1 $Repo $AppDir
  Say $AppDir
} else {
  # git 이 없으면 zip 으로 — 대신 자동 업데이트도 zip 방식으로 동작합니다.
  Warn 'git 이 없어 압축본으로 받습니다 (자동 업데이트는 계속 동작합니다)'
  $zipUrl = ($Repo -replace '\.git$', '') + "/archive/refs/heads/$Branch.zip"
  $tmp = Join-Path $env:TEMP "claude-crew-$Branch.zip"
  Invoke-WebRequest -Uri $zipUrl -OutFile $tmp -UseBasicParsing
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  $stage = Join-Path $env:TEMP 'claude-crew-stage'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Expand-Archive -Path $tmp -DestinationPath $stage -Force
  Move-Item (Get-ChildItem $stage -Directory | Select-Object -First 1).FullName $AppDir
  Remove-Item $tmp, $stage -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 이 한 줄(irm | iex)은 메모리에서 실행돼 실행 정책을 안 타지만, 여기서 부르는
# .ps1 '파일'은 정책을 탑니다. 새 PC 기본값(Restricted)에서 막히므로 자식 스크립트는
# 항상 별도 프로세스에 Bypass 를 명시해서 돌립니다. 사용자에게 정책을 바꾸라고
# 시키지 않기 위해서입니다.
function Invoke-Script($file, $extra = @()) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $AppDir $file)) + $extra
  & powershell.exe @args
}

# ── 4. 바로가기 ──────────────────────────────────────────────────────────────
Step '바로가기 만들기'
Invoke-Script 'scripts\install-shortcut.ps1'

# ── 5. 로그인 ────────────────────────────────────────────────────────────────
Step 'Claude 로그인 확인'
$auth = (claude auth status 2>&1 | Out-String)
if ($auth -match 'not logged in|No .*credential|로그인') {
  Warn '아직 로그인되어 있지 않습니다.'
  Say '이 앱은 여러분의 Claude 구독으로 동작합니다 (API 키를 쓰지 않습니다).'
  Say '지금 로그인 창을 엽니다 — 끝나면 이 창으로 돌아오세요.'
  claude auth login
} else {
  Say '로그인되어 있습니다'
}

# ── 6. 실행 ──────────────────────────────────────────────────────────────────
Step '실행'
Invoke-Script 'scripts\launch.ps1'

Write-Host ""
Write-Host "  설치 끝났습니다." -ForegroundColor Green
Write-Host "  다음부터는 바탕화면의 claude-crew 아이콘으로 여세요." -ForegroundColor DarkGray
Write-Host ""
