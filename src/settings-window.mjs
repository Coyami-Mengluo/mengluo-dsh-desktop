import { pathToFileURL } from 'node:url'
import { normalizePluginSearchQuery } from './plugin-catalog.mjs'

export const SETTINGS_IPC = Object.freeze({
  state: 'mengluo:settings:state',
  ready: 'mengluo:settings:ready',
  action: 'mengluo:settings:action',
})

const SECTIONS = new Set(['harness', 'plugins', 'network', 'client', 'about'])
const SIMPLE_ACTIONS = new Set([
  'harness-check', 'harness-setup', 'harness-download', 'harness-restart', 'harness-progress',
  'terminal', 'client-check', 'client-download', 'client-install', 'client-progress',
  'open-log', 'open-repository', 'open-official', 'open-client-releases', 'test-connection',
  'plugins-refresh', 'plugins-check',
])
const PLUGIN_ACTIONS = new Set(['plugin-install', 'plugin-update', 'plugin-remove', 'plugin-source'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const hasOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key))

/** A renderer can request fixed operations, never arbitrary paths, URLs or commands. */
export function validateSettingsAction(request) {
  if (!isRecord(request) || !Object.hasOwn(request, 'type') || typeof request.type !== 'string') return false
  if (SIMPLE_ACTIONS.has(request.type)) return Object.keys(request).length === 1
  if (['plugins-search', 'plugins-more'].includes(request.type)) {
    if (Object.keys(request).length !== 2 || !hasOnly(request, ['type', 'query'])) return false
    try { return normalizePluginSearchQuery(request.query) === request.query } catch { return false }
  }
  if (PLUGIN_ACTIONS.has(request.type)) {
    return Object.keys(request).length === 2 && hasOnly(request, ['type', 'id'])
      && typeof request.id === 'string' && /^[A-Za-z0-9@][A-Za-z0-9@/_.:-]{0,239}$/u.test(request.id)
      && !request.id.includes('://')
  }
  if (request.type === 'download-source') {
    return Object.keys(request).length === 2 && hasOnly(request, ['type', 'source'])
      && ['official', 'npmmirror'].includes(request.source)
  }
  if (!['harness-preferences', 'client-preferences'].includes(request.type)
    || Object.keys(request).length !== 2 || !hasOnly(request, ['type', 'patch'])
    || !isRecord(request.patch) || Object.keys(request.patch).length === 0) return false
  const patch = request.patch
  const allowed = request.type === 'harness-preferences' ? ['autoCheck', 'interval', 'channel'] : ['autoCheck']
  return hasOnly(patch, allowed)
    && (!Object.hasOwn(patch, 'autoCheck') || typeof patch.autoCheck === 'boolean')
    && (!Object.hasOwn(patch, 'interval') || ['6h', '24h', '7d'].includes(patch.interval))
    && (!Object.hasOwn(patch, 'channel') || ['auto', 'latest', 'next'].includes(patch.channel))
}

const failure = () => ({ ok: false, message: '操作未完成，请重试或查看日志。' })
const pluginRequestActions = new Set(['plugins-search', 'plugins-more', 'plugins-refresh', 'plugins-check', 'plugin-install', 'plugin-update'])
const safeDeadline = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : 0
const cooldownFailure = (request, result) => pluginRequestActions.has(request.type)
  && (result?.rateLimited === true || result?.code === 'PLUGIN_RATE_LIMIT') && safeDeadline(result.retryAt)
  ? { ok: false, rateLimited: true, retryAt: result.retryAt, message: '插件请求冷却中，请等待倒计时结束后重试。' } : undefined
const safeCatalogMessages = new Set([
  '搜索请求已暂停，已有结果已保留。请等待倒计时结束后重试。',
  '下一页暂时无法获取，已有结果已保留。请稍后点击“加载更多”重试，或检查系统代理。',
  '搜索暂时未完成，已有结果已保留。请检查系统代理或稍后重试，不能据此判断没有匹配插件。',
])

/** Own a reusable, isolated local settings window. Closing it never quits Harness. */
export function createSettingsWindow(options) {
  let window
  let disposed = false
  let latest = {}
  let section = 'harness'
  let sectionRevision = 0
  const trustedUrl = pathToFileURL(options.htmlPath).href
  const background = () => options.nativeTheme.shouldUseDarkColors ? '#15171c' : '#f7f8fa'
  const isTrusted = event => !disposed && window && !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame?.url === trustedUrl
  const send = () => {
    if (!disposed && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      // Errors can contain launch tokens or user paths. Only generic failure text goes to this surface.
      const state = { ...latest }
      for (const key of ['harness', 'client', 'plugins']) {
        if (state[key]) state[key] = { ...state[key], error: state[key].error ? '操作未完成，请查看日志。' : undefined }
      }
      if (state.plugins) {
        state.plugins.catalogError = safeCatalogMessages.has(state.plugins.catalogError) ? state.plugins.catalogError
          : state.plugins.catalogError ? '目录搜索未完成，请检查系统代理或稍后重试。已有结果不会被清除。' : undefined
        if (state.plugins.rateLimits) state.plugins.rateLimits = {
          ...Object.fromEntries(['searchUntil', 'metadataUntil', 'refreshUntil', 'checkUntil']
            .map(key => [key, safeDeadline(state.plugins.rateLimits[key])])),
        }
      }
      window.webContents.send(SETTINGS_IPC.state, {
        ...state, theme: options.nativeTheme.shouldUseDarkColors ? 'dark' : 'light', section, sectionRevision,
      })
    }
  }
  const ready = event => { if (isTrusted(event)) send() }
  const action = async (event, ...args) => {
    if (!isTrusted(event) || args.length !== 1 || !validateSettingsAction(args[0])) return failure()
    const request = { ...args[0], ...(args[0].patch ? { patch: { ...args[0].patch } } : {}) }
    try {
      const result = await options.onAction(request)
      return result === false || result?.ok === false ? cooldownFailure(request, result) ?? failure() : { ok: true }
    } catch (error) {
      const cooldown = cooldownFailure(request, error)
      if (cooldown) return cooldown
      options.log?.('client settings action failed; see operation log for details\n')
      return failure()
    }
  }
  const theme = () => {
    if (window && !window.isDestroyed()) window.setBackgroundColor(background())
    send()
  }
  options.ipcMain.on(SETTINGS_IPC.ready, ready)
  options.ipcMain.handle(SETTINGS_IPC.action, action)
  options.nativeTheme.on('updated', theme)

  return Object.freeze({
    get window() { return window && !window.isDestroyed() ? window : undefined },
    update(state) { if (!disposed) { latest = { ...state }; send() } },
    show(targetSection = 'harness') {
      if (disposed) return
      section = SECTIONS.has(targetSection) ? targetSection : 'harness'
      sectionRevision += 1
      if (window && !window.isDestroyed()) {
        send()
        if (window.isMinimized?.()) window.restore()
        window.show()
        window.focus()
        return
      }
      const parent = options.getParent?.()
      const candidate = new options.BrowserWindow({
        title: `${options.productName ?? 'MengLuo DSH Desktop'} · 客户端设置`,
        width: 820, height: 660, minWidth: 680, minHeight: 520,
        show: false, modal: false, backgroundColor: background(),
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        icon: options.iconPath, autoHideMenuBar: true, fullscreenable: false,
        webPreferences: {
          preload: options.preloadPath, partition: 'client-settings',
          nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false,
        },
      })
      window = candidate
      candidate.setMenu(null)
      candidate.webContents.on('will-navigate', event => { event.preventDefault() })
      candidate.webContents.on('will-frame-navigate', event => { event.preventDefault() })
      candidate.webContents.on('will-redirect', event => { event.preventDefault() })
      candidate.webContents.on('will-attach-webview', event => { event.preventDefault() })
      candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      candidate.webContents.session.setPermissionCheckHandler(() => false)
      candidate.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
      candidate.on('close', event => { if (!disposed) { event.preventDefault(); candidate.hide() } })
      candidate.on('closed', () => { if (window === candidate) window = undefined })
      void candidate.loadFile(options.htmlPath).then(() => {
        if (!disposed && window === candidate && !candidate.isDestroyed()) {
          send()
          candidate.show()
          candidate.focus()
        }
      }).catch(() => {
        options.log?.('client settings window could not load\n')
        if (window === candidate) window = undefined
        if (!candidate.isDestroyed()) candidate.destroy()
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      options.ipcMain.removeListener(SETTINGS_IPC.ready, ready)
      options.ipcMain.removeHandler(SETTINGS_IPC.action)
      options.nativeTheme.removeListener('updated', theme)
      if (window && !window.isDestroyed()) window.destroy()
      window = undefined
    },
  })
}
