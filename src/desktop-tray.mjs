/**
 * Keep a native tray available for the lifetime of the desktop application.
 * @param {object} options Electron constructors, main window, and lifecycle callbacks.
 * @returns {object} tray controller with window restoration, menu updates, and disposal.
 */
export function createDesktopTray(options) {
  const tray = new options.Tray(options.iconPath)
  const window = options.window
  let disposed = false
  const removals = []

  const listen = (emitter, event, handler) => {
    emitter.on(event, handler)
    removals.push(() => { emitter.removeListener(event, handler) })
  }
  const logFailure = (label, error) => {
    try {
      options.log?.(`${label}: ${String(error)}\n`)
    } catch {
      // Diagnostics must not interfere with restoring or closing the window.
    }
  }
  const showWindow = () => {
    if (disposed || options.isQuitting() || window.isDestroyed()) return false
    try {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      options.focusOfficial()
      return true
    } catch (error) {
      logFailure('tray window restoration failed', error)
      return false
    }
  }
  const setHarnessMenu = template => {
    if (disposed || tray.isDestroyed()) return
    const menu = options.Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      ...template,
    ])
    tray.setContextMenu(menu)
  }

  try {
    tray.setToolTip(options.productName)
    setHarnessMenu([{ label: '退出', role: 'quit' }])
    listen(tray, 'click', showWindow)
    listen(tray, 'double-click', showWindow)
    listen(window, 'close', event => {
      if (disposed || options.isQuitting() || tray.isDestroyed()) return
      try {
        window.hide()
        event.preventDefault()
      } catch (error) {
        // A failed tray hide must leave the ordinary close/quit path available.
        logFailure('hide to tray failed', error)
      }
    })
    listen(window, 'session-end', () => { options.requestQuit() })
  } catch (error) {
    for (const remove of removals.splice(0)) remove()
    tray.destroy()
    throw error
  }

  return Object.freeze({
    showWindow,
    setHarnessMenu,
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of removals.splice(0)) remove()
      if (tray.isDestroyed()) return
      try {
        tray.closeContextMenu()
      } catch (error) {
        logFailure('tray menu cleanup failed', error)
      }
      tray.destroy()
    },
  })
}
