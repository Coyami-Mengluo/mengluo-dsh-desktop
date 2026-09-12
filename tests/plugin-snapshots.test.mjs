import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, it } from 'node:test'
import { PluginSnapshots } from '../src/plugin-snapshots.mjs'

const roots = []
const runFile = promisify(execFile)
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture({ populated = true, fault, onProgress } = {}) {
  // macOS /var is a system alias; fixtures use its physical path, not a symlink ancestor.
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'plugin-snapshots-fixture-')))
  roots.push(root)
  const userData = path.join(root, 'shell'), dshHome = path.join(root, 'harness')
  const profile = path.join(dshHome, 'profiles', 'web'), record = path.join(userData, 'plugin-sources.json')
  await fs.mkdir(userData)
  await fs.mkdir(dshHome)
  await fs.writeFile(path.join(dshHome, 'chat-private.txt'), 'out of scope')
  const options = { userData, dshHome, fault, onProgress }
  const snapshots = new PluginSnapshots(options)
  async function put(relative, contents) {
    const target = path.join(profile, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }
  if (populated) {
    await put('package.json', '{"dependencies":{"example":"1.0.0"}}')
    await put('node_modules/example/index.js', 'export default "old bytes"')
    await put('config/settings.json', '{"privateFixture":"old fixture settings"}')
    await fs.writeFile(record, '{ "example": { "fixture": 1 } }\n')
  }
  return { root, userData, dshHome, profile, record, snapshots, options, put,
    create: () => snapshots.create({ runtimeVersion: '0.0.49', action: 'update', pluginName: 'example' }),
    snapshotPath: id => path.join(userData, 'plugin-snapshots', id),
  }
}

async function postOperation(world) {
  await world.put('package.json', '{"dependencies":{"example":"2.0.0"}}')
  await world.put('node_modules/example/index.js', 'export default "new bytes"')
  await world.put('new-file.txt', 'added by installer fixture')
  await fs.writeFile(world.record, '{"example":{"fixture":2}}')
}

async function shortDirectoryPath(directory) {
  // Child-only environment variable; neither the real profile nor global
  // TEMP/TMP is changed. COM reports the actual filesystem-provided 8.3 name.
  const { stdout } = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; $fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:PLUGIN_SNAPSHOT_FIXTURE_DIR).ShortPath'],
  { env: { ...process.env, PLUGIN_SNAPSHOT_FIXTURE_DIR: directory }, windowsHide: true, timeout: 10_000, maxBuffer: 4096 })
  return stdout.trim()
}

describe('offline plugin snapshots use temp fixtures only', () => {
  it('accepts real Windows 8.3 root aliases and restores source bytes and internal PNPM junctions', async t => {
    if (process.platform !== 'win32') return t.skip('Windows 8.3 directory aliases')
    const world = await fixture()
    await world.put('node_modules/.pnpm/dependency-long-name/node_modules/dependency/index.js', 'dependency fixture')
    const dependency = path.join(world.profile, 'node_modules/.pnpm/dependency-long-name/node_modules/dependency')
    const [shortUserData, shortDshHome, shortDependency] = await Promise.all([
      shortDirectoryPath(world.userData), shortDirectoryPath(world.dshHome), shortDirectoryPath(dependency),
    ])
    const userData = await fs.realpath(world.userData), dshHome = await fs.realpath(world.dshHome)
    if (path.relative(shortUserData, userData) === '' || path.relative(shortDshHome, dshHome) === '') return t.skip('8.3 name creation is disabled on the fixture volume')
    assert.equal((await fs.lstat(shortUserData)).isSymbolicLink(), false)
    assert.equal((await fs.lstat(shortDshHome)).isSymbolicLink(), false)
    const link = path.join(world.profile, 'node_modules/dependency')
    await fs.symlink(shortDependency, link, 'junction')
    for (const options of [
      { userData: shortUserData, dshHome: shortDshHome }, { userData, dshHome: shortDshHome },
      { userData: shortUserData, dshHome }, { userData, dshHome },
    ]) {
      const snapshots = new PluginSnapshots(options)
      const snapshot = await snapshots.create({ runtimeVersion: '1.0.0', action: 'update', pluginName: 'example' })
      await postOperation(world)
      await snapshots.markAfter(snapshot.id, { status: 'success' })
      assert.equal((await snapshots.inspect(snapshot.id)).canRestore, true)
      await snapshots.restore(snapshot.id)
      assert.equal(await fs.readFile(world.record, 'utf8'), '{ "example": { "fixture": 1 } }\n')
      assert.equal(await fs.readFile(path.join(link, 'index.js'), 'utf8'), 'dependency fixture')
      assert.equal(path.relative(snapshots.recordPath, await fs.realpath(world.record)), '')
      assert.equal((await snapshots.getRecoveryState()).recoveryRequired, false)
    }
  })

  it('rejects real junction ancestors and overlapping roots reached through Windows short aliases', async t => {
    if (process.platform !== 'win32') return t.skip('Windows 8.3 ancestor checks')
    const world = await fixture()
    const shortRoot = await shortDirectoryPath(world.root)
    if (path.relative(shortRoot, await fs.realpath(world.root)) === '') return t.skip('8.3 name creation is disabled on the fixture volume')
    const junction = path.join(shortRoot, 'linked-parent')
    await fs.symlink(await fs.realpath(world.userData), junction, 'junction')
    const unsafe = new PluginSnapshots({ userData: path.join(junction, 'nested'), dshHome: world.dshHome })
    await assert.rejects(unsafe.create({ runtimeVersion: '1.0.0', action: 'update', pluginName: 'example' }), { code: 'SNAPSHOT_PATH' })
    const nested = path.join(world.profile, 'nested-shell')
    await fs.mkdir(nested)
    const overlapping = new PluginSnapshots({ userData: await shortDirectoryPath(nested), dshHome: await fs.realpath(world.dshHome) })
    await assert.rejects(overlapping.create({ runtimeVersion: '1.0.0', action: 'update', pluginName: 'example' }), { code: 'SNAPSHOT_PATH' })
    assert.equal(await fs.readFile(world.record, 'utf8'), '{ "example": { "fixture": 1 } }\n')
  })

  it('preserves complete packages/config and exact source-record bytes, then restores without any install tool', async () => {
    const updates = []
    const world = await fixture({ onProgress: item => updates.push(item) })
    const snapshot = await world.create()
    assert.equal(snapshot.status, 'pending')
    assert.equal(snapshot.files, 4)
    assert.equal((await world.snapshots.inspect(snapshot.id)).canRestore, false)
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    assert.equal((await world.snapshots.inspect(snapshot.id)).canRestore, true)
    assert.equal((await world.snapshots.restore(snapshot.id)).restored, true)
    assert.equal(await fs.readFile(path.join(world.profile, 'node_modules/example/index.js'), 'utf8'), 'export default "old bytes"')
    assert.equal(await fs.readFile(world.record, 'utf8'), '{ "example": { "fixture": 1 } }\n')
    assert.equal(await fs.readFile(path.join(world.profile, 'config/settings.json'), 'utf8'), '{"privateFixture":"old fixture settings"}')
    await assert.rejects(fs.stat(path.join(world.profile, 'new-file.txt')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(world.dshHome, 'chat-private.txt'), 'utf8'), 'out of scope')
    assert.equal((await world.snapshots.getRecoveryState()).recoveryRequired, false)
    assert.equal((await world.snapshots.list())[0].status, 'restored')
    assert.ok(updates.length > 0 && updates.length < 100)
    assert.ok(updates.every(item => item.label && item.detail && !JSON.stringify(item).includes(world.root)))
    const recovery = (await fs.readdir(path.dirname(world.profile))).find(name => name.startsWith('.plugin-recovery-'))
    assert.ok(recovery)
    assert.equal(await fs.readFile(path.join(path.dirname(world.profile), recovery, 'new-file.txt'), 'utf8'), 'added by installer fixture')
  })

  it('represents missing profile and records as absent and retains newly installed files during rollback', async () => {
    const world = await fixture({ populated: false })
    const snapshot = await world.create()
    assert.equal(snapshot.bytes, 0)
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'failed' })
    await world.snapshots.restore(snapshot.id)
    await assert.rejects(fs.stat(world.profile), { code: 'ENOENT' })
    await assert.rejects(fs.stat(world.record), { code: 'ENOENT' })
    assert.equal((await world.snapshots.getRecoveryState()).recoveryRequired, false)
  })

  it('restores an existing snapshot when the current profile and sources are absent', async () => {
    const world = await fixture()
    const snapshot = await world.create()
    await fs.rm(world.profile, { recursive: true })
    await fs.unlink(world.record)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    await world.snapshots.restore(snapshot.id)
    assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /1\.0\.0/u)
    assert.match(await fs.readFile(world.record, 'utf8'), /fixture/u)
  })

  it('rejects tampered payloads and manifests before touching live data', async () => {
    for (const target of ['payload', 'manifest']) {
      const world = await fixture()
      const snapshot = await world.create()
      await postOperation(world)
      await world.snapshots.markAfter(snapshot.id, { status: 'failed' })
      if (target === 'payload') await fs.writeFile(path.join(world.snapshotPath(snapshot.id), 'web/package.json'), 'tampered')
      else {
        const filename = path.join(world.snapshotPath(snapshot.id), 'manifest.json')
        const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
        manifest.before.profile.entries[0].path = '../outside'
        await fs.writeFile(filename, JSON.stringify(manifest))
      }
      assert.equal((await world.snapshots.inspect(snapshot.id)).canRestore, false)
      await assert.rejects(world.snapshots.restore(snapshot.id))
      assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
      assert.equal((await world.snapshots.getRecoveryState()).recoveryRequired, false)
    }
  })

  it('detects external changes to profile or source records, including a change after staging', async () => {
    for (const target of ['profile', 'record', 'during-stage']) {
      const world = await fixture()
      const snapshot = await world.create()
      await postOperation(world)
      await world.snapshots.markAfter(snapshot.id, { status: 'success' })
      if (target === 'profile') await world.put('external.txt', 'external fixture edit')
      if (target === 'record') await fs.writeFile(world.record, '{"external":true}')
      if (target === 'during-stage') world.snapshots.fault = async point => { if (point === 'beforeProfileSwap') await world.put('external.txt', 'external fixture edit') }
      await assert.rejects(world.snapshots.restore(snapshot.id), error => ['SNAPSHOT_CHANGED', 'SNAPSHOT_RECOVERY'].includes(error.code))
      assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
      if (target !== 'record') assert.equal(await fs.readFile(path.join(world.profile, 'external.txt'), 'utf8'), 'external fixture edit')
      assert.equal((await world.snapshots.getRecoveryState()).recoveryRequired, false)
    }
  })

  it('rejects changes during snapshot copying without publishing a snapshot or changing the live profile', async () => {
    const world = await fixture()
    world.snapshots.fault = async point => { if (point === 'afterSnapshotCopy') await world.put('external.txt', 'concurrent fixture') }
    await assert.rejects(world.create(), { code: 'SNAPSHOT_CHANGED' })
    assert.deepEqual(await world.snapshots.list(), [])
    assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /1\.0\.0/u)
    assert.equal(await fs.readFile(path.join(world.profile, 'external.txt'), 'utf8'), 'concurrent fixture')
  })

  it('rejects IDs, root paths, unsafe ancestors, external links, file links, and directory cycles', async t => {
    const world = await fixture()
    for (const id of ['../outside', 'C:\\outside', 'not-a-uuid']) await assert.rejects(world.snapshots.restore(id), { code: 'SNAPSHOT_INVALID' })
    assert.throws(() => new PluginSnapshots({ userData: 'relative', dshHome: world.dshHome }), { code: 'SNAPSHOT_PATH' })
    assert.throws(() => new PluginSnapshots({ userData: path.parse(world.root).root, dshHome: world.dshHome }), { code: 'SNAPSHOT_PATH' })
    assert.throws(() => new PluginSnapshots({ userData: path.join(world.profile, 'shell'), dshHome: world.dshHome }), { code: 'SNAPSHOT_PATH' })
    const external = path.join(world.root, 'outside')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'untouched.txt'), 'fixture')
    const link = path.join(world.profile, 'external-link')
    try { await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (error.code === 'EPERM') return t.skip('Directory symlinks unavailable for this fixture account'); throw error }
    await assert.rejects(world.create(), { code: 'SNAPSHOT_PATH' })
    await fs.unlink(link)
    await fs.symlink(world.profile, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(world.create(), { code: 'SNAPSHOT_PATH' })
    await fs.unlink(link)
    const shellAlias = path.join(world.root, 'shell-alias')
    await fs.symlink(world.userData, shellAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const unsafe = new PluginSnapshots({ userData: shellAlias, dshHome: world.dshHome })
    await assert.rejects(unsafe.create({ runtimeVersion: '1.0.0', action: 'update', pluginName: 'fixture' }), { code: 'SNAPSHOT_PATH' })
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(world.profile, 'package.json'), link)
      await assert.rejects(world.create(), { code: 'SNAPSHOT_PATH' })
    }
    assert.equal(await fs.readFile(path.join(external, 'untouched.txt'), 'utf8'), 'fixture')
  })

  it('copies PNPM internal directory links without traversing and rebases junctions after restore', async t => {
    const world = await fixture()
    await world.put('node_modules/.pnpm/dependency@1/node_modules/dependency/index.js', 'dependency fixture')
    const target = path.join(world.profile, 'node_modules/.pnpm/dependency@1/node_modules/dependency')
    const link = path.join(world.profile, 'node_modules/dependency')
    try { await fs.symlink(process.platform === 'win32' ? target : path.relative(path.dirname(link), target), link, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (error.code === 'EPERM') return t.skip('Directory symlinks unavailable for this fixture account'); throw error }
    const snapshot = await world.create()
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    await world.snapshots.restore(snapshot.id)
    assert.equal(await fs.readFile(path.join(link, 'index.js'), 'utf8'), 'dependency fixture')
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
    assert.equal((await world.snapshots.inspect(snapshot.id)).canRestore, true)
    const manifest = JSON.parse(await fs.readFile(path.join(world.snapshotPath(snapshot.id), 'manifest.json'), 'utf8'))
    const savedLink = manifest.before.profile.entries.find(entry => entry.type === 'link')
    assert.equal(savedLink.target, 'node_modules/.pnpm/dependency@1/node_modules/dependency')
    assert.equal(manifest.files, 5)
  })

  it('reverts failures at each swap boundary without losing the post-operation originals', async () => {
    for (const point of ['afterProfileBackup', 'afterProfileSwap', 'afterRecordBackup', 'afterRecordSwap', 'beforeCommit']) {
      const world = await fixture()
      const snapshot = await world.create()
      await postOperation(world)
      await world.snapshots.markAfter(snapshot.id, { status: 'success' })
      world.snapshots.fault = async current => { if (current === point) throw new Error('fixture swap failure') }
      await assert.rejects(world.snapshots.restore(snapshot.id), error => error.code === 'SNAPSHOT_FAILED' && !error.recoveryRequired)
      assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
      assert.equal(await fs.readFile(world.record, 'utf8'), '{"example":{"fixture":2}}')
      assert.equal((await world.snapshots.getRecoveryState()).recoveryRequired, false)
      assert.equal((await world.snapshots.inspect(snapshot.id)).canRestore, true)
    }
  })

  it('supports nontraversed PNPM cyclic dependencies and recovers a crash mid-junction replacement', async t => {
    if (process.platform !== 'win32') return t.skip('Windows junction replacement transaction')
    const world = await fixture()
    await world.put('node_modules/.pnpm/a/node_modules/a/index.js', 'package a fixture')
    await world.put('node_modules/.pnpm/b/node_modules/b/index.js', 'package b fixture')
    const a = path.join(world.profile, 'node_modules/.pnpm/a/node_modules/a')
    const b = path.join(world.profile, 'node_modules/.pnpm/b/node_modules/b')
    await fs.symlink(b, path.join(a, 'b'), 'junction')
    await fs.symlink(a, path.join(b, 'a'), 'junction')
    const snapshot = await world.create()
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    world.snapshots.fault = async point => { if (point === 'afterLinkUnlink') throw Object.assign(new Error('fixture junction crash'), { simulateCrash: true }) }
    await assert.rejects(world.snapshots.restore(snapshot.id), error => error.recoveryRequired === true)
    const restarted = new PluginSnapshots({ userData: world.userData, dshHome: world.dshHome })
    assert.equal((await restarted.recover()).recovered, true)
    assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
    assert.equal(await fs.readFile(path.join(a, 'b/index.js'), 'utf8'), 'package b fixture')
    assert.equal(await fs.readFile(path.join(b, 'a/index.js'), 'utf8'), 'package a fixture')
    await restarted.restore(snapshot.id)
    assert.equal(await fs.readFile(path.join(a, 'b/index.js'), 'utf8'), 'package b fixture')
  })

  it('does not overwrite a tampered retained junction during recovery', async t => {
    if (process.platform !== 'win32') return t.skip('Windows retained junction validation')
    const world = await fixture()
    await world.put('node_modules/.pnpm/dependency/index.js', 'dependency fixture')
    await fs.symlink(path.join(world.profile, 'node_modules/.pnpm/dependency'), path.join(world.profile, 'node_modules/dependency'), 'junction')
    const snapshot = await world.create()
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    world.snapshots.fault = async point => { if (point === 'afterProfileBackup') throw Object.assign(new Error('fixture crash'), { simulateCrash: true }) }
    await assert.rejects(world.snapshots.restore(snapshot.id))
    const retained = (await fs.readdir(path.dirname(world.profile))).find(name => name.startsWith('.plugin-recovery-'))
    const link = path.join(path.dirname(world.profile), retained, 'node_modules/dependency')
    const external = path.join(world.root, 'external')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'keep.txt'), 'external fixture')
    await fs.unlink(link)
    await fs.symlink(external, link, 'junction')
    const restarted = new PluginSnapshots({ userData: world.userData, dshHome: world.dshHome })
    await assert.rejects(restarted.recover(), error => error.recoveryRequired === true)
    assert.equal(path.relative(external, await fs.readlink(link)), '')
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'external fixture')
  })

  it('detects an interrupted journal after restart, blocks mutations, and explicitly recovers both components', async () => {
    for (const point of ['afterProfileBackup', 'afterProfileSwap', 'afterRecordBackup', 'afterRecordSwap']) {
      const world = await fixture()
      const snapshot = await world.create()
      await postOperation(world)
      await world.snapshots.markAfter(snapshot.id, { status: 'success' })
      world.snapshots.fault = async current => { if (current === point) throw Object.assign(new Error('fixture simulated crash'), { simulateCrash: true }) }
      await assert.rejects(world.snapshots.restore(snapshot.id), error => error.recoveryRequired === true)
      const restarted = new PluginSnapshots({ userData: world.userData, dshHome: world.dshHome })
      assert.equal((await restarted.getRecoveryState()).recoveryRequired, true)
      assert.equal((await restarted.list())[0].recoveryRequired, true)
      assert.equal((await restarted.inspect(snapshot.id)).canRestore, false)
      await assert.rejects(restarted.create({ runtimeVersion: '1.0.0', action: 'update', pluginName: 'example' }), { code: 'SNAPSHOT_RECOVERY' })
      await assert.rejects(restarted.restore(snapshot.id), { code: 'SNAPSHOT_RECOVERY' })
      await assert.rejects(restarted.remove(snapshot.id), { code: 'SNAPSHOT_RECOVERY' })
      assert.equal((await restarted.recover()).recovered, true)
      assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
      assert.equal(await fs.readFile(world.record, 'utf8'), '{"example":{"fixture":2}}')
      assert.equal((await restarted.getRecoveryState()).recoveryRequired, false)
    }
  })

  it('refuses to repair externally edited interrupted state and preserves the retained original', async () => {
    const world = await fixture()
    const snapshot = await world.create()
    await postOperation(world)
    await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    world.snapshots.fault = async point => { if (point === 'afterProfileSwap') throw Object.assign(new Error('fixture crash'), { simulateCrash: true }) }
    await assert.rejects(world.snapshots.restore(snapshot.id))
    await world.put('external.txt', 'external fixture edit')
    const restarted = new PluginSnapshots({ userData: world.userData, dshHome: world.dshHome })
    await assert.rejects(restarted.recover(), error => error.recoveryRequired === true)
    assert.equal((await restarted.getRecoveryState()).recoveryRequired, true)
    assert.equal(await fs.readFile(path.join(world.profile, 'external.txt'), 'utf8'), 'external fixture edit')
    const recovery = (await fs.readdir(path.dirname(world.profile))).find(name => name.startsWith('.plugin-recovery-'))
    assert.equal(await fs.readFile(path.join(path.dirname(world.profile), recovery, 'new-file.txt'), 'utf8'), 'added by installer fixture')
  })

  it('resumes recovery after a second crash at either component rename boundary', async () => {
    for (const point of ['afterRecoveryProfilePreserve', 'afterRecoveryProfileReturn', 'afterRecoveryRecordPreserve', 'afterRecoveryRecordReturn']) {
      const world = await fixture()
      const snapshot = await world.create()
      await postOperation(world)
      await world.snapshots.markAfter(snapshot.id, { status: 'success' })
      world.snapshots.fault = async current => { if (current === 'afterRecordSwap') throw Object.assign(new Error('fixture restore crash'), { simulateCrash: true }) }
      await assert.rejects(world.snapshots.restore(snapshot.id))
      const interrupted = new PluginSnapshots({ ...world.options, fault: async current => { if (current === point) throw new Error('fixture repair crash') } })
      await assert.rejects(interrupted.recover(), error => error.recoveryRequired === true)
      const restarted = new PluginSnapshots({ userData: world.userData, dshHome: world.dshHome })
      assert.equal((await restarted.recover()).recovered, true)
      assert.match(await fs.readFile(path.join(world.profile, 'package.json'), 'utf8'), /2\.0\.0/u)
      assert.equal(await fs.readFile(world.record, 'utf8'), '{"example":{"fixture":2}}')
      assert.equal((await restarted.getRecoveryState()).recoveryRequired, false)
    }
  })

  it('bounds retention to five completed snapshots and never deletes an unknown directory', async () => {
    const world = await fixture()
    let tick = Date.now()
    world.snapshots.now = () => ++tick
    const restored = await world.create()
    await postOperation(world)
    await world.snapshots.markAfter(restored.id, { status: 'success' })
    await world.snapshots.restore(restored.id)
    for (let index = 0; index < 7; index++) {
      const snapshot = await world.create()
      await world.snapshots.markAfter(snapshot.id, { status: 'success' })
    }
    const directory = path.join(world.userData, 'plugin-snapshots')
    await fs.mkdir(path.join(directory, 'unknown-owned-by-user'))
    await fs.writeFile(path.join(directory, 'unknown-owned-by-user', 'keep.txt'), 'keep fixture')
    const listed = await world.snapshots.list()
    assert.equal(listed.length, 5)
    assert.equal((await fs.readdir(directory)).filter(name => /^[a-f0-9-]{36}$/u.test(name)).length, 5)
    await assert.rejects(fs.stat(world.snapshotPath(restored.id)), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(directory, 'unknown-owned-by-user', 'keep.txt'), 'utf8'), 'keep fixture')
    assert.ok(listed.every(item => !JSON.stringify(item).includes(world.root) && !JSON.stringify(item).includes('privateFixture')))
  })
})
