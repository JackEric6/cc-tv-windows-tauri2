@echo off
rem Tauri 2 开发模式（Vite 热更新 + WebView2）。
set "TVBOX_PROJECT_ROOT=%~dp0..\.."
cd /d "%TVBOX_PROJECT_ROOT%"
call npm run dev
