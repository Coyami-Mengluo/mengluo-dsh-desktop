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
