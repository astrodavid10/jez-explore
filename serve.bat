@echo off
REM ============================================================================
REM  Jezero Explorer - local server
REM
REM  Serves THIS folder on http://127.0.0.1:8714 and opens it in your browser.
REM  Close this window (or press Ctrl+C) to stop the server.
REM
REM  A server is MANDATORY. Double-clicking index.html cannot work: MapLibre
REM  GL JS 6.x is ESM-only and derives its worker URL from import.meta.url,
REM  which it refuses to do for file:// - the map would never appear.
REM ============================================================================
setlocal
set PORT=8714
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python was not found on your PATH.
  echo   Install Python 3, or serve this folder with any other static server
  echo   ^(for example:  npx serve -l %PORT%^).
  echo   Opening index.html directly from disk will NOT work - see README.md.
  echo.
  pause
  exit /b 1
)

echo.
echo   Jezero Explorer  ^-^-^>  http://127.0.0.1:%PORT%/
echo   Press Ctrl+C in this window to stop.
echo.
start "" "http://127.0.0.1:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
