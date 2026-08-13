# 바탕화면·시작메뉴 바로가기. -Uninstall 로 지웁니다.
#
# 콘솔 창이 뜨지 않게 wscript 로 vbs 를 거쳐 실행합니다.

param([switch]$Uninstall, [switch]$NoStartMenu)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Name = 'claude-crew'
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk")
)
if (-not $NoStartMenu) {
  $targets += Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$Name.lnk"
}

if ($Uninstall) {
  foreach ($t in $targets) { if (Test-Path $t) { Remove-Item $t -Force; Write-Host "  지움: $t" } }
  return
}

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
  $lnk.Arguments        = "`"$Root\scripts\crew.vbs`""
  $lnk.WorkingDirectory = $Root
  $lnk.Description      = '여러 클로드에게 일을 시키고 한 화면에서 지켜보는 개인 비서'
  $lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,21"
  $lnk.Save()
  Write-Host "  만듦: $t"
}
