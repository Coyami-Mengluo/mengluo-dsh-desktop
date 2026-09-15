# Changelog / 更新日志

This log records client features, improvements, fixes and public releases. Internal versions 0.5.3 and 0.5.4 were not public releases.

本日志记录客户端新增功能、改进、修复和公开版本。0.5.3、0.5.4 为内部版本，不列为公开发布。

## 0.5.10 — 2026-09-16

- Changed plugin search to explicit submission with a Search button or Enter. Typing, clearing input and IME composition no longer trigger automatic searches.
- Reduced repeated plugin requests: opening settings prefers cached results, identical in-flight requests share one network call, and repeated update checks reuse files pinned to the same commit while still checking the latest branch.
- Extended browsing metadata caches to 15 minutes and exact-commit file caches to 24 hours within the current client session, with bounded least-recently-used storage. Manual version checks, installation confirmation and server rate limits remain enforced.

- 插件搜索改为点击“搜索”按钮或按 Enter 后提交，输入、清空文本和输入法选字不再自动触发搜索。
- 减少插件重复请求：打开设置优先使用缓存，相同的进行中请求合并发送；重复检查更新复用同一提交的文件，仍查询最新分支。
- 普通浏览的插件信息缓存延长至 15 分钟，精确提交文件在当前客户端进程内缓存最长 24 小时，并限制缓存容量、淘汰最久未使用的条目。保留手动版本检查、安装确认及服务端限流保护。

## 0.5.9 — 2026-09-15

- Added Harness version management: retrieve official historical releases, install independent runtime slots, and verify installed versions offline before a confirmed restart switches versions.
- Added version pinning: checks can still notify about new releases, but pinned versions are not automatically downloaded or replaced.
- Added verified local Harness data backups before downgrades. Failed verification or backup blocks the switch; startup failures retain the existing installed-runtime fallback.
- Fixed settings and both update windows opening at the screen center instead of the main-window center, with display-edge clamping and preservation of manually moved visible windows.

- 新增 Harness 版本管理：获取官方历史版本、安装独立运行环境，已安装版本可离线校验，通过启动测试并确认重启后切换。
- 新增版本锁定：仍可检查并提醒新版，但不自动下载或替换锁定版本。
- 降级前自动备份并校验本地 Harness 数据；校验或备份失败时中止切换，启动失败时保留已有版本回退机制。
- 修复设置及两类更新窗口按屏幕居中弹出的问题，改为按主窗口居中并限制在所在屏幕内，已打开的窗口保留手动拖动位置。

## 0.5.8 — 2026-09-13

- Fixed loopback links being handed to the external browser, including the IPv4 loopback range, the absolute localhost name and IPv4-mapped loopback addresses. Ordinary web links and exact-origin Harness navigation are unchanged.

- 修复部分本机回环链接被误交给外部浏览器的问题，覆盖 IPv4 回环地址段、带末尾点的 localhost 和 IPv4 映射的回环地址；正常网页外链与 Harness 内部页面跳转保持不变。

## 0.5.7 — 2026-09-12

- Added a confirmed “Restart Harness” button after plugin changes, with startup readiness checks; no need to close the client manually.
- Enhanced connection checks with target-version mirror metadata and official integrity-digest comparison, distinguishing missing, inconsistent and unconfirmed metadata from connectivity failures.
- Added live client-language switching: follow system, Simplified Chinese, or English. Official Harness UI and community plugin content remain unchanged.
- Improved titlebar theme-color response while retaining smooth gradient transitions.
- Fixed plugin metadata cooldowns incorrectly locking catalog refresh and GitHub secondary limits incorrectly inheriting an unrelated hourly reset. Cooldown messages now identify their source.

- 新增插件操作后的“重启 Harness”按钮，确认后重启后台并检查界面就绪，无需手动退出客户端。
- 增强连接检测：检查镜像目标版本元数据并比对官方完整性摘要，区分未同步、不一致、未确认和连接失败。
- 新增客户端界面语言切换：跟随系统、简体中文、English，即时生效，不改变官方 Harness 界面和社区插件内容。
- 提高顶栏主题颜色响应速度，保留渐变匹配与平滑过渡。
- 修复插件信息检查冷却误锁目录刷新，以及 GitHub 临时限流错误沿用小时额度重置时间的问题；冷却提示明确标示限制来源。

## 0.5.6

- Unified plugin-search request protection in the main process: search, pagination and refresh share 8 dispatches per rolling 60 seconds, with at least a 1-second gap. Manual refresh and plugin update checks each have a 30-second cooldown. The settings page displays countdowns and retains cached or previous results for manual retry.
- Added verified local snapshots before plugin changes and confirmed offline rollback of the complete `web` profile and client source records, with checks for changed files and interrupted-restore recovery. Backups include configuration and package files and remain unencrypted on the user's device.
- Fixed snapshot path validation incorrectly rejecting ordinary Windows short-path aliases.

- 统一主进程中的插件搜索请求保护：搜索、翻页和刷新共用每滚动 60 秒 8 次额度，两次发送至少间隔 1 秒；手动刷新和插件更新检查各有 30 秒冷却。设置页显示倒计时，并保留缓存或旧结果供用户手动重试。
- 新增插件修改前的本地校验快照，以及用户确认后的整个 `web` profile 和客户端来源记录离线回滚，包含文件变化检查与中断回滚修复。备份包含配置和软件包文件，以未加密形式保存在用户设备上。
- 修复插件快照路径检查误拒绝 Windows 正常短路径别名的问题。

## 0.5.5

- Added a separate client-settings window for Harness, plugins, downloads and network, client updates, and project/log information.
- Added official npm and npmmirror choices for managed Harness downloads, connection checks, and official-source verification with transport fallback.
- Added the community plugin store, remote keyword search and pagination, installed-plugin management, and read-only plugin update checks.
- Improved compatibility with the official Harness plugin CLI for explicit installation, pinned updates and removal.

- 新增独立客户端设置窗口，集中管理 Harness、插件、下载与网络、客户端更新、项目与日志信息。
- 为受管理的 Harness 下载增加官方 npm 与 npmmirror 选择、连接检测，以及官方源校验和下载失败回退。
- 新增社区插件商店、远程关键词搜索与分页、已安装插件管理和只读更新检查。
- 改进官方 Harness 插件 CLI 兼容性，支持用户确认后的安装、固定版本更新和卸载。

## 0.5.2 — First public release / 首个公开版本

- Published the standalone desktop-shell source and Windows installer/portable packages for the unofficial Harness client.
- Established the shell's GitHub update path and separate managed Harness installation/update path, with explicit confirmation before switching or installing updates.

- 首次公开非官方 Harness 桌面客户端的独立外壳源码，以及 Windows 安装版和便携版。
- 建立外壳 GitHub 自更新与独立的 Harness 安装、更新路径；切换版本或安装客户端更新前须用户确认。
