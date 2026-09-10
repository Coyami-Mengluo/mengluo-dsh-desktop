import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  isUpdateCheckDue,
  listDshReleases,
  NPM_REGISTRY_ORIGIN,
  resolveUpdateChannel,
  selectDshUpdate,
  shouldNotifyUpdate,
  UPDATE_INTERVAL_MS,
} from './update-policy.mjs'
import {
  markRuntimePending,
  markRuntimeReady,
  readManagedRuntime,
  readRuntimeState,
  writeRuntimeState,
} from './runtime-store.mjs'
import { createBackendEnvironment, resolveWindowsTaskkillPath } from './runtime.mjs'
import { createHarnessTerminalLaunch } from './runtime-terminal.mjs'
import { isUpdateProgressStage, normalizeUpdateFileProgress } from './update-progress-window.mjs'
import { PRODUCT_NAME } from './release-config.mjs'
import { resolveDownloadSource } from './download-source.mjs'

const PACKUMENT_URL = `${NPM_REGISTRY_ORIGIN}/@deepseek-ai%2Fdsh`
const CHECK_TIMEOUT_MS = 15_000
const MAX_PACKUMENT_BYTES = 5 * 1_024 * 1_024
const FIRST_AUTOMATIC_CHECK_DELAY_MS = 30_000
const UPDATE_WORKER_CANCEL_GRACE_MS = 1_500
const UPDATE_WORKER_KILL_TIMEOUT_MS = 3_000
const PROXY_RESOLUTION_TIMEOUT_MS = 5_000
const OFFICIAL_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness'
const HARNESS_MENU_POPUP_Y = 44

/** Electron-main-only update coordinator; the official renderer stays untouched. */
export class HarnessUpdateManager {
  constructor(options) {
    this.electron = options.electron
    this.userData = options.userData
    this.runnerPath = options.runnerPath
    this.workerPath = options.workerPath
    this.npmCliPath = options.npmCliPath
    this.getWindow = options.getWindow
    this.showWindow = options.showWindow
    this.onHarnessMenuChanged = options.onHarnessMenuChanged
    this.getClientMenuItems = options.getClientMenuItems ?? (() => [])
    this.onSettingsRequested = options.onSettingsRequested ?? (() => {})
    this.onSettingsChanged = options.onSettingsChanged
    this.isPluginBusy = options.isPluginBusy ?? (() => false)
    this.onProgressRequested = options.onProgressRequested ?? (() => { this.reportProgress('show') })
    this.hasClientProgress = options.hasClientProgress ?? (() => false)
    this.getDownloadSource = options.getDownloadSource ?? (() => 'official')
    this.onDownloadStatus = options.onDownloadStatus
    this.getLogPath = options.getLogPath
    this.log = options.log
    this.requestRestart = options.requestRestart
    this.openExternal = options.openExternal
    this.progressWindow = options.progressWindow
    this.currentRuntime = options.currentRuntime
    this.installerNode = options.installerNode
    this.onSetupRequested = options.onSetupRequested
    this.onSetupProgress = options.onSetupProgress
    this.workspacePath = options.workspacePath
    this.terminalBinPath = options.terminalBinPath
    this.spawnTerminal = options.spawnTerminal ?? spawn
    this.terminalEnvironment = options.terminalEnvironment ?? process.env
    this.runUpdate = options.runUpdate ?? runUpdateWorker
    this.state = readRuntimeState(this.userData)
    this.availableRelease = undefined
    this.checkPromise = undefined
    this.installPromise = undefined
    this.preparingVersion = undefined
    this.checkTimer = undefined
    this.checkAbort = undefined
    this.installAbort = undefined
    this.notification = undefined
    this.harnessPopupMenu = undefined
    this.activeHarnessPopupMenu = undefined
    this.disposed = false
    this.progressAvailable = false
    this.settingsError = undefined
  }

  /** Install the native menu and arm the first non-blocking check. */
  start() {
    this.rebuildMenu()
    this.scheduleAutomaticCheck(true)
  }

  /** Stop network/timer work without delaying application shutdown. */
  async dispose() {
    this.disposed = true
    if (this.checkTimer !== undefined) clearTimeout(this.checkTimer)
    this.checkTimer = undefined
    this.checkAbort?.abort()
    this.installAbort?.abort()
    this.notification?.close?.()
    const activePopup = this.activeHarnessPopupMenu
    this.activeHarnessPopupMenu = undefined
    this.harnessPopupMenu = undefined
    if (activePopup !== undefined) {
      try {
        const window = this.getWindow()
        activePopup.closePopup?.(window !== undefined && !window.isDestroyed() ? window : undefined)
      } catch (error) {
        this.log(`Harness popup menu cleanup failed: ${String(error)}\n`)
      }
    }
    const pendingInstall = this.installPromise
    if (pendingInstall !== undefined) {
      try {
        await pendingInstall
      } catch {
        // Installation errors are already contained and logged by installRelease.
      }
    }
    this.reportProgress('dispose')
  }

  /** Commit a pending managed slot only after the real user-data boot is ready. */
  runtimeReady(runtime) {
    this.currentRuntime = runtime
    this.persistState(markRuntimeReady(this.state, runtime), `committing managed runtime ${runtime.version}`)
    this.rebuildMenu()
    this.scheduleAutomaticCheck(true)
  }

  /** Replace local state after startup quarantines a failed managed runtime. */
  replaceState(state, runtime) {
    this.state = state
    this.currentRuntime = runtime
    this.rebuildMenu()
    this.scheduleAutomaticCheck(true)
  }

  /** Check the official npm package and optionally present a native result. */
  async checkForUpdates({ manual = false } = {}) {
    if (this.disposed) return
    if (this.currentRuntime === undefined) {
      if (manual) this.onSetupRequested?.()
      return
    }
    if (this.checkPromise === undefined) {
      this.settingsError = undefined
      this.checkPromise = this.performCheck().finally(() => {
        this.checkPromise = undefined
        this.rebuildMenu()
        this.scheduleAutomaticCheck(false)
      })
      this.rebuildMenu()
    }
    try {
      const result = await this.checkPromise
      if (manual) await this.presentCheckResult(result)
      else this.prepareCheckResult(result)
    } catch (error) {
      this.settingsError = '暂时无法检查 Harness 更新，请重试或查看日志。'
      this.rebuildMenu()
      this.log(`update check failed: ${String(error)}\n`)
      if (manual) await this.showMessage({
        type: 'warning',
        title: 'Harness 更新',
        message: '暂时无法检查更新',
        detail: `${error instanceof Error ? error.message : String(error)}\n\n当前版本仍可正常使用。`,
      })
    }
  }

  /** Fetch official metadata through Electron's system-proxy-aware network stack. */
  async fetchPackument() {
    if (this.disposed) throw new Error('客户端正在退出')
    const controller = new AbortController()
    this.checkAbort = controller
    const timer = setTimeout(() => { controller.abort() }, CHECK_TIMEOUT_MS)
    try {
      const response = await this.electron.net.fetch(PACKUMENT_URL, {
        method: 'GET',
        headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status !== 200) throw new Error(`npm registry returned HTTP ${String(response.status)}`)
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKUMENT_BYTES) {
        throw new Error('npm registry metadata exceeded the size limit')
      }
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_PACKUMENT_BYTES) {
        throw new Error('npm registry metadata exceeded the size limit')
      }
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
      if (this.checkAbort === controller) this.checkAbort = undefined
    }
  }

  /** Return validated versions without starting any download or changing the selected runtime. */
  async fetchAvailableVersions() {
    const releases = listDshReleases(await this.fetchPackument())
    if (!this.disposed) this.persistState({ ...this.state, lastCheckedAt: Date.now() }, 'recording the installation catalog check')
    return releases
  }

  async performCheck() {
    const checkedAt = Date.now()
    const currentVersion = this.currentRuntime.version
    try {
      const packument = await this.fetchPackument()
      const release = selectDshUpdate(packument, currentVersion, this.state.channel)
      this.availableRelease = release
      return { currentVersion, release }
    } finally {
      if (!this.disposed) this.persistState({ ...this.state, lastCheckedAt: checkedAt }, 'recording an update check')
    }
  }

  /** Install a user-selected first runtime; failures reject for the retryable setup screen. */
  async installInitialRelease(release) {
    if (this.disposed || this.currentRuntime !== undefined || this.installPromise !== undefined) {
      throw new Error('当前不能开始首次安装')
    }
    this.prepareRelease(release, { reportFailure: false, initial: true })
    return await this.installPromise
  }

  async presentCheckResult(result) {
    if (result.release === undefined) {
      const channel = resolveUpdateChannel(result.currentVersion, this.state.channel)
      await this.showMessage({
        type: 'info',
        title: 'Harness 更新',
        message: '已经是最新版',
        detail: `当前官方 Harness：${result.currentVersion}\n更新通道：${channel}`,
      })
      return
    }
    if (this.state.pendingVersion === result.release.version) {
      await this.promptRestart(result.release)
      return
    }
    const started = this.prepareRelease(result.release, { reportFailure: true })
    if (started) {
      await this.showMessage({
        type: 'info',
        title: 'Harness 更新',
        message: `正在后台准备 ${result.release.version}`,
        detail: '你可以继续正常使用。下载、完整性校验和启动测试全部通过后，客户端才会提醒你重启。',
      })
    }
  }

  prepareCheckResult(result) {
    const release = result.release
    if (release === undefined || this.state.pendingVersion === release.version) return
    this.prepareRelease(release, { reportFailure: false })
  }

  prepareRelease(release, { reportFailure, initial = false }) {
    if (this.disposed || this.isPluginBusy() || (!initial && this.currentRuntime === undefined)) return false
    if (!initial && this.state.pendingVersion === release.version) return false
    if (this.installPromise !== undefined) {
      return false
    }
    this.preparingVersion = release.version
    this.settingsError = undefined
    this.reportProgress('begin', release.version)
    this.installPromise = this.installRelease(release, { reportFailure, initial }).finally(() => {
      this.installPromise = undefined
      this.preparingVersion = undefined
      this.rebuildMenu()
    })
    this.rebuildMenu()
    return true
  }

  async installRelease(release, { reportFailure, initial = false }) {
    if (typeof this.npmCliPath !== 'string' || this.npmCliPath.length === 0) {
      const detail = '客户端内置安装组件不可用；请重新安装客户端，已有 Harness 数据不会被覆盖。'
      if (initial) throw new Error(detail)
      this.log(`update preparation skipped: ${detail}\n`)
      this.reportProgress('fail', release.version)
      if (reportFailure) {
        await this.showMessage({
          type: 'warning',
          title: 'Harness 更新',
          message: '无法准备在线更新',
          detail: `${detail}\n\n请重新安装当前客户端后，再从 Harness 菜单检查更新。`,
        })
      }
      return
    }
    const node = this.currentRuntime ?? this.installerNode
    if (node === undefined) throw new Error('找不到客户端自带的 Node 安装组件，请重新安装客户端。')
    const npm = Object.freeze({
      source: initial ? 'installer' : 'current-runtime',
      nodePath: node.nodePath,
      nodeVersion: node.nodeVersion,
      npmCliPath: this.npmCliPath,
      verified: true,
    })
    this.setInstallProgress(true)
    try {
      const controller = new AbortController()
      this.installAbort = controller
      const downloadSource = resolveDownloadSource(this.getDownloadSource())
      const proxy = await this.resolveSystemProxy('npm update', new URL('@deepseek-ai%2Fdsh', downloadSource.registry).href)
      const officialProxy = downloadSource.id === 'official' ? proxy : await this.resolveSystemProxy('official npm metadata')
      controller.signal.throwIfAborted()
      await this.runUpdate({
        executable: node.nodePath,
        workerPath: this.workerPath,
        userData: this.userData,
        release,
        npm,
        runnerPath: this.runnerPath,
        currentNodeVersion: node.nodeVersion,
        currentNodeLicensePath: node.nodeLicensePath,
        proxy,
        officialProxy,
        downloadSource: downloadSource.id,
        onDownloadStatus: status => {
          if (!this.disposed) this.onDownloadStatus?.(status)
        },
        log: text => { this.log(text) },
        onProgress: (stage, files) => {
          if (files === undefined) this.reportProgress('stage', stage, release.version)
          else this.reportProgress('stage', stage, release.version, files)
          this.setInstallProgress(true, stage === 'verifying' ? files : undefined)
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted || this.disposed) return
      const installed = initial ? readManagedRuntime(this.userData, release.version) : undefined
      if (initial && installed === undefined) throw new Error('安装结果未通过完整性校验，请重试。')
      const scheduled = this.persistState(
        markRuntimePending(this.state, release.version),
        `scheduling Harness ${release.version}`,
      )
      if (!scheduled) throw new Error('更新已验证，但无法保存待切换状态；本次不会切换版本。')
      this.availableRelease = undefined
      this.rebuildMenu()
      this.reportProgress('complete', release.version)
      if (initial) return installed
      this.notifyReady(release)
    } catch (error) {
      this.settingsError = 'Harness 安装或更新未完成，当前版本未被覆盖。可以重试或查看日志。'
      this.log(`update installation failed: ${String(error)}\n`)
      if (!this.disposed) this.reportProgress('fail', release.version)
      if (initial) throw error
      if (reportFailure && !this.disposed) {
        await this.showMessage({
          type: 'error',
          title: 'Harness 更新失败',
          message: `没有切换到 ${release.version}`,
          detail: `${error instanceof Error ? error.message : String(error)}\n\n当前版本未被覆盖，可以继续使用。`,
        })
      }
    } finally {
      this.installAbort = undefined
      this.setInstallProgress(false)
    }
  }

  /** Keep the optional progress surface from affecting update correctness. */
  reportProgress(method, ...args) {
    if (this.disposed && method !== 'dispose') return
    if (method === 'begin' || method === 'complete' || method === 'fail') this.progressAvailable = true
    if (method === 'dispose') this.progressAvailable = false
    this.notifySettingsChanged()
    try {
      if (this.currentRuntime === undefined && method !== 'dispose') {
        if (method === 'show') this.showWindow?.()
        else this.onSetupProgress?.(method, ...args)
        return
      }
      const operation = this.progressWindow?.[method]
      if (typeof operation === 'function') operation.apply(this.progressWindow, args)
    } catch (error) {
      this.log(`update progress window failed: ${String(error)}\n`)
    }
  }

  /** Keep optional Windows taskbar feedback from affecting update preparation. */
  setInstallProgress(active, files) {
    try {
      const window = this.getWindow()
      if (window === undefined || window.isDestroyed()) return
      if (active && files?.totalFiles > 0) {
        window.setProgressBar(files.completedFiles / files.totalFiles, { mode: 'normal' })
      } else if (active) window.setProgressBar(2, { mode: 'indeterminate' })
      else window.setProgressBar(-1)
    } catch (error) {
      this.log(`taskbar update progress failed: ${String(error)}\n`)
    }
  }

  notifyReady(release) {
    if (!shouldNotifyUpdate(release.version, this.state.lastNotifiedVersion)) return
    this.persistState({
      ...this.state,
      lastNotifiedVersion: release.version,
    }, `recording the Harness ${release.version} notification`)
    if (!this.electron.Notification.isSupported()) return
    const notification = new this.electron.Notification({
      title: 'DeepSeek Harness 更新已准备好',
      body: `${release.version} 已完成校验和启动测试。点击即可选择重启应用。`,
      silent: false,
    })
    notification.on('click', () => {
      if (this.notification === notification) this.notification = undefined
      this.focusWindow()
      void this.promptRestart(release)
    })
    notification.on('close', () => {
      if (this.notification === notification) this.notification = undefined
    })
    this.notification?.close?.()
    this.notification = notification
    notification.show()
  }

  async promptRestart(release) {
    if (this.disposed || this.isPluginBusy()) return
    const choice = await this.showMessage({
      type: 'info',
      title: 'Harness 更新',
      message: `官方 Harness ${release.version} 已准备完成`,
      detail: '重启只会切换到已经验证的版本；若新版无法启动，会尝试已安装的可用旧版。没有可用版本时会打开版本选择界面。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response === 0 && !this.disposed && !this.isPluginBusy()) this.requestRestart()
  }

  focusWindow() {
    const window = this.getWindow()
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** Open a shell in the selected Harness runtime directory for local plugin operations. */
  async openRuntimeTerminal() {
    if (this.disposed || this.isPluginBusy()) return
    if (this.currentRuntime === undefined) {
      this.onSetupRequested?.()
      return
    }
    try {
      const proxy = await this.resolveSystemProxy('Harness terminal')
      if (this.disposed || this.isPluginBusy()) return
      const launch = createHarnessTerminalLaunch({
        runtime: this.currentRuntime,
        npmCliPath: this.npmCliPath,
        terminalBinPath: this.terminalBinPath,
        workspacePath: this.workspacePath,
        environment: this.terminalEnvironment,
        proxy: proxy ?? undefined,
      })
      const child = this.spawnTerminal(launch.command, launch.args, {
        ...launch.spawnOptions,
        cwd: launch.cwd,
        env: launch.env,
      })
      const openedAt = Date.now()
      let spawnFailed = false
      child.once('error', error => {
        spawnFailed = true
        this.log(`failed to open Harness terminal: ${String(error)}\n`)
        void this.showMessage({
          type: 'warning',
          title: '打开终端失败',
          message: '无法启动 Harness 终端',
          detail: error instanceof Error ? error.message : String(error),
        })
      })
      child.once('exit', (code, signal) => {
        const elapsed = Date.now() - openedAt
        this.log(`Harness terminal launcher exited code=${String(code)} signal=${String(signal)} elapsedMs=${String(elapsed)}\n`)
        if (!spawnFailed && code !== 0 && elapsed < 5_000 && !this.disposed) {
          void this.showMessage({
            type: 'warning',
            title: '打开终端失败',
            message: 'Harness 终端启动后立即退出',
            detail: `命令窗口返回退出码 ${String(code)}。请查看本次应用日志获取详情。`,
          })
        }
      })
      child.unref?.()
      this.log(`opened Harness terminal pid=${String(child.pid)} cwd=${launch.cwd}\n`)
    } catch (error) {
      this.log(`failed to open Harness terminal: ${String(error)}\n`)
      await this.showMessage({
        type: 'warning',
        title: '打开终端失败',
        message: '无法启动 Harness 终端',
        detail: `${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** Resolve Chromium's Windows proxy choice for the npm registry with a bounded wait. */
  async resolveSystemProxy(purpose, url = PACKUMENT_URL) {
    const resolveProxy = this.electron.app?.resolveProxy
    if (typeof resolveProxy !== 'function') return undefined
    let timer
    try {
      const proxyRules = await Promise.race([
        resolveProxy.call(this.electron.app, url),
        new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new Error('system proxy resolution timed out')) }, PROXY_RESOLUTION_TIMEOUT_MS)
        }),
      ])
      const proxy = parseResolvedProxy(proxyRules)
      if (proxy !== undefined) this.log(`using the Windows system proxy for ${purpose}\n`)
      return proxy ?? (typeof proxyRules === 'string' && proxyRules.trim().toUpperCase() === 'DIRECT' ? null : undefined)
    } catch (error) {
      this.log(`system proxy resolution failed; npm will use its inherited network settings: ${String(error)}\n`)
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Show only the Harness submenu below the custom titlebar. */
  showHarnessMenuAtTopLeft() {
    if (this.disposed || this.activeHarnessPopupMenu !== undefined) return false
    const window = this.getWindow()
    const menu = this.harnessPopupMenu
    if (window === undefined || window.isDestroyed() || menu === undefined) return false
    try {
      window.setMenuBarVisibility(false)
    } catch (error) {
      this.log(`native menu bar hide failed: ${String(error)}\n`)
    }
    this.activeHarnessPopupMenu = menu
    try {
      menu.popup({
        window,
        x: 0,
        y: HARNESS_MENU_POPUP_Y,
        callback: () => {
          if (this.activeHarnessPopupMenu === menu) this.activeHarnessPopupMenu = undefined
        },
      })
      return true
    } catch (error) {
      if (this.activeHarnessPopupMenu === menu) this.activeHarnessPopupMenu = undefined
      this.log(`Harness popup menu failed: ${String(error)}\n`)
      return false
    }
  }

  rebuildMenu() {
    if (this.disposed) return
    const installed = this.currentRuntime !== undefined
    const harnessMenuTemplate = [
      {
        label: '打开 Harness 终端…',
        enabled: installed && !this.isPluginBusy(),
        click: () => { void this.openRuntimeTerminal() },
      },
      { label: '客户端设置…', click: () => { this.onSettingsRequested('harness') } },
      ...(this.progressAvailable || this.hasClientProgress() ? [{
        label: '查看更新进度…', click: () => { this.onProgressRequested() },
      }] : []),
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ]
    const template = [{ label: '客户端', submenu: harnessMenuTemplate }]
    this.harnessPopupMenu = this.electron.Menu.buildFromTemplate(harnessMenuTemplate)
    this.electron.Menu.setApplicationMenu(this.electron.Menu.buildFromTemplate(template))
    try {
      this.onHarnessMenuChanged?.(harnessMenuTemplate)
    } catch (error) {
      this.log(`Harness tray menu update failed: ${String(error)}\n`)
    }
    const window = this.getWindow()
    if (window !== undefined && !window.isDestroyed()) window.setMenuBarVisibility(false)
    this.notifySettingsChanged()
  }

  notifySettingsChanged() {
    try { this.onSettingsChanged?.() } catch (error) {
      this.log(`settings refresh failed: ${String(error)}\n`)
    }
  }

  getSettingsState() {
    const status = this.installPromise !== undefined || this.preparingVersion !== undefined ? 'installing'
      : this.checkPromise !== undefined ? 'checking'
        : this.state.pendingVersion !== undefined ? 'pending'
          : this.settingsError ? 'error' : this.availableRelease ? 'available' : 'idle'
    return {
      installed: this.currentRuntime !== undefined, version: this.currentRuntime?.version,
      status, availableVersion: this.availableRelease?.version, pendingVersion: this.state.pendingVersion,
      autoCheck: this.state.autoCheck, interval: this.state.interval, channel: this.state.channel ?? 'auto',
      progressAvailable: this.progressAvailable, error: this.settingsError,
    }
  }

  updatePreferences(patch) {
    if (this.disposed || this.checkPromise !== undefined || this.installPromise !== undefined || this.preparingVersion !== undefined) throw new Error('请等待当前 Harness 操作结束后再修改设置')
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(patch)) || Object.keys(patch).length === 0
      || Object.keys(patch).some(key => !['autoCheck', 'interval', 'channel'].includes(key))
      || ('autoCheck' in patch && typeof patch.autoCheck !== 'boolean')
      || ('interval' in patch && (typeof patch.interval !== 'string' || !Object.hasOwn(UPDATE_INTERVAL_MS, patch.interval)))
      || ('channel' in patch && ![undefined, 'latest', 'next'].includes(patch.channel))) throw new Error('无效的 Harness 更新设置')
    const previous = this.state
    if (!this.persistState({ ...this.state, ...patch }, 'saving update preferences')) {
      this.state = previous
      throw new Error('无法保存 Harness 更新设置')
    }
    this.availableRelease = undefined
    this.rebuildMenu()
    this.scheduleAutomaticCheck(false)
  }

  scheduleAutomaticCheck(initial) {
    if (this.checkTimer !== undefined) clearTimeout(this.checkTimer)
    this.checkTimer = undefined
    if (this.disposed || this.currentRuntime === undefined || !this.state.autoCheck || this.checkPromise !== undefined) return
    const now = Date.now()
    const due = isUpdateCheckDue(this.state.lastCheckedAt, this.state.interval, now)
    const interval = UPDATE_INTERVAL_MS[this.state.interval]
    const elapsed = typeof this.state.lastCheckedAt === 'number' ? now - this.state.lastCheckedAt : interval
    const untilDue = Math.max(0, interval - Math.max(0, elapsed))
    const delay = initial && due ? FIRST_AUTOMATIC_CHECK_DELAY_MS : (due ? 1_000 : untilDue)
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined
      void this.checkForUpdates({ manual: false })
    }, Math.min(delay, 2_147_483_647))
  }

  async showMessage(options) {
    this.showWindow?.()
    const window = this.getWindow()
    return window !== undefined && !window.isDestroyed()
      ? this.electron.dialog.showMessageBox(window, options)
      : this.electron.dialog.showMessageBox(options)
  }

  persistState(nextState, context) {
    this.state = nextState
    try {
      this.state = writeRuntimeState(this.userData, nextState)
      return true
    } catch (error) {
      this.log(`runtime state write failed while ${context}: ${String(error)}\n`)
      return false
    }
  }
}

/** Run npm materialization, closure audit, and boot smoke outside Electron main. */
export function runUpdateWorker(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (typeof options.workerPath !== 'string' || options.workerPath.length === 0) {
      rejectPromise(new Error('Harness update worker path is missing'))
      return
    }
    const environment = createBackendEnvironment(process.env)
    const child = spawn(options.executable, [options.workerPath], {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let settled = false
    let completed = false
    let failure
    let forceTimer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const remember = (source, chunk) => {
      options.log?.(`[${source}] ${chunk.toString()}`)
    }
    const forceStop = () => {
      void terminateUpdateWorkerTree(child).catch(error => {
        options.log?.(`[update worker] forced cleanup failed: ${String(error)}\n`)
        if (!hasChildExited(child)) child.kill('SIGKILL')
      })
    }
    const abort = () => {
      failure = new Error('Harness update preparation was cancelled')
      try {
        if (child.connected) child.send({ type: 'cancel' }, () => {})
      } catch {
        // The close/error handlers below own settlement.
      }
      forceTimer = setTimeout(forceStop, UPDATE_WORKER_CANCEL_GRACE_MS)
    }
    child.stdout?.on('data', chunk => { remember('update worker stdout', chunk) })
    child.stderr?.on('data', chunk => { remember('update worker stderr', chunk) })
    child.on('message', message => {
      if (message === null || typeof message !== 'object') return
      if (message.type === 'log' && typeof message.text === 'string') options.log?.(message.text)
      if (message.type === 'progress' && isUpdateProgressStage(message.stage)) {
        try {
          const files = normalizeUpdateFileProgress(message.files)
          options.onProgress?.(message.stage, files)
        } catch (error) {
          options.log?.(`[update worker] progress callback failed: ${String(error)}\n`)
        }
      }
      if (message.type === 'download-source' && message.status !== null && typeof message.status === 'object'
        && ['official', 'npmmirror'].includes(message.status.source)
        && typeof message.status.fallback === 'boolean' && typeof message.status.detail === 'string'
        && message.status.detail.length <= 512) {
        try { options.onDownloadStatus?.({ source: message.status.source, fallback: message.status.fallback, detail: message.status.detail }) }
        catch (error) { options.log?.(`[update worker] download-status callback failed: ${String(error)}\n`) }
      }
      if (message.type === 'complete') completed = true
      if (message.type === 'failed' && typeof message.error === 'string') failure = new Error(message.error)
    })
    child.once('error', error => { finish(rejectPromise, error) })
    child.once('close', (code, signal) => {
      if (failure !== undefined) finish(rejectPromise, failure)
      else if (completed && code === 0) finish(resolvePromise, undefined)
      else finish(rejectPromise, new Error(`Harness update worker failed (code=${String(code)}, signal=${String(signal)})`))
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted === true) {
      abort()
      return
    }
    try {
      child.send({
        type: 'install',
        userData: options.userData,
        release: options.release,
        npm: options.npm,
        runnerPath: options.runnerPath,
        currentNodeVersion: options.currentNodeVersion,
        currentNodeLicensePath: options.currentNodeLicensePath,
        proxy: options.proxy,
        officialProxy: options.officialProxy,
        downloadSource: options.downloadSource,
      }, error => {
        if (error != null) {
          failure = error
          forceStop()
        }
      })
    } catch (error) {
      failure = error
      forceStop()
    }
  })
}

async function terminateUpdateWorkerTree(child) {
  if (hasChildExited(child) || child.pid === undefined || child.pid < 1) return
  if (process.platform !== 'win32') {
    child.kill('SIGKILL')
    return
  }
  const taskkill = resolveWindowsTaskkillPath(process.env)
  await new Promise((resolvePromise, rejectPromise) => {
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      killer.kill('SIGKILL')
      rejectPromise(new Error('update worker taskkill timed out'))
    }, UPDATE_WORKER_KILL_TIMEOUT_MS)
    killer.once('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    killer.once('close', code => {
      clearTimeout(timer)
      if (code === 0 || hasChildExited(child)) resolvePromise()
      else rejectPromise(new Error(`update worker taskkill exited with code ${String(code)}`))
    })
  })
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Convert Chromium proxy rules to one npm-compatible proxy URL.
 * @param {unknown} value `resolveProxy()` output such as `PROXY host:port; DIRECT`.
 * @returns {string | undefined} validated proxy URL, or direct/inapplicable routing.
 */
export function parseResolvedProxy(value) {
  if (typeof value !== 'string') return undefined
  for (const entry of value.split(';')) {
    const match = entry.trim().match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+([^\s]+)$/iu)
    if (match === null) continue
    const protocol = match[1].toUpperCase()
    const scheme = protocol === 'HTTPS' ? 'https:'
      : protocol === 'SOCKS4' ? 'socks4:'
        : protocol === 'SOCKS' || protocol === 'SOCKS5' ? 'socks5:'
          : 'http:'
    let parsed
    try {
      parsed = new URL(`${scheme}//${match[2]}`)
    } catch {
      continue
    }
    const port = Number(parsed.port)
    if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === ''
      || !Number.isInteger(port) || port < 1 || port > 65_535
      || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') continue
    return `${scheme}//${match[2]}`
  }
  return undefined
}
