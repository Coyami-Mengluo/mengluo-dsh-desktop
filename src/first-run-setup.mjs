import { pathToFileURL } from 'node:url'
import { UPDATE_PROGRESS_STAGE_DETAILS, normalizeUpdateFileProgress } from './update-progress-window.mjs'

export const SETUP_IPC = Object.freeze({
  state: 'mengluo:setup:state',
  ready: 'mengluo:setup:ready',
  action: 'mengluo:setup:action',
})

/** Own the local-only first-install screen; only catalog versions can cross into installation. */
export function createFirstRunSetup(options) {
  const { ipcMain, window, updater } = options
  const shellUrl = pathToFileURL(options.htmlPath).href
  let disposed = false
  let catalog = []
  let refreshPromise
  let state = Object.freeze({ visible: false, status: 'idle', releases: [], detail: '', reason: '' })
  const busy = () => state.status === 'installing' || state.status === 'starting'
  const publish = patch => {
    if (disposed) return
    state = Object.freeze({ ...state, ...patch })
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
    if (!state.visible || busy() || refreshPromise !== undefined) return
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
  const handleAction = async (event, request) => {
    if (!trusted(event)) throw new Error('安装请求不是来自客户端设置界面')
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的安装请求')
    if (request.type === 'refresh' && Object.keys(request).length === 1) await refresh()
    else if (request.type === 'install' && Object.keys(request).length === 2 && typeof request.version === 'string') await install(request.version)
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
