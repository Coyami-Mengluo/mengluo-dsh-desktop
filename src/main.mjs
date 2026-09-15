import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog as nativeDialog, ipcMain, Menu as nativeMenu, nativeTheme, net, Notification as NativeNotification, screen, shell, Tray, WebContentsView } from 'electron'
import { createLanguageController, localizeMenu, localizeMessageOptions } from './language.mjs'
import {
  BACKEND_TREE_KILL_DELAY_MS,
  createHarnessLaunchEnvironment,
  createHarnessLaunchArguments,
  DESKTOP_PORT,
  observeHarnessOutput,
  redactHarnessTokens,
  resolveBundledNpmCliPath,
  resolveBundledNodePath,
  resolveNodeChildScriptPath,
  resolveWindowsTaskkillPath,
} from './runtime.mjs'
import {
  markRuntimeFailed,
  readInstallerNode,
  readRuntimeState,
  selectRuntime,
  writeRuntimeState,
} from './runtime-store.mjs'
import { createDesktopWindow } from './desktop-window.mjs'
import { createDesktopTray } from './desktop-tray.mjs'
import { createFirstRunSetup } from './first-run-setup.mjs'
import { HarnessUpdateManager } from './update-manager.mjs'
import { startShellThemeSync } from './shell-theme.mjs'
import { captureTitlebarSnapshot, fallbackTitlebarSnapshot, TITLEBAR_IPC } from './titlebar-sampler.mjs'
import { createUpdateProgressWindow } from './update-progress-window.mjs'
import { PRODUCT_NAME, SHELL_RELEASES_URL, SHELL_RELEASE_SOURCE } from './release-config.mjs'
import { createNativeShellUpdater } from './native-shell-updater.mjs'
import { ShellUpdateManager } from './shell-updater.mjs'
import { createShellUpdateWindow } from './shell-update-window.mjs'
import { createSettingsWindow } from './settings-window.mjs'
import { DesktopSettingsController } from './settings-controller.mjs'
import { PluginCatalog } from './plugin-catalog.mjs'
import { PluginManager } from './plugin-manager.mjs'
import { resolvePluginHome } from './plugin-runtime.mjs'
import { createBackendReadiness } from './backend-readiness.mjs'
import { RuntimeVersionManager } from './runtime-versions.mjs'
import { createHarnessDataBackup } from './plugin-snapshots.mjs'

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LEGACY_PRODUCT_NAME = 'MengLuo AI'
const APP_ID = 'ai.mengluo.desktop'
const STARTUP_TIMEOUT_MS = 120_000
const TASKKILL_TIMEOUT_MS = 3_000
const FORCE_EXIT_WAIT_MS = 2_000
const RENDERER_STABILITY_MS = 1_500
const MAX_FAILURE_OUTPUT = 16_384
const WORKSPACE_DIRECTORY = `${PRODUCT_NAME} Workspace`
const LEGACY_WORKSPACE_DIRECTORY = `${LEGACY_PRODUCT_NAME} Workspace`

let mainWindow
let backend
let backendOrigin
let backendExit
let backendReadiness
let logStream
let logPath
let startupTimer
let recentOutput = ''
let quitStarted = false
let mayQuit = false
let failureShown = false
let firstRunSetup
let selectedRuntime
let runtimeState
let updateManager
let startupFailureHandling = false
let stopShellThemeSync
let updateProgressWindow
let backendRunnerPath
let desktopWindow
let desktopTray
let shellUpdateManager
let installClientAfterShutdown
let settingsWindow
let settingsController
let pluginManager
let runtimeVersions
let pluginQuitNotice
let pluginRecoveryExitApproved = false
let pluginBackendPaused = false
let language
const translate = text => language?.translate(text) ?? text
const Menu = Object.assign(Object.create(nativeMenu), {
  buildFromTemplate: template => nativeMenu.buildFromTemplate(localizeMenu(template, translate)),
})
const dialog = Object.assign(Object.create(nativeDialog), {
  showMessageBox(...args) {
    const options = localizeMessageOptions(args.pop(), translate)
    if (!options.buttons) options.buttons = [translate('确定')]
    return nativeDialog.showMessageBox(...args, options)
  },
  showErrorBox: (title, content) => nativeDialog.showErrorBox(translate(title), translate(content)),
})
function Notification(options) { return new NativeNotification(localizeMessageOptions(options, translate)) }
Notification.isSupported = () => NativeNotification.isSupported()

preserveLegacyUserData()
app.setName(PRODUCT_NAME)
app.setAppUserModelId(APP_ID)

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    desktopTray?.showWindow()
  })
  void startApplication().catch((error) => {
    showFailure(`${PRODUCT_NAME} 启动失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Start the desktop window and its supervised Harness backend. */
async function startApplication() {
  await app.whenReady()
  openLog()
  language = createLanguageController({
    userData: app.getPath('userData'), ipcMain, getSystemLocale: () => app.getSystemLocale(),
    onChanged: () => { updateManager?.rebuildMenu() },
    log: text => { appendLog('settings', text) },
  })
  const nodePathOptions = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    applicationRoot: APP_ROOT,
  }
  backendRunnerPath = resolveNodeChildScriptPath(nodePathOptions, 'backend-runner.mjs')
  const updateWorkerPath = resolveNodeChildScriptPath(nodePathOptions, 'update-worker.mjs')
  const updaterNpmCliPath = resolveBundledNpmCliPath(nodePathOptions)
  const terminalBinPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'terminal-bin')
    : join(APP_ROOT, 'assets', 'terminal-bin')
  for (const [label, path] of [
    ['Harness 后台启动器', backendRunnerPath],
    ['Harness 更新启动器', updateWorkerPath],
    ['Harness 内置 npm 更新组件', updaterNpmCliPath],
    ...['harness-terminal.cmd', 'node.cmd', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', 'dsh.cmd']
      .map(name => [`Harness 终端组件 ${name}`, join(terminalBinPath, name)]),
  ]) {
    if (!existsSync(path)) throw new Error(`找不到${label}：${path}`)
  }
  const installerNode = readInstallerNode(resolveBundledNodePath(nodePathOptions))
  runtimeState = readRuntimeState(app.getPath('userData'))
  selectedRuntime = selectRuntime(app.getPath('userData'), runtimeState)
  const workspacePath = resolveWorkspacePath()
  mkdirSync(workspacePath, { recursive: true })
  stopShellThemeSync = startShellThemeSync({
    nativeTheme,
    cwd: workspacePath,
    onError: error => { appendLog('desktop', `shell theme sync failed: ${String(error)}\n`) },
  })
  desktopWindow = createDesktopWindow({
    language,
    BrowserWindow,
    Menu,
    WebContentsView,
    ipcMain,
    nativeTheme,
    productName: PRODUCT_NAME,
    iconPath: join(APP_ROOT, 'assets', 'icon.png'),
    titlebarPreloadPath: join(APP_ROOT, 'src', 'titlebar-preload.cjs'),
    titlebarHtmlPath: join(APP_ROOT, 'assets', 'titlebar.html'),
    titlebarChannels: TITLEBAR_IPC,
    captureSnapshot: captureTitlebarSnapshot,
    fallbackSnapshot: fallbackTitlebarSnapshot,
    getBackendOrigin: () => backendOrigin,
    openExternal: openExternalUrl,
    log: text => { appendLog('titlebar', text) },
    onOfficialRenderGone: details => { handleRendererGone('official', details) },
    onShellRenderGone: details => { handleRendererGone('shell', details) },
    showHarnessMenuAtTopLeft: () => { updateManager?.showHarnessMenuAtTopLeft() },
    onClosed: () => {
      mainWindow = undefined
      desktopWindow = undefined
      if (!quitStarted) app.quit()
    },
  })
  mainWindow = desktopWindow.window
  desktopTray = createDesktopTray({
    Tray,
    Menu,
    window: mainWindow,
    iconPath: join(APP_ROOT, 'assets', 'icon.png'),
    productName: PRODUCT_NAME,
    isQuitting: () => quitStarted,
    focusOfficial: () => { desktopWindow?.focusOfficial() },
    requestQuit: () => { app.quit() },
    log: text => { appendLog('tray', text) },
  })
  updateProgressWindow = createUpdateProgressWindow({
    screen,
    language,
    BrowserWindow,
    ipcMain,
    nativeTheme,
    getParent: () => mainWindow,
    preloadPath: join(APP_ROOT, 'src', 'update-progress-preload.cjs'),
    htmlPath: join(APP_ROOT, 'assets', 'update-progress.html'),
    log: text => { appendLog('update', text) },
  })
  updateManager = new HarnessUpdateManager({
    electron: { app, dialog, Menu, net, Notification, shell },
    userData: app.getPath('userData'),
    runnerPath: backendRunnerPath,
    workerPath: updateWorkerPath,
    npmCliPath: updaterNpmCliPath,
    currentRuntime: selectedRuntime,
    installerNode,
    onSetupRequested: () => {
      desktopTray?.showWindow()
      void firstRunSetup?.show()
    },
    onSetupProgress: (method, ...args) => { firstRunSetup?.progress(method, ...args) },
    workspacePath,
    terminalBinPath,
    getWindow: () => mainWindow,
    getLogPath: () => logPath,
    log: text => { appendLog('update', text) },
    openExternal: openExternalUrl,
    progressWindow: updateProgressWindow,
    showWindow: () => { desktopTray?.showWindow() },
    onHarnessMenuChanged: template => { desktopTray?.setHarnessMenu(template) },
    onSettingsRequested: section => { showClientSettings(section) },
    onSettingsChanged: () => { settingsController?.refresh() },
    isPluginBusy: () => pluginManager?.blocksUpdates() === true,
    isVersionBusy: () => runtimeVersions?.isBusy() === true || Boolean(runtimeVersions?.catalogPromise),
    getDownloadSource: () => settingsController?.preferences.source ?? 'official',
    onDownloadStatus: status => { settingsController?.reportDownloadStatus(status) },
    hasClientProgress: () => ['downloading', 'downloaded', 'installing', 'error'].includes(shellUpdateManager?.state.status),
    onProgressRequested: () => {
      if (updateManager?.installPromise || updateManager?.preparingVersion) updateManager.reportProgress('show')
      else if (['downloading', 'downloaded', 'installing', 'error'].includes(shellUpdateManager?.state.status)) shellUpdateManager.options.progress?.show()
      else updateManager?.reportProgress('show')
    },
    requestRestart: () => {
      if (quitStarted || runtimeVersions?.isBusy() || pluginManager?.blocksUpdates()) return
      app.relaunch()
      app.quit()
    },
  })
  const shellProgress = createShellUpdateWindow({
    screen,
    language,
    BrowserWindow, ipcMain, nativeTheme, getParent: () => mainWindow,
    iconPath: join(APP_ROOT, 'assets', 'icon.png'),
    htmlPath: join(APP_ROOT, 'assets', 'shell-update.html'),
    preloadPath: join(APP_ROOT, 'src', 'shell-update-preload.cjs'),
    log: text => { appendLog('client-update', text) },
    onAction: action => {
      if (action === 'check') void shellUpdateManager?.check()
      else if (action === 'download') void shellUpdateManager?.promptDownload()
      else if (action === 'install') void shellUpdateManager?.install()
    },
  })
  shellUpdateManager = new ShellUpdateManager({
    ...createNativeShellUpdater(app.getAppPath()),
    version: app.getVersion(), userData: app.getPath('userData'), Notification,
    supported: app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR,
    progress: shellProgress,
    onMenuChanged: () => { updateManager?.rebuildMenu() },
    log: text => { appendLog('client-update', text) },
    openExternal: openExternalUrl,
    showMessage: options => mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options),
    isHarnessInstalling: () => updateManager?.installPromise !== undefined || runtimeVersions?.isBusy() === true || pluginManager?.blocksUpdates() === true,
    onInstallError: error => {
      dialog.showErrorBox('客户端更新未安装', `安装程序未能启动，请重新打开客户端后重试。\n\n${String(error)}`)
      app.quit()
    },
    requestInstall: install => {
      if (quitStarted || runtimeVersions?.isBusy() || updateManager?.installPromise !== undefined || pluginManager?.blocksUpdates()) return false
      installClientAfterShutdown = install
      app.quit()
      return true
    },
  })
  pluginManager = new PluginManager({
    userData: app.getPath('userData'),
    dshHome: resolvePluginHome({ workspacePath }),
    catalog: new PluginCatalog({ fetch: (url, options) => net.fetch(url, options) }),
    getRuntime: () => updateManager.currentRuntime,
    isBlocked: () => quitStarted || pluginBackendPaused || runtimeVersions?.isBusy() || startupFailureHandling || updateManager.installPromise !== undefined
      || updateManager.preparingVersion !== undefined || shellUpdateManager.state.status === 'installing'
      || (backend !== undefined && backendOrigin === undefined && !hasExited(backend)),
    npmCliPath: updaterNpmCliPath, terminalBinPath, workspacePath,
    resolveProxy: url => updateManager.resolveSystemProxy('Harness plugin', url),
    withBackendStopped: withPluginBackendStopped,
    restartBackend: async runtime => {
      if (runtime !== selectedRuntime) throw new Error('plugin restart runtime changed')
      await withPluginBackendStopped(async () => {}, { waitUntilReady: true })
    },
    showMessage: options => settingsWindow?.window && !settingsWindow.window.isDestroyed()
      ? dialog.showMessageBox(settingsWindow.window, options) : dialog.showMessageBox(options),
    openExternal: openExternalUrl,
    onChanged: () => { updateManager.rebuildMenu() },
    log: text => { appendLog('plugins', redactHarnessTokens(text)) },
  })
  runtimeVersions = new RuntimeVersionManager({
    updater: updateManager,
    isBlocked: () => quitStarted || pluginBackendPaused || startupFailureHandling || pluginManager.blocksUpdates()
      || shellUpdateManager.state.status === 'installing' || !backendOrigin,
    withBackendStopped: withPluginBackendStopped,
    showMessage: options => settingsWindow?.window && !settingsWindow.window.isDestroyed()
      ? dialog.showMessageBox(settingsWindow.window, options) : dialog.showMessageBox(mainWindow, options),
    backup: options => createHarnessDataBackup({ ...options, userData: app.getPath('userData'), dshHome: resolvePluginHome({ workspacePath }) }),
    openBackupFolder: async () => {
      const directory = join(app.getPath('userData'), 'harness-data-backups')
      mkdirSync(directory, { recursive: true })
      const error = await shell.openPath(directory)
      if (error) throw new Error(error)
    },
    requestRestart: () => {
      if (quitStarted || !runtimeVersions.committed || pluginManager.blocksUpdates()) return false
      runtimeState = updateManager.state
      app.relaunch()
      app.quit()
      return quitStarted
    },
    onChanged: () => { settingsController?.refresh(); updateManager.rebuildMenu() },
    log: text => { appendLog('versions', redactHarnessTokens(text)) },
  })
  settingsController = new DesktopSettingsController({
    userData: app.getPath('userData'), harness: updateManager, client: shellUpdateManager,
    plugins: pluginManager,
    versions: runtimeVersions,
    productName: PRODUCT_NAME, app, net,
    isStarting: () => backend !== undefined && backendOrigin === undefined && !hasExited(backend),
    onChanged: state => {
      settingsWindow?.update(state)
      firstRunSetup?.refreshDownloadSettings()
    },
    logAvailable: () => typeof logPath === 'string' && existsSync(logPath),
    showSetup: () => { desktopTray?.showWindow(); void firstRunSetup?.show() },
    openLog: () => {
      if (logPath) void shell.openPath(logPath).then(error => {
        if (error) appendLog('settings', `could not open log: ${error}\n`)
      }).catch(error => { appendLog('settings', `could not open log: ${String(error)}\n`) })
    },
    openRepository: () => openExternalUrl(`https://github.com/${SHELL_RELEASE_SOURCE.owner}/${SHELL_RELEASE_SOURCE.repo}`),
    openOfficial: () => openExternalUrl('https://www.deepseek.com/harness/'),
    openClientReleases: () => openExternalUrl(SHELL_RELEASES_URL),
    log: text => { appendLog('settings', text) },
  })
  settingsWindow = createSettingsWindow({
    screen,
    language,
    BrowserWindow, ipcMain, nativeTheme, getParent: () => mainWindow,
    productName: PRODUCT_NAME, iconPath: join(APP_ROOT, 'assets', 'icon.png'),
    htmlPath: join(APP_ROOT, 'assets', 'settings.html'),
    preloadPath: join(APP_ROOT, 'src', 'settings-preload.cjs'),
    onAction: request => settingsController.handleAction(request),
    log: text => { appendLog('settings', text) },
  })
  firstRunSetup = createFirstRunSetup({
    ipcMain,
    window: mainWindow,
    updater: updateManager,
    htmlPath: join(APP_ROOT, 'assets', 'titlebar.html'),
    showLoading: () => { desktopWindow?.showLoading() },
    downloadSettings: {
      getState: () => settingsController.getDownloadState(),
      setSource: source => settingsController.setDownloadSource(source),
      testConnection: version => settingsController.testConnection(version),
    },
    onInstalled: runtime => {
      if (quitStarted) return
      runtimeState = readRuntimeState(app.getPath('userData'))
      selectedRuntime = runtime
      updateManager.replaceState(runtimeState, runtime)
      startBackend(runtime)
    },
  })
  await pluginManager.refreshSnapshots()
  await runtimeVersions.refreshLocal().catch(error => { appendLog('versions', `local version listing failed: ${String(error)}\n`) })
  updateManager.start()
  shellUpdateManager.start()
  settingsController.refresh()
  await desktopWindow.loadShell()
  if (!mainWindow.isVisible()) mainWindow.show()
  if (pluginManager.snapshotRecoveryRequired) showClientSettings('plugins')
  else if (selectedRuntime === undefined) await firstRunSetup.show()
  else startBackend(selectedRuntime)
}

function showClientSettings(section = 'harness') {
  if (quitStarted) return
  settingsController?.refresh()
  settingsWindow?.show(section)
  void settingsController?.inspectProxy()
  if (section === 'harness' && !runtimeVersions?.isBusy()) void runtimeVersions?.refreshLocal().catch(error => {
    appendLog('versions', `local version listing failed: ${String(error)}\n`)
  })
}

/**
 * Open a validated ordinary Web link and contain shell integration failures.
 * @param {string} url validated HTTP or HTTPS URL.
 */
function openExternalUrl(url) {
  void shell.openExternal(url).catch((error) => {
    appendLog('desktop', `external link failed: ${String(error)}\n`)
  })
}

/** Spawn the selected official CLI under its own standalone Node runtime. */
function startBackend(runtime) {
  if (quitStarted || pluginBackendPaused || pluginManager?.snapshotRecoveryRequired) return
  backendReadiness?.fail()
  const readiness = createBackendReadiness({
    timeoutMs: STARTUP_TIMEOUT_MS + 15_000,
    onTimeout: () => {
      if (backendReadiness === readiness) void handleBackendStartupFailure('Harness 界面未能在预期时间内完成加载。')
    },
  })
  backendReadiness = readiness
  desktopWindow?.showLoading()
  const cliPath = runtime.cliPath
  if (!existsSync(runtime.nodePath)) {
    void handleBackendStartupFailure(`找不到 Harness runtime 的 Node：${runtime.nodePath}`)
    return readiness.promise
  }
  if (backendRunnerPath === undefined || !existsSync(backendRunnerPath)) {
    void handleBackendStartupFailure(`找不到 Harness 后台启动器：${backendRunnerPath ?? '尚未解析'}`)
    return readiness.promise
  }
  if (!existsSync(cliPath)) {
    void handleBackendStartupFailure(`找不到 Harness 后台：${cliPath}`)
    return readiness.promise
  }

  const workspace = resolveWorkspacePath()
  mkdirSync(workspace, { recursive: true })
  const environment = createHarnessLaunchEnvironment(process.env)
  appendLog('desktop', `starting official Harness ${runtime.version} (${runtime.source}); requesting 127.0.0.1:${String(DESKTOP_PORT)}\n`)
  const child = spawn(
    runtime.nodePath,
    createHarnessLaunchArguments({ runnerPath: backendRunnerPath, cliPath, version: runtime.version, port: DESKTOP_PORT }),
    {
      cwd: workspace,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  backend = child
  selectedRuntime = runtime
  settingsController?.refresh()

  backendExit = new Promise((resolve) => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const exit = backendExit
  observeHarnessOutput(child, {
    log: appendLog,
    onReady: url => { acceptReadyUrl(url, child, readiness) },
  })
  child.on('error', (error) => {
    appendLog('desktop', `backend process error: ${error.message}\n`)
    if (!pluginBackendPaused && backend === child && backendOrigin === undefined) {
      void handleBackendStartupFailure(`无法启动 Harness 后台：${error.message}`)
    }
  })
  void exit.then(({ code, signal }) => {
    if (quitStarted || pluginBackendPaused || backend !== child) return
    const outcome = signal === null ? `退出码 ${String(code)}` : `信号 ${signal}`
    if (backendOrigin === undefined) {
      void handleBackendStartupFailure(`Harness 后台在启动时停止（${outcome}）。`)
    } else {
      if (selectedRuntime?.source === 'managed') {
        persistRuntimeState(
          markRuntimeFailed(readRuntimeState(app.getPath('userData')), selectedRuntime),
          `recording crashed managed runtime ${selectedRuntime.version}`,
        )
      }
      showFailure(`Harness 后台已停止（${outcome}）。`)
    }
  })
  startupTimer = setTimeout(() => {
    void handleBackendStartupFailure(`Harness 后台在 ${String(STARTUP_TIMEOUT_MS / 1_000)} 秒内没有完成启动。`)
  }, STARTUP_TIMEOUT_MS)
  return readiness.promise
}

/** @returns {string} working directory shared by Harness home resolution and the backend. */
function resolveWorkspacePath() {
  const documents = app.getPath('documents')
  const current = join(documents, WORKSPACE_DIRECTORY)
  return [current, join(documents, 'DeepSeek harness Workspace'), join(documents, LEGACY_WORKSPACE_DIRECTORY)]
    .find(path => existsSync(path)) ?? current
}

/** Reuse the previous private-shell profile after the visible product rename. */
function preserveLegacyUserData() {
  const appData = app.getPath('appData')
  const current = join(appData, PRODUCT_NAME)
  const selected = [current, join(appData, 'DeepSeek harness'), join(appData, LEGACY_PRODUCT_NAME)]
    .find(path => existsSync(path)) ?? current
  mkdirSync(selected, { recursive: true })
  app.setPath('userData', selected)
}

/**
 * Load the validated backend URL including its authentication query.
 * @param {string} readyUrl validated URL emitted by the supervised backend.
 * @param {import('node:child_process').ChildProcess} child emitting process.
 */
function acceptReadyUrl(readyUrl, child, readiness) {
  if (pluginBackendPaused || backend !== child || backendOrigin !== undefined || failureShown) return
  const ready = new URL(readyUrl)
  backendOrigin = ready.origin
  settingsController?.refresh()
  clearStartupTimer()
  startupFailureHandling = false
  appendLog('desktop', `loading ${readyUrl}\n`)
  const runtime = selectedRuntime
  const host = desktopWindow
  if (runtime === undefined || host === undefined) return
  void loadReadyRenderer(host, readyUrl, child, runtime, readiness)
}

/** Commit a managed slot only after Chromium loaded it and stayed alive briefly. */
async function loadReadyRenderer(host, readyUrl, child, runtime, readiness) {
  try {
    await host.loadOfficial(readyUrl)
    await new Promise(resolve => { setTimeout(resolve, RENDERER_STABILITY_MS) })
    if (quitStarted || pluginBackendPaused || failureShown || backend !== child || host.window.isDestroyed()) { readiness.fail(); return }
    updateManager?.runtimeReady(runtime)
    firstRunSetup?.complete()
    readiness.ready()
  } catch (error) {
    readiness.fail(error)
    if (backend !== child || quitStarted || pluginBackendPaused) return
    await handleBackendStartupFailure(`无法载入 ${PRODUCT_NAME} 界面：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Contain shell and official renderer crashes according to their ownership. */
function handleRendererGone(kind, details) {
  const window = mainWindow
  if (quitStarted || pluginBackendPaused || window === undefined || window.isDestroyed() || details.reason === 'clean-exit') return
  const reason = kind === 'official'
    ? `官方 Harness 界面进程意外退出（${details.reason}）。`
    : `桌面标题栏进程意外退出（${details.reason}）。`
  if (kind === 'official' && selectedRuntime?.source === 'managed') void handleBackendStartupFailure(reason)
  else showFailure(reason)
}

/** Stop a failed runtime before selecting a verified old slot or returning to installation. */
async function handleBackendStartupFailure(reason) {
  if (quitStarted || pluginBackendPaused || failureShown || startupFailureHandling) return
  backendReadiness?.fail(new Error(reason))
  startupFailureHandling = true
  clearStartupTimer()
  appendLog('desktop', `${reason}\n`)
  const failedRuntime = selectedRuntime
  const child = backend
  const exit = backendExit
  if (failedRuntime?.source !== 'managed') {
    startupFailureHandling = false
    showFailure(reason)
    return
  }

  persistRuntimeState(
    markRuntimeFailed(readRuntimeState(app.getPath('userData')), failedRuntime),
    `quarantining managed runtime ${failedRuntime.version}`,
  )
  if (child !== undefined && exit !== undefined && !hasExited(child)) {
    void sendShutdownRequest(child)
    let stopped = await resolvesBefore(exit, 1_000)
    if (!stopped && !hasExited(child)) {
      try {
        await terminateRecordedProcessTree(child)
        stopped = await resolvesBefore(exit, FORCE_EXIT_WAIT_MS)
      } catch (error) {
        appendLog('desktop', `failed runtime cleanup warning: ${String(error)}\n`)
      }
    }
    if (!stopped && !hasExited(child)) {
      startupFailureHandling = false
      showFailure(`${reason}\n\n无法停止失败的 Harness 进程，因此没有启动另一个版本。`)
      return
    }
  }
  if (backend === child) {
    backend = undefined
    backendExit = undefined
    backendOrigin = undefined
  }
  if (quitStarted) return
  const fallbackRuntime = selectRuntime(app.getPath('userData'), runtimeState)
  selectedRuntime = fallbackRuntime
  updateManager?.replaceState(runtimeState, fallbackRuntime)
  startupFailureHandling = false
  if (fallbackRuntime === undefined) {
    appendLog('desktop', `no usable installed runtime after ${failedRuntime.version}; opening installation\n`)
    await firstRunSetup?.recover(reason)
  } else {
    appendLog('desktop', `quarantined ${failedRuntime.version}; falling back to installed ${fallbackRuntime.version}\n`)
    startBackend(fallbackRuntime)
  }
}

/** Keep state persistence failures from escaping Electron event callbacks. */
function persistRuntimeState(nextState, context) {
  runtimeState = nextState
  try {
    runtimeState = writeRuntimeState(app.getPath('userData'), nextState)
  } catch (error) {
    appendLog('desktop', `runtime state write failed while ${context}: ${String(error)}\n`)
  }
  return runtimeState
}

/** Open one append-only log for this application run. */
function openLog() {
  const directory = app.getPath('logs')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  logPath = join(directory, `deepseek-harness-desktop-${stamp}.log`)
  const stream = createWriteStream(logPath, { flags: 'a' })
  logStream = stream
  stream.on('error', (error) => {
    if (logStream === stream) logStream = undefined
    recentOutput = `${recentOutput}[desktop] log error: ${error.message}\n`.slice(-MAX_FAILURE_OUTPUT)
    if (!quitStarted) showFailure(`无法写入运行日志：${error.message}`)
  })
}

/**
 * Append backend output and keep a bounded in-memory diagnostic tail.
 * @param {string} source output source label.
 * @param {string} value output text.
 */
function appendLog(source, value) {
  const entry = `[${new Date().toISOString()}] [${source}] ${redactHarnessTokens(value)}`
  if (logStream !== undefined && !logStream.destroyed) logStream.write(entry)
  recentOutput = `${recentOutput}${entry}`.slice(-MAX_FAILURE_OUTPUT)
}

/**
 * Present one startup/runtime failure and begin bounded backend shutdown.
 * @param {string} reason user-facing failure summary.
 */
function showFailure(reason) {
  if (failureShown || quitStarted) return
  backendReadiness?.fail(new Error(reason))
  desktopTray?.showWindow()
  reason = redactHarnessTokens(reason)
  failureShown = true
  clearStartupTimer()
  appendLog('desktop', `${reason}\n`)
  const occupied = recentOutput.includes('EADDRINUSE')
    ? `\n\n端口 ${String(DESKTOP_PORT)} 已被占用，请关闭占用它的程序后重试。`
    : ''
  const detail = `${reason}${occupied}\n\n日志：${logPath ?? '尚未创建'}`
  const options = {
    type: 'error',
    title: `${PRODUCT_NAME} 启动失败`,
    message: '本地 Harness 服务无法继续运行。',
    detail,
  }
  const prompt = mainWindow !== undefined && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
  void prompt.catch((error) => {
    dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, `${detail}\n\n${String(error)}`)
  }).finally(() => { app.quit() })
}

/** Clear the outstanding startup deadline. */
function clearStartupTimer() {
  if (startupTimer !== undefined) clearTimeout(startupTimer)
  startupTimer = undefined
}

/** A restore must never swap live plugin files underneath the supervised backend. */
async function withPluginBackendStopped(operation, { waitUntilReady = false } = {}) {
  if (quitStarted || pluginBackendPaused || startupFailureHandling || pluginManager?.recoveryRequired) throw new Error('plugin backend pause unavailable')
  pluginBackendPaused = true
  const runtime = selectedRuntime
  let stopped = false
  clearStartupTimer()
  desktopWindow?.showLoading()
  try {
    await shutdownBackend()
    stopped = true
    backend = undefined
    backendExit = undefined
    backendOrigin = undefined
    await operation()
  } finally {
    pluginBackendPaused = false
    if (stopped && !quitStarted && !pluginManager?.snapshotRecoveryRequired) {
      failureShown = false
      startupFailureHandling = false
      if (runtime) {
        const ready = startBackend(runtime)
        if (waitUntilReady) {
          if (!ready) throw new Error('plugin backend restart unavailable')
          await ready
        }
      }
      else await firstRunSetup?.show()
    } else if (!stopped && backendOrigin !== undefined) {
      // A failed shutdown did not authorize a file restore; keep the still-live UI accessible.
      desktopWindow?.officialView.setVisible(true)
    } else if (!quitStarted) showClientSettings('plugins')
    settingsController?.refresh()
  }
}

/** Ask the CLI to dispose, then terminate its recorded process tree on timeout. */
async function shutdownBackend() {
  backendReadiness?.fail()
  clearStartupTimer()
  const child = backend
  if (child === undefined || backendExit === undefined || hasExited(child)) return

  void sendShutdownRequest(child)
  const stopped = await resolvesBefore(backendExit, BACKEND_TREE_KILL_DELAY_MS)
  if (stopped) return
  appendLog('desktop', 'graceful shutdown timed out; terminating recorded process tree\n')
  let terminationError
  try {
    await terminateRecordedProcessTree(child)
  } catch (error) {
    terminationError = error
    appendLog('desktop', `forced termination failed: ${String(error)}\n`)
    if (!hasExited(child)) {
      const killed = child.kill('SIGKILL')
      appendLog('desktop', `direct backend termination fallback accepted: ${String(killed)}\n`)
    }
  }
  const forceStopped = await resolvesBefore(backendExit, FORCE_EXIT_WAIT_MS)
  if (!forceStopped && !hasExited(child)) {
    const suffix = terminationError === undefined ? '' : ` ${String(terminationError)}`
    throw new Error(`Harness 后台仍在运行。${suffix}`)
  }
}

/**
 * Send one callback-observed IPC request without racing channel closure.
 * @param {import('node:child_process').ChildProcess} child spawned backend.
 */
async function sendShutdownRequest(child) {
  if (!child.connected) return
  await new Promise((resolve) => {
    try {
      child.send({ type: 'dsh:shutdown' }, (error) => {
        if (error != null) appendLog('desktop', `IPC shutdown failed: ${error.message}\n`)
        resolve()
      })
    } catch (error) {
      appendLog('desktop', `IPC shutdown failed: ${String(error)}\n`)
      resolve()
    }
  })
}

/**
 * Test whether Node has observed backend process termination.
 * @param {import('node:child_process').ChildProcess} child spawned backend.
 * @returns {boolean} whether the child has exited.
 */
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Wait for a promise without leaving its timer armed.
 * @template T
 * @param {Promise<T>} promise operation to wait for.
 * @param {number} timeoutMs maximum wait.
 * @returns {Promise<boolean>} whether the operation settled in time.
 */
async function resolvesBefore(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Terminate the process tree rooted at the recorded backend PID.
 * @param {import('node:child_process').ChildProcess} child spawned backend.
 */
async function terminateRecordedProcessTree(child) {
  if (hasExited(child) || child.pid === undefined || child.pid < 1) return
  if (process.platform !== 'win32') {
    if (!child.kill('SIGKILL') && !hasExited(child)) throw new Error('Node refused to terminate the backend process')
    return
  }
  const taskkill = resolveWindowsTaskkillPath(process.env)
  const code = await new Promise((resolve, reject) => {
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killer.kill('SIGKILL')
      reject(new Error(`taskkill timed out after ${String(TASKKILL_TIMEOUT_MS)}ms`))
    }, TASKKILL_TIMEOUT_MS)
    killer.once('error', (error) => {
      finish(reject, error)
    })
    killer.once('close', (exitCode) => {
      finish(resolve, exitCode)
    })
  })
  if (code !== 0 && !hasExited(child)) throw new Error(`taskkill exited with code ${String(code)}`)
}

/** Wait until the current log stream has flushed and closed. */
async function closeLog() {
  const stream = logStream
  logStream = undefined
  if (stream === undefined || stream.destroyed) return
  await new Promise((resolve) => { stream.end(resolve) })
}

app.on('window-all-closed', () => { app.quit() })
app.on('before-quit', (event) => {
  if (mayQuit) return
  event.preventDefault()
  if (quitStarted) return
  if (runtimeVersions?.isBusy() && !runtimeVersions.committed) {
    showClientSettings('harness')
    if (!pluginQuitNotice) {
      pluginQuitNotice = dialog.showMessageBox({ type: 'info', title: '版本操作尚未结束',
        message: '请等待版本校验或数据备份结束后再退出',
        detail: '仍可关闭主窗口留在托盘；请勿同时在外部终端操作 Harness 数据。',
      }).catch(() => {}).finally(() => { pluginQuitNotice = undefined })
    }
    return
  }
  if (pluginManager?.recoveryRequired && !pluginRecoveryExitApproved) {
    if (!pluginQuitNotice) {
      pluginQuitNotice = dialog.showMessageBox({ type: 'warning', title: '插件进程需要检查',
        message: '尚未确认插件进程已退出',
        detail: '客户端可以退出，但后台可能仍有插件安装进程。请先核查运行日志及残留进程，避免重新打开后同时修改插件。',
        buttons: ['仍然退出', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      }).then(choice => {
        if (choice.response === 0) { pluginRecoveryExitApproved = true; app.quit() }
      }).catch(() => { appendLog('plugins', 'could not show plugin recovery notice\n') })
        .finally(() => { pluginQuitNotice = undefined })
    }
    return
  }
  if (pluginManager?.isBusy()) {
    showClientSettings('plugins')
    if (!pluginQuitNotice) {
      pluginQuitNotice = dialog.showMessageBox({ type: 'info', title: '插件操作尚未结束',
        message: '请等待插件操作结束后再退出',
        detail: '官方插件命令正在处理依赖或等待确认。为避免中断后配置不完整，暂不退出；仍可关闭主窗口留在托盘。',
      }).catch(() => { appendLog('plugins', 'could not show plugin shutdown notice\n') })
        .finally(() => { pluginQuitNotice = undefined })
    }
    return
  }
  quitStarted = true
  runtimeVersions?.dispose()
  pluginManager?.dispose()
  settingsController?.dispose()
  settingsWindow?.dispose()
  language?.dispose()
  settingsController = undefined
  settingsWindow = undefined
  shellUpdateManager?.dispose()
  firstRunSetup?.dispose()
  firstRunSetup = undefined
  desktopTray?.dispose()
  desktopTray = undefined
  stopShellThemeSync?.()
  stopShellThemeSync = undefined
  // Destroy shell-owned progress UI before aborting background work. npm and
  // the worker may emit one final activity snapshot while winding down; that
  // late event must never recreate a window during application shutdown.
  updateProgressWindow?.dispose()
  updateProgressWindow = undefined
  void (async () => {
    try {
      await Promise.all([
        updateManager?.dispose(),
        shutdownBackend(),
      ])
    } catch (error) {
      installClientAfterShutdown = undefined
      appendLog('desktop', `shutdown did not reach quiescence: ${String(error)}\n`)
      dialog.showErrorBox(`${PRODUCT_NAME} 关闭异常`, `后台进程可能仍在运行。\n\n${String(error)}\n\n日志：${logPath ?? '尚未创建'}`)
    }
    desktopWindow?.dispose()
    desktopWindow = undefined
    await closeLog()
    mayQuit = true
    if (installClientAfterShutdown !== undefined) {
      try { installClientAfterShutdown() } catch (error) {
        dialog.showErrorBox('客户端更新未安装', String(error))
        app.quit()
      }
    } else app.quit()
  })()
})
