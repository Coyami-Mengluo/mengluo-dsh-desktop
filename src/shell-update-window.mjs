import { pathToFileURL } from 'node:url'
import { PRODUCT_NAME } from './release-config.mjs'
import { centerHiddenChild } from './window-placement.mjs'

export const CLIENT_UPDATE_CHANNELS = Object.freeze({
  state: 'mengluo:client-update:state', ready: 'mengluo:client-update:ready', action: 'mengluo:client-update:action',
})

/** Own a local, isolated progress window; only three fixed updater actions cross its preload. */
export function createShellUpdateWindow(options) {
  let window
  let disposed = false
  let latest = { status: 'idle' }
  const trustedUrl = pathToFileURL(options.htmlPath).href
  const isTrusted = event => !disposed && window && !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === trustedUrl
  const send = () => {
    if (!disposed && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(CLIENT_UPDATE_CHANNELS.state, { ...latest, dark: options.nativeTheme.shouldUseDarkColors })
    }
  }
  const ready = event => { if (isTrusted(event)) send() }
  const action = (event, ...args) => {
    if (!isTrusted(event) || args.length !== 1 || !['check', 'download', 'install'].includes(args[0])) return
    options.onAction(args[0])
  }
  const theme = () => {
    if (window && !window.isDestroyed()) window.setBackgroundColor(options.nativeTheme.shouldUseDarkColors ? '#111318' : '#f5f7fb')
    send()
  }
  options.ipcMain.on(CLIENT_UPDATE_CHANNELS.ready, ready)
  options.ipcMain.on(CLIENT_UPDATE_CHANNELS.action, action)
  options.nativeTheme.on('updated', theme)
  return Object.freeze({
    update(state) { if (!disposed) { latest = { ...state }; send() } },
    show() {
      if (disposed) return
      if (window && !window.isDestroyed()) {
        centerHiddenChild(window, options.getParent(), options.screen)
        window.show()
        return
      }
      const parent = options.getParent()
      const candidate = new options.BrowserWindow({
        title: `${PRODUCT_NAME} · 客户端更新`, width: 540, height: 420,
        minWidth: 480, minHeight: 390, show: false, modal: false,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        icon: options.iconPath, autoHideMenuBar: true, maximizable: false, fullscreenable: false,
        backgroundColor: options.nativeTheme.shouldUseDarkColors ? '#111318' : '#f5f7fb',
        webPreferences: {
          preload: options.preloadPath, partition: 'client-update', nodeIntegration: false,
          contextIsolation: true, sandbox: true, webSecurity: true, devTools: false,
        },
      })
      window = candidate
      options.language?.register(candidate, options.htmlPath)
      candidate.setMenu(null)
      candidate.webContents.on('will-navigate', event => { event.preventDefault() })
      candidate.webContents.on('will-attach-webview', event => { event.preventDefault() })
      candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      candidate.webContents.session.setPermissionCheckHandler(() => false)
      candidate.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
      candidate.on('close', event => { if (!disposed) { event.preventDefault(); candidate.hide() } })
      candidate.on('closed', () => { if (window === candidate) window = undefined })
      void candidate.loadFile(options.htmlPath).then(() => {
        if (!disposed && window === candidate && !candidate.isDestroyed()) {
          send()
          centerHiddenChild(candidate, options.getParent(), options.screen)
          candidate.showInactive()
        }
      }).catch(error => { options.log(`client update window failed: ${String(error)}\n`) })
    },
    dispose() {
      if (disposed) return
      disposed = true
      options.ipcMain.removeListener(CLIENT_UPDATE_CHANNELS.ready, ready)
      options.ipcMain.removeListener(CLIENT_UPDATE_CHANNELS.action, action)
      options.nativeTheme.removeListener('updated', theme)
      if (window && !window.isDestroyed()) window.destroy()
      window = undefined
    },
  })
}
