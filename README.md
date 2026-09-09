# MengLuo DSH Desktop

English | [中文](README.zh.md)

An unofficial, personal-maintainer Windows desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This project is not affiliated with, sponsored by, or endorsed by DeepSeek. Harness provides the agent and its Web UI; this project provides installation, native windows, process supervision, and desktop integration.

## Install and use

Download the **setup.exe** from [GitHub Releases](https://github.com/Coyami-Mengluo/mengluo-dsh-desktop/releases/latest). The first launch asks you to choose an official Harness version and installs its production dependencies from the official npm registry. An existing verified installation is reused. The installer includes Electron, installation Node and npm, but not Harness itself. Windows x64 is the supported platform. Unsigned preview builds can trigger SmartScreen warnings.

Closing the main window hides it to the tray. Right-click the tray, or press **Ctrl+Alt+U**, for the menu; choose **Quit** to stop the client and Harness. The menu also opens a terminal with the selected Harness runtime's Node and `dsh`, plus pinned npm/npx/pnpm tooling. Git is available only if installed on Windows.

The transparent application icon is AI-generated artwork supplied by the maintainer, not an official DeepSeek logo. Artwork provenance and its separate terms are in [the artwork notice](assets/ARTWORK.md). The original MIT geometric SVG is retained as an alternative.

## Two separate update paths

- **Client updates:** check this repository's stable GitHub Releases automatically once a day, or manually from the menu. Download and restart both require confirmation. The installed NSIS client prefers differential downloads and falls back to a full installer if the required cache, old blockmap, or HTTP range support is unavailable. The progress window shows measured transferred bytes, speed, percentage and an estimate when available. Ordinary application exit never installs a pending update automatically. Portable/development builds link to the release page instead of replacing themselves.
- **Harness updates:** continue to install one exact official npm version and its complete production dependencies into an isolated runtime slot, then verify and smoke-test it before switching. This path does not use GitHub client updates and is not differential. The existing 30-minute npm timeout remains.

Client installers replace application files, not the per-user Harness runtime slots, plugins or conversations. A confirmed client restart stops current Harness tasks; finish them first. Existing private-client profiles and workspaces are reused when no new profile exists. Upstream Harness can change its own data formats; this project cannot guarantee compatibility with every future release or migrate undocumented formats.

## Build from source

Use **Windows x64 and Node.js 24.19.0**. No official Harness source checkout or pnpm workspace is needed.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run prepare:electron
npm.cmd run prepare:icon
npm.cmd test
npm.cmd start
```

To build the installer and portable client:

```powershell
npm.cmd run dist:win
npm.cmd run check:release
```

The build verifies a compatible local copy of the pinned Node/npm tools or downloads the fixed Node distribution from nodejs.org. The archive checksum, Node executable hash and Authenticode identity, and npm tree fingerprint are checked. Build downloads need internet access. Keep `package-lock.json` and use `npm ci`; do not copy another checkout's `node_modules`.

`dist/` contains the installer, its `.blockmap`, the portable executable and `latest.yml`. Local packaging **never uploads**. See [release instructions](docs/RELEASING.md) for the initial manual installation, publishing order, old-blockmap retention, and verification still needed before a public release.

## Security and contributions

See [SECURITY.md](SECURITY.md) for data locations, updater trust assumptions and reporting guidance, and [CONTRIBUTING.md](CONTRIBUTING.md) for development checks. Do not put API keys, logs, conversations, signing keys or personal configuration in an issue or source archive.

The official UI runs without a preload bridge, Node integration or injected UI patches. The shell samples only the top pixel strip for titlebar colors. Ordinary external links still open in the system browser.

## License

The shell and original placeholder SVG use [MIT](LICENSE). The illustrated PNG is excluded from that grant; see [the artwork notice](assets/ARTWORK.md). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DeepSeek's name and marks are not granted by this project's license.
