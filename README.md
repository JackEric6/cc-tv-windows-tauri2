# 丛丛影视 Windows 版

基于 Tauri 2、WebView2 Evergreen 与 React 构建的 Windows 桌面影视播放器。应用使用系统 WebView 渲染界面，并通过随应用打包的 Node sidecar 处理本地服务和影视源请求。

## 功能

- 聚合多个影视源搜索影片，并可配置各站点的搜索开关和单源请求截止时间。
- 支持瓜子首页片单，也可选择天堂、非凡、量子或暴风匹配片单中的同名影片；瓜子不可用时按配置顺序回退。
- 提供分类浏览、收藏、播放记录与继续播放进度。
- 播放器支持 HLS、倍速、进度跳转、弹幕、画中画和全屏。
- 支持弹幕匹配、播放设置及成人内容过滤设置。

## 下载与安装

打开 [GitHub Releases](https://github.com/JackEric6/cc-tv-windows-tauri2/releases) 下载最新版本：

- `cc-tv-windows-tauri2-<版本号>-setup.exe`：安装版。
- `cc-tv-windows-tauri2-<版本号>-portable.zip`：绿色便携版，解压后运行 `congcong-tv-windows-tauri2.exe`。

应用面向 64 位 Windows。安装程序会在系统缺少 WebView2 Runtime 时启动 Evergreen 安装引导；首次安装可能需要网络连接。

## 开发环境

- Windows 10 或更新版本
- Node.js 22
- Rust stable 工具链
- Visual Studio C++ Build Tools（MSVC）

安装依赖并启动开发版：

```powershell
npm ci
npm run dev
```

检查类型并构建 Windows 安装程序：

```powershell
npm run typecheck
npm run build:win
```

`npm run build:win` 会先构建前端和 Node sidecar，再由 Tauri 生成 NSIS 安装程序。GitHub Actions 在推送到 `main`、针对 `main` 创建 Pull Request 或手动触发时执行 Windows 构建。

## 技术栈

- Tauri 2 与 WebView2 Evergreen
- React、TypeScript、Vite
- Node.js sidecar
- Video.js

## 项目结构

- `src/main/`：Node.js 后端与本地服务。
- `src/renderer/`：React 用户界面。
- `src/shared/`：前后端共享类型与协议。
- `src-tauri/`：Tauri 桌面外壳及 Windows 打包配置。
- `scripts/`：构建、接口探测和开发辅助脚本；`scripts/windows/` 存放 Windows 启动器。
- `docs/`：项目文档；`docs/legacy/` 保存早期 Electron 方案文档，仅供查阅历史设计。

旧框架文档：[功能框架设计书](docs/legacy/功能框架.txt)。当前安装、开发与构建方式以本文档为准。
