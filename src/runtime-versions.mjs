import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { compareSemver, parseSemver } from './update-policy.mjs'
import { managedRuntimeDirectory, markRuntimePending } from './runtime-store.mjs'
import { runUpdateWorker } from './update-manager.mjs'

export function validRuntimeVersion(value) {
  try { return typeof value === 'string' && value.length <= 80 && Boolean(parseSemver(value)) } catch { return false }
}

/** Cheap discovery only. Integrity and isolated startup are checked in a worker before switching. */
export async function listInstalledVersions(userData) {
  const store = join(userData, 'harness-runtimes')
  try {
    const stat = await lstat(store)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return []
    const entries = await readdir(store, { withFileTypes: true })
    const versions = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !validRuntimeVersion(entry.name)) continue
      const seal = join(managedRuntimeDirectory(userData, entry.name), 'desktop-runtime-seal.json')
      try {
        const file = await lstat(seal)
        if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024) continue
        const identity = JSON.parse(await readFile(seal, 'utf8'))
        if (identity.package === '@deepseek-ai/dsh' && identity.version === entry.name) versions.push(entry.name)
      } catch { /* Incomplete/quarantined slots are not selectable. */ }
    }
    return versions.sort((a, b) => compareSemver(b, a))
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Explicit version changes are serialized with install, plugin and client-update operations. */
export class RuntimeVersionManager {
  constructor(options) {
    this.options = options
    this.updater = options.updater
    this.installed = []
    this.releases = []
    this.phase = 'idle'
    this.error = ''
    this.catalogError = false
    this.catalogPromise = undefined
    this.refreshAfter = 0
    this.closed = false
    this.committed = false
  }

  isBusy() { return !['idle', 'installed', 'error'].includes(this.phase) }
  changed() { this.options.onChanged?.() }
  setPhase(phase, progress) { this.phase = phase; this.progress = progress; this.changed() }
  available() {
    if (this.closed || this.isBusy() || this.catalogPromise || this.options.isBlocked?.()
      || this.updater.installPromise || this.updater.checkPromise || !this.updater.currentRuntime) throw new Error('Runtime version operation unavailable')
  }
  getState() {
    const current = this.updater.currentRuntime?.version
    const known = new Set([...this.installed, ...this.releases.map(item => item.version), ...(current ? [current] : [])])
    return { busy: this.isBusy(), loading: Boolean(this.catalogPromise), phase: this.phase, error: this.error,
      catalogError: this.catalogError, refreshAfter: this.refreshAfter, target: this.target,
      progress: this.progress, locked: this.updater.state.versionLocked,
      items: [...known].sort((a, b) => compareSemver(b, a)).map(version => ({ version,
        installed: this.installed.includes(version), current: version === current,
        preview: parseSemver(version).prerelease.length > 0, failed: this.updater.state.badVersions.includes(version),
      })),
    }
  }
  async refreshLocal() {
    this.installed = await (this.options.listInstalled ?? listInstalledVersions)(this.updater.userData)
    this.changed()
  }
  refreshCatalog() {
    if (this.catalogPromise) return this.catalogPromise
    this.available()
    if (Date.now() < this.refreshAfter) return Promise.resolve()
    this.refreshAfter = Date.now() + 30_000
    this.catalogError = false
    this.catalogPromise = (async () => {
      try {
        await this.refreshLocal()
        const releases = await this.updater.fetchAvailableVersions()
        if (!this.closed) this.releases = releases.filter(item => validRuntimeVersion(item.version))
      } catch (error) { this.catalogError = true; this.options.log(`runtime catalog failed: ${String(error)}\n`) }
      finally { this.catalogPromise = undefined; this.changed() }
    })()
    this.changed()
    return this.catalogPromise
  }
  async handleAction(request) {
    if (request.type === 'harness-versions-backups') { if (!this.closed) await this.options.openBackupFolder(); return }
    if (request.type === 'harness-versions-refresh') return await this.refreshCatalog()
    if (request.type === 'harness-version-lock') {
      this.available()
      if (typeof request.locked !== 'boolean') throw new Error('Invalid version lock')
      if (!this.updater.persistState({ ...this.updater.state, versionLocked: request.locked,
        ...(request.locked ? { pendingVersion: undefined } : {}),
      }, 'saving runtime version lock')) throw new Error('Could not persist runtime lock')
      this.updater.notification?.close?.()
      this.updater.rebuildMenu()
      this.updater.scheduleAutomaticCheck(false)
      this.changed()
      return
    }
    if (!['harness-version-install', 'harness-version-switch'].includes(request.type)) throw new Error('Unknown version operation')
    this.available()
    const version = request.version
    if (!validRuntimeVersion(version) || version === this.updater.currentRuntime.version) throw new Error('Invalid target version')
    const runtime = this.updater.currentRuntime
    this.target = version
    this.error = ''
    this.setPhase('confirming')
    try {
      await this.refreshLocal()
      if (request.type === 'harness-version-install') {
        const release = this.releases.find(item => item.version === version)
        if (!release || this.installed.includes(version)) throw new Error('Unknown/unavailable registry version')
        const choice = await this.options.showMessage({ type: 'question', title: '安装 Harness 版本',
          message: `下载并安装 Harness ${version}？`, detail: '使用独立运行环境，不替换当前版本。安装成功后仍需手动选择切换。',
          buttons: ['安装', '取消'], defaultId: 1, cancelId: 1, noLink: true })
        if (choice.response !== 0) { this.setPhase('idle'); return }
        this.assertCurrent(runtime)
        this.setPhase('installing')
        if (!this.updater.prepareRelease(release, { reportFailure: false, stageOnly: true })) throw new Error('Version installation could not start')
        const installed = await this.updater.installPromise
        if (!installed) throw new Error('Version installation was cancelled')
        this.setPhase('installed')
        await this.refreshLocal()
        return
      }
      if (!this.installed.includes(version)) throw new Error('Selected runtime is not installed')
      const downgrade = compareSemver(version, runtime.version) < 0
      const choice = await this.options.showMessage({ type: 'warning', title: '切换 Harness 版本',
        message: `从 ${runtime.version} 切换到 ${version}？`,
        detail: '请先结束任务，并关闭其他 Harness 实例和插件终端。通过隔离启动测试后会重启客户端，并锁定所选版本。'
          + (downgrade ? '\n\n降级前会在本机备份整个 Harness 数据目录（聊天、配置和插件，不含工作区文件）。备份未加密，可能含密钥；最多 2 GiB / 100000 项，外部链接或备份失败会阻止切换。旧版本可能不兼容新数据，启动失败回退也不会自动还原数据。' : '\n\n切换会继续使用现有聊天、配置和插件。版本兼容性由官方决定，不能保证所有版本均可运行。'),
        buttons: ['验证并重启切换', '取消'], defaultId: 1, cancelId: 1, noLink: true })
      if (choice.response !== 0) { this.setPhase('idle'); return }
      this.assertCurrent(runtime)
      this.setPhase('verifying')
      this.controller = new AbortController()
      await (this.options.verify ?? runUpdateWorker)({ operation: 'verify',
        executable: this.updater.installerNode?.nodePath ?? runtime.nodePath,
        workerPath: this.updater.workerPath, userData: this.updater.userData,
        runnerPath: this.updater.runnerPath, release: { version }, signal: this.controller.signal, log: this.options.log })
      this.assertCurrent(runtime)
      this.setPhase('stopping')
      await this.options.withBackendStopped(async () => {
        if (downgrade) {
          this.setPhase('backup')
          const backupPath = await this.options.backup({ fromVersion: runtime.version, toVersion: version,
            onProgress: progress => { this.setPhase('backup', progress) } })
          this.options.log(`verified Harness downgrade backup: ${backupPath}\n`)
        }
        if (this.closed || this.updater.currentRuntime !== runtime) throw new Error('Runtime changed before committing switch')
        const previous = this.updater.state
        if (!this.updater.persistState({ ...markRuntimePending(previous, version), versionLocked: true }, 'scheduling explicit runtime switch')) throw new Error('Could not save target version')
        this.updater.notification?.close?.()
        this.setPhase('restarting')
        this.committed = true
        try {
          if (this.options.requestRestart() !== true) throw new Error('Client restart was not accepted')
        } catch (error) {
          this.committed = false
          if (!this.updater.persistState(previous, 'undoing cancelled runtime switch')) throw new Error('Could not restore runtime selection; check the runtime state before restarting')
          throw error
        }
      })
    } catch (error) {
      this.error = '版本操作未完成。当前版本未被替换；请检查备份限制、版本兼容性或查看日志。'
      this.options.log(`runtime version operation failed: ${String(error)}\n`)
      this.setPhase('error')
      throw error
    } finally {
      this.controller = undefined
      this.changed()
      this.updater.scheduleAutomaticCheck(false)
    }
  }
  assertCurrent(runtime) {
    if (this.closed || this.updater.currentRuntime !== runtime || this.options.isBlocked?.()
      || this.updater.checkPromise || this.updater.installPromise) throw new Error('Runtime operation became stale')
  }
  dispose() { this.closed = true; this.controller?.abort() }
}
