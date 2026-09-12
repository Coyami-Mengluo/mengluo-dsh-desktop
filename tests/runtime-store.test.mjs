import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  defaultRuntimeState,
  inspectNodeVersion,
  managedRuntimeDirectory,
  markRuntimeFailed,
  markRuntimePending,
  markRuntimeReady,
  normalizeRuntimeState,
  readRuntimeState,
  readInstallerNode,
  runtimeStatePath,
  selectRuntime,
  verifyRuntimeSeal,
  writeRuntimeSeal,
  writeRuntimeState,
} from '../src/runtime-store.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop runtime store', () => {
  it('normalizes corrupt persisted preferences and path-like versions', () => {
    assert.deepEqual(normalizeRuntimeState({
      autoCheck: false,
      interval: 'hourly',
      channel: 'evil',
      activeVersion: '../escape',
      badVersions: ['1.2.3', '../escape', '1.2.3'],
    }), {
      ...defaultRuntimeState(),
      autoCheck: false,
      badVersions: ['1.2.3'],
    })
  })

  it('writes state atomically and recovers from malformed JSON', () => {
    const userData = temporaryDirectory()
    const stored = writeRuntimeState(userData, { ...defaultRuntimeState(), interval: '6h' })
    assert.equal(readRuntimeState(userData).interval, '6h')
    assert.equal(JSON.parse(readFileSync(runtimeStatePath(userData), 'utf8')).schema, 1)
    assert.equal(stored.interval, '6h')
    writeFileSync(runtimeStatePath(userData), '{broken', 'utf8')
    assert.deepEqual(readRuntimeState(userData), defaultRuntimeState())
  })

  it('selects a valid pending runtime before active and previous', () => {
    const userData = temporaryDirectory()
    installFixture(userData, '1.2.3')
    installFixture(userData, '1.3.0')
    const selected = selectRuntime(userData, {
      ...defaultRuntimeState(),
      activeVersion: '1.2.3',
      pendingVersion: '1.3.0',
    })
    assert.equal(selected.version, '1.3.0')
    assert.equal(selected.source, 'managed')
    assert.match(selected.nodePath, /node-runtime[\\/]node\.exe$/u)
  })

  it('requires setup when no installed slot is valid, and recovers an available previous slot', () => {
    const userData = temporaryDirectory()
    installFixture(userData, '1.2.3')
    assert.equal(selectRuntime(userData, defaultRuntimeState()), undefined)
    assert.equal(selectRuntime(userData, { ...defaultRuntimeState(), activeVersion: '9.9.9' }), undefined)
    assert.equal(selectRuntime(userData, {
      ...defaultRuntimeState(),
      activeVersion: '1.2.3',
      badVersions: ['1.2.3'],
    }), undefined)
    assert.equal(selectRuntime(userData, {
      ...defaultRuntimeState(), activeVersion: '9.9.9', previousVersion: '1.2.3',
    }).version, '1.2.3')
  })

  it('commits pending readiness and quarantines failures', () => {
    const pending = markRuntimePending({ ...defaultRuntimeState(), activeVersion: '1.2.3' }, '1.3.0')
    const ready = markRuntimeReady(pending, { source: 'managed', version: '1.3.0' })
    assert.equal(ready.activeVersion, '1.3.0')
    assert.equal(ready.previousVersion, '1.2.3')
    assert.equal(ready.pendingVersion, undefined)
    const failed = markRuntimeFailed(ready, { source: 'managed', version: '1.3.0' })
    assert.equal(failed.activeVersion, undefined)
    assert.deepEqual(failed.badVersions, ['1.3.0'])
  })

  it('keeps a different pending slot while restarting the already active runtime', () => {
    const state = { ...defaultRuntimeState(), activeVersion: '1.2.3', pendingVersion: '1.3.0', previousVersion: '1.2.2' }
    const ready = markRuntimeReady(state, { source: 'managed', version: '1.2.3' })
    assert.equal(ready.pendingVersion, '1.3.0')
    assert.equal(ready.previousVersion, '1.2.2')
    assert.equal(state.pendingVersion, '1.3.0')
  })

  it('never derives a runtime path from invalid SemVer text', () => {
    const userData = temporaryDirectory()
    assert.throws(() => managedRuntimeDirectory(userData, '..\\escape'), /invalid semantic version/u)
    assert.throws(() => managedRuntimeDirectory(userData, 'v1.2.3'), /invalid semantic version/u)
  })

  it('rejects changes to the CLI, lockfile, and official frontend tree', () => {
    const mutations = [
      root => { writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'changed') },
      root => { writeFileSync(join(root, 'package-lock.json'), '{}') },
      root => { writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), 'changed') },
      root => { writeFileSync(join(root, 'node-runtime', 'node.exe'), 'changed') },
      root => { writeFileSync(join(root, 'node-runtime', 'LICENSE'), 'changed') },
    ]
    for (const mutate of mutations) {
      const userData = temporaryDirectory()
      const root = installFixture(userData, '1.2.3')
      mutate(root)
      assert.equal(selectRuntime(userData, { ...defaultRuntimeState(), activeVersion: '1.2.3' }), undefined)
    }
  })

  it('requires matching web-app and frontend package identities in a seal', () => {
    const userData = temporaryDirectory()
    const root = installFixture(userData, '1.2.3')
    const manifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '1.2.2' }))
    assert.throws(() => { verifyRuntimeSeal(root, '1.2.3') }, /identity mismatch/u)
  })

  it('reads a strict version from a regular standalone Node executable', () => {
    const root = temporaryDirectory()
    const nodePath = join(root, 'node.exe')
    writeFileSync(nodePath, 'fixture')
    assert.equal(inspectNodeVersion(nodePath, () => ({ status: 0, stdout: 'v24.19.0\n' })), '24.19.0')
    assert.throws(
      () => inspectNodeVersion(nodePath, () => ({ status: 0, stdout: 'Electron 43' })),
      /invalid version/u,
    )
  })

  it('describes the first-install Node without any Harness package', () => {
    const root = temporaryDirectory()
    const nodePath = join(root, 'node.exe')
    writeFileSync(nodePath, 'node fixture')
    assert.throws(() => readInstallerNode(nodePath, { nodeVersion: '24.19.0' }), /ENOENT/u)
    writeFileSync(join(root, 'LICENSE'), 'Node license fixture')
    assert.deepEqual(readInstallerNode(nodePath, { nodeVersion: '24.19.0' }), {
      nodePath, nodeVersion: '24.19.0', nodeLicensePath: join(root, 'LICENSE'),
    })
  })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'mengluo-runtime-store-'))
  temporaryDirectories.push(directory)
  return directory
}

function installFixture(userData, version) {
  const root = managedRuntimeDirectory(userData, version)
  const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const webAppRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  const frontendRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  mkdirSync(webAppRoot, { recursive: true })
  mkdirSync(join(frontendRoot, 'dist'), { recursive: true })
  mkdirSync(join(root, 'node-runtime'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version, engines: { node: '^22.19 || >=24' },
  }))
  writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
  writeFileSync(join(webAppRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version }))
  writeFileSync(join(frontendRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version }))
  writeFileSync(join(frontendRoot, 'dist', 'index.html'), '<title>DeepSeek Harness</title>')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }))
  writeFileSync(join(root, 'node-runtime', 'node.exe'), 'fixture-node')
  writeFileSync(join(root, 'node-runtime', 'LICENSE'), 'Node.js is licensed for use as follows:\nfixture')
  writeRuntimeSeal(root, version, { nodeVersion: '24.19.0' })
  return root
}
