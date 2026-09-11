import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createSettingsWindow, SETTINGS_IPC, validateSettingsAction } from '../src/settings-window.mjs'

describe('settings action contract', () => {
  it('accepts only fixed actions and narrowly typed preferences', () => {
    for (const type of ['harness-check', 'harness-setup', 'harness-download', 'harness-restart', 'harness-progress',
      'terminal', 'client-check', 'client-download', 'client-install', 'client-progress',
      'open-log', 'open-repository', 'open-official', 'open-client-releases', 'test-connection',
      'plugins-refresh', 'plugins-check']) {
      assert.equal(validateSettingsAction({ type }), true, type)
      assert.equal(validateSettingsAction({ type, url: 'https://untrusted.invalid' }), false, type)
    }
    assert.equal(validateSettingsAction({ type: 'download-source', source: 'official' }), true)
    assert.equal(validateSettingsAction({ type: 'download-source', source: 'npmmirror' }), true)
    assert.equal(validateSettingsAction({ type: 'harness-preferences', patch: { autoCheck: false, interval: '24h', channel: 'next' } }), true)
    assert.equal(validateSettingsAction({ type: 'client-preferences', patch: { autoCheck: true } }), true)
    for (const request of [null, [], 'terminal', { type: 'exec', command: 'npm install' },
      { type: 'download-source', source: 'https://untrusted.invalid' },
      { type: 'harness-preferences', patch: {} },
      { type: 'harness-preferences', patch: { autoCheck: 1 } },
      { type: 'harness-preferences', patch: { interval: '1s' } },
      { type: 'harness-preferences', patch: { channel: 'nightly' } },
      { type: 'harness-preferences', patch: { path: 'C:\\user' } },
      { type: 'client-preferences', patch: { autoCheck: true, channel: 'next' } },
      { type: 'client-preferences', patch: { autoCheck: true }, extra: true },
      Object.assign(Object.create({ type: 'terminal' }), {}),
      { type: 'harness-preferences', patch: Object.create({ autoCheck: true }) },
    ]) assert.equal(validateSettingsAction(request), false, JSON.stringify(request))
    assert.equal(Object.isFrozen(SETTINGS_IPC), true)
  })
  it('accepts plugin identity only, rejecting URLs, commands and extra request fields', () => {
    for (const type of ['plugin-install', 'plugin-update', 'plugin-remove', 'plugin-source']) {
      for (const id of ['@author/dsh-theme', 'github:author/plugin', 'example-id']) {
        assert.equal(validateSettingsAction({ type, id }), true)
      }
      for (const id of ['', ' ', 'plugin;cmd', '$(secret)', 'https://untrusted.invalid?q=1', 'https://github.com/example/plugin', '-option', 'x'.repeat(241), undefined, {}, ['plugin']]) {
        assert.equal(validateSettingsAction({ type, id }), false, JSON.stringify({ type, id }))
      }
      assert.equal(validateSettingsAction({ type, id: 'plugin', url: 'https://untrusted.invalid' }), false)
      assert.equal(validateSettingsAction({ type, id: 'plugin', command: 'npm install' }), false)
      assert.equal(validateSettingsAction({ type }), false)
    }
    assert.equal(validateSettingsAction({ type: 'plugins-auto-update', enabled: true }), false)
  })
  it('accepts normalized bounded remote queries but rejects search syntax and extra fields', () => {
    for (const type of ['plugins-search', 'plugins-more']) {
      for (const query of ['', '中文 主题', 'aurora-theme', 'author/repo', 'plugin_name.v2', 'éclair']) {
        assert.equal(validateSettingsAction({ type, query }), true, JSON.stringify({ type, query }))
      }
      for (const query of [undefined, {}, ['theme'], 'x'.repeat(101), ' theme', 'theme  color',
        'theme\ncolor', 'topic:other', 'theme OR skin', 'NOT theme', 'AND', '"quoted"', '(theme)', '@author', 'https://github.com', 'theme;cmd', 'a '.repeat(50).trim()]) {
        assert.equal(validateSettingsAction({ type, query }), false, JSON.stringify({ type, query }))
      }
      assert.equal(validateSettingsAction({ type }), false)
      assert.equal(validateSettingsAction({ type, query: 'theme', page: 2 }), false)
      assert.equal(validateSettingsAction({ type, query: 'theme', url: 'https://untrusted.invalid' }), false)
    }
  })
})

describe('isolated client settings window', () => {
  it('reuses one window, restores it, hides on close, and changes sections only on show', async () => {
    const world = fixture()
    world.controller.update({ harness: { installed: true, version: '0.1.2' } })
    assert.equal(world.windows.length, 0)
    assert.equal(world.controller.window, undefined)
    world.controller.show('network')
    await tick()
    const window = world.windows[0]
    assert.equal(world.controller.window, window)
    assert.equal(window.options.width, 820)
    assert.equal(window.options.minWidth, 680)
    assert.equal(window.options.minHeight, 520)
    assert.equal(window.options.modal, false)
    assert.equal(window.options.parent, world.parent)
    assert.equal(window.showCalls, 1)
    assert.equal(window.focusCalls, 1)
    assert.equal(window.webContents.messages.at(-1)[1].section, 'network')
    const revision = window.webContents.messages.at(-1)[1].sectionRevision
    world.controller.update({ harness: { installed: true, version: '0.1.3' } })
    assert.equal(window.webContents.messages.at(-1)[1].sectionRevision, revision)
    let prevented = false
    window.emit('close', { preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(window.hideCalls, 1)
    assert.equal(window.destroyed, false)
    window.minimized = true
    world.controller.show('client')
    assert.equal(world.windows.length, 1)
    assert.equal(window.restoreCalls, 1)
    assert.equal(window.showCalls, 2)
    assert.equal(window.focusCalls, 2)
    assert.equal(window.webContents.messages.at(-1)[1].section, 'client')
    assert.equal(window.webContents.messages.at(-1)[1].sectionRevision, revision + 1)
    world.controller.show('arbitrary')
    assert.equal(window.webContents.messages.at(-1)[1].section, 'harness')
    world.controller.show('plugins')
    assert.equal(window.webContents.messages.at(-1)[1].section, 'plugins')
    world.controller.dispose()
    assert.equal(world.controller.window, undefined)
  })

  it('follows native theme and sends no raw exception details', async () => {
    const world = fixture()
    world.controller.show()
    await tick()
    const window = world.windows[0]
    assert.equal(window.options.backgroundColor, '#f7f8fa')
    world.nativeTheme.shouldUseDarkColors = true
    world.nativeTheme.emit('updated')
    assert.equal(window.backgrounds.at(-1), '#15171c')
    assert.equal(window.webContents.messages.at(-1)[1].theme, 'dark')
    world.controller.update({ harness: { status: 'error', error: 'token=private-harness-token' }, client: { status: 'error', error: 'C:\\private\\path' }, plugins: { error: 'npm token=secret', catalogError: 'token=private-catalog' } })
    const payload = window.webContents.messages.at(-1)[1]
    assert.equal(payload.harness.error, '操作未完成，请查看日志。')
    assert.equal(payload.plugins.error, '操作未完成，请查看日志。')
    assert.equal(payload.plugins.catalogError, '目录搜索未完成，请检查系统代理或稍后重试。已有结果不会被清除。')
    assert.doesNotMatch(JSON.stringify(payload), /private|token/u)
    world.controller.update({ plugins: { catalogError: '搜索请求已暂停，已有结果已保留。请等待倒计时结束后重试。' } })
    assert.equal(world.windows[0].webContents.messages.at(-1)[1].plugins.catalogError, '搜索请求已暂停，已有结果已保留。请等待倒计时结束后重试。')
    world.controller.dispose()
  })

  it('handles a thrown structured plugin rate limit without exposing exception text', async () => {
    const retryAt = Date.now() + 45_000
    const world = fixture({ onAction: () => { throw Object.assign(new Error('token=private'), { code: 'PLUGIN_RATE_LIMIT', retryAt }) } })
    world.controller.show('plugins')
    await tick()
    assert.deepEqual(await world.invoke(world.trustedEvent(), { type: 'plugins-refresh' }), {
      ok: false, rateLimited: true, retryAt, message: '插件请求冷却中，请等待倒计时结束后重试。',
    })
    assert.deepEqual(world.logs, [])
    world.controller.dispose()
  })

  it('requires exact webContents, mainFrame and file URL before any IPC action', async () => {
    const world = fixture()
    world.controller.show()
    await tick()
    const window = world.windows[0]
    const event = world.trustedEvent()
    assert.deepEqual(await world.invoke(event, { type: 'terminal' }), { ok: true })
    assert.deepEqual(world.actions, [{ type: 'terminal' }])
    const size = window.webContents.messages.length
    world.ipcMain.emit(SETTINGS_IPC.ready, event)
    assert.equal(window.webContents.messages.length, size + 1)
    const invalidEvents = [
      { ...event, sender: {} },
      { ...event, senderFrame: { url: event.senderFrame.url } },
      { sender: {}, senderFrame: { url: 'https://untrusted.invalid' } },
    ]
    for (const invalid of invalidEvents) {
      assert.equal((await world.invoke(invalid, { type: 'terminal' })).ok, false)
      world.ipcMain.emit(SETTINGS_IPC.ready, invalid)
    }
    window.webContents.mainFrame.url += '?injected=1'
    assert.equal((await world.invoke(event, { type: 'terminal' })).ok, false)
    window.webContents.mainFrame.url = world.url
    assert.equal((await world.invoke(event, { type: 'terminal', command: 'npm' })).ok, false)
    assert.equal((await world.invoke(event, { type: 'terminal' }, 'extra')).ok, false)
    assert.equal(world.actions.length, 1)
    assert.equal(window.webContents.messages.length, size + 1)
    world.controller.dispose()
  })

  it('converts action failures to a fixed safe reply', async () => {
    const world = fixture({ onAction: () => { throw new Error('secret=123 C:\\private-path') } })
    world.controller.show()
    await tick()
    assert.deepEqual(await world.invoke(world.trustedEvent(), { type: 'client-check' }), {
      ok: false, message: '操作未完成，请重试或查看日志。',
    })
    assert.doesNotMatch(world.logs.join(''), /secret|private-path/u)
    world.controller.dispose()
    const rejected = fixture({ onAction: () => ({ ok: false, message: 'secret=123' }) })
    rejected.controller.show()
    await tick()
    assert.doesNotMatch(JSON.stringify(await rejected.invoke(rejected.trustedEvent(), { type: 'harness-check' })), /secret/u)
    rejected.controller.dispose()
  })

  it('passes only validated plugin cooldown deadlines and a fixed safe explanation', async () => {
    const retryAt = Date.now() + 30_000
    let reply = { ok: false, rateLimited: true, retryAt, message: 'token=private-reply', extra: 'secret' }
    const world = fixture({ onAction: () => reply })
    world.controller.show('plugins')
    await tick()
    for (const request of [{ type: 'plugins-refresh' }, { type: 'plugins-check' },
      { type: 'plugins-search', query: '主题' }, { type: 'plugins-more', query: '' },
      { type: 'plugin-install', id: 'npm:theme' }, { type: 'plugin-update', id: 'npm:theme' }]) {
      assert.deepEqual(await world.invoke(world.trustedEvent(), request), {
        ok: false, rateLimited: true, retryAt, message: '插件请求冷却中，请等待倒计时结束后重试。',
      })
    }
    assert.equal((await world.invoke(world.trustedEvent(), { type: 'client-check' })).rateLimited, undefined)
    assert.equal((await world.invoke(world.trustedEvent(), { type: 'plugin-remove', id: 'npm:theme' })).rateLimited, undefined)
    for (const invalid of [undefined, null, 0, -1, Infinity, NaN, '123', {}, 1.5, 8.64e15 + 1]) {
      reply = { ok: false, rateLimited: true, retryAt: invalid, message: 'private' }
      assert.deepEqual(await world.invoke(world.trustedEvent(), { type: 'plugins-check' }), {
        ok: false, message: '操作未完成，请重试或查看日志。',
      })
    }
    reply = { ok: false, message: 'HTTP 403: private' }
    assert.equal((await world.invoke(world.trustedEvent(), { type: 'plugins-refresh' })).rateLimited, undefined)
    world.controller.update({ plugins: { rateLimits: { searchUntil: retryAt, metadataUntil: Infinity,
      refreshUntil: 'private', checkUntil: -1, searchReason: 'token=private', metadataReason: 'private' } } })
    const payload = world.windows[0].webContents.messages.at(-1)[1]
    assert.deepEqual(payload.plugins.rateLimits, { searchUntil: retryAt, metadataUntil: 0, refreshUntil: 0, checkUntil: 0 })
    assert.doesNotMatch(JSON.stringify(payload), /private|token/u)
    world.controller.dispose()
  })

  it('denies navigation, subframes, popups, webviews and all permissions', async () => {
    const world = fixture()
    world.controller.show()
    await tick()
    const window = world.windows[0]
    assert.deepEqual(window.options.webPreferences, {
      preload: join(import.meta.dirname, '..', 'src', 'settings-preload.cjs'), partition: 'client-settings',
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false,
    })
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      let prevented = false
      window.webContents.emit(name, { preventDefault: () => { prevented = true } })
      assert.equal(prevented, true, name)
    }
    assert.deepEqual(window.webContents.openHandler({ url: 'https://example.invalid' }), { action: 'deny' })
    assert.equal(window.webContents.session.permissionCheck(), false)
    let granted
    window.webContents.session.permissionRequest(null, 'camera', value => { granted = value })
    assert.equal(granted, false)
    world.controller.dispose()
  })

  it('disposes IPC and theme listeners, prevents post-dispose reopen, and handles failed loads', async () => {
    const world = fixture()
    world.controller.show()
    await tick()
    world.controller.dispose()
    world.controller.dispose()
    assert.equal(world.windows[0].destroyed, true)
    assert.equal(world.ipcMain.listenerCount(SETTINGS_IPC.ready), 0)
    assert.equal(world.handlers.has(SETTINGS_IPC.action), false)
    assert.equal(world.nativeTheme.listenerCount('updated'), 0)
    world.controller.show()
    world.controller.update({ client: {} })
    assert.equal(world.windows.length, 1)
    const broken = fixture({ failLoad: true })
    broken.controller.show()
    await tick()
    assert.equal(broken.windows[0].destroyed, true)
    assert.equal(broken.windows[0].showCalls, 0)
    assert.equal(broken.logs.length, 1)
    broken.controller.dispose()
  })

  it('ships strict CSP, fixed action bridge and accessible isolated sections', () => {
    const root = join(import.meta.dirname, '..')
    const html = readFileSync(join(root, 'assets', 'settings.html'), 'utf8')
    const css = readFileSync(join(root, 'assets', 'settings.css'), 'utf8')
    const js = readFileSync(join(root, 'assets', 'settings.js'), 'utf8')
    const preload = readFileSync(join(root, 'src', 'settings-preload.cjs'), 'utf8')
    for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'"]) assert.ok(html.includes(rule), rule)
    for (const section of ['harness', 'plugins', 'network', 'client', 'about']) assert.match(html, new RegExp(`id="panel-${section}" role="tabpanel"`))
    assert.doesNotMatch(html, /<script(?!\s+src=)|\sstyle=|\sonclick=/u)
    assert.doesNotMatch(js, /innerHTML|outerHTML|eval\(|fetch\(|XMLHttpRequest/u)
    assert.match(js, /document\.activeElement !== input/u)
    assert.match(js, /sectionRevision !== lastSectionRevision/u)
    assert.match(css, /prefers-reduced-motion/u)
    assert.match(css, /overflow-y: auto/u)
    assert.match(preload, /exposeInMainWorld\('clientSettings'/u)
    assert.doesNotMatch(preload, /node:fs|child_process|process\.env|shell\.openExternal/u)
    assert.match(html, /第三方镜像/u)
    assert.match(html, /不修改系统全局 npm 配置/u)
    assert.match(html, /社区目录收录不代表安全或兼容认证/u)
    assert.match(html, /只检查更新，不会自动安装/u)
    assert.match(js, /button\.dataset\.pluginId/u)
    assert.match(js, /replaceChildren/u)
  })
})

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(overrides = {}) {
  const windows = [], actions = [], logs = []
  const ipcMain = new EventEmitter(), handlers = new Map()
  ipcMain.handle = (channel, handler) => { handlers.set(channel, handler) }
  ipcMain.removeHandler = channel => { handlers.delete(channel) }
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  const parent = { isDestroyed: () => false }
  const htmlPath = join(import.meta.dirname, '..', 'assets', 'settings.html')
  const url = pathToFileURL(htmlPath).href
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.destroyed = false
      this.showCalls = 0; this.focusCalls = 0; this.hideCalls = 0; this.restoreCalls = 0
      this.backgrounds = []
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, {
        mainFrame: { url }, messages: [], isDestroyed: () => false,
        send: (...args) => { this.webContents.messages.push(args) },
        setWindowOpenHandler: handler => { this.webContents.openHandler = handler },
      })
      const session = {}
      session.setPermissionCheckHandler = handler => { session.permissionCheck = handler }
      session.setPermissionRequestHandler = handler => { session.permissionRequest = handler }
      this.webContents.session = session
      windows.push(this)
    }
    setMenu(value) { this.menu = value }
    loadFile() { return overrides.failLoad ? Promise.reject(new Error('private-load-error')) : Promise.resolve() }
    show() { this.showCalls += 1 }
    focus() { this.focusCalls += 1 }
    hide() { this.hideCalls += 1 }
    restore() { this.restoreCalls += 1; this.minimized = false }
    isMinimized() { return this.minimized }
    setBackgroundColor(value) { this.backgrounds.push(value) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const controller = createSettingsWindow({
    BrowserWindow, ipcMain, nativeTheme, getParent: () => parent, htmlPath,
    preloadPath: join(import.meta.dirname, '..', 'src', 'settings-preload.cjs'),
    iconPath: join(import.meta.dirname, '..', 'assets', 'icon.png'), productName: 'Test Desktop',
    onAction: overrides.onAction ?? (request => { actions.push(request) }), log: value => { logs.push(value) },
  })
  return {
    windows, actions, logs, ipcMain, handlers, nativeTheme, parent, controller, url,
    trustedEvent: () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }),
    invoke: (...args) => handlers.get(SETTINGS_IPC.action)(...args),
  }
}
