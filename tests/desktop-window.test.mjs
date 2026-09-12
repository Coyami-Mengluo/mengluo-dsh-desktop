import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import {
  createNativeEditMenuTemplate,
  createDesktopWindow,
  isHarnessMenuShortcut,
  officialViewBounds,
  TITLEBAR_HEIGHT,
  TITLEBAR_CAPTURE_INTERVAL_MS,
} from '../src/desktop-window.mjs'

const CHANNELS = {
  state: 'mengluo:titlebar:state',
  ready: 'mengluo:titlebar:ready',
}
const DARK = Object.freeze({
  mode: 'solid',
  stops: [{ offset: 0, color: '#111111' }],
  foreground: '#FFFFFF',
  source: 'fallback',
})
const CAPTURED = Object.freeze({
  mode: 'gradient',
  stops: [
    { offset: 0, color: '#102040' },
    { offset: 0.5, color: '#203050' },
    { offset: 1, color: '#304060' },
  ],
  foreground: '#FFFFFF',
  source: 'capture',
})

describe('desktop shell and official WebContentsView composition', () => {
  it('samples active theme changes within 600ms and stops work while hidden, minimized or fullscreen', async context => {
    context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2000 })
    const world = fixture()
    const { controller } = world
    try {
      assert.equal(TITLEBAR_CAPTURE_INTERVAL_MS, 600)
      await controller.loadShell()
      await controller.loadOfficial('http://127.0.0.1:47821/')
      await controller.refreshSnapshot()
      context.mock.timers.tick(600)
      await Promise.resolve()
      assert.ok(world.captureCalls.length >= 2)
      controller.window.visible = false
      const hiddenCount = world.captureCalls.length
      controller.officialWebContents.emit('before-mouse-event', {}, { type: 'mouseUp' })
      context.mock.timers.tick(3000)
      await Promise.resolve()
      assert.equal(world.captureCalls.length, hiddenCount)
      controller.window.visible = true
      controller.window.minimized = true
      await controller.refreshSnapshot()
      assert.equal(world.captureCalls.length, hiddenCount)
      controller.window.minimized = false
      controller.window.fullscreen = true
      await controller.refreshSnapshot()
      assert.equal(world.captureCalls.length, hiddenCount)
      controller.window.fullscreen = false
      let prevented = false
      controller.officialWebContents.emit('before-mouse-event', { preventDefault: () => { prevented = true } }, { type: 'mouseUp' })
      context.mock.timers.tick(80)
      await Promise.resolve()
      assert.equal(world.captureCalls.length, hiddenCount + 1)
      assert.equal(prevented, false)
    } finally { controller.dispose() }
    assert.equal(controller.officialWebContents.listenerCount('before-mouse-event'), 0)
  })

  it('uses local window controls while isolating the official no-preload renderer', async () => {
    const world = fixture()
    const controller = world.controller
    const window = controller.window
    const official = controller.officialView

    assert.equal(window.options.titleBarStyle, 'hidden')
    assert.equal(window.options.titleBarOverlay, false)
    assert.equal(Object.hasOwn(window.options, 'frame'), false)
    assert.equal(window.options.webPreferences.partition, 'desktop-titlebar')
    assert.match(window.options.webPreferences.preload, /titlebar-preload\.cjs$/u)
    assert.equal(window.options.webPreferences.sandbox, true)
    assert.equal(official.options.webPreferences.partition, 'persist:mengluo-ai')
    assert.equal(Object.hasOwn(official.options.webPreferences, 'preload'), false)
    assert.equal(official.options.webPreferences.nodeIntegration, false)
    assert.equal(official.options.webPreferences.contextIsolation, true)
    assert.equal(official.options.webPreferences.sandbox, true)
    assert.deepEqual(window.contentView.children, [official])
    assert.equal(controller.officialWebContents, official.webContents)

    await controller.loadShell()
    assert.equal(window.loadedFile, 'fixture-titlebar.html')
    assert.equal(window.showCalls, 1)
    await controller.loadOfficial('http://127.0.0.1:47821/')
    await controller.refreshSnapshot()
    assert.equal(official.visible, true)
    assert.equal(official.webContents.focusCalls, 1)
    const capture = world.captureCalls.at(-1)
    assert.equal(capture.webContents, official.webContents)
    assert.equal(capture.options.darkFallback, true)
    assert.equal(capture.options.width, 1_320)
    assert.equal(typeof capture.options.onError, 'function')
    assert.equal(window.overlays.length, 0)
    controller.dispose()
  })

  it('tracks content bounds, fullscreen, focus, IPC readiness, and explicit teardown', async () => {
    const world = fixture()
    const { controller, ipcMain, nativeTheme } = world
    const window = controller.window
    const official = controller.officialView

    assert.deepEqual(official.bounds, { x: 0, y: 44, width: 1_320, height: 817 })
    window.contentBounds = { x: 40, y: 30, width: 1_600, height: 900 }
    window.emit('resize')
    assert.deepEqual(official.bounds, { x: 0, y: 44, width: 1_600, height: 857 })
    window.fullscreen = true
    window.emit('enter-full-screen')
    assert.deepEqual(official.bounds, { x: 0, y: 0, width: 1_600, height: 901 })
    window.fullscreen = false
    window.emit('leave-full-screen')
    assert.deepEqual(official.bounds, { x: 0, y: 44, width: 1_600, height: 857 })

    ipcMain.emit(CHANNELS.ready, { sender: window.webContents })
    assert.deepEqual(window.webContents.messages.at(-1), [CHANNELS.state, {
      focused: true,
      fullscreen: false,
      snapshot: DARK,
    }])
    window.focused = false
    window.emit('blur')
    assert.equal(window.webContents.messages.at(-1)[1].focused, false)
    nativeTheme.shouldUseDarkColors = false
    nativeTheme.emit('updated')
    assert.equal(window.webContents.messages.at(-1)[1].snapshot.foreground, '#000000')

    controller.dispose()
    assert.equal(official.webContents.closed, true)
    assert.deepEqual(window.contentView.children, [])
    assert.equal(ipcMain.listenerCount(CHANNELS.ready), 0)
    assert.equal(nativeTheme.listenerCount('updated'), 0)
  })

  it('explicitly closes the official WebContents when the native window closes first', () => {
    const world = fixture()
    const window = world.controller.window
    const official = world.controller.officialWebContents
    window.destroyed = true
    window.emit('closed')
    assert.equal(official.closed, true)
    assert.equal(world.ipcMain.listenerCount(CHANNELS.ready), 0)
  })

  it('denies the shell and confines official navigation, popups, webviews, and permissions', () => {
    const world = fixture()
    const shell = world.controller.window.webContents
    const official = world.controller.officialWebContents

    assert.equal(prevented(shell, 'will-navigate', 'file:///other.html'), true)
    assert.deepEqual(shell.openHandler({ url: 'https://example.com' }), { action: 'deny' })
    assert.equal(shell.session.permissionCheck(), false)

    assert.equal(prevented(official, 'will-navigate', 'http://127.0.0.1:47821/session'), false)
    assert.equal(prevented(official, 'will-redirect', 'https://example.com/escape'), true)
    let webviewPrevented = false
    official.emit('will-attach-webview', { preventDefault: () => { webviewPrevented = true } })
    assert.equal(webviewPrevented, true)
    assert.deepEqual(official.openHandler({ url: 'https://example.com/docs' }), { action: 'deny' })
    assert.deepEqual(world.externalUrls, ['https://example.com/docs'])
    assert.equal(official.session.permissionCheck(undefined, 'clipboard-sanitized-write', 'http://127.0.0.1:47821'), true)
    assert.equal(official.session.permissionCheck(undefined, 'clipboard-read', 'http://127.0.0.1:47821'), false)
    assert.equal(official.session.permissionCheck(undefined, 'clipboard-sanitized-write', 'https://example.com'), false)
    world.controller.dispose()
  })

  it('shows a native copy, paste, and selection menu targeted at the official renderer', () => {
    const world = fixture()
    const official = world.controller.officialWebContents
    official.emit('context-menu', {}, {
      isEditable: true,
      selectionText: 'selected text',
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
      },
    })

    assert.equal(world.contextMenus.length, 1)
    assert.equal(world.contextMenus[0].details.window, world.controller.window)
    assert.deepEqual(
      world.contextMenus[0].template.filter(item => item.type !== 'separator').map(item => item.label),
      ['撤销', '重做', '剪切', '复制', '粘贴', '删除', '全选'],
    )
    assert.equal(world.contextMenus[0].template.find(item => item.label === '重做').enabled, false)
    world.contextMenus[0].template.find(item => item.label === '复制').click()
    world.contextMenus[0].template.find(item => item.label === '粘贴').click()
    assert.deepEqual(official.editCommands, ['copy', 'paste'])

    const readonly = createNativeEditMenuTemplate(official, {
      isEditable: false,
      selectionText: 'read only selection',
      editFlags: { canCopy: true, canSelectAll: true },
    })
    assert.deepEqual(readonly.filter(item => item.type !== 'separator').map(item => item.label), ['复制', '全选'])
    readonly[0].click()
    assert.deepEqual(official.editCommands, ['copy', 'paste', 'copy'])
    world.controller.dispose()
  })

  it('contains shell and official renderer failures in separate callbacks', () => {
    const world = fixture()
    world.controller.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    world.controller.officialWebContents.emit('render-process-gone', {}, { reason: 'oom' })
    assert.deepEqual(world.gone, [
      ['shell', { reason: 'crashed' }],
      ['official', { reason: 'oom' }],
    ])
    world.controller.dispose()
  })

  it('reveals the Harness menu once for Ctrl+Alt+U in either renderer', () => {
    const world = fixture()
    const shell = world.controller.window.webContents
    const official = world.controller.officialWebContents
    const shortcut = {
      type: 'keyDown',
      key: 'u',
      code: 'KeyU',
      alt: true,
      control: true,
      shift: false,
      meta: false,
      isAutoRepeat: false,
    }

    assert.equal(inputPrevented(official, shortcut), true)
    assert.equal(world.harnessMenuRequests.length, 1)
    assert.equal(inputPrevented(official, { ...shortcut, type: 'keyUp' }), false)
    assert.equal(inputPrevented(official, { ...shortcut, isAutoRepeat: true }), false)
    assert.equal(inputPrevented(shell, { ...shortcut, key: 'U' }), true)
    assert.equal(world.harnessMenuRequests.length, 2)
    assert.equal(isHarnessMenuShortcut({ ...shortcut, code: '' }), true)
    assert.equal(isHarnessMenuShortcut({ ...shortcut, key: 'other-layout-key' }), true)

    world.controller.dispose()
    assert.equal(shell.listenerCount('before-input-event'), 0)
    assert.equal(shell.listenerCount('blur'), 0)
    assert.equal(official.listenerCount('before-input-event'), 0)
    assert.equal(official.listenerCount('blur'), 0)
  })

  it('does not intercept Alt, Alt+F4, AltGraph, or other modifier combinations', () => {
    const world = fixture()
    const official = world.controller.officialWebContents
    const shortcut = harnessShortcut()
    for (const input of [
      { ...shortcut, key: 'Alt', code: 'AltLeft', control: false },
      { ...shortcut, key: 'F4', code: 'F4' },
      { ...shortcut, key: 'AltGraph', code: 'AltRight' },
      { ...shortcut, key: 'AltGraph', code: 'KeyU' },
      { ...shortcut, control: false },
      { ...shortcut, alt: false },
      { ...shortcut, shift: true },
      { ...shortcut, meta: true },
      { ...shortcut, key: 'F10', code: 'F10', control: false, alt: false },
      { ...shortcut, key: 'i', code: 'KeyI' },
      undefined,
    ]) {
      assert.equal(inputPrevented(official, input), false)
      assert.equal(isHarnessMenuShortcut(input), false)
    }
    assert.equal(world.harnessMenuRequests.length, 0)
    world.controller.dispose()
  })

  it('rejects the U event for the full AltGraph chord independently per renderer', () => {
    const world = fixture()
    const shell = world.controller.window.webContents
    const official = world.controller.officialWebContents
    const altGraphDown = {
      type: 'keyDown',
      key: 'AltGraph',
      code: 'AltRight',
      control: true,
      alt: true,
      shift: false,
      meta: false,
      isAutoRepeat: false,
    }
    const shortcut = harnessShortcut()

    assert.equal(inputPrevented(official, altGraphDown), false)
    assert.equal(inputPrevented(official, shortcut), false)
    assert.equal(world.harnessMenuRequests.length, 0)
    assert.equal(inputPrevented(shell, shortcut), true)
    assert.equal(world.harnessMenuRequests.length, 1)

    assert.equal(inputPrevented(official, { ...altGraphDown, type: 'keyUp', control: false, alt: false }), false)
    assert.equal(inputPrevented(official, shortcut), true)
    assert.equal(world.harnessMenuRequests.length, 2)

    assert.equal(inputPrevented(official, altGraphDown), false)
    official.emit('blur')
    assert.equal(inputPrevented(official, shortcut), true)
    assert.equal(world.harnessMenuRequests.length, 3)
    assert.equal(isHarnessMenuShortcut(shortcut, true), false)
    world.controller.dispose()
  })

  it('clamps child bounds for tiny and invalid content sizes', () => {
    assert.deepEqual(officialViewBounds({ width: -10, height: 20 }, false), {
      x: 0, y: 20, width: 0, height: 0,
    })
    assert.deepEqual(officialViewBounds({ width: 800.9, height: 600.9 }, true), {
      x: 0, y: 0, width: 800, height: 601,
    })
  })

  it('overscans one DIP below the parent to cover fractional-DPI rounding seams', () => {
    const bounds = officialViewBounds({ width: 1_920, height: 1_080 }, false)
    assert.equal(bounds.y + bounds.height, 1_081)
    assert.equal(bounds.height, 1_080 - TITLEBAR_HEIGHT + 1)
  })
})

function fixture() {
  const ipcMain = new EventEmitter()
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true })
  const windows = []
  const views = []
  const captureCalls = []
  const externalUrls = []
  const gone = []
  const harnessMenuRequests = []
  const contextMenus = []
  const Menu = {
    buildFromTemplate(template) {
      return {
        popup(details) { contextMenus.push({ template, details }) },
      }
    },
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.destroyed = false
      this.visible = false
      this.minimized = false
      this.maximized = false
      this.fullscreen = false
      this.focused = true
      this.contentBounds = { x: 10, y: 10, width: 1_320, height: 860 }
      this.overlays = []
      this.showCalls = 0
      this.webContents = new FakeWebContents()
      this.contentView = {
        children: [],
        addChildView: view => { this.contentView.children.push(view) },
        removeChildView: view => {
          this.contentView.children = this.contentView.children.filter(candidate => candidate !== view)
        },
      }
      windows.push(this)
    }
    getContentBounds() { return this.contentBounds }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    isMaximized() { return this.maximized }
    isFullScreen() { return this.fullscreen }
    isFocused() { return this.focused }
    setTitleBarOverlay(value) { this.overlays.push(value) }
    show() { this.visible = true; this.showCalls += 1 }
    loadFile(path) {
      this.loadedFile = path
      queueMicrotask(() => { this.emit('ready-to-show') })
      return Promise.resolve()
    }
  }
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = new FakeWebContents()
      this.visible = true
      this.bounds = undefined
      views.push(this)
    }
    setVisible(value) { this.visible = value }
    setBounds(value) { this.bounds = value }
    getBounds() { return this.bounds }
  }
  const controller = createDesktopWindow({
    BrowserWindow,
    Menu,
    WebContentsView,
    ipcMain,
    nativeTheme,
    productName: 'DeepSeek harness',
    iconPath: 'fixture-icon.png',
    titlebarPreloadPath: 'fixture-titlebar-preload.cjs',
    titlebarHtmlPath: 'fixture-titlebar.html',
    titlebarChannels: CHANNELS,
    captureSnapshot: async (webContents, options) => {
      captureCalls.push({ webContents, options })
      return CAPTURED
    },
    fallbackSnapshot: dark => dark
      ? DARK
      : { ...DARK, foreground: '#000000', stops: [{ offset: 0, color: '#F5F5F5' }] },
    getBackendOrigin: () => 'http://127.0.0.1:47821',
    openExternal: url => { externalUrls.push(url) },
    onShellRenderGone: details => { gone.push(['shell', details]) },
    onOfficialRenderGone: details => { gone.push(['official', details]) },
    showHarnessMenuAtTopLeft: () => { harnessMenuRequests.push(true) },
  })
  return {
    controller,
    ipcMain,
    nativeTheme,
    windows,
    views,
    captureCalls,
    externalUrls,
    gone,
    harnessMenuRequests,
    contextMenus,
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.closed = false
    this.focusCalls = 0
    this.editCommands = []
    this.messages = []
    this.openHandler = undefined
    this.session = {
      setPermissionCheckHandler: handler => { this.session.permissionCheck = handler },
      setPermissionRequestHandler: handler => { this.session.permissionRequest = handler },
    }
  }
  isDestroyed() { return this.destroyed }
  send(...args) { this.messages.push(args) }
  setWindowOpenHandler(handler) { this.openHandler = handler }
  loadURL(url) { this.loadedUrl = url; return Promise.resolve() }
  focus() { this.focusCalls += 1 }
  undo() { this.editCommands.push('undo') }
  redo() { this.editCommands.push('redo') }
  cut() { this.editCommands.push('cut') }
  copy() { this.editCommands.push('copy') }
  paste() { this.editCommands.push('paste') }
  delete() { this.editCommands.push('delete') }
  selectAll() { this.editCommands.push('selectAll') }
  close() { this.closed = true; this.destroyed = true }
}

function prevented(webContents, event, url) {
  let value = false
  webContents.emit(event, { preventDefault: () => { value = true } }, url)
  return value
}

function inputPrevented(webContents, input) {
  let value = false
  webContents.emit('before-input-event', { preventDefault: () => { value = true } }, input)
  return value
}

function harnessShortcut() {
  return {
    type: 'keyDown',
    key: 'u',
    code: 'KeyU',
    alt: true,
    control: true,
    shift: false,
    meta: false,
    isAutoRepeat: false,
  }
}
