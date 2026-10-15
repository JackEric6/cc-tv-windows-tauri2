# 丛丛影视 Windows 版（Tauri 2）

基于 Tauri 2、WebView2 Evergreen、React 和 Video.js 的 Windows 桌面影视客户端，提供首页片单、影视源搜索、分类浏览、在线播放、弹幕和离线缓存。影视源由第三方站点提供，网络、地区限制和上游变更可能影响搜索或播放。

本迁移以 [cc-tv-windows `2af4caf`](https://github.com/JackEric6/cc-tv-windows/commit/2af4caf77f4e76dc388e885eb5cbeb932ec0edde) 为功能基线。

## 功能

- 内置瓜子、西瓜、荐片及多类苹果 CMS 影视源。首页默认使用瓜子；加载失败时按西瓜、荐片顺序回退。可在设置中更换首页源。
- 聚合搜索按固定顺序展示影视源。搜索设置可单独控制首页、搜索和分类使用哪些源；对搜索不可用的源可以只关闭搜索，不影响其详情或播放用途。
- 分类浏览默认加载电影，使用西瓜、天堂和暴风三个源，并缓存已加载结果。
- 搜索和分类默认过滤成人与伦理片。暴风的「理论片」也视为成人内容；同名搜索结果只要有一个源标记为成人/伦理片，其他源的同名或关键词相关变体也会一起过滤。反馈建议提交 `4848` 可在本次运行期间关闭过滤；退出软件后会恢复默认开启。开启过滤时搜索会等整批结果返回后统一处理，关闭时按影视源逐个显示。
- 搜索结果支持跨源复用海报；首选图片加载失败时会按片名尝试其他源的海报。
- 详情页显示可用的影片简介、导演、主演、年份、地区、类型和评分；支持线路选择、选集、上一集/下一集、倍速、片头片尾标记和双击切换全屏。
- Video.js 播放器支持进度条时间与画面预览。鼠标移入音量控制区域会关闭进度预览；音量按钮和竖向滑杆均可用滚轮调节音量。
- 在线弹幕支持自动匹配、显示设置、时间轴跳转和暂停停留；同一影片不同影视源共用弹幕缓存。
- 离线缓存支持选择集数、断点续传、下载队列管理，并保存可获取的海报和弹幕。下载内容使用与在线播放相同的播放器，离线播放进度会记入历史。
- 提供观看历史、收藏、搜索记录、白色/暗黑主题、系统代理开关和反馈建议设置。
- 请求超时默认为 3 秒，可在常规设置中调整。
- AI 总结支持用户配置兼容的 API 地址、模型和密钥；应用不附带本地模型。使用画面总结时，会将抽取的画面发送到用户配置的服务。

## 安装与数据

当前迁移版本为 **1.0.12**。Windows 安装程序由 GitHub Actions 构建并作为工作流产物提供；后续正式版本从本仓库的 [GitHub Releases](https://github.com/JackEric6/cc-tv-windows-tauri2/releases) 下载。发布包不包含本机影视源、账号、设置、历史记录或离线缓存数据。

程序配置、影视源、收藏、观看历史和离线缓存保存在应用目录旁的 `data/` 目录。迁移时会尝试沿用旧版默认安装目录下的 `data/`；迁移或卸载前仍建议备份。安装包使用 WebView2 Evergreen Bootstrapper：已安装 Evergreen Runtime 的电脑会复用它，否则安装器会从 Microsoft 下载并安装运行时。安装程序未使用代码签名证书，Windows 可能显示 SmartScreen 提示。

## 开发与构建

需要 Node.js 22、Rust stable MSVC 工具链和 Visual Studio C++ Build Tools。在项目目录运行：

```powershell
npm install
npm run dev
npm run typecheck
npm run build:win
```

Windows x64 NSIS 安装程序输出到 `src-tauri/target/release/bundle/nsis/`。前端仍使用 React，原 Node 服务被打成独立后台并随程序打包；Chromium/WebView2 本体不随安装包重复分发，依赖 Evergreen Runtime。CI 工作流会运行类型检查和 Windows 安装包构建。

## 影视源说明

影视源由用户配置与软件内置的公开接口组成。上游站点会调整地址、接口和访问策略，软件无法保证每个影视源持续可用；请遵守对应服务条款及所在地法律法规。

## 许可

桌面框架参考 [hgtuj5688/tvbox-desktop](https://github.com/hgtuj5688/tvbox-desktop)，保留其 MIT 许可证。Video.js 使用 Apache-2.0 许可证；Tauri 2、WebView2 和 Node.js 的第三方许可随各自发行包提供。影视内容、影视源和弹幕由相应第三方服务提供。
