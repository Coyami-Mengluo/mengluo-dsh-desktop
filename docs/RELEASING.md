# 发布与客户端自更新

本地源码准备不会创建仓库、提交、推送或公开 Release。计划的公开仓库为 `Coyami-MengLuo/mengluo-dsh-desktop`。版本 `0.5.0` 是引入自更新的首个独立客户端版本；更早的私有安装包需要先手动安装一次这个版本，后续才可使用壳的自更新。

## 发布流程

1. 审查源码、许可证和占位图标，确认要公开的只有这个独立目录。不要上传原来的官方源码大目录、`.git` 历史、依赖、构建缓存、日志或用户数据。
2. 在隔离或干净的 Windows x64 构建环境执行 `npm ci --ignore-scripts`、`npm run dist:win`、`npm run check:release`，以及源码版和打包版的界面冒烟测试。
3. 使用经过核验的同一组产物创建**草稿** GitHub Release，标签严格为 `v0.5.0`（以后与 package.json 的版本一致）。不能把不同构建的安装器、blockmap 和元数据混用。
4. 上传 `MengLuo-DSH-Desktop-0.5.0-setup.exe`、同名 `.exe.blockmap`、便携版以及 `latest.yml`。元数据的文件名、大小和 SHA-512 必须匹配安装器；所有附件准备好后，再人工发布草稿为正式 Release。
5. 保留已发布旧版本的安装器和 `.blockmap`。有旧缓存和匹配 blockmap 时，更新器可复用未变化的数据块；缺失或服务不支持 Range 时会完整下载。首次没有可用缓存时可能也是完整下载。差分减少下载量，不是直接在线修改已安装文件。
6. 在下一版本正式推送前，使用独立 Windows 测试用户验证真实的“旧安装版 → 检查 → 下载 → 确认 → 停止 Harness → 安装 → 重启”，以及代理、断网重试、缓存缺失、Hash 校验失败和用户数据保留。没有发布两个真实版本前，不应把 GitHub 全链路标记为已验证。

本地 `npm run dist:win` 强制 `publish: never`。仓库内的构建工作流只产出待审查的构建附件，不自动发布或授予写入 Release 的权限。上传和发布是独立的人工步骤。

用 `node scripts/verify-artifacts.mjs` 可再次核对安装包摘要、blockmap、更新源和内置源码/许可证。用 `node scripts/export-source.mjs` 可导出白名单源码 ZIP 及 SHA-256 文件；该命令不会覆盖同名已有 ZIP，也不会创建 Git 仓库或上传。不要直接压缩整个工作目录。

## 安全限制

当前没有配置 Windows 代码签名证书。HTTPS 和 Release 内的 SHA-512 可检测下载损坏，但不能抵御已被攻破的 GitHub 发布账户。请为 GitHub 账户启用双因素验证，限制仓库写权限，并在需要正式发布者身份验证时接入代码签名。不要把 token、证书或私钥提交到仓库。

壳的更新与官方 Harness npm 更新互不替换。安装器不删除应用数据，更新前仍应备份重要工作；本项目不保证在系统掉电、磁盘故障或官方数据格式改变时自动恢复一切状态。
