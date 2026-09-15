import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createUpdateProgressWindow,
  normalizeUpdateFileProgress,
  UPDATE_INSTALL_TIMEOUT_MS,
  UPDATE_PROGRESS_IPC,
} from '../src/update-progress-window.mjs'
import { formatUpdateTiming } from '../assets/update-progress-timing.js'

describe('native update progress window', () => {
  it('distinguishes an installed historical slot from a scheduled update', () => {
    const world = fixture()
    world.controller.complete('1.0.0', true)
    assert.equal(world.controller.state.percent, 100)
    assert.match(world.controller.state.detail, /尚未切换/u)
    world.controller.dispose()
  })

  it('shows without focus, hides instead of cancelling, follows theme, and disposes', async () => {
    const world = fixture({ now: () => 1_000 })
    world.controller.begin('0.1.0-rc.6')
    await new Promise(resolve => { setImmediate(resolve) })

    const window = world.windows[0]
    assert.equal(window.options.modal, false)
    assert.equal(window.options.show, false)
    assert.equal(window.options.webPreferences.nodeIntegration, false)
    assert.equal(window.options.webPreferences.partition, 'update-progress')
    assert.match(window.options.webPreferences.preload, /update-progress-preload\.cjs$/u)
    assert.equal(window.options.webPreferences.contextIsolation, true)
    assert.equal(window.options.webPreferences.sandbox, true)
    assert.equal(window.options.webPreferences.webSecurity, true)
    assert.equal(window.options.webPreferences.devTools, false)
    assert.equal(window.showInactiveCalls, 1)
    assert.equal(window.showCalls, 0)
    assert.deepEqual(world.controller.state.timing, {
      startedAt: 1_000,
      estimateMinMs: 600_000,
      estimateMaxMs: 1_200_000,
      timeoutMs: 1_800_000,
    })

    let prevented = false
    window.emit('close', { preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(window.hideCalls, 1)
    assert.equal(window.destroyed, false)

    world.controller.show()
    assert.equal(window.showInactiveCalls, 2)
    world.controller.stage('installing', '0.1.0-rc.6')
    assert.equal(world.controller.state.percent, undefined)
    assert.equal(world.controller.state.label, '通过 npm 下载并安装')
    world.controller.stage('installing', '0.1.0-rc.6', {
      completedFiles: 1_024,
      registryRequests: 320,
      resolvedDependencies: 210,
    })
    assert.match(world.controller.state.detail, /已解析 210 个依赖/u)
    assert.match(world.controller.state.detail, /320 次 registry 获取/u)
    assert.match(world.controller.state.detail, /1024 个文件/u)
    world.controller.stage('verifying', '0.1.0-rc.6', { completedFiles: 250, totalFiles: 1_000 })
    assert.equal(world.controller.state.percent, 25)
    assert.match(world.controller.state.detail, /250 \/ 1000/u)

    world.nativeTheme.shouldUseDarkColors = true
    world.nativeTheme.emit('updated')
    assert.equal(world.controller.state.theme, 'dark')
    assert.equal(window.backgrounds.at(-1), '#111318')

    world.controller.complete('0.1.0-rc.6')
    assert.equal(world.controller.state.percent, 100)
    assert.equal(world.controller.state.status, 'complete')
    assert.equal(window.showInactiveCalls, 3)
    world.controller.dispose()
    assert.equal(window.destroyed, true)
    world.controller.stage('installing', '0.1.0-rc.6', { completedFiles: 99 })
    world.controller.show()
    assert.equal(world.windows.length, 1)
    assert.equal(world.ipcMain.listenerCount(UPDATE_PROGRESS_IPC.ready), 0)
    assert.equal(world.nativeTheme.listenerCount('updated'), 0)
  })

  it('uses the 30-minute limit and reports an honest elapsed-time estimate', () => {
    assert.equal(UPDATE_INSTALL_TIMEOUT_MS, 30 * 60 * 1_000)
    const running = {
      status: 'running',
      stage: 'installing',
      timing: {
        startedAt: 1_000,
        estimateMinMs: 10 * 60 * 1_000,
        estimateMaxMs: 20 * 60 * 1_000,
        timeoutMs: UPDATE_INSTALL_TIMEOUT_MS,
      },
    }
    assert.equal(
      formatUpdateTiming(running, 1_000 + 5 * 60 * 1_000 + 7_000),
      '预计总耗时 10–20 分钟 · 已用 5分07秒 · npm 安装上限 30 分钟',
    )
    assert.equal(
      formatUpdateTiming(running, 1_000 + 22 * 60 * 1_000),
      '已用 22分00秒 · 已超过通常耗时，npm 安装上限 30 分钟',
    )
    assert.equal(
      formatUpdateTiming({ ...running, status: 'complete' }, 1_000 + 9 * 60 * 1_000 + 34_000),
      '本次共用时 9分34秒',
    )
  })

  it('accepts only bounded physical-file counters', () => {
    assert.deepEqual(normalizeUpdateFileProgress({ completedFiles: 2, totalFiles: 4 }), {
      completedFiles: 2,
      totalFiles: 4,
    })
    assert.deepEqual(normalizeUpdateFileProgress({ registryRequests: 3, resolvedDependencies: 2 }), {
      registryRequests: 3,
      resolvedDependencies: 2,
    })
    assert.throws(() => { normalizeUpdateFileProgress({ completedFiles: -1 }) }, /non-negative/u)
    assert.throws(() => {
      normalizeUpdateFileProgress({ completedFiles: 5, totalFiles: 4 })
    }, /no smaller/u)
  })

  it('denies navigation, popups, webviews, and permissions and never publishes raw failure detail', () => {
    const world = fixture()
    world.controller.begin('0.1.0-rc.6')
    const window = world.windows[0]
    let navigationPrevented = false
    window.webContents.emit('will-navigate', { preventDefault: () => { navigationPrevented = true } })
    assert.equal(navigationPrevented, true)
    let webviewPrevented = false
    window.webContents.emit('will-attach-webview', { preventDefault: () => { webviewPrevented = true } })
    assert.equal(webviewPrevented, true)
    assert.deepEqual(window.webContents.openHandler(), { action: 'deny' })
    assert.equal(window.webContents.session.permissionCheck(), false)
    let permission
    window.webContents.session.permissionRequest(undefined, undefined, value => { permission = value })
    assert.equal(permission, false)

    world.controller.fail('0.1.0-rc.6')
    const serialized = JSON.stringify(world.controller.state)
    assert.match(serialized, /当前 Harness 版本未受影响/u)
    assert.doesNotMatch(serialized, /[A-Za-z]:\\|AppData|node_modules/u)
    world.controller.dispose()
  })

  it('ships a strict CSP with external-only script and style assets', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'assets', 'update-progress.html'), 'utf8')
    const preload = readFileSync(join(import.meta.dirname, '..', 'src', 'update-progress-preload.cjs'), 'utf8')
    assert.match(html, /default-src 'none'/u)
    assert.match(html, /script-src 'self'/u)
    assert.match(html, /style-src 'self'/u)
    assert.match(html, /connect-src 'none'/u)
    assert.match(html, /frame-ancestors 'none'/u)
    assert.match(html, /id="timing-label"/u)
    assert.match(html, /<script src="\.\/update-progress\.js" type="module"><\/script>/u)
    assert.doesNotMatch(html, /<script(?!\s+src=)/u)
    assert.doesNotMatch(html, /\sstyle=/u)
    assert.match(preload, /require\('electron'\)/u)
    assert.doesNotMatch(preload, /node:fs|child_process|process\.env/u)
  })
})

function fixture(options = {}) {
  const windows = []
  const ipcMain = new EventEmitter()
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  const parent = { isDestroyed: () => false }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.destroyed = false
      this.showInactiveCalls = 0
      this.showCalls = 0
      this.hideCalls = 0
      this.backgrounds = []
      this.webContents = new FakeWebContents()
      windows.push(this)
    }
    setMenu() {}
    loadFile() {
      queueMicrotask(() => { this.emit('ready-to-show') })
      return Promise.resolve()
    }
    showInactive() { this.showInactiveCalls += 1 }
    show() { this.showCalls += 1 }
    hide() { this.hideCalls += 1 }
    setBackgroundColor(value) { this.backgrounds.push(value) }
    isDestroyed() { return this.destroyed }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const controller = createUpdateProgressWindow({
    BrowserWindow,
    ipcMain,
    nativeTheme,
    getParent: () => parent,
    preloadPath: 'fixture-update-progress-preload.cjs',
    htmlPath: 'fixture-progress.html',
    now: options.now,
  })
  return { controller, ipcMain, nativeTheme, windows }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.messages = []
    this.openHandler = undefined
    this.session = {
      setPermissionCheckHandler: handler => { this.session.permissionCheck = handler },
      setPermissionRequestHandler: handler => { this.session.permissionRequest = handler },
    }
  }
  isDestroyed() { return false }
  send(...args) { this.messages.push(args) }
  setWindowOpenHandler(handler) { this.openHandler = handler }
}
