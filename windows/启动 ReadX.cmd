@echo off
REM ReadX Windows launcher.
REM Incremental build (shared -> web -> desktop -> Go server), then start the Electron shell
REM in production mode. The shell starts the Go server and serves the built web dist itself.
REM Launched detached so no console window stays open.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Install Node.js 20+ and add it to PATH.
  pause
  exit /b 1
)

echo Starting ReadX ...
node scripts\ensure-built.mjs
if errorlevel 1 (
  echo [ERROR] Build failed. See the output above.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "apps\desktop"
