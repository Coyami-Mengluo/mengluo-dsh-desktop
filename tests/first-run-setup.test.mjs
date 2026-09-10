import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { createFirstRunSetup, SETUP_IPC } from '../src/first-run-setup.mjs'
import { listDshReleases } from '../src/update-policy.mjs'

const integrity = `sha512-${'A'.repeat(86)}==`
const versions = ['1.0.0', '1.1.0-rc.1', '0.9.0']
const packument = () => ({
  name: '@deepseek-ai/dsh',
  'dist-tags': { latest: '1.0.0', next: '1.1.0-rc.1' },
  versions: Object.fromEntries(versions.map(version => [version, {
    name: '@deepseek-ai/dsh', version,
    dist: { integrity, tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` },
  }])),
})

describe('first-install version catalog', () => {
  it('includes sorted historical choices and marks latest without mislabeling prereleases', () => {
    const releases = listDshReleases(packument())
    assert.deepEqual(releases.map(item => item.version), ['1.1.0-rc.1', '1.0.0', '0.9.0'])
    assert.equal(releases[0].preview, true)
    assert.equal(releases[1].recommended, true)
    const metadata = packument()
    metadata['dist-tags'].latest = '1.1.0-rc.1'
    assert.equal(listDshReleases(metadata)[0].preview, true)
  })
  it('excludes unverifiable history and rejects invalid tagged artifacts', () => {
    const metadata = packument()
    metadata.versions['0.9.0'].dist.tarball = 'https://evil.example/runtime.tgz'
    assert.equal(listDshReleases(metadata).length, 2)
    metadata.versions['1.0.0'].dist.integrity = 'sha1-wrong'
    assert.throws(() => listDshReleases(metadata), /SHA-512/u)
  })
})

describe('local first-run setup controller', () => {
  it('defaults to the official source without requiring new integration callbacks', async () => {
    const f = fixture()
    await f.setup.show()
    assert.equal(f.setup.state.downloadSource, 'official')
    assert.equal(f.setup.state.downloadConfigurable, false)
    assert.deepEqual(f.setup.state.downloadSources.map(source => source.id), ['official', 'npmmirror'])
    await assert.rejects(f.action({ type: 'download-source', source: 'npmmirror' }), /无法修改/u)
    f.setup.dispose()
  })
  it('uses shared persisted source settings, including after catalog errors and cross-view changes', async () => {
    let source = 'official'
    let networkBusy = false
    const changes = []
    const downloadSettings = {
      getState: () => ({ source, busy: networkBusy }),
      setSource: next => { source = next; changes.push(next) },
    }
    const f = fixture({ downloadSettings, fetch: async () => { throw new Error('offline') } })
    await f.setup.show()
    assert.equal(f.setup.state.status, 'error')
    await f.action({ type: 'download-source', source: 'npmmirror' })
    assert.equal(f.setup.state.downloadSource, 'npmmirror')
    assert.deepEqual(changes, ['npmmirror'])
    assert.deepEqual(f.installs, [])
    source = 'official'
    networkBusy = true
    f.setup.refreshDownloadSettings()
    assert.equal(f.setup.state.downloadSource, 'official')
    assert.equal(f.setup.state.downloadBusy, true)
    await assert.rejects(f.action({ type: 'download-source', source: 'npmmirror' }), /正在进行/u)
    networkBusy = false
    await f.action({ type: 'download-source', source: 'npmmirror' })
    f.setup.dispose()
    const reopened = fixture({ downloadSettings })
    await reopened.setup.show()
    assert.equal(reopened.setup.state.downloadSource, 'npmmirror')
    reopened.setup.dispose()
  })
  it('publishes shared download and fallback activity without changing the selected source', async () => {
    let activity = ''
    const installing = Promise.withResolvers()
    const f = fixture({
      downloadSettings: { getState: () => ({ source: 'npmmirror', activity }), setSource: () => {} },
      install: () => installing.promise,
    })
    await f.setup.show()
    assert.equal(f.setup.state.downloadActivity, '')
    const pending = f.action({ type: 'install', version: '1.0.0' })
    activity = 'npmmirror 缺少此文件，正在回退官方源下载。'
    f.setup.refreshDownloadSettings()
    assert.equal(f.setup.state.downloadActivity, activity)
    assert.equal(f.setup.state.downloadSource, 'npmmirror')
    assert.equal(f.setup.state.status, 'installing')
    activity = ''
    f.setup.refreshDownloadSettings()
    assert.equal(f.setup.state.downloadActivity, '')
    installing.resolve({ version: '1.0.0' })
    await pending
    f.setup.dispose()
  })
  it('rejects unknown sources, expanded requests, hidden UI, and untrusted frames', async () => {
    const changes = []
    const f = fixture({ downloadSettings: { getState: () => ({ source: 'official' }), setSource: source => { changes.push(source) } } })
    await assert.rejects(f.action({ type: 'download-source', source: 'npmmirror' }), /首次安装/u)
    await f.setup.show()
    for (const source of ['custom', 'https://evil.example', '../npm']) {
      await assert.rejects(f.action({ type: 'download-source', source }), /不支持/u)
    }
    await assert.rejects(f.action({ type: 'download-source', source: 'npmmirror', registry: 'https://evil.example' }), /不支持/u)
    await assert.rejects(f.action({ type: 'test-connection', source: 'npmmirror' }), /不支持/u)
    for (const request of [{ type: 'download-source', source: 'npmmirror' }, { type: 'test-connection' }]) {
      for (const event of [
        { ...f.event, sender: {} },
        { ...f.event, senderFrame: { url: f.url } },
      ]) await assert.rejects(f.action(request, event), /不是来自/u)
      f.event.senderFrame.url = 'https://official.example'
      await assert.rejects(f.action(request), /不是来自/u)
      f.event.senderFrame.url = f.url
    }
    assert.deepEqual(changes, [])
    f.setup.dispose()
  })
  it('locks source changes during installation, shared work, and asynchronous persistence', async () => {
    const saving = Promise.withResolvers()
    const installing = Promise.withResolvers()
    let source = 'official'
    let sharedBusy = false
    const f = fixture({
      downloadSettings: {
        getState: () => ({ source, busy: sharedBusy }),
        setSource: async next => { await saving.promise; source = next },
      },
      install: () => installing.promise,
    })
    await f.setup.show()
    const switching = f.action({ type: 'download-source', source: 'npmmirror' })
    assert.equal(f.setup.state.downloadBusy, true)
    await assert.rejects(f.action({ type: 'download-source', source: 'official' }), /正在进行/u)
    await f.action({ type: 'install', version: '1.0.0' })
    assert.deepEqual(f.installs, [])
    saving.resolve()
    await switching
    assert.equal(f.setup.state.downloadBusy, false)
    sharedBusy = true
    await assert.rejects(f.action({ type: 'install', version: '1.0.0' }), /正在进行/u)
    sharedBusy = false
    const pending = f.action({ type: 'install', version: '1.0.0' })
    await assert.rejects(f.action({ type: 'download-source', source: 'official' }), /正在进行/u)
    installing.resolve({ version: '1.0.0' })
    await pending
    await assert.rejects(f.action({ type: 'download-source', source: 'official' }), /正在进行/u)
    f.setup.dispose()
  })
  it('tests only the selected source and clears stale results after source changes', async () => {
    let source = 'npmmirror'
    const checking = Promise.withResolvers()
    const f = fixture({ downloadSettings: {
      getState: () => ({ source }),
      setSource: next => { source = next },
      testConnection: async () => { assert.equal(source, 'npmmirror'); return checking.promise },
    } })
    await f.setup.show()
    const pending = f.action({ type: 'test-connection' })
    assert.equal(f.setup.state.connectionTesting, true)
    await assert.rejects(f.action({ type: 'download-source', source: 'official' }), /正在进行/u)
    await f.action({ type: 'install', version: '1.0.0' })
    assert.deepEqual(f.installs, [])
    checking.resolve({ ok: true, message: 'npmmirror 连接正常（123 ms）' })
    await pending
    assert.deepEqual(f.setup.state.connectionResult, { ok: true, message: 'npmmirror 连接正常（123 ms）' })
    assert.equal(f.setup.state.connectionTesting, false)
    source = 'official'
    f.setup.refreshDownloadSettings()
    assert.equal(f.setup.state.connectionResult, undefined)
    f.setup.dispose()
  })
  it('unlocks after a failed source save and ignores late connection results after disposal', async () => {
    const checking = Promise.withResolvers()
    const f = fixture({ downloadSettings: {
      getState: () => ({ source: 'official' }),
      setSource: () => { throw new Error('settings write failed') },
      testConnection: () => checking.promise,
    } })
    await f.setup.show()
    await assert.rejects(f.action({ type: 'download-source', source: 'npmmirror' }), /settings write failed/u)
    assert.equal(f.setup.state.downloadSource, 'official')
    assert.equal(f.setup.state.downloadBusy, false)
    const pending = f.action({ type: 'test-connection' })
    f.setup.dispose()
    const sentCount = f.sent.length
    checking.resolve({ ok: true, message: 'late result' })
    await pending
    assert.equal(f.sent.length, sentCount)
  })
  it('makes connection errors retryable without changing the installation state', async () => {
    let fail = true
    const f = fixture({ downloadSettings: {
      getState: () => ({ source: 'official' }), setSource: () => {},
      testConnection: async () => { if (fail) throw new Error('connection timeout'); return { ok: true, message: '连接正常' } },
    } })
    await f.setup.show()
    await f.action({ type: 'test-connection' })
    assert.equal(f.setup.state.connectionResult.ok, false)
    assert.match(f.setup.state.connectionResult.message, /connection timeout/u)
    assert.equal(f.setup.state.connectionTesting, false)
    assert.equal(f.setup.state.status, 'ready')
    fail = false
    await f.action({ type: 'test-connection' })
    assert.equal(f.setup.state.connectionResult.ok, true)
    f.setup.dispose()
  })
  it('waits for explicit selection and only installs a version from the fetched catalog', async () => {
    const f = fixture()
    await f.setup.show()
    assert.equal(f.setup.state.status, 'ready')
    assert.deepEqual(f.installs, [])
    await assert.rejects(f.action({ type: 'install', version: '../evil' }), /列表/u)
    await f.action({ type: 'install', version: '0.9.0' })
    assert.deepEqual(f.installs, ['0.9.0'])
    assert.deepEqual(f.started, ['0.9.0'])
    assert.equal(f.setup.state.status, 'starting')
    f.setup.complete()
    assert.equal(f.setup.state.visible, false)
    await f.action({ type: 'install', version: '1.0.0' })
    assert.deepEqual(f.installs, ['0.9.0'])
    f.setup.dispose()
  })
  it('denies official renderers, child frames, navigated frames, and expanded commands', async () => {
    const f = fixture()
    await f.setup.show()
    for (const event of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url: f.event.senderFrame.url } },
    ]) await assert.rejects(f.action({ type: 'install', version: '1.0.0' }, event), /不是来自/u)
    f.event.senderFrame.url = 'https://evil.example'
    await assert.rejects(f.action({ type: 'refresh' }), /不是来自/u)
    f.event.senderFrame.url = f.url
    await assert.rejects(f.action({ type: 'install', version: '1.0.0', tarball: 'evil' }), /不支持/u)
    await assert.rejects(f.action({ type: 'shell' }), /不支持/u)
    assert.deepEqual(f.installs, [])
    f.setup.dispose()
  })
  it('keeps failure retryable and reports actual verification counters', async () => {
    let fail = true
    const f = fixture({ install: async release => {
      f.setup.progress('stage', 'verifying', release.version, { completedFiles: 30, totalFiles: 100 })
      assert.equal(f.setup.state.percent, 30)
      if (fail) throw new Error('network timeout')
      return release
    } })
    await f.setup.show()
    await f.action({ type: 'install', version: '1.0.0' })
    assert.equal(f.setup.state.status, 'error')
    assert.match(f.setup.state.detail, /network timeout/u)
    fail = false
    await f.action({ type: 'install', version: '1.0.0' })
    assert.equal(f.setup.state.status, 'starting')
    await f.setup.recover('real startup failed')
    assert.equal(f.setup.state.status, 'ready')
    assert.equal(f.setup.state.reason, 'real startup failed')
    f.setup.dispose()
  })
  it('does not duplicate installs and drops late progress after disposal', async () => {
    const deferred = Promise.withResolvers()
    const f = fixture({ install: () => deferred.promise })
    await f.setup.show()
    const pending = f.action({ type: 'install', version: '1.0.0' })
    await f.action({ type: 'install', version: '0.9.0' })
    assert.equal(f.installs.length, 1)
    f.setup.dispose()
    const count = f.sent.length
    f.setup.progress('stage', 'installing', '1.0.0')
    deferred.resolve({ version: '1.0.0' })
    await pending
    assert.equal(f.sent.length, count)
    assert.deepEqual(f.started, [])
    assert.equal(f.ipc.listenerCount(SETUP_IPC.ready), 0)
    assert.equal(f.handlers.size, 0)
  })
  it('allows a failed version-list fetch to retry without installing anything', async () => {
    let fail = true
    const f = fixture({ fetch: async () => {
      if (fail) throw new Error('offline')
      return listDshReleases(packument())
    } })
    await f.setup.show()
    assert.equal(f.setup.state.status, 'error')
    fail = false
    await f.action({ type: 'refresh' })
    assert.equal(f.setup.state.status, 'ready')
    assert.deepEqual(f.installs, [])
    f.setup.dispose()
  })
})

function fixture(options = {}) {
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (name, handler) => { handlers.set(name, handler) }
  ipc.removeHandler = name => { handlers.delete(name) }
  const htmlPath = resolve('fixture-titlebar.html')
  const url = pathToFileURL(htmlPath).href
  const sent = [], installs = [], started = []
  const webContents = { isDestroyed: () => false, mainFrame: { url }, send: (name, value) => { sent.push({ name, value }) } }
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const setup = createFirstRunSetup({
    ipcMain: ipc, window: { isDestroyed: () => false, webContents }, htmlPath,
    showLoading: () => {}, onInstalled: runtime => { started.push(runtime.version) },
    downloadSettings: options.downloadSettings,
    updater: {
      fetchAvailableVersions: options.fetch ?? (async () => listDshReleases(packument())),
      installInitialRelease: async release => {
        installs.push(release.version)
        return options.install === undefined ? release : await options.install(release)
      },
    },
  })
  return { setup, ipc, handlers, event, url, sent, installs, started,
    action: (request, sender = event) => handlers.get(SETUP_IPC.action)(sender, request) }
}
