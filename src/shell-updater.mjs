import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME, SHELL_RELEASE_SOURCE, SHELL_RELEASES_URL } from './release-config.mjs'

const DAY = 24 * 60 * 60 * 1000
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u

/** Validate stable NSIS release metadata before allowing the updater to download an executable. */
export function validateShellRelease(info) {
  if (!info || typeof info.version !== 'string' || !VERSION.test(info.version)) throw new Error('客户端发布版本格式无效')
  const name = `MengLuo-DSH-Desktop-${info.version}-setup.exe`
  if (!Array.isArray(info.files) || info.files.length !== 1) throw new Error('客户端发布必须只包含一个安装版更新条目')
  const file = info.files[0]
  if (file?.url !== name || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512)) {
    throw new Error('客户端安装包名称或校验信息无效')
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1024 * 1024 * 1024) {
    throw new Error('客户端安装包大小无效')
  }
  return Object.freeze({ version: info.version, name, size: file.size })
}

/** Main-process client updater. Harness runtime directories are not inputs to this updater. */
export class ShellUpdateManager {
  constructor(options) {
    this.options = options
    this.updater = options.updater
    this.preferencesPath = join(options.userData, 'client-updates.json')
    this.preferences = { autoCheck: true, lastCheckedAt: 0, lastNotifiedVersion: '' }
    try {
      const value = JSON.parse(readFileSync(this.preferencesPath, 'utf8'))
      if (typeof value.autoCheck === 'boolean') this.preferences.autoCheck = value.autoCheck
      if (Number.isSafeInteger(value.lastCheckedAt) && value.lastCheckedAt >= 0) this.preferences.lastCheckedAt = value.lastCheckedAt
      if (typeof value.lastNotifiedVersion === 'string' && VERSION.test(value.lastNotifiedVersion)) this.preferences.lastNotifiedVersion = value.lastNotifiedVersion
    } catch (error) {
      if (error?.code !== 'ENOENT') options.log(`client update preferences ignored: ${String(error)}\n`)
    }
    this.state = { status: 'idle', currentVersion: options.version }
    this.disposed = false
    this.checkPromise = undefined
    this.downloadPromise = undefined
    this.timer = undefined
    this.notification = undefined
    this.listeners = []
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.allowPrerelease = false
    this.updater.allowDowngrade = false
    this.updater.disableDifferentialDownload = false
    this.updater.disableWebInstaller = true
    this.updater.setFeedURL(SHELL_RELEASE_SOURCE)
    this.updater.logger = {
      info: message => options.log(`${String(message)}\n`),
      warn: message => options.log(`${String(message)}\n`),
      error: message => options.log(`${String(message)}\n`),
      debug: () => {},
    }
    this.listen('error', error => {
      options.log(`client updater error: ${String(error)}\n`)
      if (this.installStarted) options.onInstallError?.(error)
      if (!this.disposed) this.setState({ status: 'error', error: error.message ?? String(error) })
    })
    this.listen('download-progress', value => {
      if (this.disposed || this.state.status !== 'downloading') return
      const total = Number.isFinite(value.total) && value.total > 0 ? value.total : undefined
      const transferred = Number.isFinite(value.transferred) && value.transferred >= 0 ? value.transferred : 0
      const speed = Number.isFinite(value.bytesPerSecond) && value.bytesPerSecond > 0 ? value.bytesPerSecond : undefined
      this.setState({
        transferred, total, speed,
        percent: total === undefined ? undefined : Math.min(100, transferred / total * 100),
        remainingSeconds: total !== undefined && speed !== undefined ? Math.ceil(Math.max(0, total - transferred) / speed) : undefined,
      })
    })
  }

  listen(event, callback) {
    this.updater.on(event, callback)
    this.listeners.push([event, callback])
  }

  start() {
    this.setState({})
    this.schedule(true)
  }

  setState(patch) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.options.progress?.update(this.state)
    this.options.onMenuChanged?.()
  }

  persist() {
    try {
      mkdirSync(this.options.userData, { recursive: true })
      writeFileSync(`${this.preferencesPath}.tmp`, `${JSON.stringify(this.preferences)}\n`)
      renameSync(`${this.preferencesPath}.tmp`, this.preferencesPath)
      return true
    } catch (error) { this.options.log(`client update preferences save failed: ${String(error)}\n`); return false }
  }

  updatePreferences(patch) {
    if (this.disposed) return
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))
      || Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'autoCheck')
      || typeof patch.autoCheck !== 'boolean') throw new Error('无效的客户端更新设置')
    const previous = this.preferences
    this.preferences = { ...previous, autoCheck: patch.autoCheck }
    if (!this.persist()) { this.preferences = previous; throw new Error('无法保存客户端更新设置') }
    this.schedule(true)
    this.options.onMenuChanged?.()
  }

  getSettingsState() {
    return {
      ...this.state, supported: this.options.supported, autoCheck: this.preferences.autoCheck,
      error: this.state.status === 'error' ? '客户端更新未完成，请重试或查看日志。' : undefined,
    }
  }

  schedule(initial = false) {
    clearTimeout(this.timer)
    if (this.disposed || !this.options.supported || !this.preferences.autoCheck) return
    const elapsed = Math.max(0, Date.now() - this.preferences.lastCheckedAt)
    const delay = Math.max(initial ? 30_000 : 60_000, DAY - elapsed)
    this.timer = setTimeout(() => { void this.check(false) }, delay)
    this.timer.unref?.()
  }

  async check(manual = true) {
    if (this.disposed) return
    if (!this.options.supported) {
      if (manual) await this.options.showMessage({
        type: 'info', title: '客户端更新', message: '开发版和便携版不支持自动替换',
        detail: '请从发布页下载并安装安装版，以后即可使用差分自更新。', buttons: ['打开发布页', '取消'], cancelId: 1,
      }).then(choice => { if (choice.response === 0 && !this.disposed) this.options.openExternal(SHELL_RELEASES_URL) })
      return
    }
    if (this.downloadPromise || this.state.status === 'downloaded' || this.state.status === 'installing') {
      if (manual) this.options.progress?.show()
      return
    }
    if (!this.checkPromise) {
      // A new check replaces the updater's internal candidate. Never retain permission
      // to download an older candidate if the new metadata fails validation.
      this.release = undefined
      this.setState({ status: 'checking', version: undefined, error: undefined, percent: undefined })
      this.checkPromise = (async () => {
        const result = await this.updater.checkForUpdates()
        if (this.disposed) return
        if (!result || result.isUpdateAvailable !== true) {
          this.release = undefined
          this.setState({ status: 'idle', version: undefined })
          return false
        }
        this.release = validateShellRelease(result.updateInfo)
        this.setState({ status: 'available', version: this.release.version })
        return true
      })().finally(() => {
        this.checkPromise = undefined
        if (!this.disposed) {
          this.preferences.lastCheckedAt = Date.now()
          this.persist()
          this.schedule()
          this.options.onMenuChanged?.()
        }
      })
    }
    try {
      const available = await this.checkPromise
      if (this.disposed) return
      if (manual && available) await this.promptDownload()
      else if (manual) await this.options.showMessage({ type: 'info', title: '客户端更新', message: '客户端已经是最新版', detail: `${PRODUCT_NAME} ${this.options.version}` })
      else if (available && this.preferences.lastNotifiedVersion !== this.release.version) {
        this.preferences.lastNotifiedVersion = this.release.version
        this.persist()
        this.notify(`客户端 ${this.release.version} 可更新`, '点击选择是否下载，当前工作不会被中断。', () => { void this.promptDownload() })
      }
    } catch (error) {
      if (this.disposed) return
      this.setState({ status: 'error', error: error.message ?? String(error) })
      if (manual) await this.options.showMessage({ type: 'warning', title: '客户端更新', message: '暂时无法检查客户端更新', detail: `${error.message ?? String(error)}\n\n现有客户端和 Harness 不受影响。` })
    }
  }

  async promptDownload() {
    if (this.disposed || !this.release || this.downloadPromise || this.checkPromise || this.downloadPrompt
      || !['available', 'error'].includes(this.state.status)) return
    this.downloadPrompt = true
    const authorizedRelease = this.release
    const version = authorizedRelease.version
    try {
      const choice = await this.options.showMessage({
      type: 'info', title: '客户端更新', message: `发现客户端 ${version}`,
      detail: '只更新桌面壳。优先差分下载，不能差分时自动下载完整安装包；不会重新安装 Harness 或插件。',
      buttons: ['下载更新', '稍后'], cancelId: 1, defaultId: 0, noLink: true,
    })
      if (choice.response === 0 && !this.disposed && this.release === authorizedRelease) await this.download()
    } finally { this.downloadPrompt = false }
  }

  async download() {
    if (this.disposed || !this.release || this.downloadPromise || this.checkPromise || !this.options.supported
      || !['available', 'error'].includes(this.state.status)) return
    this.options.progress?.show()
    this.setState({ status: 'downloading', error: undefined, percent: undefined, transferred: 0, total: undefined, speed: undefined, remainingSeconds: undefined })
    this.cancellation = this.options.createCancellationToken()
    this.downloadPromise = Promise.resolve().then(() => this.updater.downloadUpdate(this.cancellation))
    try {
      const paths = await this.downloadPromise
      if (this.disposed) return
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('更新器没有返回已校验的安装包')
      this.setState({ status: 'downloaded', percent: 100, remainingSeconds: 0 })
      this.notify('客户端更新已准备好', '点击确认重启安装。Harness、插件和聊天数据会保留。', () => { void this.install() })
    } catch (error) {
      if (!this.disposed) this.setState({ status: 'error', error: error.message ?? String(error) })
    } finally {
      this.downloadPromise = undefined
      this.cancellation = undefined
      if (!this.disposed) this.options.onMenuChanged?.()
    }
  }

  async install() {
    if (this.disposed || this.state.status !== 'downloaded' || this.installPrompt) return
    if (this.options.isHarnessInstalling()) {
      await this.options.showMessage({ type: 'info', title: '客户端更新', message: '请等待 Harness 安装、更新或插件操作完成后再重启客户端' })
      return
    }
    this.installPrompt = true
    try {
      const choice = await this.options.showMessage({
        type: 'question', title: '重启并安装客户端更新', message: `安装客户端 ${this.release.version}？`,
        detail: '重启会停止当前 Harness 任务，请先保存工作。只替换客户端程序，不删除 Harness、插件或聊天数据。',
        buttons: ['重启安装', '稍后'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (choice.response !== 0 || this.disposed || this.options.isHarnessInstalling()) return
      this.setState({ status: 'installing' })
      // The main process must stop Harness and flush logs before invoking this callback.
      const accepted = this.options.requestInstall(() => {
        this.installStarted = true
        this.updater.quitAndInstall(false, true)
      })
      if (!accepted) this.setState({ status: 'downloaded' })
    } finally { this.installPrompt = false }
  }

  notify(title, body, onClick) {
    if (this.disposed || !this.options.Notification.isSupported()) return
    this.notification?.close()
    const notification = new this.options.Notification({ title, body })
    this.notification = notification
    notification.on('click', () => { if (!this.disposed) onClick() })
    notification.show()
  }

  menuItems() {
    const busy = Boolean(this.checkPromise || this.downloadPromise) || this.state.status === 'installing'
    return [
      { label: `客户端：${this.options.version}`, enabled: false },
      { label: this.state.status === 'checking' ? '正在检查客户端更新…' : '检查客户端更新…', enabled: !busy, click: () => { void this.check() } },
      ...(this.release && !busy && this.state.status !== 'downloaded' ? [{ label: `下载客户端 ${this.release.version}…`, click: () => { void this.promptDownload() } }] : []),
      ...(this.state.status === 'downloaded' ? [{ label: `重启并安装客户端 ${this.release?.version}…`, click: () => { void this.install() } }] : []),
      ...(this.state.status === 'downloading' || this.state.status === 'downloaded' || this.state.status === 'error'
        ? [{ label: '显示客户端更新进度…', click: () => { this.options.progress?.show() } }] : []),
      { label: '每天自动检查客户端更新', type: 'checkbox', checked: this.preferences.autoCheck, enabled: this.options.supported,
        click: item => { this.preferences.autoCheck = item.checked; this.persist(); this.schedule(true); this.options.onMenuChanged?.() } },
      { label: '客户端发布页', click: () => { this.options.openExternal(SHELL_RELEASES_URL) } },
      { type: 'separator' },
    ]
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.cancellation?.cancel()
    this.notification?.close()
    // Keep the error sink until process exit: quitAndInstall can emit an error after shutdown preparation.
    for (const [event, listener] of this.listeners) if (event !== 'error') this.updater.removeListener(event, listener)
    this.options.progress?.dispose()
  }
}
