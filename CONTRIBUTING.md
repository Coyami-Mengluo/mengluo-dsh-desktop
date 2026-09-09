# Contributing

Use Windows x64 and Node.js 24.19.0. Install the locked development dependencies with `npm ci --ignore-scripts`, then run `npm run prepare:electron` and `npm run prepare:icon`. Dependency installation scripts are disabled; the explicitly invoked Electron downloader uses its pinned package checksums.

Run `npm test` for local behavior tests, `npm run smoke:setup` for the isolated native first-install and titlebar scenario, and `npm run smoke:tray` for tray lifecycle checks. These fixtures do not use your existing Harness home or start a real model session. Run `npm run smoke:client-update` and `node --test tests/shell-differential.test.mjs` before changing updater code. The differential test uses a loopback server and non-executable synthetic data; it never launches an installer.

Do not change the official renderer, weaken runtime verification, remove third-party license notices, or make updates install without confirmation. Add tests for cancellation, failure, sender validation and late callbacks when changing update/lifecycle code. Keep README.md and README.zh.md aligned. Use `npm run check:release` before preparing a source archive.

Forks must change `src/release-config.mjs` and repository metadata together before distributing their own builds. Do not redirect users to a release repository they did not choose or ship a GitHub token. Local packaging does not publish; publishing requires a separate maintainer action.
