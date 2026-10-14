@echo off
REM CBCT 每日精读 — Windows 启动器
REM 先编译再启动 Electron；编译输出到 dist/，dist 已存在时也会重新增量编译。
chcp 65001 >nul
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm，请先安装 Node.js 18+ 并加入 PATH。
  pause
  exit /b 1
)

echo 正在编译 CBCT 每日精读…
call npm run build
if errorlevel 1 (
  echo [错误] 编译失败，请查看上面的输出。
  pause
  exit /b 1
)

REM 用 start 脱离控制台启动，脚本随即退出，不留黑窗口。
start "" "node_modules\electron\dist\electron.exe" .
