import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))

describe('desktop package configuration', () => {
  it('builds the unofficial standalone client with a public release identity', () => {
    assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
    assert.equal(manifest.description, 'An unofficial Windows desktop client for DeepSeek Harness')
    assert.equal(manifest.license, 'MIT')
    assert.equal(manifest.dependencies['electron-updater'], '6.8.9')
    assert.equal(manifest.build.appId, 'ai.mengluo.desktop')
    assert.equal(manifest.build.productName, 'MengLuo DSH Desktop')
    assert.equal(manifest.build.portable.artifactName, 'MengLuo-DSH-Desktop-${version}-portable.${ext}')
    assert.equal(manifest.build.nsis.artifactName, 'MengLuo-DSH-Desktop-${version}-setup.${ext}')
    assert.equal(manifest.build.nsis.differentialPackage, true)
    assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false)
    assert.equal(manifest.build.directories.output, 'dist')
  })

  it('stages and packages the pinned standalone Node runtime', () => {
    assert.equal(manifest.scripts['stage:node'], 'node scripts/stage-node.mjs')
    assert.equal(manifest.scripts['stage:npm'], 'node scripts/stage-npm.mjs')
    assert.match(manifest.scripts.start, /run stage:node && .*run stage:npm && electron \.$/u)
    assert.doesNotMatch(manifest.scripts['dist:win'], /build:lib|dsh-web-frontend|stage:runtime|smoke:runtime/u)
    assert.match(manifest.scripts['dist:win'], /npm test && npm run stage:node && npm run stage:npm/u)
    assert.deepEqual(manifest.build.asarUnpack, ['src/**/*', 'assets/titlebar.*', 'assets/setup.*', 'assets/settings.*', 'assets/progress-meter.*', 'assets/shell-update.*', 'assets/icon.png', 'assets/terminal-bin/**/*'])
    assert.deepEqual(manifest.build.files, ['src/**/*', 'assets/**/*', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/**/*'])
    assert.deepEqual(manifest.build.extraResources, [{
      from: 'build',
      to: '.',
      filter: ['runtime/node-runtime/**/*', 'updater/npm/**/*'],
    }])
  })

  it('ships physical Harness terminal launchers outside ASAR', () => {
    for (const path of [
      'assets/terminal-bin/harness-terminal.cmd',
      'assets/terminal-bin/open-terminal.cmd',
      'assets/terminal-bin/node.cmd',
      'assets/terminal-bin/npm.cmd',
      'assets/terminal-bin/npx.cmd',
      'assets/terminal-bin/pnpm.cmd',
      'assets/terminal-bin/dsh.cmd',
    ]) {
      assert.doesNotThrow(() => readFileSync(resolve(desktopRoot, path)))
    }
  })

  it('ships the isolated titlebar controller, preload, and renderer assets', () => {
    for (const path of [
      'src/desktop-window.mjs',
      'src/titlebar-sampler.mjs',
      'src/titlebar-preload.cjs',
      'assets/titlebar.html',
      'assets/titlebar.css',
      'assets/titlebar.js',
      'src/first-run-setup.mjs',
      'assets/setup.js',
      'assets/setup.css',
      'assets/progress-meter.css',
      'assets/progress-meter.js',
      'src/settings-window.mjs',
      'src/settings-preload.cjs',
      'src/settings-controller.mjs',
      'src/download-source.mjs',
      'assets/settings.html',
      'assets/settings.js',
      'assets/settings.css',
    ]) {
      assert.doesNotThrow(() => readFileSync(resolve(desktopRoot, path)))
    }
  })

  it('uses a per-user assisted installer with destination and shortcut controls', () => {
    assert.equal(manifest.build.nsis.oneClick, false)
    assert.equal(manifest.build.nsis.allowToChangeInstallationDirectory, true)
    assert.equal(manifest.build.nsis.perMachine, false)
    assert.equal(manifest.build.nsis.createDesktopShortcut, true)
    assert.equal(manifest.build.nsis.createStartMenuShortcut, true)
    assert.equal(manifest.build.nsis.shortcutName, 'MengLuo DSH Desktop')
    assert.equal(manifest.build.nsis.uninstallDisplayName, 'MengLuo DSH Desktop ${version}')
  })

  it('packages one high-resolution transparent RGBA icon for Windows and the app window', () => {
    assert.equal(manifest.build.win.icon, 'assets/icon.png')
    const png = readFileSync(resolve(desktopRoot, manifest.build.win.icon))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    assert.equal(width, height)
    assert.ok(width >= 512)
    assert.equal(png[24], 8)
    assert.equal(png[25], 6)
  })
})
