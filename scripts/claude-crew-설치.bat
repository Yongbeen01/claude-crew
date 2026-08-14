@echo off
setlocal
title claude-crew

REM claude-crew installer. Double-click this file.
REM All Korean output comes from install.ps1, which handles UTF-8 itself;
REM this file stays ASCII so cmd.exe never mangles it.

echo.
echo   claude-crew
echo   Installing... this window will show progress.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Yongbeen01/claude-crew/main/scripts/install.ps1 ^| iex"

if errorlevel 1 (
  echo.
  echo   [!] Something went wrong. Send this window to the person who shared it.
)

echo.
pause
