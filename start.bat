@echo off
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo 没有找到 npm。请先安装 Node.js，并重新打开终端。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

call npm run tauri dev
if errorlevel 1 pause
