import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { HarnessUpdateManager, parseResolvedProxy, runUpdateWorker } from '../src/update-manager.mjs'
import { writeRuntimeSeal } from '../src/runtime-store.mjs'

const INTEGRITY = `sha512-${'A'.repeat(86)}==`
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('native Harness update manager', () => {
  it('blocks automatic and manual Harness preparation while a plugin operation holds the shared lock', async t => {
    for (const manual of [false, true]) {
      let pluginBusy = true
      const harness = fixture({ isPluginBusy: () => pluginBusy })
      t.after(() => harness.manager.dispose())
      const release = { version: '0.1.0-rc.6', integrity: INTEGRITY }
      assert.equal(harness.manager.prepareRelease(release, { reportFailure: manual }), false)
      assert.equal(harness.manager.prepareRelease(release, { reportFailure: manual, initial: true }), false)
      await harness.manager.checkForUpdates({ manual })
      assert.equal(harness.requests, 1, 'Read-only metadata checks are still permitted')
      assert.equal(harness.installs, 0)
      assert.equal(harness.manager.installPromise, undefined)
      assert.equal(harness.manager.preparingVersion, undefined)
      assert.equal(harness.notifications.length, 0)
      pluginBusy = false
      assert.equal(harness.manager.prepareRelease(harness.manager.availableRelease, { reportFailure: manual }), true)
      await harness.manager.installPromise
      assert.equal(harness.installs, 1, 'Preparation can be explicitly retried after the plugin operation')
    }
  })

  it('rechecks the plugin lock when an earlier automatic metadata request completes', async t => {
    let pluginBusy = false
    const metadata = promiseWithResolvers()
    const harness = fixture({ isPluginBusy: () => pluginBusy, fetch: () => metadata.promise })
    t.after(() => harness.manager.dispose())
    const check = harness.manager.checkForUpdates({ manual: false })
    pluginBusy = true
    metadata.resolve(response(packument()))
    await check
    assert.equal(harness.installs, 0)
    assert.equal(harness.manager.installPromise, undefined)
    assert.equal(harness.manager.availableRelease.version, '0.1.0-rc.6')
  })

  it('prevents Harness restart before and after a native confirmation when plugins become busy', async t => {
    let pluginBusy = true
    let restarts = 0
    const answer = promiseWithResolvers()
    const harness = fixture({
      isPluginBusy: () => pluginBusy, requestRestart: () => { restarts += 1 },
      showMessage: () => answer.promise,
    })
    t.after(() => harness.manager.dispose())
    const release = { version: '0.1.0-rc.6' }
    await harness.manager.promptRestart(release)
    assert.equal(harness.dialogs.length, 0)
    pluginBusy = false
    const prompt = harness.manager.promptRestart(release)
    assert.equal(harness.dialogs.length, 1)
    pluginBusy = true
    answer.resolve({ response: 0 })
    await prompt
    assert.equal(restarts, 0)
    pluginBusy = false
    await harness.manager.promptRestart(release)
    assert.equal(restarts, 1)
  })

  it('does not spawn a terminal if plugins become busy while system proxy resolution is pending', async t => {
    let pluginBusy = true
    let launches = 0
    const proxy = promiseWithResolvers()
    const harness = fixture({
      isPluginBusy: () => pluginBusy, resolveProxy: () => proxy.promise,
      spawnTerminal: () => { launches += 1; throw new Error('Terminal must not spawn while a plugin operation is active') },
    })
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    assert.equal(harness.menu[0].submenu.find(item => item.label === '打开 Harness 终端…').enabled, false)
    await harness.manager.openRuntimeTerminal()
    assert.deepEqual(harness.proxyTargets, [])
    pluginBusy = false
    harness.manager.rebuildMenu()
    assert.equal(harness.menu[0].submenu.find(item => item.label === '打开 Harness 终端…').enabled, true)
    const terminal = harness.manager.openRuntimeTerminal()
    assert.equal(harness.proxyTargets.length, 1)
    pluginBusy = true
    proxy.resolve('DIRECT')
    await terminal
    assert.equal(launches, 0)
    assert.equal(harness.dialogs.length, 0, 'The late lock check occurs before creating or validating terminal launch paths')
    assert.doesNotMatch(harness.logs.join(''), /failed to open Harness terminal/u)
  })

  it('shows installation choices without automatic download or terminal access before setup', async () => {
    let shown = 0
    const harness = fixture({ uninstalled: true, onSetupRequested: () => { shown += 1 } })
    harness.manager.start()
    assert.equal(harness.manager.checkTimer, undefined)
    assert.equal(harness.manager.getSettingsState().installed, false)
    assert.equal(harness.manager.getSettingsState().version, undefined)
    assert.equal(harness.manager.getSettingsState().status, 'idle')
    assert.deepEqual(harness.menu[0].submenu.map(item => item.label ?? item.type), ['打开 Harness 终端…', '客户端设置…', 'separator', '退出'])
    assert.equal(harness.menu[0].submenu.find(item => item.label === '打开 Harness 终端…').enabled, false)
    const versions = await harness.manager.fetchAvailableVersions()
    assert.equal(versions[0].version, '0.1.0-rc.6')
    assert.equal(harness.installs, 0)
    await harness.manager.checkForUpdates({ manual: true })
    assert.equal(shown, 1)
    await harness.manager.dispose()
  })

  it('installs the first runtime with installation-only Node and activates only a sealed result', async () => {
    let received
    const stages = []
    const harness = fixture({
      uninstalled: true,
      onSetupProgress: (...args) => { stages.push(args) },
      runUpdate: async options => {
        received = options
        options.onProgress('installing', { completedFiles: 5 })
        createSealedSlot(options.userData, options.release.version)
      },
    })
    const release = (await harness.manager.fetchAvailableVersions())[0]
    const runtime = await harness.manager.installInitialRelease(release)
    assert.equal(runtime.version, release.version)
    assert.equal(received.executable, 'installer/node.exe')
    assert.equal(received.npm.source, 'installer')
    assert.equal(received.currentNodeLicensePath, 'installer/LICENSE')
    assert.equal(harness.manager.state.pendingVersion, release.version)
    assert.equal(harness.manager.state.activeVersion, undefined)
    assert.equal(harness.notifications.length, 0)
    assert.ok(stages.some(item => item[0] === 'stage' && item[1] === 'installing'))
    harness.manager.runtimeReady(runtime)
    assert.equal(harness.manager.state.activeVersion, release.version)
    await assert.rejects(harness.manager.installInitialRelease(release), /不能开始/u)
    await harness.manager.dispose()
  })

  it('does not schedule an incomplete first install and permits retry after failure', async () => {
    const harness = fixture({ uninstalled: true })
    const release = (await harness.manager.fetchAvailableVersions())[0]
    await assert.rejects(harness.manager.installInitialRelease(release), /完整性校验/u)
    assert.equal(harness.manager.state.pendingVersion, undefined)
    assert.equal(harness.manager.installPromise, undefined)
    await assert.rejects(harness.manager.installInitialRelease(release), /完整性校验/u)
    assert.equal(harness.installs, 2)
    await harness.manager.dispose()
  })
  it('checks the official next channel without relying on Electron Response.url', async () => {
    const harness = fixture()
    await harness.manager.checkForUpdates({ manual: true })
    const preparation = harness.manager.installPromise
    if (preparation !== undefined) await preparation
    await harness.manager.dispose()
    assert.equal(harness.requests, 1)
    assert.equal(harness.installs, 1)
    assert.equal(harness.fetchOptions.redirect, 'error')
    assert.equal(harness.manager.state.pendingVersion, '0.1.0-rc.6')
    assert.match(harness.dialogs[0].message, /正在后台准备 0\.1\.0-rc\.6/u)
  })

  it('prepares silently and notifies only after validation completes', async () => {
    const deferred = promiseWithResolvers()
    const harness = fixture({ runUpdate: () => deferred.promise })
    await harness.manager.checkForUpdates({ manual: false })
    const preparation = harness.manager.installPromise
    assert.notEqual(preparation, undefined)
    assert.equal(harness.notifications.length, 0)
    assert.equal(harness.dialogs.length, 0)
    assert.equal(harness.manager.getSettingsState().status, 'installing')
    assert.equal(harness.manager.getSettingsState().availableVersion, '0.1.0-rc.6')
    assert.match(JSON.stringify(harness.menu), /查看更新进度/u)

    deferred.resolve()
    await preparation
    assert.equal(harness.notifications.length, 1)
    assert.match(harness.notifications[0].body, /已完成校验和启动测试/u)
    assert.equal(harness.manager.state.pendingVersion, '0.1.0-rc.6')
    assert.doesNotMatch(JSON.stringify(harness.menu), /后台准备 0\.1\.0-rc\.6/u)
    assert.equal(harness.manager.getSettingsState().status, 'pending')
    assert.equal(harness.manager.getSettingsState().pendingVersion, '0.1.0-rc.6')
    assert.doesNotMatch(JSON.stringify(harness.menu), /重启并应用/u)

    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.dispose()
    assert.equal(harness.notifications.length, 1)
    assert.equal(harness.installs, 1)
  })

  it('prepares without system Node by running bundled npm under the selected runtime Node', async () => {
    const nodePath = 'C:\\managed-runtime\\node-runtime\\node.exe'
    const npmCliPath = 'C:\\installed\\resources\\updater\\npm\\bin\\npm-cli.js'
    let received
    const harness = fixture({
      nodePath,
      npmCliPath,
      findNpm: () => { throw new Error('system Node discovery must not run') },
      runUpdate: async options => { received = options },
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise

    assert.equal(received.executable, nodePath)
    assert.deepEqual(received.npm, {
      source: 'current-runtime',
      nodePath,
      nodeVersion: '24.19.0',
      npmCliPath,
      verified: true,
    })
    assert.equal(received.currentNodeVersion, '24.19.0')
    assert.equal(received.currentNodeLicensePath, 'bundled-runtime/node-runtime/LICENSE')
    assert.equal(received.proxy, null)
    assert.equal(received.officialProxy, null)
    assert.equal(received.downloadSource, 'official')
    await harness.manager.dispose()
  })

  it('passes the Windows system proxy only to npm update preparation', async () => {
    let received
    const harness = fixture({
      proxyRules: 'PROXY 127.0.0.1:18080; DIRECT',
      runUpdate: async options => { received = options },
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.equal(received.proxy, 'http://127.0.0.1:18080')
    assert.match(harness.logs.join(''), /Windows system proxy/u)
    await harness.manager.dispose()
  })

  it('resolves PAC routing for the selected mirror and official metadata separately', async t => {
    let received
    const statuses = []
    const harness = fixture({
      getDownloadSource: () => 'npmmirror',
      resolveProxy: async url => new URL(url).hostname === 'registry.npmmirror.com'
        ? 'DIRECT' : 'PROXY 127.0.0.1:18080',
      onDownloadStatus: status => { statuses.push(status) },
      runUpdate: async options => {
        received = options
        options.onDownloadStatus({ source: 'npmmirror', fallback: false, detail: '镜像下载中' })
      },
    })
    t.after(() => harness.manager.dispose())
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.deepEqual(harness.proxyTargets, [
      'https://registry.npmmirror.com/@deepseek-ai%2Fdsh',
      'https://registry.npmjs.org/@deepseek-ai%2Fdsh',
    ])
    assert.deepEqual(harness.fetchUrls, ['https://registry.npmjs.org/@deepseek-ai%2Fdsh'])
    assert.equal(received.downloadSource, 'npmmirror')
    assert.equal(received.proxy, null)
    assert.equal(received.officialProxy, 'http://127.0.0.1:18080')
    assert.deepEqual(statuses, [{ source: 'npmmirror', fallback: false, detail: '镜像下载中' }])
    await harness.manager.dispose()
    received.onDownloadStatus({ source: 'official', fallback: true, detail: 'late status' })
    assert.equal(statuses.length, 1)
  })

  it('resolves the official registry once and rejects unrecognized download sources before worker execution', async t => {
    let received
    const official = fixture({ runUpdate: async options => { received = options } })
    t.after(() => official.manager.dispose())
    await official.manager.checkForUpdates({ manual: false })
    await official.manager.installPromise
    assert.deepEqual(official.proxyTargets, ['https://registry.npmjs.org/@deepseek-ai%2Fdsh'])
    assert.equal(received.proxy, received.officialProxy)
    const invalid = fixture({ getDownloadSource: () => 'https://evil.example/npm' })
    t.after(() => invalid.manager.dispose())
    await invalid.manager.checkForUpdates({ manual: false })
    await invalid.manager.installPromise
    assert.equal(invalid.installs, 0)
    assert.deepEqual(invalid.proxyTargets, [])
    assert.equal(invalid.manager.getSettingsState().status, 'error')
    assert.match(invalid.logs.join(''), /unsupported Harness download source/u)
  })

  it('passes the selected source to the very first install without changing official catalog retrieval', async t => {
    let received
    const harness = fixture({
      uninstalled: true,
      getDownloadSource: () => 'npmmirror',
      runUpdate: async options => { received = options; createSealedSlot(options.userData, options.release.version) },
    })
    t.after(() => harness.manager.dispose())
    const release = (await harness.manager.fetchAvailableVersions())[0]
    await harness.manager.installInitialRelease(release)
    assert.equal(received.downloadSource, 'npmmirror')
    assert.equal(received.npm.source, 'installer')
    assert.deepEqual(harness.fetchUrls, ['https://registry.npmjs.org/@deepseek-ai%2Fdsh'])
    assert.equal(harness.proxyTargets[0], 'https://registry.npmmirror.com/@deepseek-ai%2Fdsh')
  })

  it('parses Chromium proxy rules without accepting credentials or missing ports', () => {
    assert.equal(parseResolvedProxy('PROXY 127.0.0.1:18080; DIRECT'), 'http://127.0.0.1:18080')
    assert.equal(parseResolvedProxy('HTTPS proxy.example:8443'), 'https://proxy.example:8443')
    assert.equal(parseResolvedProxy('SOCKS5 [::1]:1080'), 'socks5://[::1]:1080')
    assert.equal(parseResolvedProxy('DIRECT'), undefined)
    assert.equal(parseResolvedProxy('PROXY user:password@host:8080'), undefined)
    assert.equal(parseResolvedProxy('PROXY host-without-port'), undefined)
  })

  it('reports a missing built-in updater without asking the user to install Node', async () => {
    const harness = fixture({ npmCliPath: '' })
    await harness.manager.checkForUpdates({ manual: true })
    if (harness.manager.installPromise !== undefined) await harness.manager.installPromise
    const warning = harness.dialogs.find(dialog => dialog.message === '无法准备在线更新')
    assert.match(warning?.detail ?? '', /重新安装当前客户端/u)
    assert.doesNotMatch(warning?.detail ?? '', /安装.*Node|系统 Node/u)
    assert.equal(harness.installs, 0)
    await harness.manager.dispose()
  })

  it('reports indeterminate taskbar progress and clears it after success, failure, and cancellation', async () => {
    const success = progressHarness()
    await success.harness.manager.checkForUpdates({ manual: false })
    assert.deepEqual(success.calls, [[2, { mode: 'indeterminate' }]])
    success.deferred.resolve()
    await success.harness.manager.installPromise
    assert.deepEqual(success.calls, [[2, { mode: 'indeterminate' }], [-1]])
    await success.harness.manager.dispose()

    const failureCalls = []
    const failure = fixture({
      window: taskbarWindow(failureCalls),
      runUpdate: async () => { throw new Error('fixture install failed') },
    })
    await failure.manager.checkForUpdates({ manual: false })
    await failure.manager.installPromise
    assert.deepEqual(failureCalls, [[2, { mode: 'indeterminate' }], [-1]])
    await failure.manager.dispose()

    const cancellation = progressHarness({ waitForAbort: true })
    await cancellation.harness.manager.checkForUpdates({ manual: false })
    await cancellation.harness.manager.dispose()
    assert.deepEqual(cancellation.calls, [[2, { mode: 'indeterminate' }], [-1]])
  })

  it('uses real file-verification percentage on the Windows taskbar', async () => {
    const calls = []
    const harness = fixture({
      window: taskbarWindow(calls),
      runUpdate: async options => {
        options.onProgress('installing', { completedFiles: 800 })
        options.onProgress('verifying', { completedFiles: 250, totalFiles: 1_000 })
        options.onProgress('smoke')
      },
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.deepEqual(calls, [
      [2, { mode: 'indeterminate' }],
      [2, { mode: 'indeterminate' }],
      [0.25, { mode: 'normal' }],
      [2, { mode: 'indeterminate' }],
      [-1],
    ])
    await harness.manager.dispose()
  })

  it('contains and logs taskbar progress API failures', async () => {
    const harness = fixture({
      window: {
        isDestroyed: () => false,
        setMenuBarVisibility: () => {},
        setProgressBar: () => { throw new Error('fixture taskbar unavailable') },
      },
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.equal(harness.manager.state.pendingVersion, '0.1.0-rc.6')
    assert.equal(harness.logs.filter(line => /fixture taskbar unavailable/u.test(line)).length, 2)
    await harness.manager.dispose()
  })

  it('publishes structured stages, reopens from the menu, and completes before notifying', async () => {
    const timeline = []
    const deferred = promiseWithResolvers()
    const harness = fixture({
      progressWindow: progressWindowFixture(timeline),
      onNotification: () => { timeline.push(['notification']) },
      runUpdate: async options => {
        options.onProgress('preparing')
        options.onProgress('installing')
        options.onProgress('verifying')
        options.onProgress('smoke')
        options.onProgress('finalizing')
        await deferred.promise
      },
    })
    await harness.manager.checkForUpdates({ manual: false })
    const preparation = harness.manager.installPromise
    await new Promise(resolve => { setImmediate(resolve) })
    const reopen = harness.menu[0].submenu.find(item => item.label === '查看更新进度…')
    assert.equal(typeof reopen?.click, 'function')
    reopen.click()
    assert.deepEqual(timeline.slice(0, 7), [
      ['begin', '0.1.0-rc.6'],
      ['stage', 'preparing', '0.1.0-rc.6'],
      ['stage', 'installing', '0.1.0-rc.6'],
      ['stage', 'verifying', '0.1.0-rc.6'],
      ['stage', 'smoke', '0.1.0-rc.6'],
      ['stage', 'finalizing', '0.1.0-rc.6'],
      ['show'],
    ])

    deferred.resolve()
    await preparation
    const completeIndex = timeline.findIndex(entry => entry[0] === 'complete')
    const notificationIndex = timeline.findIndex(entry => entry[0] === 'notification')
    assert.ok(completeIndex >= 0)
    assert.ok(notificationIndex > completeIndex)
    await harness.manager.dispose()
    assert.deepEqual(timeline.at(-1), ['dispose'])
  })

  it('shows an explicit progress failure without exposing the worker error', async () => {
    const timeline = []
    const harness = fixture({
      progressWindow: progressWindowFixture(timeline),
      runUpdate: async () => { throw new Error('C:\\private\\runtime\\node_modules failed') },
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.deepEqual(timeline.filter(entry => entry[0] === 'fail'), [['fail', '0.1.0-rc.6']])
    assert.doesNotMatch(JSON.stringify(timeline), /private|node_modules/u)
    await harness.manager.dispose()
  })

  it('drops worker progress that arrives after application disposal starts', async () => {
    const timeline = []
    const harness = fixture({
      progressWindow: progressWindowFixture(timeline),
      runUpdate: options => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          options.onProgress('installing', {
            completedFiles: 2,
            registryRequests: 99,
            resolvedDependencies: 50,
          })
          reject(new Error('fixture cancelled'))
        }, { once: true })
      }),
    })
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.dispose()
    assert.deepEqual(timeline, [
      ['begin', '0.1.0-rc.6'],
      ['dispose'],
    ])
  })

  it('pops up only the Harness submenu at the titlebar and contains duplicate opens', async () => {
    const visibility = []
    const window = {
      isDestroyed: () => false,
      setMenuBarVisibility: value => { visibility.push(value) },
    }
    const harness = fixture({ window })
    assert.equal(harness.manager.showHarnessMenuAtTopLeft(), false)
    harness.manager.start()

    assert.equal(harness.manager.showHarnessMenuAtTopLeft(), true)
    assert.equal(harness.manager.showHarnessMenuAtTopLeft(), false)
    assert.equal(harness.popups.length, 1)
    assert.equal(harness.popups[0].options.window, window)
    assert.equal(harness.popups[0].options.x, 0)
    assert.equal(harness.popups[0].options.y, 44)
    assert.equal(typeof harness.popups[0].options.callback, 'function')
    assert.match(JSON.stringify(harness.popups[0].menu), /客户端设置/u)
    assert.match(JSON.stringify(harness.popups[0].menu), /打开 Harness 终端/u)
    assert.doesNotMatch(JSON.stringify(harness.popups[0].menu), /帮助|官方项目|检查 Harness 更新|自动检查|更新频率|更新通道/u)
    assert.doesNotMatch(JSON.stringify(harness.popups[0].menu), /accelerator|CmdOrCtrl/u)
    assert.deepEqual(visibility, [false, false])

    harness.popups[0].options.callback()
    assert.equal(harness.manager.showHarnessMenuAtTopLeft(), true)
    assert.equal(harness.popups.length, 2)
    await harness.manager.dispose()
    assert.equal(harness.popupCloses.length, 1)
    assert.equal(harness.manager.showHarnessMenuAtTopLeft(), false)
  })

  it('keeps the tray menu synchronized and reveals the window for manual dialogs', async t => {
    const trayMenus = []
    let shows = 0
    const harness = fixture({
      onHarnessMenuChanged: template => { trayMenus.push(template) },
      showWindow: () => { shows += 1 },
    })
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    assert.deepEqual(trayMenus.at(-1), harness.menu[0].submenu)
    assert.equal(trayMenus.at(-1).at(-1).role, 'quit')
    harness.manager.updatePreferences({ autoCheck: false })
    assert.equal(harness.manager.getSettingsState().autoCheck, false)
    assert.doesNotMatch(JSON.stringify(trayMenus.at(-1)), /自动检查更新/u)
    assert.equal(shows, 0)
    await harness.manager.showMessage({ type: 'info', message: 'fixture manual result' })
    assert.equal(shows, 1)
    assert.equal(harness.dialogs.at(-1).message, 'fixture manual result')
  })

  it('opens local settings from both concise menus without embedding switches or initiating network work', async t => {
    const requested = []
    const changes = []
    const harness = fixture({
      onSettingsRequested: section => { requested.push(section) },
      onSettingsChanged: () => { changes.push('changed') },
      getClientMenuItems: () => [{ label: 'legacy client updater item' }],
    })
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    assert.equal(harness.menu[0].label, '客户端')
    const submenu = harness.menu[0].submenu
    assert.deepEqual(submenu.map(item => item.label ?? item.type), ['打开 Harness 终端…', '客户端设置…', 'separator', '退出'])
    submenu.find(item => item.label === '客户端设置…').click()
    assert.deepEqual(requested, ['harness'])
    assert.equal(harness.requests, 0)
    assert.equal(harness.installs, 0)
    assert.ok(changes.length > 0)
    assert.deepEqual(harness.manager.getSettingsState(), {
      installed: true, version: '0.1.0-rc.5', status: 'idle',
      availableVersion: undefined, pendingVersion: undefined,
      autoCheck: true, interval: '24h', channel: 'auto',
      progressAvailable: false, error: undefined,
    })
  })

  it('adds one shared progress shortcut only when Harness or client progress is available', async t => {
    let clientProgress = false
    let requested = 0
    const harness = fixture({ hasClientProgress: () => clientProgress, onProgressRequested: () => { requested += 1 } })
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    const progressItems = () => harness.menu[0].submenu.filter(item => item.label === '查看更新进度…')
    assert.equal(progressItems().length, 0)
    clientProgress = true
    harness.manager.rebuildMenu()
    assert.equal(progressItems().length, 1)
    progressItems()[0].click()
    assert.equal(requested, 1)
    harness.manager.reportProgress('begin', '0.1.0-rc.6')
    harness.manager.rebuildMenu()
    assert.equal(progressItems().length, 1)
    clientProgress = false
    harness.manager.rebuildMenu()
    assert.equal(progressItems().length, 1)
    assert.equal(harness.manager.getSettingsState().progressAvailable, true)
  })

  it('persists only supported preferences and exposes the automatic channel without changing runtime selection', async t => {
    const harness = fixture()
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    harness.manager.availableRelease = { version: '0.1.0-rc.6' }
    harness.manager.updatePreferences({ autoCheck: false, interval: '7d', channel: 'latest' })
    assert.equal(harness.manager.checkTimer, undefined)
    const state = harness.manager.getSettingsState()
    assert.equal(state.autoCheck, false)
    assert.equal(state.interval, '7d')
    assert.equal(state.channel, 'latest')
    assert.equal(state.version, '0.1.0-rc.5')
    assert.equal(state.availableVersion, undefined)
    assert.equal(harness.installs, 0)
    const persisted = JSON.parse(readFileSync(join(harness.userData, 'harness-runtime-state.json'), 'utf8'))
    assert.equal(persisted.channel, 'latest')
    assert.equal(persisted.autoCheck, false)
    harness.manager.updatePreferences({ interval: '6h', channel: undefined })
    assert.equal(harness.manager.getSettingsState().channel, 'auto')
    assert.equal(harness.manager.getSettingsState().interval, '6h')
    harness.manager.updatePreferences(Object.assign(Object.create(null), { autoCheck: false }))
    const previous = harness.manager.state
    for (const patch of [
      null, [], {}, new Date(), 'invalid', Object.create({ autoCheck: false }),
      Object.assign(new (class CustomPreferences {})(), { autoCheck: false }),
      { autoCheck: 1 }, { autoCheck: 'false' },
      { interval: 'monthly' }, { interval: 24 }, { interval: ['24h'] },
      { interval: { toString: () => '24h' } }, { channel: 'auto' }, { channel: null },
      { channel: 'nightly' }, { registry: 'https://evil.example' }, { activeVersion: '0.1.0-rc.6' },
    ]) {
      assert.throws(() => harness.manager.updatePreferences(patch), /无效/u)
      assert.equal(harness.manager.state, previous)
    }
  })

  it('rejects preference changes during checks, installation, and disposal, then allows retry', async t => {
    const checking = promiseWithResolvers()
    const installing = promiseWithResolvers()
    const harness = fixture({ fetch: () => checking.promise, runUpdate: () => installing.promise })
    t.after(() => harness.manager.dispose())
    const check = harness.manager.checkForUpdates({ manual: false })
    assert.equal(harness.manager.getSettingsState().status, 'checking')
    assert.throws(() => harness.manager.updatePreferences({ autoCheck: false }), /等待/u)
    checking.resolve(response(packument()))
    await check
    assert.equal(harness.manager.getSettingsState().status, 'installing')
    assert.throws(() => harness.manager.updatePreferences({ channel: 'latest' }), /等待/u)
    installing.resolve()
    await harness.manager.installPromise
    harness.manager.preparingVersion = '0.1.0-rc.6'
    assert.equal(harness.manager.getSettingsState().status, 'installing')
    assert.throws(() => harness.manager.updatePreferences({ interval: '6h' }), /等待/u)
    harness.manager.preparingVersion = undefined
    harness.manager.updatePreferences({ autoCheck: false })
    assert.equal(harness.manager.getSettingsState().autoCheck, false)
    await harness.manager.dispose()
    assert.throws(() => harness.manager.updatePreferences({ autoCheck: true }), /等待/u)
  })

  it('rolls back failed preference persistence without reporting a successful settings change', async t => {
    const changes = []
    const harness = fixture({ onSettingsChanged: () => { changes.push('changed') } })
    t.after(() => harness.manager.dispose())
    harness.manager.start()
    const previous = harness.manager.state
    const timer = harness.manager.checkTimer
    const available = { version: '0.1.0-rc.6' }
    harness.manager.availableRelease = available
    const count = changes.length
    mkdirSync(join(harness.userData, 'harness-runtime-state.json'))
    assert.throws(() => harness.manager.updatePreferences({ autoCheck: false, interval: '7d', channel: 'next' }), /无法保存/u)
    assert.equal(harness.manager.state, previous)
    assert.equal(harness.manager.checkTimer, timer)
    assert.equal(harness.manager.availableRelease, available)
    assert.equal(changes.length, count)
    assert.match(harness.logs.join(''), /state write failed/u)
  })

  it('reports generic settings errors while retaining detailed diagnostics in the log', async t => {
    const harness = fixture({ fetch: async () => { throw new Error('C:\\private\\network-detail') } })
    t.after(() => harness.manager.dispose())
    await harness.manager.checkForUpdates({ manual: false })
    const state = harness.manager.getSettingsState()
    assert.equal(state.status, 'error')
    assert.match(state.error, /无法检查/u)
    assert.doesNotMatch(state.error, /private|network-detail/u)
    assert.match(harness.logs.join(''), /network-detail/u)
  })

  it('contains settings refresh failures without interrupting menus, updates, or preference saving', async t => {
    const harness = fixture({ onSettingsChanged: () => { throw new Error('fixture settings UI unavailable') } })
    t.after(() => harness.manager.dispose())
    assert.doesNotThrow(() => harness.manager.start())
    assert.doesNotThrow(() => harness.manager.reportProgress('stage', 'checking', '0.1.0-rc.6'))
    await harness.manager.checkForUpdates({ manual: false })
    await harness.manager.installPromise
    assert.equal(harness.manager.getSettingsState().pendingVersion, '0.1.0-rc.6')
    assert.doesNotThrow(() => harness.manager.updatePreferences({ autoCheck: false }))
    assert.equal(harness.manager.getSettingsState().autoCheck, false)
    assert.match(harness.logs.join(''), /settings refresh failed.*fixture settings UI unavailable/u)
    assert.equal(harness.notifications.length, 1)
  })

  it('opens a separate Harness console in the workspace with exact command tooling', { skip: process.platform !== 'win32' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mengluo-terminal-manager-'))
    temporaryDirectories.push(root)
    const terminalBinPath = join(root, 'terminal-bin')
    const workspacePath = join(root, 'workspace')
    const runtimeRoot = join(root, 'runtime')
    const nodePath = join(runtimeRoot, 'node-runtime', 'node.exe')
    const cliPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const npmCliPath = join(root, 'updater', 'npm', 'bin', 'npm-cli.js')
    for (const path of [terminalBinPath, workspacePath, join(nodePath, '..'), join(cliPath, '..'), join(npmCliPath, '..')]) {
      mkdirSync(path, { recursive: true })
    }
    for (const path of [
      join(terminalBinPath, 'harness-terminal.cmd'), join(terminalBinPath, 'open-terminal.cmd'),
      nodePath, cliPath, npmCliPath,
      join(npmCliPath, '..', 'npx-cli.js'),
    ]) writeFileSync(path, 'fixture')
    const launches = []
    const child = {
      pid: 1234,
      once: () => child,
      unref: () => { child.unrefCalled = true },
      unrefCalled: false,
    }
    const harness = fixture({
      nodePath,
      cliPath,
      npmCliPath,
      terminalBinPath,
      workspacePath,
      terminalEnvironment: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', SECRET_TOKEN: 'hidden' },
      spawnTerminal: (command, args, options) => {
        launches.push({ command, args, options })
        return child
      },
    })
    harness.manager.start()
    await harness.manager.openRuntimeTerminal()
    assert.equal(launches.length, 1)
    assert.equal(launches[0].options.cwd, workspacePath)
    assert.equal(launches[0].options.detached, false)
    assert.equal(launches[0].options.windowsHide, true)
    assert.equal(launches[0].options.env.SECRET_TOKEN, undefined)
    assert.equal(launches[0].options.env.DSH_DESKTOP_DSH_CLI, cliPath)
    assert.equal(child.unrefCalled, true)
    await harness.manager.dispose()
  })

  it('runs preparation in a supervised child and contains cancellation', async () => {
    const workerPath = join(import.meta.dirname, 'fixtures', 'update-worker-fixture.mjs')
    const logs = []
    const stages = []
    await runUpdateWorker({
      executable: process.execPath,
      workerPath,
      userData: 'fixture-user-data',
      release: { version: '0.1.0-rc.6', integrity: INTEGRITY },
      npm: { nodePath: process.execPath, npmCliPath: 'fixture-npm.js' },
      runnerPath: 'fixture-runner.mjs',
      log: text => { logs.push(text) },
      onProgress: (stage, files) => { stages.push([stage, files]) },
    })
    assert.match(logs.join(''), /fixture prepared/u)
    assert.deepEqual(stages, [['installing', { completedFiles: 12 }]])

    const controller = new AbortController()
    const cancelled = runUpdateWorker({
      executable: process.execPath,
      workerPath,
      userData: 'fixture-user-data',
      release: { version: '0.1.0-rc.6', integrity: INTEGRITY },
      npm: { nodePath: process.execPath, npmCliPath: 'fixture-npm.js' },
      runnerPath: 'fixture-runner.mjs',
      signal: controller.signal,
    })
    controller.abort()
    await assert.rejects(cancelled, /cancel/u)
  })
})

function fixture(options = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'mengluo-update-manager-'))
  temporaryDirectories.push(userData)
  const dialogs = []
  const notifications = []
  const logs = []
  let requests = 0
  let installs = 0
  let menu
  let fetchOptions
  const fetchUrls = []
  const proxyTargets = []
  const popups = []
  const popupCloses = []
  class FakeNotification {
    static isSupported() { return true }
    constructor(options) {
      this.options = options
      this.listeners = {}
      notifications.push(options)
    }
    on(event, listener) { this.listeners[event] = listener }
    show() { options.onNotification?.(this.options) }
  }
  const electron = {
    app: {
      getVersion: () => '0.2.0',
      resolveProxy: async url => {
        proxyTargets.push(url)
        return options.resolveProxy === undefined ? options.proxyRules ?? 'DIRECT' : options.resolveProxy(url)
      },
    },
    dialog: {
      showMessageBox: async (...args) => {
        const message = args.at(-1)
        dialogs.push(message)
        return options.showMessage ? options.showMessage(message) : { response: message.type === 'question' ? 1 : 0 }
      },
    },
    Menu: {
      buildFromTemplate: template => {
        const built = [...template]
        built.popup = popupOptions => { popups.push({ menu: built, options: popupOptions }) }
        built.closePopup = window => { popupCloses.push(window) }
        return built
      },
      setApplicationMenu: value => { menu = value },
    },
    net: {
      fetch: async (url, init) => {
        requests += 1
        fetchUrls.push(url)
        fetchOptions = init
        return options.fetch === undefined ? response(packument()) : options.fetch(url, init)
      },
    },
    Notification: FakeNotification,
    shell: { showItemInFolder: () => {} },
  }
  const manager = new HarnessUpdateManager({
    electron,
    userData,
    runnerPath: 'runner.mjs',
    workerPath: 'worker.mjs',
    npmCliPath: Object.hasOwn(options, 'npmCliPath') ? options.npmCliPath : 'build/updater/npm/bin/npm-cli.js',
    currentRuntime: options.uninstalled ? undefined : {
      source: 'bundled',
      version: '0.1.0-rc.5',
      root: options.runtimeRoot ?? 'bundled-runtime',
      cliPath: options.cliPath ?? 'cli.js',
      nodePath: options.nodePath ?? 'bundled-runtime/node-runtime/node.exe',
      nodeLicensePath: 'bundled-runtime/node-runtime/LICENSE',
      nodeVersion: '24.19.0',
    },
    installerNode: { nodePath: 'installer/node.exe', nodeVersion: '24.19.0', nodeLicensePath: 'installer/LICENSE' },
    onSetupRequested: options.onSetupRequested,
    onSetupProgress: options.onSetupProgress,
    getWindow: () => options.window,
    showWindow: options.showWindow,
    onHarnessMenuChanged: options.onHarnessMenuChanged,
    getClientMenuItems: options.getClientMenuItems,
    onSettingsRequested: options.onSettingsRequested,
    onSettingsChanged: options.onSettingsChanged,
    onProgressRequested: options.onProgressRequested,
    hasClientProgress: options.hasClientProgress,
    getDownloadSource: options.getDownloadSource,
    onDownloadStatus: options.onDownloadStatus,
    isPluginBusy: options.isPluginBusy,
    getLogPath: () => undefined,
    log: text => { logs.push(text) },
    requestRestart: options.requestRestart ?? (() => {}),
    openExternal: () => {},
    progressWindow: options.progressWindow,
    workspacePath: options.workspacePath ?? userData,
    terminalBinPath: options.terminalBinPath ?? userData,
    terminalEnvironment: options.terminalEnvironment,
    spawnTerminal: options.spawnTerminal,
    findNpm: options.findNpm,
    runUpdate: async updateOptions => {
      installs += 1
      return options.runUpdate?.(updateOptions)
    },
  })
  return {
    manager,
    userData,
    dialogs,
    logs,
    notifications,
    get requests() { return requests },
    get installs() { return installs },
    get menu() { return menu },
    get fetchOptions() { return fetchOptions },
    popups,
    popupCloses,
    fetchUrls,
    proxyTargets,
  }
}

function progressWindowFixture(timeline) {
  return Object.fromEntries(['begin', 'stage', 'complete', 'fail', 'show', 'dispose'].map(method => [
    method,
    (...args) => { timeline.push([method, ...args]) },
  ]))
}

function progressHarness(options = {}) {
  const deferred = promiseWithResolvers()
  const calls = []
  const runUpdate = options.waitForAbort
    ? ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('fixture cancelled')) }, { once: true })
    })
    : () => deferred.promise
  return {
    calls,
    deferred,
    harness: fixture({ window: taskbarWindow(calls), runUpdate }),
  }
}

function taskbarWindow(calls) {
  return {
    isDestroyed: () => false,
    setMenuBarVisibility: () => {},
    setProgressBar: (value, options) => {
      calls.push(options === undefined ? [value] : [value, options])
    },
  }
}

function promiseWithResolvers() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function packument() {
  const versions = {}
  for (const version of ['0.1.0-rc.6']) {
    versions[version] = {
      name: '@deepseek-ai/dsh',
      version,
      dist: {
        tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
        integrity: INTEGRITY,
      },
    }
  }
  return {
    name: '@deepseek-ai/dsh',
    'dist-tags': { latest: '0.1.0-rc.6', next: '0.1.0-rc.6' },
    versions,
  }
}

function response(value) {
  const text = JSON.stringify(value)
  return {
    status: 200,
    headers: { get: name => name === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text,
  }
}

function createSealedSlot(userData, version) {
  const root = join(userData, 'harness-runtimes', version)
  for (const name of ['dsh', 'dsh-web-app', 'dsh-web-frontend']) {
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', name)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }))
  }
  for (const [path, text] of [
    ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'fixture'],
    ['node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', '<title>DeepSeek Harness</title>'],
    ['node-runtime/node.exe', 'fixture'], ['node-runtime/LICENSE', 'fixture'],
  ]) {
    const parts = path.split('/')
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...parts), text)
  }
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'package-lock.json'), '{}')
  writeRuntimeSeal(root, version, { nodeVersion: '24.19.0' })
}
