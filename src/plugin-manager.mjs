import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readInstalledPlugins, runPluginOperation } from './plugin-runtime.mjs'
import { normalizePluginSearchQuery } from './plugin-catalog.mjs'
import { PluginSnapshots } from './plugin-snapshots.mjs'

const SOURCE_NOTICE = '社区插件未经本客户端安全审核，兼容性需以作者说明为准。进入此页会检查更新，但不会自动安装或升级插件。'
const ID = /^[A-Za-z0-9@/_.:-]{1,240}$/u
const SHA = /^[a-f0-9]{40}$/u
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u
const MANUAL_REFRESH_COOLDOWN_MS = 30_000
const SNAPSHOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

/** Main-process coordinator. Only IDs from a freshly read inventory/catalog cross IPC. */
export class PluginManager {
  constructor(options) {
    this.options = options
    this.now = options.now ?? Date.now
    this.catalog = options.catalog
    this.readInstalled = options.readInstalled ?? readInstalledPlugins
    this.runOperation = options.runOperation ?? runPluginOperation
    this.recordPath = join(options.userData, 'plugin-sources.json')
    this.records = this.readRecords()
    this.catalogItems = []
    this.query = ''
    this.catalogQuery = ''
    this.refreshUntil = 0
    this.checkUntil = 0
    this.catalogLoading = false
    this.loadingMore = false
    this.catalogError = ''
    this.catalogRevision = 0
    this.page = 0
    this.total = 0
    this.hasMore = false
    this.limitReached = false
    this.incomplete = false
    this.installed = []
    this.updates = new Map()
    this.updateIdentities = new Map()
    this.busy = false
    this.restarting = false
    this.restartRecommended = false
    this.loading = false
    this.checking = false
    this.checkedAt = undefined
    this.progress = null
    this.error = ''
    this.notice = SOURCE_NOTICE
    this.disposed = false
    this.recoveryRequired = false
    this.snapshotRecoveryRequired = false
    this.snapshotItems = []
    this.snapshotError = ''
    this.snapshotsLoading = false
    this.snapshots = options.snapshots ?? new PluginSnapshots({
      userData: options.userData, dshHome: options.dshHome, now: this.now,
      onProgress: progress => {
        this.progress = { label: '正在处理本地插件快照', detail: progress.detail ?? '复制并校验插件文件…' }
        this.changed()
      },
    })
  }

  isBusy() { return this.busy }
  blocksUpdates() { return this.busy || this.recoveryRequired || this.snapshotRecoveryRequired }

  getRateLimits() {
    const limits = this.catalog.getRateLimitState?.() ?? {}
    return { ...limits, refreshUntil: this.refreshUntil > this.now() ? this.refreshUntil : 0,
      checkUntil: this.checkUntil > this.now() ? this.checkUntil : 0 }
  }

  limited(retryAt, rateLimitScope) {
    this.changed()
    return { ok: false, rateLimited: true, retryAt, rateLimitScope, message: '请求暂时冷却中，请等待倒计时结束后重试。' }
  }

  getState() {
    const blocked = this.options.isBlocked?.() === true
    return {
      installedRuntime: Boolean(this.options.getRuntime()), loading: this.loading,
      busy: this.busy || blocked, checking: this.checking, checkedAt: this.checkedAt,
      restarting: this.restarting, restartRecommended: this.restartRecommended,
      recoveryRequired: this.recoveryRequired,
      snapshots: { items: this.snapshotItems, loading: this.snapshotsLoading, error: this.snapshotError,
        recoveryRequired: this.snapshotRecoveryRequired },
      query: this.query, catalogQuery: this.catalogQuery, rateLimits: this.getRateLimits(),
      catalogLoading: this.catalogLoading, loadingMore: this.loadingMore,
      catalogError: this.catalogError, total: this.total, page: this.page,
      hasMore: this.hasMore && this.query === this.catalogQuery, limitReached: this.limitReached, incomplete: this.incomplete,
      progress: this.progress, error: this.error,
      notice: this.snapshotRecoveryRequired ? '检测到未完成的插件回滚，已暂停 Harness 启动和插件修改。请在本地快照中修复中断的回滚。'
        : this.recoveryRequired ? '上次插件进程尚未确认退出，已暂停插件修改和客户端/Harness 重启更新。请退出后检查残留进程，再重新打开客户端。'
        : blocked ? '请等待 Harness 安装、启动或客户端重启操作结束后再管理插件。' : this.notice,
      catalog: this.catalogItems.map(item => {
        const installed = this.installed.find(plugin => plugin.name === item.name || plugin.github && `${plugin.github.owner}/${plugin.github.repo}`.toLowerCase() === item.repo?.toLowerCase())
        return {
          id: item.id, name: item.name, description: item.description, author: item.author,
          sourceLabel: 'GitHub 社区 · 兼容性未验证', repositoryUrl: item.sourceUrl,
          installed: Boolean(installed), installedId: installed?.id,
        }
      }),
      installed: this.installed.map(item => {
        const update = this.updates.get(item.id)
        return {
          id: item.id, name: item.name, description: item.reason ?? '', version: item.version,
          sourceLabel: item.source === 'npm' ? 'npm' : item.source === 'github' ? 'GitHub' : '其他来源',
          managed: item.managed, updateAvailable: item.managed && update?.status === 'available',
          availableVersion: update?.candidate?.source === 'github'
            ? `${update.candidate.version ?? '提交'} · ${update.candidate.commit?.slice(0, 7) ?? ''}`
            : update?.candidate?.version,
          updateCheckStatus: update?.status, updateCheckMessage: update?.reason,
          repositoryUrl: this.sourceUrl(item),
        }
      }),
    }
  }

  changed() {
    if (this.disposed) return
    try { this.options.onChanged?.() } catch { this.log('plugin view refresh failed\n') }
  }

  log(text) { try { this.options.log?.(text) } catch { /* Diagnostics cannot retain operation locks. */ } }

  /** Local metadata only; never contact a registry or run a plugin to show history. */
  async refreshSnapshots() {
    if (this.snapshotsPromise) return this.snapshotsPromise
    this.snapshotsLoading = true
    this.changed()
    this.snapshotsPromise = (async () => {
      try {
        const recovery = await this.snapshots.getRecoveryState()
        this.snapshotRecoveryRequired = recovery.recoveryRequired === true
        this.snapshotItems = await this.snapshots.list()
        this.snapshotError = ''
        return { ok: true }
      } catch (error) {
        // An unreadable journal must never be interpreted as a clean profile.
        this.snapshotRecoveryRequired = true
        this.snapshotError = '无法读取本地快照或恢复记录，请查看日志；未修改插件。'
        this.log(`plugin snapshot inventory failed: ${String(error).slice(0, 700)}\n`)
        return { ok: false }
      } finally { this.snapshotsLoading = false; this.snapshotsPromise = undefined; this.changed() }
    })()
    return this.snapshotsPromise
  }

  async restoreSnapshot(id, { recover = false } = {}) {
    if (this.disposed || this.busy || this.recoveryRequired || this.loading || this.checking
      || this.options.isBlocked?.() || typeof this.options.withBackendStopped !== 'function') return { ok: false }
    const runtime = this.options.getRuntime()
    if (!recover && (!SNAPSHOT_ID.test(id ?? '') || !runtime || this.snapshotRecoveryRequired)) return { ok: false }
    this.busy = true
    this.error = ''
    this.progress = { label: '检查本地快照', detail: '确认恢复范围与当前状态…' }
    this.changed()
    try {
      await this.refreshSnapshots()
      if (recover ? !this.snapshotRecoveryRequired : this.snapshotRecoveryRequired) throw new Error('snapshot recovery state changed')
      const snapshot = recover ? undefined : this.snapshotItems.find(item => item.id === id)
      if (!recover && (!snapshot || snapshot.runtimeVersion !== runtime.version || !['success', 'failed'].includes(snapshot.status))) {
        throw new Error('snapshot is not restorable under the current Harness version')
      }
      const choice = await this.options.showMessage({
        type: 'warning', title: recover ? '修复中断的插件回滚' : '恢复整个 web 插件环境',
        message: recover ? '恢复到这次回滚开始前的状态？' : `恢复到 ${snapshot.pluginName} 操作前？`,
        detail: '这会先暂停 Harness，正在执行的任务会中断，请先结束重要任务并关闭修改插件的终端。\n\n恢复范围是整个 web profile（全部插件、依赖和该目录内配置），以及客户端插件来源记录；不只恢复单个插件。不会恢复聊天、工作区或插件写到目录外的文件。恢复成功后重新启动 Harness。',
        buttons: [recover ? '检查并修复' : '恢复快照', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (choice.response !== 0) { this.progress = null; return { ok: true, cancelled: true } }
      if (this.disposed || this.options.isBlocked?.() || this.options.getRuntime() !== runtime) throw new Error('Harness state changed')
      await this.options.withBackendStopped(async () => {
        try {
          this.progress = { label: recover ? '修复中断的回滚' : '恢复本地插件快照', detail: '离线校验并切换插件文件…' }
          this.changed()
          if (recover) await this.snapshots.recover()
          else await this.snapshots.restore(id)
        } finally {
          // The backend pause callback must know whether it is safe to restart,
          // including when a partially completed rename throws.
          await this.refreshSnapshots()
        }
      })
      if (this.snapshotRecoveryRequired) throw new Error('snapshot recovery remains pending')
      this.records = this.readRecords()
      this.inventory()
      this.updates.clear()
      this.updateIdentities.clear()
      this.checkedAt = undefined
      this.notice = recover ? '中断的回滚已修复，已恢复到回滚开始前的插件状态。' : '已从本地快照恢复整个 web 插件环境；未下载或执行插件安装脚本。'
      this.progress = { label: '恢复完成', detail: this.notice, percent: 100 }
      return { ok: true }
    } catch (error) {
      if (error?.recoveryRequired === true) this.snapshotRecoveryRequired = true
      this.error = '未能恢复插件快照。当前文件已变化、版本不兼容或快照校验失败时不会覆盖；请查看日志和本地快照中的恢复状态。'
      this.progress = null
      this.log(`plugin snapshot restore failed: ${String(error).slice(0, 700)}\n`)
      return { ok: false, message: this.error }
    } finally { this.busy = false; this.changed() }
  }

  inventory() {
    const runtime = this.options.getRuntime()
    this.installed = runtime ? this.readInstalled({ runtime, dshHome: this.options.dshHome }).plugins : []
    this.pruneUpdates()
    return this.installed
  }

  pruneUpdates() {
    const identities = new Map(this.installed.map(item => [item.id, pluginIdentity(this.tracked(item))]))
    for (const id of this.updates.keys()) {
      if (!identities.has(id) || identities.get(id) !== this.updateIdentities.get(id)) {
        this.updates.delete(id)
        this.updateIdentities.delete(id)
      }
    }
  }

  readRecords() {
    try {
      if (!existsSync(this.recordPath)) return {}
      const stat = lstatSync(this.recordPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) return {}
      const data = JSON.parse(readFileSync(this.recordPath, 'utf8'))
      return Object.fromEntries(Object.entries(data).filter(([name, value]) => ID.test(name) && validRecord(value)))
    } catch { return {} }
  }

  saveRecord(name, candidate) {
    if (candidate?.source === 'github' && validRecord(candidate)) {
      this.records[name] = { spec: candidate.spec, repo: candidate.repo, ref: candidate.ref, commit: candidate.commit }
    } else delete this.records[name]
    if (existsSync(this.recordPath)) {
      const stat = lstatSync(this.recordPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('插件更新来源记录不是普通文件')
    }
    const temporary = `${this.recordPath}.${randomUUID()}.tmp`
    let created = false
    try {
      writeFileSync(temporary, `${JSON.stringify(this.records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      created = true
      renameSync(temporary, this.recordPath)
      created = false
    } finally { if (created) { try { unlinkSync(temporary) } catch { /* Retain an owned orphan on cleanup failure. */ } } }
  }

  tracked(item) {
    const record = this.records[item.name]
    // Never apply an old tracking branch to a plugin replaced manually in the terminal.
    return record?.spec === item.spec ? { ...item, ...record } : item
  }

  sourceUrl(item) {
    const tracked = this.tracked(item)
    const repo = tracked.repo ?? (item.github && `${item.github.owner}/${item.github.repo}`)
    if (typeof repo === 'string' && REPO.test(repo)) return `https://github.com/${repo}`
    if (item.source === 'npm' && ID.test(item.name)) return `https://www.npmjs.com/package/${encodeURIComponent(item.name)}`
    return undefined
  }

  async refresh({ catalog = true, checkFresh = false } = {}) {
    if (this.disposed || this.busy) return Promise.resolve({ ok: false })
    const limits = this.getRateLimits()
    const scopes = [...(catalog ? [['search', limits.searchUntil], ['refresh', this.refreshUntil]] : []),
      ...(checkFresh ? [['metadata', limits.metadataUntil], ['check', this.checkUntil]] : [])]
    const blocked = scopes.filter(([, until]) => until > this.now()).sort((a, b) => b[1] - a[1])[0]
    if (blocked) return this.limited(blocked[1], blocked[0])
    // Reserve before awaiting either lane; IPC callers cannot bypass the UI cooldown.
    if (catalog) this.refreshUntil = this.now() + MANUAL_REFRESH_COOLDOWN_MS
    if (checkFresh) this.checkUntil = this.now() + MANUAL_REFRESH_COOLDOWN_MS
    const results = await Promise.all([
      this.refreshInstalled({ checkFresh }),
      ...(catalog ? [this.searchCatalog(this.query, { refresh: true })] : []),
    ])
    // A catalog refresh must not inherit an unrelated metadata cooldown. That
    // lane publishes its own status for the installed-plugins update button.
    return catalog ? results[1] : results[0]
  }

  refreshInstalled({ checkFresh = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise
    this.loading = true
    this.error = ''
    this.changed()
    this.refreshPromise = (async () => {
      try {
        this.inventory()
        const result = await this.checkInstalled({ refresh: checkFresh })
        return result ?? { ok: !this.error }
      } catch {
        this.error = '无法读取 web 插件清单，请在运行日志中查看原因，或用 Harness 终端检查配置。'
        return { ok: false }
      }
    })().finally(() => { this.loading = false; this.refreshPromise = undefined; this.changed() })
    return this.refreshPromise
  }

  /** Read-only search requests have their own cancellation lane, independent of update checks. */
  searchCatalog(input, { refresh = false, append = false } = {}) {
    // This lane reads only public metadata; the selected mutation already holds its own immutable candidate.
    if (this.disposed) return Promise.resolve({ ok: false })
    if (typeof input !== 'string') return Promise.resolve({ ok: false })
    let query
    try { query = normalizePluginSearchQuery(input) } catch { return Promise.resolve({ ok: false }) }
    if (append) {
      // A stale renderer cannot append a page for an earlier query or choose arbitrary page numbers.
      if (query !== this.query || query !== this.catalogQuery || this.catalogLoading || !this.hasMore || this.page < 1 || this.page >= 10) return Promise.resolve({ ok: false })
      if (this.loadingMore) return this.catalogPromise ?? Promise.resolve({ ok: false })
    } else if (!refresh && this.catalogLoading && query === this.query) {
      return this.catalogPromise ?? Promise.resolve({ ok: true })
    }
    this.catalogAbort?.abort()
    const controller = new AbortController()
    this.catalogAbort = controller
    const revision = ++this.catalogRevision
    const page = append ? this.page + 1 : 1
    // Keep the last successful result until its replacement succeeds. catalogQuery
    // labels that snapshot so a blocked new query cannot advertise old matches.
    this.query = query
    this.catalogLoading = !append
    this.loadingMore = append
    this.catalogError = ''
    this.changed()
    const current = () => !this.disposed && revision === this.catalogRevision && !controller.signal.aborted
    const pending = (async () => {
      try {
        const result = await this.catalog.list({ query, page, refresh, signal: controller.signal })
        if (!current()) return { ok: true, superseded: true }
        if (result.query !== query || result.page !== page || !Array.isArray(result.items)) throw new Error('catalog query mismatch')
        const seen = new Set()
        this.catalogItems = [...(append ? this.catalogItems : []), ...result.items]
          .filter(item => {
            if (!item || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id.toLowerCase())) return false
            seen.add(item.id.toLowerCase())
            return true
          }).slice(0, 1000)
        this.page = page
        this.catalogQuery = query
        this.total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : this.catalogItems.length
        this.hasMore = result.hasMore === true && page < 10
        this.limitReached = result.limitReached === true
        this.incomplete = (append && this.incomplete) || result.incomplete === true
        this.notice = SOURCE_NOTICE
        return { ok: true }
      } catch (error) {
        if (!current()) return { ok: true, superseded: true }
        if (isRateLimit(error, this.now())) {
          this.catalogError = '搜索请求已暂停，已有结果已保留。请等待倒计时结束后重试。'
          return this.limited(error.retryAt, 'search')
        }
        this.catalogError = append
          ? '下一页暂时无法获取，已有结果已保留。请稍后点击“加载更多”重试，或检查系统代理。'
          : '搜索暂时未完成，已有结果已保留。请检查系统代理或稍后重试，不能据此判断没有匹配插件。'
        return { ok: false }
      } finally {
        if (current()) {
          this.catalogLoading = false
          this.loadingMore = false
          this.catalogAbort = undefined
          this.catalogPromise = undefined
          this.changed()
        }
      }
    })()
    this.catalogPromise = pending
    return pending
  }

  async checkInstalled({ refresh = false } = {}) {
    this.checking = true
    this.changed()
    let rateLimited
    let failed = false
    try {
      // Concurrency is bounded; the catalog also enforces the actual request budget.
      const queue = [...this.installed]
      this.pruneUpdates()
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !this.disposed && !rateLimited) {
          const item = queue.shift()
          let result = { status: 'unknown', reason: item.reason ?? '此来源暂不支持自动检测，请查看作者说明。' }
          if (item.managed) {
            try { result = await this.catalog.checkUpdate(this.tracked(item), { refresh }) }
            catch (error) {
              if (isRateLimit(error, this.now())) {
                rateLimited = this.limited(Math.max(rateLimited?.retryAt || 0, error.retryAt), 'metadata')
                // Preserve any previously checked result; do not pretend a cooldown
                // means a plugin is current, or erase useful manual-update actions.
                if (!this.updates.has(item.id)) {
                  this.updates.set(item.id, { status: 'unknown', reason: '检测已暂停，请等待冷却结束后再检查。' })
                  this.updateIdentities.set(item.id, pluginIdentity(this.tracked(item)))
                }
                continue
              }
              failed = true
              result = { status: 'unknown', reason: '检测失败，请检查网络或稍后重试。' }
            }
          }
          this.updates.set(item.id, result)
          this.updateIdentities.set(item.id, pluginIdentity(this.tracked(item)))
          this.changed()
        }
      }))
      if (!rateLimited && !failed) this.checkedAt = this.now()
      return rateLimited ?? { ok: !failed }
    } finally { this.checking = false }
  }

  async handleAction(request) {
    if (this.disposed) return { ok: false }
    if (request.type === 'plugins-restart') return this.restartHarness()
    if (request.type === 'plugins-snapshots') return this.busy ? { ok: false } : this.refreshSnapshots()
    if (request.type === 'plugin-restore') return this.restoreSnapshot(request.id)
    if (request.type === 'plugins-recover') return this.restoreSnapshot(undefined, { recover: true })
    if (request.type === 'plugins-refresh') return this.refresh()
    if (request.type === 'plugins-check') return this.refresh({ catalog: false, checkFresh: true })
    if (request.type === 'plugins-search') return this.searchCatalog(request.query)
    if (request.type === 'plugins-more') return this.searchCatalog(request.query, { append: true })
    if (!ID.test(request.id ?? '')) return { ok: false }
    if (request.type === 'plugin-source') {
      const item = this.catalogItems.find(entry => entry.id === request.id)
      const installed = this.installed.find(entry => entry.id === request.id)
      const url = item?.sourceUrl ?? (installed && this.sourceUrl(installed))
      // Defense in depth even though the catalog already validates source URLs.
      if (typeof url !== 'string' || !/^https:\/\/(?:github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}|www\.npmjs\.com\/package\/(?:%40[a-z0-9][a-z0-9_.-]*%2F)?[a-z0-9][a-z0-9_.-]*)$/u.test(url)) return { ok: false }
      this.options.openExternal(url)
      return { ok: true }
    }
    const action = { 'plugin-install': 'install', 'plugin-update': 'update', 'plugin-remove': 'remove' }[request.type]
    return action ? this.mutate(action, request.id) : { ok: false }
  }

  /** Restart the current supervised backend, never the shell's pending installer. */
  async restartHarness() {
    if (this.disposed || !this.restartRecommended || this.blocksUpdates() || this.loading || this.checking
      || this.snapshotsLoading || this.options.isBlocked?.() || typeof this.options.restartBackend !== 'function') return { ok: false }
    const runtime = this.options.getRuntime()
    if (!runtime) return { ok: false }
    // Also locks automatic updates while the native confirmation is open.
    this.busy = true
    this.error = ''
    this.changed()
    try {
      const choice = await this.options.showMessage({
        type: 'warning', title: '重启 Harness', message: '现在重启 Harness 以加载插件变更？',
        detail: '正在执行的任务会中断，请先保存工作、结束重要任务，并关闭正在修改插件的终端。\n\n仅重启当前 Harness 后台，客户端窗口保持打开；不会安装已下载的客户端更新。',
        buttons: ['重启 Harness', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (choice.response !== 0) return { ok: true, cancelled: true }
      if (this.disposed || this.options.isBlocked?.() || this.options.getRuntime() !== runtime
        || this.recoveryRequired || this.snapshotRecoveryRequired) throw new Error('Harness state changed before restart')
      this.restarting = true
      this.progress = { label: '正在重启 Harness', detail: '正在停止后台并重新加载界面，请稍候…' }
      this.changed()
      await this.options.restartBackend(runtime)
      if (this.disposed || this.options.getRuntime() !== runtime) throw new Error('Harness runtime changed during restart')
      this.restartRecommended = false
      this.notice = 'Harness 已重新启动并加载界面，可以继续使用。'
      this.progress = { label: '重启完成', detail: this.notice, percent: 100 }
      return { ok: true }
    } catch (error) {
      this.error = 'Harness 重启未完成，请检查运行日志和后台状态后重试。插件文件未因重启操作而更改。'
      this.progress = null
      this.log(`plugin backend restart failed: ${String(error).slice(0, 700)}\n`)
      return { ok: false, message: this.error }
    } finally { this.busy = false; this.restarting = false; this.changed() }
  }

  async mutate(action, id) {
    if (this.disposed || this.blocksUpdates() || this.loading || this.catalogLoading || this.loadingMore || this.options.isBlocked?.() || !this.options.getRuntime()) return { ok: false }
    // Acquire before metadata or confirmation; automatic Harness preparation checks this same lock.
    this.busy = true
    this.error = ''
    this.progress = { label: '准备插件操作', detail: '读取插件来源与当前安装状态…' }
    this.changed()
    const runtime = this.options.getRuntime()
    let attempted = false
    let snapshot
    let snapshotFinished = false
    try {
      this.inventory()
      let candidate
      let current
      if (action === 'install') {
        if (!this.catalogItems.some(item => item.id === id)) throw new Error('目录已变化，请先刷新。')
        candidate = await this.catalog.resolve(id, { refresh: true })
        if (this.installed.some(item => item.name === candidate.name)) throw new Error('该插件已存在，请到已安装列表检查更新。')
      } else {
        current = this.installed.find(item => item.id === id)
        if (!current?.managed) throw new Error('此项目不是可管理的额外插件。')
        if (action === 'update') {
          const result = await this.catalog.checkUpdate(this.tracked(current), { refresh: true })
          if (result.status !== 'available' || !result.candidate) throw new Error('暂未确认可用的新版本，请重新检测。')
          candidate = result.candidate
          if (candidate.name !== current.name) throw new Error('新版本的包名已变化，请查看作者说明。')
        }
      }
      const name = candidate?.name ?? current.name
      const label = { install: '安装', update: '更新', remove: '卸载' }[action]
      this.progress = { label: `等待确认${label}`, detail: name }
      this.changed()
      const result = await this.options.showMessage({
        type: 'warning', title: `${label} Harness 插件`, message: `${label} ${name}？`,
        detail: (action === 'remove'
          ? '仅调用官方命令移除 web profile 的此项依赖，不主动删除插件数据；插件或官方流程仍可能影响配置。请先结束重要任务，并关闭正在修改插件的终端。'
          : `来源：${candidate.sourceUrl ?? candidate.repo ?? name}\n目标：${candidate.spec}\n\n第三方插件及其安装脚本可能执行代码，并拥有 Harness 进程的文件和网络权限。本客户端未审核其安全性，也不保证兼容。请确认信任来源、已结束重要任务，并关闭正在修改插件的终端。`)
          + '\n\n操作前会创建整个 web profile 的本地快照（含配置和依赖，未加密）。快照失败时不会开始安装；不能撤销插件对目录外文件的影响。',
        buttons: [label, '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (result.response !== 0) { this.progress = null; return { ok: true, cancelled: true } }
      if (this.disposed || this.options.isBlocked?.() || this.options.getRuntime() !== runtime) throw new Error('Harness 状态已变化，请稍后重试。')
      // Re-read after native confirmation, which may have been open while a terminal changed the profile.
      this.inventory()
      const latest = this.installed.find(item => item.name === name)
      if (action === 'install' ? Boolean(latest) : !latest?.managed || latest.spec !== current.spec) throw new Error('插件清单已变化，请刷新后重试。')
      this.progress = { label: `正在${label}插件`, detail: '正在读取系统代理…' }
      this.changed()
      const proxy = await this.options.resolveProxy(candidate?.source === 'github' ? 'https://github.com/' : 'https://registry.npmjs.org/')
      if (this.disposed || this.options.isBlocked?.() || this.options.getRuntime() !== runtime) throw new Error('Harness 状态已变化，请稍后重试。')
      this.progress = { label: '创建操作前快照', detail: '复制并校验整个 web 插件环境…' }
      this.changed()
      snapshot = await this.snapshots.create({ runtimeVersion: runtime.version, action, pluginName: name })
      if (this.disposed || this.options.isBlocked?.() || this.options.getRuntime() !== runtime) throw new Error('Harness 状态已变化，请稍后重试。')
      this.records = this.readRecords()
      attempted = true
      await this.runOperation({
        runtime, dshHome: this.options.dshHome, npmCliPath: this.options.npmCliPath,
        terminalBinPath: this.options.terminalBinPath, workspacePath: this.options.workspacePath, proxy,
        operation: { action, name, ...(candidate ? { spec: candidate.spec } : {}) },
        onProgress: progress => { this.progress = progress; this.changed() },
        log: text => this.log(text),
      })
      this.restartRecommended = true
      let saved = true
      try { this.saveRecord(name, candidate) } catch { saved = false }
      await this.snapshots.markAfter(snapshot.id, { status: 'success' })
      snapshotFinished = true
      this.inventory()
      this.updates.delete(name)
      this.updateIdentities.delete(name)
      this.notice = `${label}完成。若 Harness 未即时生效，可在保存工作后点击“重启 Harness”加载变更。${saved ? '' : '更新来源记录未保存，后续可能需要手动查看仓库更新。'}`
      this.progress = { label: `${label}完成`, detail: this.notice, percent: 100 }
      return { ok: true }
    } catch (error) {
      if (!attempted && isRateLimit(error, this.now())) {
        this.error = '插件来源检查暂时冷却中，未修改插件。请等待倒计时结束后重试。'
        this.progress = null
        return this.limited(error.retryAt, 'metadata')
      }
      if (error.cleanupUncertain === true) this.recoveryRequired = true
      if (error.recoveryRequired === true) this.snapshotRecoveryRequired = true
      if (snapshot && !snapshotFinished && !this.recoveryRequired) {
        try { await this.snapshots.markAfter(snapshot.id, { status: 'failed' }) }
        catch (snapshotError) { this.log(`plugin snapshot finalization failed: ${String(snapshotError).slice(0, 700)}\n`) }
      }
      // Do not put CLI output, paths, tokens or stack traces in native dialogs/renderer state.
      this.error = attempted
        ? '插件操作或快照记录未完成。请检查本地快照，或用 Harness 终端核查插件状态；详细信息见运行日志。'
        : '未开始修改插件。来源、安装状态或操作前快照尚未确认，请刷新后重试并查看日志。'
      this.log(`plugin ${action} failed: ${String(error).slice(0, 700)}\n`)
      this.progress = null
      try { this.inventory() } catch { /* Preserve last readable inventory. */ }
      this.updates.clear()
      this.updateIdentities.clear()
      return { ok: false, message: this.error }
    } finally { if (snapshot) await this.refreshSnapshots(); this.busy = false; this.changed() }
  }

  dispose() {
    this.disposed = true
    this.catalogRevision += 1
    this.catalogAbort?.abort()
    this.catalog.dispose?.()
  }
}

function isRateLimit(error, now) {
  return error?.code === 'PLUGIN_RATE_LIMIT' && Number.isFinite(error.retryAt) && error.retryAt > now
}

function pluginIdentity(item) {
  return JSON.stringify([item.name, item.spec, item.version, item.source, item.managed,
    item.repo, item.ref, item.commit, item.github?.owner, item.github?.repo, item.github?.ref, item.github?.commit])
}

function validRecord(value) {
  return value && typeof value === 'object' && typeof value.repo === 'string' && REPO.test(value.repo)
    && typeof value.ref === 'string' && value.ref.length > 0 && value.ref.length <= 200
    && !/[\x00-\x20\x7f]/u.test(value.ref) && typeof value.commit === 'string' && SHA.test(value.commit)
    && value.spec === `github:${value.repo}#${value.commit}`
}
