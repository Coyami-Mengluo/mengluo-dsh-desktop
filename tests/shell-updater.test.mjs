import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ShellUpdateManager, validateShellRelease } from '../src/shell-updater.mjs'
import { SHELL_RELEASE_SOURCE } from '../src/release-config.mjs'

const release = (version = '0.5.1') => ({
  version, files: [{ url: `MengLuo-DSH-Desktop-${version}-setup.exe`, size: 1024, sha512: Buffer.alloc(64, 1).toString('base64') }],
})
function fixture(t, overrides = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'mengluo-client-update-'))
  const actions = [], messages = [], notifications = [], states = []
  const updater = new EventEmitter()
  updater.setFeedURL = value => { updater.feed = value }
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: release() })
  updater.downloadUpdate = async () => { actions.push('download'); return ['verified-fixture.exe'] }
  updater.quitAndInstall = (...args) => { actions.push(['install', ...args]) }
  const options = {
    updater, userData, version: '0.5.0', supported: true, log: () => {},
    showMessage: async value => { messages.push(value); return { response: 1 } },
    openExternal: value => { actions.push(value) },
    createCancellationToken: () => ({ cancel: () => { actions.push('cancel') } }),
    isHarnessInstalling: () => false,
    requestInstall: callback => { actions.push('shutdown-requested'); options.installCallback = callback; return true },
    progress: { update: state => { states.push(state) }, show: () => {}, dispose: () => {} },
    Notification: class extends EventEmitter {
      static isSupported() { return true }
      constructor(value) { super(); notifications.push(value) }
      show() {}
      close() {}
    },
    ...overrides,
  }
  const manager = new ShellUpdateManager(options)
  t.after(() => { manager.dispose(); rmSync(userData, { recursive: true, force: true }) })
  return { manager, updater, actions, messages, notifications, states, options }
}

test('locks the GitHub feed and requires explicit download and install decisions', async t => {
  const f = fixture(t)
  assert.equal(f.updater.feed, SHELL_RELEASE_SOURCE)
  assert.equal(f.updater.autoDownload, false)
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  assert.equal(f.updater.allowDowngrade, false)
  assert.equal(f.updater.allowPrerelease, false)
  assert.equal(f.updater.disableDifferentialDownload, false)
  assert.equal(f.updater.disableWebInstaller, true)
  await f.manager.check(false)
  assert.equal(f.manager.state.status, 'available')
  assert.equal(f.notifications.length, 1)
  assert.deepEqual(f.actions, [])
  await f.manager.check(false)
  assert.equal(f.notifications.length, 1)
  assert.equal(JSON.parse(readFileSync(f.manager.preferencesPath)).lastNotifiedVersion, '0.5.1')
  await f.manager.promptDownload()
  assert.deepEqual(f.actions, [])
})

test('requires the exact stable installer filename, size and SHA-512 metadata', () => {
  assert.equal(validateShellRelease(release()).version, '0.5.1')
  for (const url of ['https://evil.example/payload.exe', '../setup.exe', 'MengLuo-DSH-Desktop-0.5.1-portable.exe']) {
    assert.throws(() => validateShellRelease({ ...release(), files: [{ ...release().files[0], url }] }))
  }
  for (const bad of [null, { version: '0.5.1-beta.1' }, { ...release(), files: [] },
    { ...release(), files: [{ ...release().files[0], sha512: 'wrong' }] },
    { ...release(), files: [{ ...release().files[0], size: 0 }] }]) assert.throws(() => validateShellRelease(bad))
})

test('invalid release metadata cannot start a download', async t => {
  const f = fixture(t)
  f.updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { ...release(), files: [] } })
  await f.manager.check(false)
  await f.manager.download()
  assert.equal(f.manager.state.status, 'error')
  assert.deepEqual(f.actions, [])
})

test('downloaded updates install only after confirmation and the main-process shutdown callback', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  await f.manager.download()
  assert.equal(f.manager.state.status, 'downloaded')
  assert.deepEqual(f.actions, ['download'])
  await f.manager.install()
  assert.deepEqual(f.actions, ['download'])
  f.options.showMessage = async () => ({ response: 0 })
  await f.manager.install()
  assert.deepEqual(f.actions, ['download', 'shutdown-requested'])
  f.manager.dispose()
  f.options.installCallback()
  assert.deepEqual(f.actions, ['download', 'shutdown-requested', ['install', false, true]])
})

test('a rejected second release revokes the earlier download authorization', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  assert.equal(f.manager.state.status, 'available')
  f.updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { ...release(), files: [] } })
  await f.manager.check(false)
  await f.manager.download()
  assert.equal(f.manager.release, undefined)
  assert.deepEqual(f.actions, [])
})

test('an open confirmation cannot approve replacement metadata for the same version', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  let answer
  f.options.showMessage = () => new Promise(resolve => { answer = resolve })
  const prompt = f.manager.promptDownload()
  await f.manager.check(false)
  answer({ response: 0 })
  await prompt
  assert.deepEqual(f.actions, [])
})

test('a downloaded installer cannot be overwritten by a duplicate download action', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  await f.manager.download()
  await f.manager.download()
  assert.deepEqual(f.actions, ['download'])
  assert.equal(f.manager.state.status, 'downloaded')
})

test('Harness installation prevents a client restart, including while the confirmation is open', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  await f.manager.download()
  f.options.showMessage = async () => { f.options.isHarnessInstalling = () => true; return { response: 0 } }
  await f.manager.install()
  assert.deepEqual(f.actions, ['download'])
})

test('plugin operations block client installation before confirmation and allow retry after completion', async t => {
  let pluginBusy = true
  const harnessInstalling = false
  const f = fixture(t, { isHarnessInstalling: () => harnessInstalling || pluginBusy })
  await f.manager.check(false)
  await f.manager.download()
  await f.manager.install()
  assert.equal(f.manager.state.status, 'downloaded')
  assert.deepEqual(f.actions, ['download'])
  assert.equal(f.options.installCallback, undefined)
  assert.match(f.messages.at(-1).message, /插件操作/u)
  pluginBusy = false
  f.options.showMessage = async () => ({ response: 0 })
  await f.manager.install()
  assert.deepEqual(f.actions, ['download', 'shutdown-requested'])
  assert.equal(f.manager.state.status, 'installing')
  assert.equal(typeof f.options.installCallback, 'function')
})

test('a plugin operation starting during client installation confirmation prevents shutdown', async t => {
  let pluginBusy = false
  const f = fixture(t, { isHarnessInstalling: () => pluginBusy })
  await f.manager.check(false)
  await f.manager.download()
  let answer
  f.options.showMessage = () => new Promise(resolve => { answer = resolve })
  const install = f.manager.install()
  assert.equal(f.manager.installPrompt, true)
  pluginBusy = true
  answer({ response: 0 })
  await install
  assert.equal(f.manager.installPrompt, false)
  assert.equal(f.manager.state.status, 'downloaded')
  assert.deepEqual(f.actions, ['download'])
  assert.equal(f.options.installCallback, undefined)
})

test('download failures and checksum rejection never enable installation', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  f.updater.downloadUpdate = async () => { throw new Error('SHA-512 mismatch fixture') }
  await f.manager.download()
  assert.equal(f.manager.state.status, 'error')
  await f.manager.install()
  assert.deepEqual(f.actions, [])
})

test('progress uses measured bytes and speed, and quitting cancels unfinished downloads', async t => {
  const f = fixture(t)
  await f.manager.check(false)
  let finish
  f.updater.downloadUpdate = () => new Promise(resolve => { finish = resolve })
  const downloading = f.manager.download()
  await Promise.resolve()
  f.updater.emit('download-progress', { total: 1000, transferred: 250, bytesPerSecond: 50 })
  assert.equal(f.manager.state.percent, 25)
  assert.equal(f.manager.state.remainingSeconds, 15)
  f.manager.dispose()
  assert.deepEqual(f.actions, ['cancel'])
  finish(['verified-fixture.exe'])
  await downloading
  assert.equal(f.manager.state.status, 'downloading')
  assert.equal(f.notifications.length, 1)
  assert.doesNotThrow(() => f.updater.emit('error', new Error('late fixture failure')))
})

test('development and portable clients cannot download an installer automatically', async t => {
  const f = fixture(t, { supported: false })
  await f.manager.check(false)
  await f.manager.download()
  assert.deepEqual(f.actions, [])
  assert.equal(f.notifications.length, 0)
})

test('concurrent checks share one network request', async t => {
  const f = fixture(t)
  let resolveCheck, calls = 0
  f.updater.checkForUpdates = () => { calls += 1; return new Promise(resolve => { resolveCheck = resolve }) }
  const first = f.manager.check(false)
  const second = f.manager.check(false)
  resolveCheck({ isUpdateAvailable: false, updateInfo: release('0.4.0') })
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(f.manager.state.status, 'idle')
  assert.equal(f.notifications.length, 0)
})

test('client settings persist only autoCheck and expose a safe snapshot', async t => {
  const f = fixture(t)
  f.manager.updatePreferences({ autoCheck: false })
  assert.equal(JSON.parse(readFileSync(f.manager.preferencesPath)).autoCheck, false)
  assert.equal(f.manager.getSettingsState().autoCheck, false)
  assert.equal(f.manager.getSettingsState().currentVersion, '0.5.0')
  assert.equal(f.manager.getSettingsState().supported, true)
  assert.deepEqual(f.actions, [])
  for (const patch of [null, [], {}, { autoCheck: 'false' }, { autoCheck: true, feed: 'https://evil.example' }, Object.assign(Object.create({ autoCheck: true }), { feed: 'ignored' })]) {
    assert.throws(() => f.manager.updatePreferences(patch))
  }
  f.manager.setState({ status: 'error', error: 'private fixture token' })
  assert.doesNotMatch(JSON.stringify(f.manager.getSettingsState()), /private fixture/u)
})

test('client preference save failure rolls back without starting an update', t => {
  const f = fixture(t)
  f.manager.persist = () => false
  assert.throws(() => f.manager.updatePreferences({ autoCheck: false }), /保存/u)
  assert.equal(f.manager.getSettingsState().autoCheck, true)
  assert.equal(f.manager.timer, undefined)
  assert.deepEqual(f.actions, [])
})
