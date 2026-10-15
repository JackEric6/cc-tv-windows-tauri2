@echo off
rem 启动上一次 Windows release 构建的 Tauri 应用。
cd /d "%~dp0"
if not exist "%~dp0src-tauri\target\release\congcong-tv-windows-tauri2.exe" (
  echo [TVBox] 没找到构建产物，请先执行: npm run build:win
  exit /b 1
)
"%~dp0src-tauri\target\release\congcong-tv-windows-tauri2.exe" %*
