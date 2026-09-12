import { pathToFileURL } from 'node:url'
import { UPDATE_PROGRESS_STAGE_DETAILS, normalizeUpdateFileProgress } from './update-progress-window.mjs'

export const SETUP_IPC = Object.freeze({
  state: 'mengluo:setup:state',
  ready: 'mengluo:setup:ready',
  action: 'mengluo:setup:action',
})

const DOWNLOAD_SOURCE_IDS = new Set(['official', 'npmmirror'])
const DEFAULT_DOWNLOAD_SOURCES = Object.freeze([
  Object.freeze({ id: 'official', label: '官方 npm', description: '直接从 npm 官方发布源下载。' }),
  Object.freeze({ id: 'npmmirror', label: 'npmmirror（第三方国内镜像）', description: '可能改善国内 npm 下载速度，版本同步可能有延迟。' }),
])

/** Own the local-only first-install screen; only catalog versions can cross into installation. */
export function createFirstRunSetup(options) {
  const { ipcMain, window, updater } = options
  const shellUrl = pathToFileURL(options.htmlPath).href
  let disposed = false
  let catalog = []
  let refreshPromise
  let sourceChanging = false
  let connectionTesting = false
  const readDownloadSettings = () => {
    const value = options.downloadSettings?.getState?.() ?? {}
    return {
      downloadSource: DOWNLOAD_SOURCE_IDS.has(value.source) ? value.source : 'official',
      downloadSources: DEFAULT_DOWNLOAD_SOURCES.map(fallback => {
        const source = value.sources?.find(item => item.id === fallback.id)
        return Object.freeze({
          id: fallback.id,
          label: typeof source?.label === 'string' ? source.label : fallback.label,
          description: typeof source?.description === 'string' ? source.description : fallback.description,
        })
      }),
      downloadBusy: value.busy === true || sourceChanging,
      downloadActivity: typeof value.activity === 'string' ? value.activity.slice(0, 512) : '',
      downloadConfigurable: typeof options.downloadSettings?.setSource === 'function',
      connectionTestAvailable: typeof options.downloadSettings?.testConnection === 'function',
      connectionTesting,
    }
  }
  let state = Object.freeze({ visible: false, status: 'idle', releases: [], detail: '', reason: '', ...readDownloadSettings() })
  const busy = () => state.status === 'installing' || state.status === 'starting'
  const publish = patch => {
    if (disposed) return
    state = Object.freeze({ ...state, ...readDownloadSettings(), ...patch })
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(SETUP_IPC.state, state)
    }
  }
  const trusted = event => !disposed
    && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === shellUrl

  const refresh = () => {
    if (disposed || !state.visible || busy()) return Promise.resolve()
    if (refreshPromise !== undefined) return refreshPromise
    publish({ status: 'loading', detail: '正在获取官方版本列表…' })
    refreshPromise = (async () => {
      try {
        const releases = await updater.fetchAvailableVersions()
        if (disposed) return
        catalog = releases
        publish({
          status: 'ready',
          releases: releases.map(({ version, recommended, preview }) => ({ version, recommended, preview })),
          detail: '请选择版本，确认后才会下载。安装会包含该版本配套的官方依赖。',
        })
      } catch (error) {
        publish({ status: 'error', detail: `获取版本失败：${error.message ?? String(error)}。请检查网络或系统代理后重试。` })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  const install = async version => {
    if (!state.visible || busy() || refreshPromise !== undefined || sourceChanging || connectionTesting) return
    if (readDownloadSettings().downloadBusy) throw new Error('下载任务正在进行，请稍后安装')
    const release = catalog.find(candidate => candidate.version === version)
    if (release === undefined) throw new Error('请选择列表中的官方 Harness 版本')
    publish({ status: 'installing', version, reason: '', startedAt: Date.now(), files: undefined, percent: undefined, detail: '正在准备安装…' })
    try {
      const runtime = await updater.installInitialRelease(release)
      if (disposed || runtime === undefined) return
      publish({ status: 'starting', detail: '安装和测试已完成，正在启动所选版本…', percent: undefined, files: undefined })
      await options.onInstalled(runtime)
    } catch (error) {
      publish({ status: 'error', detail: `安装失败：${error.message ?? String(error)}\n可以重试或选择其他版本。已有配置、插件和会话不会被删除。` })
    }
  }
  const handleReady = event => {
    if (trusted(event)) publish({})
  }
  const assertDownloadIdle = () => {
    if (!state.visible) throw new Error('请先打开首次安装界面')
    if (busy() || sourceChanging || connectionTesting || readDownloadSettings().downloadBusy) {
      throw new Error('安装或下载任务正在进行，暂时不能切换或检测下载源')
    }
  }
  const setDownloadSource = async source => {
    if (!DOWNLOAD_SOURCE_IDS.has(source)) throw new Error('不支持的 Harness 下载源')
    assertDownloadIdle()
    if (typeof options.downloadSettings?.setSource !== 'function') throw new Error('当前无法修改下载源')
    sourceChanging = true
    publish({ connectionResult: undefined })
    try {
      await options.downloadSettings.setSource(source)
    } finally {
      sourceChanging = false
      publish({})
    }
  }
  const testConnection = async version => {
    assertDownloadIdle()
    if (version !== undefined && !catalog.some(release => release.version === version)) throw new Error('请选择版本列表中的目标版本后再检测')
    if (typeof options.downloadSettings?.testConnection !== 'function') throw new Error('当前无法检测下载源连接')
    connectionTesting = true
    publish({ connectionResult: undefined })
    try {
      const result = await options.downloadSettings.testConnection(version)
      publish({ connectionResult: { ok: result?.ok === true, message: String(result?.message ?? '连接检测已完成') } })
    } catch (error) {
      publish({ connectionResult: { ok: false, message: `连接检测失败：${error.message ?? String(error)}` } })
    } finally {
      connectionTesting = false
      publish({})
    }
  }
  const handleAction = async (event, request) => {
    if (!trusted(event)) throw new Error('安装请求不是来自客户端设置界面')
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的安装请求')
    if (request.type === 'refresh' && Object.keys(request).length === 1) await refresh()
    else if (request.type === 'install' && Object.keys(request).length === 2 && typeof request.version === 'string') await install(request.version)
    else if (request.type === 'download-source' && Object.keys(request).length === 2 && typeof request.source === 'string') await setDownloadSource(request.source)
    else if (request.type === 'test-connection' && Object.keys(request).length === 1) await testConnection()
    else if (request.type === 'test-connection' && Object.keys(request).length === 2 && typeof request.version === 'string') await testConnection(request.version)
    else throw new Error('不支持的安装操作')
  }
  ipcMain.on(SETUP_IPC.ready, handleReady)
  ipcMain.handle(SETUP_IPC.action, handleAction)

  return Object.freeze({
    async show(reason = '') {
      if (disposed || busy()) return
      options.showLoading()
      publish({ visible: true, reason, files: undefined, percent: undefined })
      await refresh()
    },
    recover(reason) {
      if (disposed) return
      publish({ status: 'error', visible: true, reason, detail: '没有可用的已安装版本，请重新选择并安装。', percent: undefined, files: undefined })
      return this.show(reason)
    },
    complete() {
      publish({ visible: false, status: 'idle' })
    },
    refreshDownloadSettings() {
      const next = readDownloadSettings()
      publish(next.downloadSource !== state.downloadSource ? { connectionResult: undefined } : {})
    },
    progress(method, ...args) {
      if (disposed || state.status !== 'installing') return
      if (method === 'stage') {
        const [stage, , activity] = args
        const files = normalizeUpdateFileProgress(activity)
        const percent = stage === 'verifying' && files?.totalFiles > 0
          ? Math.floor(files.completedFiles / files.totalFiles * 100) : undefined
        publish({ detail: UPDATE_PROGRESS_STAGE_DETAILS[stage].label, files, percent })
      } else if (method === 'complete') {
        publish({ detail: '安装与启动测试完成', percent: 100, files: undefined })
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      ipcMain.removeListener(SETUP_IPC.ready, handleReady)
      ipcMain.removeHandler(SETUP_IPC.action)
    },
    get state() { return state },
  })
}
