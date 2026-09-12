const STATE_CHANNEL = 'mengluo:update-progress:state'
const READY_CHANNEL = 'mengluo:update-progress:ready'

export const UPDATE_PROGRESS_STAGE_DETAILS = Object.freeze({
  checking: Object.freeze({ label: '检查更新信息' }),
  preparing: Object.freeze({ label: '准备安全安装目录' }),
  installing: Object.freeze({ label: '通过 npm 下载并安装' }),
  verifying: Object.freeze({ label: '校验版本与依赖完整性' }),
  smoke: Object.freeze({ label: '启动新版 Harness 测试' }),
  finalizing: Object.freeze({ label: '完成安全切换准备' }),
  complete: Object.freeze({ label: '更新准备完成', percent: 100 }),
})

/** Maximum wall time allowed for one official npm runtime installation. */
export const UPDATE_INSTALL_TIMEOUT_MS = 30 * 60 * 1_000

const UPDATE_ESTIMATE_MIN_MS = 10 * 60 * 1_000
const UPDATE_ESTIMATE_MAX_MS = 20 * 60 * 1_000

const RUNNING_STAGES = new Set(['checking', 'preparing', 'installing', 'verifying', 'smoke', 'finalizing'])

export function isUpdateProgressStage(value) {
  return typeof value === 'string' && RUNNING_STAGES.has(value)
}

/** Validate optional physical-file counters sent across the worker boundary. */
export function normalizeUpdateFileProgress(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('update file progress must be an object')
  }
  const counters = ['completedFiles', 'registryRequests', 'resolvedDependencies']
  for (const name of counters) {
    if (value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 0)) {
      throw new Error(`${name} must be a non-negative safe integer`)
    }
  }
  const completedFiles = value.completedFiles
  const totalFiles = value.totalFiles
  if (totalFiles !== undefined && (completedFiles === undefined
    || !Number.isSafeInteger(totalFiles)
    || totalFiles < completedFiles || totalFiles < 0)) {
    throw new Error('total update file count must be a safe integer no smaller than completed files')
  }
  if (counters.every(name => value[name] === undefined) && totalFiles === undefined) {
    throw new Error('update progress activity must contain at least one counter')
  }
  return Object.freeze({
    ...(completedFiles === undefined ? {} : { completedFiles }),
    ...(totalFiles === undefined ? {} : { totalFiles }),
    ...(value.registryRequests === undefined ? {} : { registryRequests: value.registryRequests }),
    ...(value.resolvedDependencies === undefined ? {} : { resolvedDependencies: value.resolvedDependencies }),
  })
}

/** Own the isolated, non-modal update progress surface in Electron main. */
export function createUpdateProgressWindow(options) {
  const {
    BrowserWindow,
    ipcMain,
    nativeTheme,
    getParent,
    preloadPath,
    htmlPath,
    log = () => {},
    now = Date.now,
  } = options
  let window
  let windowReady = false
  let disposed = false
  let operationStartedAt
  let latestState = progressState('checking', 'running', undefined, nativeTheme.shouldUseDarkColors)

  const sendState = () => {
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(STATE_CHANNEL, latestState)
  }
  const applyTheme = () => {
    latestState = Object.freeze({ ...latestState, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' })
    if (window !== undefined && !window.isDestroyed()) {
      window.setBackgroundColor(latestState.theme === 'dark' ? '#111318' : '#f5f7fb')
      sendState()
    }
  }
  const handleReady = event => {
    if (window !== undefined && !window.isDestroyed() && event.sender === window.webContents) sendState()
  }
  const handleThemeUpdated = () => { applyTheme() }

  ipcMain.on(READY_CHANNEL, handleReady)
  nativeTheme.on('updated', handleThemeUpdated)

  const createWindow = () => {
    if (disposed) return undefined
    if (window !== undefined && !window.isDestroyed()) return window
    const parent = getParent()
    const candidate = new BrowserWindow({
      title: 'MengLuo DSH Desktop · Harness 更新',
      width: 520,
      height: 390,
      minWidth: 480,
      minHeight: 350,
      show: false,
      modal: false,
      parent: parent !== undefined && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: latestState.theme === 'dark' ? '#111318' : '#f5f7fb',
      webPreferences: {
        preload: preloadPath,
        partition: 'update-progress',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
      },
    })
    window = candidate
    options.language?.register(candidate, htmlPath)
    windowReady = false
    candidate.setMenu(null)
    candidate.webContents.on('will-navigate', event => { event.preventDefault() })
    candidate.webContents.on('will-attach-webview', event => { event.preventDefault() })
    candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    candidate.webContents.session.setPermissionCheckHandler(() => false)
    candidate.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    candidate.on('close', event => {
      if (disposed) return
      event.preventDefault()
      candidate.hide()
    })
    candidate.on('closed', () => {
      if (window === candidate) {
        window = undefined
        windowReady = false
      }
    })
    candidate.once('ready-to-show', () => {
      if (!disposed && !candidate.isDestroyed()) {
        windowReady = true
        candidate.showInactive()
      }
    })
    void candidate.loadFile(htmlPath).catch(error => {
      log(`update progress window failed to load: ${String(error)}\n`)
    })
    return candidate
  }

  const publish = (stage, status, version, detail) => {
    latestState = progressState(
      stage,
      status,
      version,
      nativeTheme.shouldUseDarkColors,
      detail,
      operationStartedAt,
    )
    createWindow()
    sendState()
  }
  const reveal = () => {
    const candidate = createWindow()
    if (candidate !== undefined && !candidate.isDestroyed() && windowReady) {
      sendState()
      candidate.showInactive()
    }
  }

  return Object.freeze({
    begin(version) {
      if (disposed) return
      operationStartedAt = now()
      publish('checking', 'running', version)
    },
    stage(stage, version, files) {
      if (disposed) return
      if (!isUpdateProgressStage(stage)) throw new Error(`unsupported update progress stage: ${String(stage)}`)
      latestState = progressState(
        stage,
        'running',
        version,
        nativeTheme.shouldUseDarkColors,
        undefined,
        operationStartedAt,
        files,
      )
      createWindow()
      sendState()
    },
    complete(version) {
      if (disposed) return
      publish('complete', 'complete', version)
      reveal()
    },
    fail(version) {
      if (disposed) return
      publish('complete', 'failed', version, '更新准备失败，当前 Harness 版本未受影响。')
      reveal()
    },
    show() {
      if (disposed) return
      reveal()
    },
    dispose() {
      if (disposed) return
      disposed = true
      ipcMain.removeListener(READY_CHANNEL, handleReady)
      nativeTheme.removeListener('updated', handleThemeUpdated)
      if (window !== undefined && !window.isDestroyed()) window.destroy()
      window = undefined
    },
    get state() { return latestState },
  })
}

function progressState(stage, status, version, dark, detail, startedAt, filesValue) {
  const description = UPDATE_PROGRESS_STAGE_DETAILS[stage]
  if (description === undefined) throw new Error(`unsupported update progress stage: ${String(stage)}`)
  const files = normalizeUpdateFileProgress(filesValue)
  const percent = progressPercent(stage, status, description.percent, files)
  return Object.freeze({
    status,
    stage,
    label: status === 'failed' ? '更新准备失败' : description.label,
    detail: detail ?? progressDetail(stage, status, files),
    percent,
    files,
    version: typeof version === 'string' ? version : '',
    theme: dark ? 'dark' : 'light',
    timing: Object.freeze({
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      estimateMinMs: UPDATE_ESTIMATE_MIN_MS,
      estimateMaxMs: UPDATE_ESTIMATE_MAX_MS,
      timeoutMs: UPDATE_INSTALL_TIMEOUT_MS,
    }),
  })
}

function progressPercent(stage, status, fixedPercent, files) {
  if (status === 'failed') return undefined
  if (Number.isFinite(fixedPercent)) return fixedPercent
  if (stage !== 'verifying' || files?.totalFiles === undefined || files.totalFiles === 0) return undefined
  return Math.min(100, Math.floor((files.completedFiles / files.totalFiles) * 100))
}

function progressDetail(stage, status, files) {
  if (status === 'complete') return '新版已经通过完整性校验和启动测试，可以安全重启应用。'
  if (stage === 'installing' && files !== undefined) {
    const activity = []
    if (files.resolvedDependencies > 0) activity.push(`已解析 ${String(files.resolvedDependencies)} 个依赖`)
    if (files.registryRequests > 0) activity.push(`已完成 ${String(files.registryRequests)} 次 registry 获取`)
    if (files.completedFiles !== undefined) activity.push(`候选目录已落盘 ${String(files.completedFiles)} 个文件`)
    return `npm 正在解析依赖、下载并写入文件；${activity.join('，')}。依赖树完成前无法确定最终总数。`
  }
  if (stage === 'verifying' && files?.totalFiles !== undefined) {
    return `正在逐个校验候选 runtime 文件：${String(files.completedFiles)} / ${String(files.totalFiles)}。`
  }
  return '可以继续使用当前窗口，关闭此窗口不会取消更新。'
}

export const UPDATE_PROGRESS_IPC = Object.freeze({ state: STATE_CHANNEL, ready: READY_CHANNEL })
