import { classifyNavigation } from './runtime.mjs'
import { createTitlebarState } from './titlebar-sampler.mjs'
import { createWindowControls } from './window-controls.mjs'

export const TITLEBAR_HEIGHT = 44
export const TITLEBAR_CAPTURE_INTERVAL_MS = 600
export const TITLEBAR_BACKGROUND_CAPTURE_INTERVAL_MS = 2_500
const TITLEBAR_INPUT_CAPTURE_DELAY_MS = 80
const TITLEBAR_CAPTURE_MIN_GAP_MS = 200
// The parent clips this extra DIP after Chromium converts child bounds at fractional display scales.
const BOTTOM_CLIP_OVERSCAN = 1

/**
 * Calculate the official renderer's bounds below the native titlebar overlay.
 * @param {{ width: number; height: number }} contentSize BrowserWindow content size.
 * @param {boolean} fullscreen whether Chromium content should cover the title bar.
 * @returns {{ x: number; y: number; width: number; height: number }} child view bounds.
 */
export function officialViewBounds(contentSize, fullscreen) {
  const width = Math.max(0, Math.trunc(contentSize.width))
  const height = Math.max(0, Math.trunc(contentSize.height))
  const top = fullscreen ? 0 : Math.min(TITLEBAR_HEIGHT, height)
  const visibleHeight = Math.max(0, height - top)
  return {
    x: 0,
    y: top,
    width,
    height: visibleHeight === 0 ? 0 : visibleHeight + BOTTOM_CLIP_OVERSCAN,
  }
}

/**
 * Match the single main-process shortcut that reveals the Harness menu.
 * @param {object | undefined} input Electron before-input-event input.
 * @param {boolean} altGraphActive whether this WebContents has an active AltGraph chord.
 * @returns {boolean} whether this is Ctrl+Alt+U without other modifiers.
 */
export function isHarnessMenuShortcut(input, altGraphActive = false) {
  const isU = (typeof input?.key === 'string' && input.key.toLowerCase() === 'u')
    || input?.code === 'KeyU'
  return !altGraphActive
    && input?.type === 'keyDown'
    && input.key !== 'AltGraph'
    && isU
    && input.control === true
    && input.alt === true
    && input.shift !== true
    && input.meta !== true
    && input.isAutoRepeat !== true
}

/**
 * Build a native edit menu targeted explicitly at the official renderer.
 * @param {object} webContents official renderer WebContents.
 * @param {object} params Electron context-menu parameters.
 * @returns {Array<object>} Electron Menu template.
 */
export function createNativeEditMenuTemplate(webContents, params = {}) {
  const flags = params.editFlags !== null && typeof params.editFlags === 'object'
    ? params.editFlags
    : {}
  const editable = params.isEditable === true
  const hasSelection = typeof params.selectionText === 'string' && params.selectionText.length > 0
  const item = (label, command, flag, fallback) => ({
    label,
    enabled: typeof flags[flag] === 'boolean' ? flags[flag] : fallback,
    click: () => {
      if (webContents.isDestroyed?.() === true || typeof webContents[command] !== 'function') return
      webContents[command]()
    },
  })

  if (editable) {
    return [
      item('撤销', 'undo', 'canUndo', false),
      item('重做', 'redo', 'canRedo', false),
      { type: 'separator' },
      item('剪切', 'cut', 'canCut', false),
      item('复制', 'copy', 'canCopy', hasSelection),
      item('粘贴', 'paste', 'canPaste', true),
      item('删除', 'delete', 'canDelete', false),
      { type: 'separator' },
      item('全选', 'selectAll', 'canSelectAll', true),
    ]
  }
  return [
    item('复制', 'copy', 'canCopy', hasSelection),
    { type: 'separator' },
    item('全选', 'selectAll', 'canSelectAll', true),
  ]
}

/**
 * Create a local titlebar shell and a separately sandboxed official Harness view.
 * @param {object} options injected Electron constructors, paths, policies, and sampler.
 * @returns {object} window controller exposing the official WebContents to trusted main-process services.
 */
export function createDesktopWindow(options) {
  const window = new options.BrowserWindow({
    title: options.productName,
    width: 1_320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0b',
    icon: options.iconPath,
    webPreferences: {
      partition: 'desktop-titlebar',
      preload: options.titlebarPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    },
  })
  const officialView = new options.WebContentsView({
    webPreferences: {
      partition: 'persist:mengluo-ai',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  options.language?.register(window, options.titlebarHtmlPath, true)
  const officialWebContents = officialView.webContents
  window.contentView.addChildView(officialView)
  officialView.setVisible(false)

  let disposed = false
  let officialLoaded = false
  let loadRevision = 0
  let captureTimer
  let captureInFlight = false
  let captureQueued = false
  let lastCaptureAt = -Infinity
  let snapshot = options.fallbackSnapshot(options.nativeTheme.shouldUseDarkColors)
  const removals = []
  const windowControls = createWindowControls({ window, ipcMain: options.ipcMain, htmlPath: options.titlebarHtmlPath })

  const listen = (emitter, event, listener) => {
    emitter.on(event, listener)
    removals.push(() => { emitter.removeListener(event, listener) })
  }
  const logFailure = (label, error) => {
    try {
      options.log?.(`${label}: ${String(error)}\n`)
    } catch {
      // Diagnostics cannot affect the window lifecycle.
    }
  }
  const state = () => createTitlebarState({
    focused: !window.isDestroyed() && window.isFocused(),
    fullscreen: !window.isDestroyed() && window.isFullScreen(),
    snapshot,
  })
  const sendState = () => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.webContents.send(options.titlebarChannels.state, state())
    } catch (error) {
      logFailure('titlebar state delivery failed', error)
    }
  }
  const layout = () => {
    if (disposed || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    officialView.setBounds(officialViewBounds({ width, height }, window.isFullScreen()))
  }
  const scheduleCapture = (delay = 120) => {
    if (disposed || !officialLoaded) return
    if (captureTimer !== undefined) clearTimeout(captureTimer)
    captureTimer = setTimeout(() => {
      captureTimer = undefined
      void refreshSnapshot()
    }, Math.max(delay, TITLEBAR_CAPTURE_MIN_GAP_MS - (Date.now() - lastCaptureAt)))
    captureTimer.unref?.()
  }
  const refreshSnapshot = async () => {
    if (disposed || !officialLoaded || officialWebContents.isDestroyed() || window.isDestroyed()
      || !window.isVisible() || window.isMinimized() || window.isFullScreen()) return
    if (captureInFlight) {
      captureQueued = true
      return
    }
    captureInFlight = true
    lastCaptureAt = Date.now()
    const revision = loadRevision
    try {
      const bounds = officialView.getBounds()
      const captured = await options.captureSnapshot(officialWebContents, {
        darkFallback: options.nativeTheme.shouldUseDarkColors,
        width: bounds.width,
        onError: error => { logFailure('titlebar capture failed', error) },
      })
      if (!disposed && officialLoaded && revision === loadRevision) {
        snapshot = captured
        sendState()
      }
    } catch (error) {
      logFailure('titlebar capture failed', error)
      if (!disposed && revision === loadRevision) {
        snapshot = options.fallbackSnapshot(options.nativeTheme.shouldUseDarkColors)
        sendState()
      }
    } finally {
      captureInFlight = false
      if (captureQueued) {
        captureQueued = false
        scheduleCapture(0)
      }
    }
  }
  const updateWindowState = () => {
    layout()
    sendState()
    scheduleCapture()
  }
  const revealHarnessMenu = () => {
    try {
      options.showHarnessMenuAtTopLeft?.()
    } catch (error) {
      logFailure('Harness menu popup failed', error)
    }
  }
  const installHarnessMenuShortcut = (webContents) => {
    let altGraphActive = false
    const handleInput = (event, input) => {
      if (input?.type === 'keyDown' && input.key === 'AltGraph') {
        altGraphActive = true
        return
      }
      if (input?.type === 'keyUp' && (input.key === 'AltGraph' || input.code === 'AltRight')) {
        altGraphActive = false
        return
      }
      if (!isHarnessMenuShortcut(input, altGraphActive)) return
      event.preventDefault()
      revealHarnessMenu()
    }
    const clearAltGraph = () => { altGraphActive = false }
    listen(webContents, 'before-input-event', handleInput)
    listen(webContents, 'blur', clearAltGraph)
    removals.push(clearAltGraph)
  }

  installShellPolicy(window.webContents)
  installOfficialPolicy(officialWebContents, window, options)
  installHarnessMenuShortcut(window.webContents)
  installHarnessMenuShortcut(officialWebContents)
  listen(window, 'resize', updateWindowState)
  listen(window, 'maximize', updateWindowState)
  listen(window, 'unmaximize', updateWindowState)
  listen(window, 'enter-full-screen', updateWindowState)
  listen(window, 'leave-full-screen', updateWindowState)
  listen(window, 'focus', () => {
    sendState()
    scheduleCapture(0)
  })
  listen(window, 'blur', sendState)
  listen(options.nativeTheme, 'updated', () => {
    if (officialLoaded) scheduleCapture(0)
    else {
      snapshot = options.fallbackSnapshot(options.nativeTheme.shouldUseDarkColors)
      sendState()
    }
  })
  listen(window.webContents, 'render-process-gone', (_event, details) => {
    try {
      options.onShellRenderGone?.(details)
    } catch (error) {
      logFailure('shell renderer failure callback failed', error)
    }
  })
  listen(officialWebContents, 'render-process-gone', (_event, details) => {
    try {
      options.onOfficialRenderGone?.(details)
    } catch (error) {
      logFailure('official renderer failure callback failed', error)
    }
  })
  listen(officialWebContents, 'did-finish-load', () => { scheduleCapture(0) })
  // Observe native input completion without intercepting it or injecting into
  // Harness. Capture only its existing 8px top strip, never mouse-move events.
  listen(officialWebContents, 'before-mouse-event', (_event, input) => {
    if (input?.type === 'mouseUp') scheduleCapture(TITLEBAR_INPUT_CAPTURE_DELAY_MS)
  })
  listen(officialWebContents, 'before-input-event', (_event, input) => {
    if (input?.type === 'keyUp') scheduleCapture(TITLEBAR_INPUT_CAPTURE_DELAY_MS)
  })

  const onTitlebarReady = (event) => {
    if (event.sender === window.webContents) sendState()
  }
  options.ipcMain.on(options.titlebarChannels.ready, onTitlebarReady)

  const captureInterval = setInterval(() => {
    if (disposed || !officialLoaded || window.isDestroyed() || window.isMinimized() || !window.isVisible() || window.isFullScreen()) return
    if (!window.isFocused() && Date.now() - lastCaptureAt < TITLEBAR_BACKGROUND_CAPTURE_INTERVAL_MS) return
    scheduleCapture(0)
  }, TITLEBAR_CAPTURE_INTERVAL_MS)
  captureInterval.unref?.()

  const cleanup = (closeOfficial) => {
    if (disposed) return
    disposed = true
    loadRevision += 1
    clearInterval(captureInterval)
    if (captureTimer !== undefined) clearTimeout(captureTimer)
    captureTimer = undefined
    options.ipcMain.removeListener(options.titlebarChannels.ready, onTitlebarReady)
    windowControls.dispose()
    for (const remove of removals.splice(0)) remove()
    if (closeOfficial && !officialWebContents.isDestroyed()) {
      try {
        officialWebContents.close()
      } catch (error) {
        logFailure('official renderer cleanup failed', error)
      }
      if (!window.isDestroyed()) {
        try {
          window.contentView.removeChildView(officialView)
        } catch (error) {
          logFailure('official view detach failed', error)
        }
      }
    }
  }
  listen(window, 'closed', () => {
    cleanup(true)
    try {
      options.onClosed?.()
    } catch (error) {
      logFailure('desktop window close callback failed', error)
    }
  })

  const focusOfficial = () => {
    if (!disposed && officialLoaded && !officialWebContents.isDestroyed()) officialWebContents.focus()
  }

  layout()
  window.once('ready-to-show', () => {
    if (!disposed && !window.isDestroyed()) window.show()
  })

  return Object.freeze({
    window,
    officialView,
    officialWebContents,
    async loadShell() {
      await window.loadFile(options.titlebarHtmlPath)
      sendState()
    },
    async loadOfficial(url) {
      const revision = ++loadRevision
      officialLoaded = false
      officialView.setVisible(false)
      await officialWebContents.loadURL(url)
      if (disposed || revision !== loadRevision || officialWebContents.isDestroyed()) return
      officialLoaded = true
      layout()
      officialView.setVisible(true)
      focusOfficial()
      scheduleCapture(0)
    },
    showLoading() {
      loadRevision += 1
      officialLoaded = false
      officialView.setVisible(false)
      snapshot = options.fallbackSnapshot(options.nativeTheme.shouldUseDarkColors)
      sendState()
    },
    focusOfficial,
    refreshSnapshot,
    dispose() { cleanup(true) },
  })
}

function installShellPolicy(webContents) {
  webContents.on('will-navigate', (event) => { event.preventDefault() })
  webContents.on('will-redirect', (event) => { event.preventDefault() })
  webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.session.setPermissionCheckHandler(() => false)
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
}

function installOfficialPolicy(webContents, ownerWindow, options) {
  const handleNavigation = (event, url) => {
    if (classifyNavigation(url, options.getBackendOrigin()) !== 'internal') event.preventDefault()
  }
  webContents.on('will-navigate', handleNavigation)
  webContents.on('will-redirect', handleNavigation)
  webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, options.getBackendOrigin()) === 'external') {
      try {
        options.openExternal(url)
      } catch (error) {
        try {
          options.log?.(`external navigation callback failed: ${String(error)}\n`)
        } catch {
          // Diagnostics cannot affect popup denial.
        }
      }
    }
    return { action: 'deny' }
  })
  const allowed = (permission, requestingUrl) => {
    if (permission !== 'clipboard-sanitized-write') return false
    const origin = options.getBackendOrigin()
    if (origin === undefined) return false
    try {
      return new URL(requestingUrl).origin === origin
    } catch {
      return false
    }
  }
  webContents.session.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin),
  )
  webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback, details) => { callback(allowed(permission, details.requestingUrl)) },
  )
  webContents.on('context-menu', (_event, params) => {
    try {
      const menu = options.Menu.buildFromTemplate(createNativeEditMenuTemplate(webContents, params))
      menu.popup({ window: ownerWindow })
    } catch (error) {
      try {
        options.log?.(`native context menu failed: ${String(error)}\n`)
      } catch {
        // Diagnostics cannot affect the renderer.
      }
    }
  })
}
