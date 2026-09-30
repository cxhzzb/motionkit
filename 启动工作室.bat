@echo off
rem ===========================================================================
rem  MotionKit Studio - one-click launcher (development mode)
rem
rem  Why dev mode: the AI assistant needs the local backend (python / ffmpeg /
rem  headless browser). The single-file dist\studio.html has no backend.
rem
rem  For the offline single-file version just open dist\studio.html directly.
rem
rem  NOTE: this file is intentionally ASCII-only. The Chinese status text is
rem  printed by tools\serve.mjs, so the console encoding never mangles it.
rem ===========================================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"
title MotionKit Studio

echo.
echo   MotionKit Studio  ^|  development mode
echo   =======================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo       Install it from https://nodejs.org/  then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "tools\serve.mjs" (
  echo.
  echo   [X] tools\serve.mjs not found.
  echo       Put this .bat in the project root and run it there.
  echo.
  pause
  exit /b 1
)

rem Python is only needed by the AI assistant; the studio itself works without it.
set "PYTHONIOENCODING=utf-8"
where python >nul 2>nul
if errorlevel 1 (
  echo   [!] Python not found - the AI assistant stays disabled.
) else (
  python -c "import faster_whisper;print('   [i] Local speech-to-text ready  (faster-whisper ' + faster_whisper.__version__ + ')')" 2>nul
  if errorlevel 1 echo   [!] faster-whisper not installed - auto subtitles will be skipped
)

echo   [i] Starting the local server; the browser opens by itself...
echo.

node "tools\serve.mjs" --open

echo.
echo   Studio stopped.
pause
endlocal
