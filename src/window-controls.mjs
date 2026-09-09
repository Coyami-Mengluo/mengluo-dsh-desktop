import { pathToFileURL } from 'node:url'

export const WINDOW_CONTROL_IPC = Object.freeze({
  state: 'mengluo:window-controls:state',
  ready: 'mengluo:window-controls:ready',
  action: 'mengluo:window-controls:action',
})

/**
 * Restrict caption actions to the owning packaged shell's main frame.
 * @param {object} options Electron window, ipcMain, and the local titlebar HTML path.
 * @returns {{ dispose: () => void }} idempotent listener cleanup; close uses the existing tray policy.
 */
export function createWindowControls({ window, ipcMain, htmlPath }) {
  const shellUrl = pathToFileURL(htmlPath).href
  let disposed = false
  const alive = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed()
  const trusted = event => alive() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === shellUrl
  const publish = () => {
    if (alive()) window.webContents.send(WINDOW_CONTROL_IPC.state, { maximized: window.isMaximized() })
  }
  const ready = event => { if (trusted(event)) publish() }
  const action = (event, ...requests) => {
    if (!trusted(event) || requests.length !== 1) return
    switch (requests[0]) {
      case 'minimize': window.minimize(); break
      case 'toggle-maximize':
        if (window.isFullScreen()) return
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        break
      case 'close': window.close(); break
      default: return
    }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    ipcMain.removeListener(WINDOW_CONTROL_IPC.ready, ready)
    ipcMain.removeListener(WINDOW_CONTROL_IPC.action, action)
    window.removeListener('maximize', publish)
    window.removeListener('unmaximize', publish)
    window.removeListener('closed', dispose)
  }
  ipcMain.on(WINDOW_CONTROL_IPC.ready, ready)
  ipcMain.on(WINDOW_CONTROL_IPC.action, action)
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.on('closed', dispose)
  return Object.freeze({ dispose })
}
