import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeVersionManager, listInstalledVersions } from '../src/runtime-versions.mjs'
import { defaultRuntimeState } from '../src/runtime-store.mjs'
import { createHarnessDataBackup } from '../src/plugin-snapshots.mjs'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { validateSettingsAction } from '../src/settings-window.mjs'

function fixture(options = {}) {
  const events = []
  const updater = {
    userData: 'fixture-only', currentRuntime: { version: '1.2.0', nodePath: process.execPath },
    state: { ...defaultRuntimeState(), activeVersion: '1.2.0', pendingVersion: '1.3.0' },
    persistState(value) { events.push('persist'); if (options.persistFails) return false; this.state = value; return true },
    rebuildMenu() {}, scheduleAutomaticCheck() {},
    fetchAvailableVersions: async () => { events.push('catalog'); return [{ version: '1.4.0' }] },
    prepareRelease(release, config) {
      assert.equal(config.stageOnly, true)
      events.push('install'); this.installPromise = Promise.resolve({ version: release.version }).finally(() => { this.installPromise = undefined })
      return true
    },
  }
  const manager = new RuntimeVersionManager({ updater,
    listInstalled: async () => ['1.2.0', '1.1.0', '1.3.0'],
    showMessage: async message => { events.push('confirm'); assert.equal(message.defaultId, 1); return { response: 0 } },
    verify: async input => { events.push('verify'); assert.equal(input.operation, 'verify') },
    backup: async () => { events.push('backup'); return 'private-fixture-backup' },
    withBackendStopped: async operation => { events.push('stop'); try { await operation() } finally { events.push('resume-or-quit') } },
    requestRestart: () => { events.push('restart'); return true }, log() {}, ...options,
  })
  return { manager, updater, events }
}

test('strict version IPC permits only fixed actions and exact versions', () => {
  for (const type of ['harness-version-switch', 'harness-version-install']) {
    assert.equal(validateSettingsAction({ type, version: '0.1.0-rc.8' }), true)
    for (const version of ['latest', '^1.0.0', '../1.0.0', '1.0.0;cmd', 'https://npmjs.org', '1.0.0 '.trimEnd() + ' ', '1.' + '0'.repeat(81) + '.1', undefined]) {
      assert.equal(validateSettingsAction({ type, version }), false)
    }
    assert.equal(validateSettingsAction({ type, version: '1.0.0', root: 'C:/private' }), false)
  }
  assert.equal(validateSettingsAction({ type: 'harness-version-lock', locked: true }), true)
  assert.equal(validateSettingsAction({ type: 'harness-version-lock', locked: 'yes' }), false)
})

test('downgrade verifies offline, stops backend, backs up, pins then restarts', async () => {
  const { manager, updater, events } = fixture()
  await manager.handleAction({ type: 'harness-version-switch', version: '1.1.0' })
  assert.deepEqual(events, ['confirm', 'verify', 'stop', 'backup', 'persist', 'restart', 'resume-or-quit'])
  assert.equal(updater.currentRuntime.version, '1.2.0')
  assert.equal(updater.state.activeVersion, '1.2.0')
  assert.equal(updater.state.pendingVersion, '1.1.0')
  assert.equal(updater.state.versionLocked, true)
})

test('installed newer versions are verified without download or downgrade backup', async () => {
  const { manager, events } = fixture()
  await manager.handleAction({ type: 'harness-version-switch', version: '1.3.0' })
  assert.deepEqual(events, ['confirm', 'verify', 'stop', 'persist', 'restart', 'resume-or-quit'])
})

test('cancel, unavailable targets, concurrent work and stale confirmation cannot schedule a switch', async () => {
  for (const target of ['../escape', '8.8.8', '1.2.0']) {
    const { manager, updater, events } = fixture()
    await assert.rejects(manager.handleAction({ type: 'harness-version-switch', version: target }))
    assert.equal(updater.state.pendingVersion, '1.3.0')
    assert.equal(events.includes('verify'), false)
  }
  const cancelled = fixture({ showMessage: async () => ({ response: 1 }) })
  await cancelled.manager.handleAction({ type: 'harness-version-switch', version: '1.1.0' })
  assert.deepEqual(cancelled.events, [])
  const answer = Promise.withResolvers()
  const world = fixture({ showMessage: () => answer.promise })
  const pending = world.manager.handleAction({ type: 'harness-version-switch', version: '1.1.0' })
  await assert.rejects(world.manager.handleAction({ type: 'harness-version-switch', version: '1.3.0' }))
  world.updater.currentRuntime = { version: '1.2.1' }
  answer.resolve({ response: 0 })
  await assert.rejects(pending)
  assert.equal(world.events.includes('verify'), false)
})

test('failed verification, backup, shutdown or persistence preserves the previous selection', async () => {
  for (const key of ['verify', 'backup', 'withBackendStopped', 'persistFails']) {
    const { manager, updater, events } = fixture({ [key]: key === 'persistFails' ? true : async () => { throw new Error('fixture failure') } })
    const previous = structuredClone(updater.state)
    await assert.rejects(manager.handleAction({ type: 'harness-version-switch', version: '1.1.0' }))
    assert.deepEqual(updater.state, previous)
    assert.equal(events.includes('restart'), false)
    assert.equal(manager.isBusy(), false)
    assert.equal(manager.phase, 'error')
  }
})

test('rejected restart undoes pending switch and releases the operation lock', async () => {
  const { manager, updater } = fixture({ requestRestart: () => false })
  const before = structuredClone(updater.state)
  await assert.rejects(manager.handleAction({ type: 'harness-version-switch', version: '1.1.0' }))
  assert.deepEqual(updater.state, before)
  assert.equal(manager.committed, false)
  assert.equal(manager.isBusy(), false)
})

test('registry downloads are stage-only and unknown packages are never installed', async () => {
  const { manager, updater, events } = fixture()
  await assert.rejects(manager.handleAction({ type: 'harness-version-install', version: '7.7.7' }))
  await manager.refreshCatalog()
  await manager.refreshCatalog()
  assert.equal(events.filter(item => item === 'catalog').length, 1)
  const previous = structuredClone(updater.state)
  await manager.handleAction({ type: 'harness-version-install', version: '1.4.0' })
  assert.equal(events.includes('install'), true)
  assert.deepEqual(updater.state, previous)
  assert.equal(manager.phase, 'installed')
  assert.equal(events.includes('restart'), false)
})

test('pin clears a stale prepared switch; unpin does not install or restart', async () => {
  const { manager, updater, events } = fixture()
  await manager.handleAction({ type: 'harness-version-lock', locked: true })
  assert.equal(updater.state.pendingVersion, undefined)
  assert.equal(updater.state.versionLocked, true)
  await manager.handleAction({ type: 'harness-version-lock', locked: false })
  assert.equal(updater.state.versionLocked, false)
  assert.deepEqual(events, ['persist', 'persist'])
})

async function directories(t) {
  // macOS /var aliases /private/var; use the physical fixture root as existing snapshot tests do.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mengluo-version-backup-test-')))
  t.after(() => removeTreeWithoutFollowingLinks(root))
  const userData = join(root, 'client'), dshHome = join(root, 'dsh')
  await mkdir(userData); await mkdir(dshHome)
  return { root, userData, dshHome, fromVersion: '1.2.0', toVersion: '1.1.0' }
}

test('local listing excludes invalid, unfinished and quarantined slots', async t => {
  const { userData } = await directories(t)
  for (const version of ['1.0.0', '2.0.0', '.quarantine', '3.0.0']) {
    const root = join(userData, 'harness-runtimes', version)
    await mkdir(root, { recursive: true })
    if (version !== '3.0.0') await writeFile(join(root, 'desktop-runtime-seal.json'), JSON.stringify({ package: '@deepseek-ai/dsh', version }))
  }
  assert.deepEqual(await listInstalledVersions(userData), ['2.0.0', '1.0.0'])
})

test('downgrade backup copies chats, configuration and plugin bytes without touching originals', async t => {
  const config = await directories(t)
  const fixtures = { 'chats/session.json': '{"messages":["private fixture"]}', 'config.json': '{"key":"fixture-only"}', 'profiles/web/package.json': '{"dependencies":{}}' }
  for (const [filename, bytes] of Object.entries(fixtures)) {
    const target = join(config.dshHome, filename)
    await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes)
  }
  await writeFile(join(config.userData, 'plugin-sources.json'), '{}')
  const target = await createHarnessDataBackup(config)
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
  assert.equal(manifest.kind, 'harness-downgrade-data')
  for (const [filename, bytes] of Object.entries(fixtures)) {
    assert.equal(await readFile(join(target, 'dsh-home', filename), 'utf8'), bytes)
    assert.equal(await readFile(join(config.dshHome, filename), 'utf8'), bytes)
  }
  assert.equal(await readFile(join(target, 'plugin-sources.json'), 'utf8'), '{}')
})

test('oversized data cannot produce a completed backup', async t => {
  const config = await directories(t)
  const large = join(config.dshHome, 'too-large')
  await writeFile(large, ''); await truncate(large, 2 * 1024 ** 3 + 1)
  await assert.rejects(createHarnessDataBackup(config), { code: 'SNAPSHOT_LIMIT' })
  const store = join(config.userData, 'harness-data-backups')
  for (const folder of await readdir(store)) assert.equal((await readdir(join(store, folder))).includes('manifest.json'), false)
})

test('backup refuses external directory links without copying or changing their target', async t => {
  const config = await directories(t)
  const outside = join(config.root, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'outside fixture')
  await symlink(outside, join(config.dshHome, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createHarnessDataBackup(config), { code: 'SNAPSHOT_PATH' })
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'outside fixture')
})
