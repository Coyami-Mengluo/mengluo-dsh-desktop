# MengLuo DSH Desktop

[English](README.md) | 中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方 Windows 桌面客户端，由个人维护。项目与 DeepSeek 无隶属、赞助或背书关系。智能体和 Web UI 由 Harness 提供，本项目负责安装、原生窗口、进程监管与桌面功能。

## 安装与使用

从 [GitHub Releases](https://github.com/Coyami-Mengluo/mengluo-dsh-desktop/releases/latest) 下载 **setup.exe 安装版**。首次启动会让你选择官方 Harness 版本，再从官方 npm 发布源安装其生产依赖；已有且通过验证的版本会直接沿用。安装包包含 Electron、安装用 Node 和 npm，不预装 Harness。支持 Windows x64；未签名的预览版可能触发 SmartScreen 警告。

关闭主窗口会隐藏到托盘。右键托盘，或按 **Ctrl+Alt+U** 打开菜单；选择“退出”才会停止客户端和 Harness。菜单也提供 Harness 终端，使用已选运行时的 Node 和 `dsh`，以及固定版本的 npm/npx/pnpm 工具。Git 只有在 Windows 已安装时才可用。

透明应用图标是维护者提供的 AI 生成插画，不是 DeepSeek 官方标志。来源与独立使用说明见[图标素材说明](assets/ARTWORK.md)。原先采用 MIT 的几何 SVG 仍保留作为替代素材。

## 两条独立的更新路径

- **客户端更新：**每天自动检查本仓库 GitHub Releases 的稳定版，也可从菜单手动检查。下载和重启均须用户确认。安装版优先差分下载；缺少缓存、旧版 blockmap 或服务器不支持 HTTP Range 时，会回退完整安装包。进度窗口根据实际数据显示传输量、速度、百分比和可用的预计时间。平时退出客户端不会自动安装已下载的更新。便携版和开发版只提供发布页入口，不自动替换自身。
- **Harness 更新：**继续从官方 npm 安装一个精确版本及其完整生产依赖，在隔离运行时目录内完成校验和启动测试后再切换。这条路径不使用客户端的 GitHub 更新，也不是增量更新；npm 超时仍为 30 分钟。

客户端安装器替换应用文件，不删除当前用户的 Harness 运行时目录、插件或会话。确认重启客户端会停止当前 Harness 任务，请先完成工作。没有新 profile 时会沿用旧私有客户端的 profile 与 workspace。官方 Harness 可能修改自身的数据格式，本项目不能保证兼容所有未来版本，也不能迁移未公开的数据格式。

## 从源码构建

使用 **Windows x64 和 Node.js 24.19.0**，无需下载官方 Harness 源码，也不依赖 pnpm workspace。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run prepare:electron
npm.cmd run prepare:icon
npm.cmd test
npm.cmd start
```

生成安装版与便携版：

```powershell
npm.cmd run dist:win
npm.cmd run check:release
```

构建会校验本机已有的固定版本 Node/npm；没有合适副本时，从 nodejs.org 下载固定的 Node 发行包。下载包摘要、Node 可执行文件摘要和 Authenticode 身份，以及 npm 文件树指纹均会校验。构建下载需要联网。保留 `package-lock.json` 并使用 `npm ci`，不要复制其他工程的 `node_modules`。

`dist/` 包含安装器、配套 `.blockmap`、便携版和 `latest.yml`。本地打包**不会上传任何文件**。首次手动安装、发布顺序、保留旧 blockmap，以及公开发布前仍需验证的事项，见[发布说明](docs/RELEASING.md)。

## 安全与贡献

数据位置、更新信任前提和安全反馈方式见 [SECURITY.md](SECURITY.md)，开发检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。不要在 issue 或源码包里放 API Key、日志、聊天内容、签名私钥或个人配置。

官方 UI 不提供 preload 桥，不启用 Node 集成，也不注入界面补丁。外壳只采样顶部像素带来匹配标题栏颜色。普通外链仍交给系统浏览器。

## 许可证

外壳和原占位 SVG 采用 [MIT](LICENSE)。插画 PNG 不包含在该授权内，见[图标素材说明](assets/ARTWORK.md)。第三方组件保留各自的许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目许可证不授予 DeepSeek 名称或商标权利。
