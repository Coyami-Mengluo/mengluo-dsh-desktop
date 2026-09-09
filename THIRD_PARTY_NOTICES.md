# Third-party notices

MengLuo DSH Desktop is a separate, unofficial desktop shell. It was developed in a local DeepSeek Harness checkout, but this source export contains the shell and its tests/build scripts, not the upstream monorepo or its Git history. The upstream MIT notice is retained in [licenses/DeepSeek-Harness.LICENSE](licenses/DeepSeek-Harness.LICENSE). DeepSeek Harness is downloaded separately from its official npm registry by the user-selected installation flow; its packages retain their own notices.

Components included in Windows application distributions:

| Component | License information | Location in the installed distribution |
| --- | --- | --- |
| Electron 43.2.0 | MIT; Chromium and bundled libraries have additional notices | `LICENSE.electron.txt` and `LICENSES.chromium.html` beside the executable |
| Node.js 24.19.0 installation runtime | MIT plus bundled-component notices | `resources/runtime/node-runtime/LICENSE` |
| npm 11.17.0 and its bundled dependencies | Artistic-2.0 for npm; dependencies retain their own licenses | `resources/updater/npm/LICENSE` and dependency license files in that tree |
| electron-updater 6.8.9 | MIT | its package license inside `resources/app.asar/node_modules` |
| builder-util-runtime 9.7.0 and updater dependencies | See their exact locked package metadata and license files | package directories inside `resources/app.asar/node_modules` |
| lazy-val 1.0.5 | MIT as declared by upstream package metadata; supplementary attribution and standard terms retained | `resources/app.asar/licenses/lazy-val.NOTICE` |

`package-lock.json` records exact Node package versions and integrity metadata. Keep third-party license files when repackaging. Build tools are not runtime imports: electron-builder uses MIT, and the optional SVG rasterizer `@resvg/resvg-js` uses MPL-2.0. The original [placeholder SVG](assets/icon.svg) remains MIT-licensed. The current illustrated icon was supplied by the maintainer as their own AI-generated output; it has a separate [artwork notice](assets/ARTWORK.md) and is not included in the source-code MIT grant. The old private client's separate third-party illustration is still excluded from this export.

Authoritative sources: [Harness license](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE), [Electron license](https://github.com/electron/electron/blob/v43.2.0/LICENSE), [Node license](https://github.com/nodejs/node/blob/v24.19.0/LICENSE), [npm license](https://github.com/npm/cli/blob/v11.17.0/LICENSE), and [electron-builder/updater](https://github.com/electron-userland/electron-builder).
