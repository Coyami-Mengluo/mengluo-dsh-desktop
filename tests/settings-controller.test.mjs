import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DesktopSettingsController } from '../src/settings-controller.mjs'
import { readDownloadPreferences } from '../src/download-source.mjs'

const worlds = []
afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.controller.dispose()
    rmSync(world.root, { recursive: true, force: true })
  }
})

describe('desktop settings controller', () => {
  it('exposes plugin snapshots and routes only validated fixed plugin operations without invoking Harness install', async () => {
    const world = fixture()
    const pluginCalls = []
    const snapshot = { installedRuntime: true, busy: false, catalog: [{ id: 'github:example/theme', name: 'Theme' }], installed: [] }
    world.options.plugins = {
      isBusy: () => false, getState: () => snapshot,
      handleAction: async request => { pluginCalls.push(request); return { ok: true } },
    }
    assert.equal(world.controller.getState().plugins, snapshot)
    world.controller.refresh()
    assert.equal(world.changes.at(-1).plugins, snapshot)
    for (const request of [
      { type: 'plugins-refresh' }, { type: 'plugins-check' },
      { type: 'plugin-install', id: 'github:example/theme' },
      { type: 'plugin-source', id: 'github:example/theme' },
      { type: 'plugin-update', id: '@example/theme' },
      { type: 'plugin-remove', id: '@example/theme' },
    ]) {
      assert.deepEqual(await world.controller.handleAction(request), { ok: true })
      assert.deepEqual(pluginCalls.at(-1), request)
    }
    assert.deepEqual(world.calls, [])
    assert.deepEqual(world.fetches, [])
    const count = pluginCalls.length
    for (const request of [
      { type: 'plugins-refresh', url: 'https://untrusted.invalid' },
      { type: 'plugin-install', id: 'github:example/theme', command: 'npm install' },
      { type: 'plugin-update', id: 'https://github.com/example/theme' },
      { type: 'plugin-auto-update', id: '@example/theme' },
    ]) assert.equal((await world.controller.handleAction(request)).ok, false)
    assert.equal(pluginCalls.length, count)
    world.options.plugins.handleAction = async () => ({ ok: false, message: '插件操作正在进行' })
    assert.equal((await world.controller.handleAction({ type: 'plugins-check' })).ok, false)
    world.options.plugins.handleAction = async () => { throw new Error('private plugin failure') }
    const failure = await world.controller.handleAction({ type: 'plugins-check' })
    assert.equal(failure.ok, false)
    assert.doesNotMatch(failure.message, /private plugin failure/u)
    world.options.plugins = undefined
    assert.equal((await world.controller.handleAction({ type: 'plugins-refresh' })).ok, false)
  })

  it('treats plugin mutations as Harness busy for download sources, probes, candidate preparation and restart', async () => {
    const world = fixture()
    let pluginBusy = true
    world.options.plugins = { isBusy: () => pluginBusy, getState: () => ({ busy: pluginBusy }) }
    world.options.harness.availableRelease = { version: '0.1.5-rc.1' }
    world.options.harness.state.pendingVersion = '0.1.5-rc.1'
    assert.equal(world.controller.isHarnessBusy(), true)
    assert.equal(world.controller.getDownloadState().busy, true)
    assert.throws(() => world.controller.setDownloadSource('npmmirror'), /结束后才能切换/u)
    assert.equal((await world.controller.testConnection()).ok, false)
    for (const type of ['harness-check', 'harness-setup', 'harness-download', 'harness-restart']) {
      assert.equal((await world.controller.handleAction({ type })).ok, false, type)
    }
    assert.deepEqual(world.calls, [])
    assert.deepEqual(world.fetches, [])
    assert.deepEqual(readdirSync(world.root), [])
    pluginBusy = false
    assert.equal(world.controller.getDownloadState().busy, false)
    world.controller.setDownloadSource('npmmirror')
    assert.equal(readDownloadPreferences(world.root).source, 'npmmirror')
    assert.equal((await world.controller.handleAction({ type: 'harness-download' })).ok, true)
    assert.equal(world.calls.at(-1)[0], 'harness-download')
  })

  it('exposes one shared persisted source for setup and settings without changing global npm or environment', async () => {
    const world = fixture()
    const environmentBefore = { ...process.env }
    const npmConfig = join(world.root, '.npmrc')
    writeFileSync(npmConfig, 'registry=https://personal.invalid/\n')
    assert.equal(world.controller.getDownloadState().source, 'official')
    assert.deepEqual(await world.controller.handleAction({ type: 'download-source', source: 'npmmirror' }), { ok: true })
    assert.equal(world.controller.getState().network.source, 'npmmirror')
    assert.deepEqual(readDownloadPreferences(world.root), { source: 'npmmirror' })
    const reloaded = new DesktopSettingsController(world.options)
    try {
      assert.equal(reloaded.getDownloadState().source, 'npmmirror')
      assert.deepEqual(reloaded.getDownloadState().sources.map(item => item.id), ['official', 'npmmirror'])
      assert.ok(reloaded.getDownloadState().sources.every(item => !Object.hasOwn(item, 'registry')))
    } finally { reloaded.dispose() }
    assert.equal(readFileSync(npmConfig, 'utf8'), 'registry=https://personal.invalid/\n')
    assert.deepEqual({ ...process.env }, environmentBefore)
    assert.deepEqual(readdirSync(world.root).sort(), ['.npmrc', 'download-settings.json'])
  })

  it('rejects source changes during install, preparation, startup and connection testing', async () => {
    for (const state of ['install', 'preparing', 'starting', 'probing']) {
      const world = fixture()
      if (state === 'install') world.options.harness.installPromise = Promise.resolve()
      if (state === 'preparing') world.options.harness.preparingVersion = '0.1.5-rc.1'
      if (state === 'starting') world.options.isStarting = () => true
      if (state === 'probing') world.controller.probe = { status: 'checking' }
      assert.equal(world.controller.getDownloadState().busy, true)
      assert.throws(() => world.controller.setDownloadSource('npmmirror'), /结束后才能切换/u)
      assert.equal((await world.controller.handleAction({ type: 'download-source', source: 'npmmirror' })).ok, false)
      assert.equal(world.controller.getDownloadState().source, 'official')
      assert.deepEqual(readdirSync(world.root), [])
    }
  })

  it('maps auto channel to the manager default without mutating renderer input', async () => {
    const world = fixture()
    const request = { type: 'harness-preferences', patch: { autoCheck: false, interval: '7d', channel: 'auto' } }
    assert.equal((await world.controller.handleAction(request)).ok, true)
    assert.deepEqual(world.calls.at(-1), ['harness-preferences', { autoCheck: false, interval: '7d', channel: undefined }])
    assert.equal(request.patch.channel, 'auto')
    for (const channel of ['latest', 'next']) {
      await world.controller.handleAction({ type: 'harness-preferences', patch: { channel } })
      assert.deepEqual(world.calls.at(-1), ['harness-preferences', { channel }])
    }
    await world.controller.handleAction({ type: 'client-preferences', patch: { autoCheck: false } })
    assert.deepEqual(world.calls.at(-1), ['client-preferences', { autoCheck: false }])
  })

  it('rejects arbitrary actions, URLs, commands, paths and invalid settings before invoking callbacks', async () => {
    const world = fixture()
    for (const request of [
      null, [], 'terminal', { type: 'exec', command: 'npm install unknown' },
      { type: 'open-repository', url: 'https://untrusted.invalid/' },
      { type: 'open-log', path: 'C:\\private\\data' },
      { type: 'terminal', command: 'git clone arbitrary' },
      { type: 'download-source', source: 'https://registry.npmmirror.com/' },
      { type: 'download-source', source: 'official', proxy: 'http://untrusted:1' },
      { type: 'harness-preferences', patch: { channel: 'nightly' } },
      { type: 'client-preferences', patch: { autoCheck: true, interval: '6h' } },
    ]) assert.equal((await world.controller.handleAction(request)).ok, false)
    assert.deepEqual(world.calls, [])
    assert.deepEqual(world.fetches, [])
    assert.deepEqual(readdirSync(world.root), [])
  })

  it('routes trusted external-link and log actions to fixed zero-argument host callbacks', async () => {
    const world = fixture()
    for (const type of ['open-repository', 'open-official', 'open-client-releases', 'open-log']) {
      assert.equal((await world.controller.handleAction({ type })).ok, true)
      assert.deepEqual(world.calls.at(-1), [type])
    }
    world.options.logAvailable = () => false
    const count = world.calls.length
    assert.equal((await world.controller.handleAction({ type: 'open-log' })).ok, false)
    assert.equal(world.calls.length, count)
  })

  it('routes check, progress and terminal operations without accepting renderer parameters', async () => {
    const world = fixture()
    const expected = new Map([
      ['harness-check', ['harness-check', { manual: true }]],
      ['harness-progress', ['harness-progress', 'show']],
      ['terminal', ['terminal']], ['client-check', ['client-check']],
      ['client-download', ['client-download']], ['client-install', ['client-install']],
      ['client-progress', ['client-progress']],
    ])
    for (const [type, call] of expected) {
      assert.equal((await world.controller.handleAction({ type })).ok, true)
      assert.deepEqual(world.calls.at(-1), call)
    }
  })

  it('guards initial setup, Harness candidate download and restart using manager state', async () => {
    const world = fixture()
    const harness = world.options.harness
    assert.equal((await world.controller.handleAction({ type: 'harness-setup' })).ok, true)
    assert.deepEqual(world.calls.at(-1), ['harness-setup'])
    harness.currentRuntime = { version: '0.1.4' }
    assert.equal((await world.controller.handleAction({ type: 'harness-setup' })).ok, false)
    assert.equal((await world.controller.handleAction({ type: 'harness-download' })).ok, false)
    harness.availableRelease = { version: '0.1.5-rc.1', integrity: 'fixture' }
    assert.equal((await world.controller.handleAction({ type: 'harness-download' })).ok, true)
    assert.deepEqual(world.calls.at(-1), ['harness-download', harness.availableRelease, { reportFailure: true }])
    assert.equal((await world.controller.handleAction({ type: 'harness-restart' })).ok, false)
    harness.state.pendingVersion = '0.1.5-rc.1'
    assert.equal((await world.controller.handleAction({ type: 'harness-restart' })).ok, true)
    assert.deepEqual(world.calls.at(-1), ['harness-restart', { version: '0.1.5-rc.1' }])
    harness.preparingVersion = '0.1.5-rc.1'
    const count = world.calls.length
    assert.equal((await world.controller.handleAction({ type: 'harness-download' })).ok, false)
    assert.equal((await world.controller.handleAction({ type: 'harness-restart' })).ok, false)
    assert.equal(world.calls.length, count)
  })

  it('probes only the selected fixed registry and the required official metadata service', async () => {
    const world = fixture()
    world.controller.setDownloadSource('npmmirror')
    let cancelledBodies = 0
    world.options.net.fetch = async (url, init) => {
      world.fetches.push([url, init])
      return { status: 200, body: { cancel: async () => { cancelledBodies += 1 } } }
    }
    const result = await world.controller.testConnection()
    assert.equal(result.ok, true)
    assert.equal(world.controller.probe.status, 'success')
    assert.deepEqual(world.fetches.map(([url]) => url).sort(), [
      'https://registry.npmjs.org/-/ping', 'https://registry.npmmirror.com/-/ping',
    ])
    assert.equal(cancelledBodies, 2)
    for (const [, init] of world.fetches) {
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      assert.equal(init.headers, undefined)
    }
    assert.match(result.message, /不代表下载速度或目标版本已同步/u)
    world.fetches.length = 0
    world.controller.setDownloadSource('official')
    await world.controller.testConnection()
    assert.deepEqual(world.fetches.map(([url]) => url), ['https://registry.npmjs.org/-/ping'])
  })

  it('reports a failed probe when either the mirror or official metadata connection fails', async () => {
    for (const failure of ['http', 'network']) {
      const world = fixture()
      world.controller.setDownloadSource('npmmirror')
      world.options.net.fetch = async url => {
        if (url.includes('registry.npmjs.org')) {
          if (failure === 'network') throw new Error('network failure with private diagnostic')
          return { status: 503 }
        }
        return { status: 200 }
      }
      const result = await world.controller.testConnection()
      assert.equal(result.ok, false)
      assert.equal(world.controller.probe.status, 'error')
      assert.equal(world.controller.probePromise, undefined)
      assert.match(result.message, /官方 npm：连接失败/u)
      assert.doesNotMatch(result.message, /private diagnostic/u)
      assert.equal(world.controller.getDownloadState().busy, false)
    }
  })

  it('deduplicates an in-flight connection probe and refuses probing during install', async () => {
    const world = fixture()
    const response = deferred()
    world.options.net.fetch = async (url, init) => {
      world.fetches.push([url, init])
      return response.promise
    }
    const first = world.controller.testConnection()
    const second = world.controller.testConnection()
    assert.equal(first, second)
    assert.equal(world.fetches.length, 1)
    assert.equal(world.controller.getDownloadState().busy, true)
    response.resolve({ status: 200 })
    assert.equal((await first).ok, true)
    world.options.harness.installPromise = Promise.resolve()
    assert.equal((await world.controller.testConnection()).ok, false)
    assert.equal(world.fetches.length, 1)
  })

  it('aborts an in-flight probe on dispose and suppresses stale UI notifications and actions', async () => {
    const world = fixture()
    let signal
    world.options.net.fetch = async (_url, init) => {
      signal = init.signal
      return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
    }
    const pending = world.controller.testConnection()
    const notices = world.changes.length
    world.controller.dispose()
    assert.equal(signal.aborted, true)
    assert.equal((await pending).ok, false)
    assert.equal(world.controller.probePromise, undefined)
    assert.equal(world.changes.length, notices)
    assert.equal((await world.controller.handleAction({ type: 'terminal' })).ok, false)
    assert.equal((await world.controller.testConnection()).ok, false)
    assert.throws(() => world.controller.setDownloadSource('npmmirror'), /结束后才能切换/u)
    world.controller.reportDownloadStatus({ source: 'npmmirror', detail: 'late status' })
    assert.equal(world.changes.length, notices)
  })

  it('displays system proxy, DIRECT and resolver failures without mutating network configuration', async () => {
    const world = fixture()
    world.options.app.resolveProxy = async () => 'PROXY 127.0.0.1:18080'
    await world.controller.inspectProxy()
    assert.match(world.controller.proxyStatus, /http:\/\/127\.0\.0\.1:18080/u)
    world.options.app.resolveProxy = async () => 'DIRECT'
    await world.controller.inspectProxy()
    assert.match(world.controller.proxyStatus, /按系统规则直连/u)
    world.options.app.resolveProxy = async () => { throw new Error('private system diagnostic') }
    await world.controller.inspectProxy()
    assert.match(world.controller.proxyStatus, /暂时无法读取系统代理/u)
    assert.doesNotMatch(world.controller.proxyStatus, /private system diagnostic/u)
    assert.deepEqual(world.calls, [])
  })

  it('ignores an old source proxy result after switching source', async () => {
    const world = fixture()
    const oldProxy = deferred()
    const newProxy = deferred()
    const urls = []
    world.options.app.resolveProxy = url => { urls.push(url); return urls.length === 1 ? oldProxy.promise : newProxy.promise }
    const pending = world.controller.inspectProxy()
    world.controller.setDownloadSource('npmmirror')
    newProxy.resolve('DIRECT')
    await tick()
    assert.match(world.controller.proxyStatus, /按系统规则直连/u)
    oldProxy.resolve('PROXY 127.0.0.1:9999')
    await pending
    assert.match(world.controller.proxyStatus, /按系统规则直连/u)
    assert.deepEqual(urls, [
      'https://registry.npmjs.org/@deepseek-ai%2Fdsh', 'https://registry.npmmirror.com/@deepseek-ai%2Fdsh',
    ])
  })

  it('reports bounded source activity and exposes generic action failures', async () => {
    const world = fixture()
    world.controller.reportDownloadStatus({ source: 'arbitrary', detail: 'ignored' })
    assert.equal(world.controller.activity, '')
    world.controller.reportDownloadStatus({ source: 'official', fallback: true, detail: 'a'.repeat(700) })
    assert.equal(world.controller.activity.length, 512)
    world.options.client.check = async () => { throw new Error('private update diagnostic') }
    const result = await world.controller.handleAction({ type: 'client-check' })
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.message, /private update diagnostic/u)
    assert.match(world.logs.at(-1), /settings action client-check failed/u)
  })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mengluo-settings-controller-'))
  const calls = []
  const fetches = []
  const changes = []
  const logs = []
  const record = name => (...args) => { calls.push([name, ...args]) }
  const options = {
    userData: root, productName: 'MengLuo DSH Desktop',
    harness: {
      state: {}, currentRuntime: undefined, availableRelease: undefined,
      getSettingsState: () => ({ installed: false }),
      updatePreferences: record('harness-preferences'), checkForUpdates: record('harness-check'),
      prepareRelease: record('harness-download'), promptRestart: record('harness-restart'),
      reportProgress: record('harness-progress'), openRuntimeTerminal: record('terminal'),
    },
    client: {
      options: { version: '0.5.2', progress: { show: record('client-progress') } },
      getSettingsState: () => ({ version: '0.5.2', status: 'idle' }),
      updatePreferences: record('client-preferences'), check: record('client-check'),
      promptDownload: record('client-download'), install: record('client-install'),
    },
    app: { resolveProxy: async () => 'DIRECT' },
    net: { fetch: async (url, init) => { fetches.push([url, init]); return { status: 200 } } },
    isStarting: () => false, showSetup: record('harness-setup'), logAvailable: () => true,
    openLog: record('open-log'), openRepository: record('open-repository'),
    openOfficial: record('open-official'), openClientReleases: record('open-client-releases'),
    onChanged: state => { changes.push(state) }, log: value => { logs.push(value) },
  }
  const world = { root, options, calls, fetches, changes, logs, controller: new DesktopSettingsController(options) }
  worlds.push(world)
  return world
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function tick() {
  return new Promise(resolve => setImmediate(resolve))
}
