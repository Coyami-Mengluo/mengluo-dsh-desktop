import { DOWNLOAD_SOURCES, readDownloadPreferences, resolveDownloadSource, writeDownloadPreferences } from './download-source.mjs'
import { parseResolvedProxy } from './update-manager.mjs'
import { validateSettingsAction } from './settings-window.mjs'
import { describeRegistryVersion, probeRegistryVersion } from './registry-probe.mjs'

/** Main-process settings actions. Renderer data can select actions, never paths, commands or URLs. */
export class DesktopSettingsController {
  constructor(options) {
    this.options = options
    this.preferences = readDownloadPreferences(options.userData)
    this.probe = { status: 'idle', detail: '检测仅反映连接是否可用，不代表实际下载速度。' }
    this.proxyStatus = '使用 Windows 系统代理规则，尚未读取当前状态。'
    this.activity = ''
    this.disposed = false
    this.probePromise = undefined
    this.proxyRevision = 0
  }

  isHarnessBusy() {
    const harness = this.options.harness
    return harness.installPromise !== undefined || harness.preparingVersion !== undefined || this.options.isStarting?.() === true
      || this.options.versions?.isBusy() === true || Boolean(this.options.versions?.catalogPromise)
      || (this.options.plugins?.blocksUpdates?.() ?? this.options.plugins?.isBusy()) === true
  }

  getDownloadState() {
    return {
      source: this.preferences.source,
      activity: this.activity,
      sources: DOWNLOAD_SOURCES.map(({ id, label, description }) => ({ id, label, description })),
      busy: this.isHarnessBusy() || this.probe.status === 'checking',
    }
  }

  getState() {
    return {
      harness: this.options.harness.getSettingsState(),
      client: this.options.client.getSettingsState(),
      plugins: this.options.plugins?.getState(),
      versions: this.options.versions?.getState(),
      network: { ...this.getDownloadState(), proxyStatus: this.proxyStatus, probe: this.probe, activity: this.activity },
      about: {
        productName: this.options.productName, clientVersion: this.options.client.options.version,
        harnessVersion: this.options.harness.currentRuntime?.version, logAvailable: this.options.logAvailable(),
      },
    }
  }

  refresh() {
    if (!this.disposed) this.options.onChanged?.(this.getState())
  }

  setDownloadSource(id) {
    if (this.disposed || this.getDownloadState().busy) throw new Error('当前操作结束后才能切换下载源')
    if (!['official', 'npmmirror'].includes(id)) throw new Error('unsupported download source')
    const source = resolveDownloadSource(id)
    this.preferences = writeDownloadPreferences(this.options.userData, { source: source.id })
    this.probe = { status: 'idle', detail: '下载源已保存，下次 Harness 安装或更新时生效。' }
    this.activity = ''
    this.refresh()
    void this.inspectProxy()
    return this.preferences
  }

  reportDownloadStatus(status) {
    if (this.disposed || !status || !['official', 'npmmirror'].includes(status.source) || typeof status.detail !== 'string') return
    this.activity = status.detail.slice(0, 512)
    this.refresh()
  }

  async inspectProxy() {
    if (this.disposed) return
    const revision = ++this.proxyRevision
    const source = resolveDownloadSource(this.preferences.source)
    let timer
    try {
      const rules = await Promise.race([
        this.options.app.resolveProxy(new URL('@deepseek-ai%2Fdsh', source.registry).href),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('proxy timeout')), 5_000); timer.unref?.() }),
      ])
      if (this.disposed || revision !== this.proxyRevision) return
      const proxy = parseResolvedProxy(rules)
      this.proxyStatus = proxy ? `当前下载源使用系统代理：${proxy}`
        : typeof rules === 'string' && rules.trim().toUpperCase() === 'DIRECT' ? '当前下载源按系统规则直连。'
          : '未识别到可用于 npm 的系统代理；连接情况请运行检测。'
    } catch {
      if (this.disposed || revision !== this.proxyRevision) return
      this.proxyStatus = '暂时无法读取系统代理；未修改系统网络设置。'
    } finally {
      clearTimeout(timer)
      if (revision === this.proxyRevision) this.refresh()
    }
  }

  testConnection(requestedVersion) {
    if (this.disposed) return Promise.resolve({ ok: false, message: '客户端正在退出。' })
    if (this.probePromise) return this.probePromise
    if (this.isHarnessBusy()) return Promise.resolve({ ok: false, message: '请等待当前 Harness 操作结束后再检测。' })
    const selected = resolveDownloadSource(this.preferences.source)
    const harness = this.options.harness
    const version = requestedVersion ?? harness.state.pendingVersion ?? harness.availableRelease?.version ?? harness.currentRuntime?.version
    const sources = selected.id === 'official' ? [selected] : [selected, resolveDownloadSource('official')]
    const controller = new AbortController()
    this.probeAbort = controller
    const timer = setTimeout(() => controller.abort(), 12_000)
    this.probe = { status: 'checking', detail: '正在检查下载源和官方元数据服务的连接…' }
    this.refresh()
    this.probePromise = (async () => {
      const [results, synchronization] = await Promise.all([Promise.all(sources.map(async source => {
        const start = Date.now()
        try {
          const response = await this.options.net.fetch(new URL('-/ping', source.registry).href, {
            method: 'GET', redirect: 'error', signal: controller.signal,
          })
          await response.body?.cancel()
          return { source, ok: response.status === 200, elapsed: Date.now() - start }
        } catch { return { source, ok: false } }
      })), probeRegistryVersion({ fetch: (...args) => this.options.net.fetch(...args), source: selected.id, version, signal: controller.signal })])
      if (this.disposed) return { ok: false, message: '检测已结束。' }
      const connected = results.every(item => item.ok)
      const ok = connected && ['not-selected', 'official', 'synced'].includes(synchronization.status)
      const detail = [...results.map(item => `${item.source.label}：${item.ok ? `连接正常（${item.elapsed} ms）` : '连接失败，请检查网络或系统代理'}`),
        describeRegistryVersion(synchronization), '此检测不代表实际下载速度，也不保证依赖和文件均已同步。'].join('\n')
      this.probe = { status: ok ? 'success' : connected ? 'warning' : 'error', detail, synchronization }
      return { ok, message: detail }
    })().finally(() => {
      clearTimeout(timer)
      this.probePromise = undefined
      this.probeAbort = undefined
      this.refresh()
    })
    void this.inspectProxy()
    return this.probePromise
  }

  async handleAction(request) {
    if (this.disposed || !validateSettingsAction(request)) return { ok: false, message: '不支持此设置操作。' }
    const { harness, client } = this.options
    try {
      if (request.type.startsWith('harness-version')) {
        if (!this.options.versions) throw new Error('Runtime version manager is unavailable')
        await this.options.versions.handleAction(request)
        this.refresh()
        return { ok: true }
      }
      if (request.type.startsWith('plugin-') || request.type.startsWith('plugins-')) {
        return this.options.plugins ? await this.options.plugins.handleAction(request) : { ok: false, message: '插件管理尚未就绪。' }
      }
      switch (request.type) {
        case 'harness-preferences': {
          const patch = { ...request.patch }
          if (Object.hasOwn(patch, 'channel') && patch.channel === 'auto') patch.channel = undefined
          harness.updatePreferences(patch)
          break
        }
        case 'client-preferences': client.updatePreferences(request.patch); break
        case 'download-source': this.setDownloadSource(request.source); break
        case 'test-connection': return await this.testConnection()
        case 'harness-check':
          if (this.isHarnessBusy()) throw new Error('Harness is busy')
          await harness.checkForUpdates({ manual: true })
          break
        case 'harness-setup':
          if (harness.currentRuntime !== undefined || this.isHarnessBusy()) throw new Error('setup unavailable')
          this.options.showSetup()
          break
        case 'harness-download':
          if (this.isHarnessBusy() || harness.state.versionLocked || !harness.availableRelease) throw new Error('no candidate')
          harness.prepareRelease(harness.availableRelease, { reportFailure: true })
          break
        case 'harness-restart':
          if (this.isHarnessBusy() || !harness.state.pendingVersion) throw new Error('no pending runtime')
          await harness.promptRestart({ version: harness.state.pendingVersion })
          break
        case 'harness-progress': harness.reportProgress('show'); break
        case 'terminal': await harness.openRuntimeTerminal(); break
        case 'client-check': await client.check(); break
        case 'client-download': await client.promptDownload(); break
        case 'client-install': await client.install(); break
        case 'client-progress': client.options.progress?.show(); break
        case 'open-log':
          if (!this.options.logAvailable()) throw new Error('log unavailable')
          this.options.openLog()
          break
        case 'open-repository': this.options.openRepository(); break
        case 'open-official': this.options.openOfficial(); break
        case 'open-client-releases': this.options.openClientReleases(); break
        default: return { ok: false, message: '不支持此设置操作。' }
      }
      this.refresh()
      return { ok: true }
    } catch (error) {
      this.options.log(`settings action ${request.type} failed: ${String(error)}\n`)
      this.refresh()
      return { ok: false, message: '操作未完成，请等待当前任务结束后重试，或查看运行日志。' }
    }
  }

  dispose() {
    this.disposed = true
    this.proxyRevision += 1
    this.probeAbort?.abort()
  }
}
