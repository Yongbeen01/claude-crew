@echo off
setlocal
title claude-crew

REM claude-crew installer. Double-click this file.
REM
REM Korean output all comes from install.ps1, which sets its own UTF-8 console
REM encoding. This file stays ASCII: cmd.exe reads .bat in the OEM code page and
REM would mangle anything else.
REM
REM PowerShell is called by full path on purpose. Relying on PATH picks up
REM whatever the launching environment happens to have, and on a machine with an
REM unusual PATH that fails with a bare "Access is denied" the user cannot act on.

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

echo.
echo   claude-crew
echo   Installing. This window shows the progress.
echo.

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Yongbeen01/claude-crew/main/scripts/install.ps1 | iex"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [!] Setup did not finish ^(code %RC%^).
  echo   [!] Take a screenshot of this window and send it back.
) else (
  echo   Done. From now on, use the claude-crew icon on your desktop.
)

echo.
pause
