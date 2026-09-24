$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "没有找到 npm。请先安装 Node.js，并重新打开终端。"
  exit 1
}

if (-not (Test-Path node_modules)) {
  Write-Host "正在安装依赖..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "依赖安装失败。"
    exit 1
  }
}

npm run tauri dev
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }