import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { installNpmRuntimeClosure, installOfficialRuntime, npmCiArguments, runProcess, validateOfficialRuntimeLock } from '../src/runtime-installer.mjs'
import { UPDATE_INSTALL_TIMEOUT_MS } from '../src/update-progress-window.mjs'

const release = { version: '1.2.3', integrity: `sha512-${'A'.repeat(86)}==` }
const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-frontend', 'dependency']
const directories = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'mengluo-mirror-'))
  directories.push(path)
  return path
}
function createLock(root, edit = () => {}) {
  const manifest = { name: 'fixture-runtime', version: '0.0.0', dependencies: { '@deepseek-ai/dsh': release.version } }
  const lock = { lockfileVersion: 3, packages: { '': manifest } }
  for (const name of names) lock.packages[`node_modules/${name}`] = {
    version: release.version,
    integrity: release.integrity,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${release.version}.tgz`,
  }
  edit(lock)
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock))
  return lock
}
function options(root, additions = {}) {
  return {
    npm: { nodePath: 'node-fixture.exe', npmCliPath: 'npm-cli-fixture.js' },
    staging: root, cache: join(root, 'cache'), userConfig: join(root, 'empty.npmrc'),
    release, downloadSource: 'npmmirror',
    officialProxy: 'http://127.0.0.1:18080', proxy: 'http://127.0.0.1:18081',
    ...additions,
  }
}

describe('integrity-pinned mirror npm installation', () => {
  it('builds script-disabled ci arguments with fixed host substitution and isolated config', () => {
    const args = npmCiArguments({ npmCliPath: 'npm.js', staging: 'stage', cache: 'cache', userConfig: 'empty', downloadSource: 'npmmirror' })
    assert.equal(args[1], 'ci')
    for (const expected of ['--ignore-scripts', '--engine-strict=true', '--registry=https://registry.npmmirror.com/', '--replace-registry-host=npmjs', '--globalconfig=empty.global', '--fetch-timeout=45000']) {
      assert.ok(args.includes(expected))
    }
    assert.throws(() => npmCiArguments({ downloadSource: 'https://attacker.invalid/' }), /unsupported/u)
  })

  it('keeps the official source as one ordinary exact npm install', async () => {
    const calls = []
    const root = temporaryDirectory()
    await installNpmRuntimeClosure(options(root, { downloadSource: 'official', runProcess: async (...args) => { calls.push(args) } }))
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1][1], 'install')
    assert.equal(calls[0][1].includes('--package-lock-only'), false)
    assert.ok(calls[0][1].includes('--registry=https://registry.npmjs.org/'))
    assert.equal(calls[0][2].environment.HTTP_PROXY, 'http://127.0.0.1:18081')
  })

  it('resolves the official lock before mirror ci and never changes its bytes', async () => {
    const root = temporaryDirectory()
    const calls = []
    const reports = []
    let trusted
    await installNpmRuntimeClosure(options(root, {
      onDownloadStatus: value => { reports.push(value) },
      runProcess: async (command, args, settings) => {
        calls.push({ command, args, settings })
        if (calls.length === 1) {
          createLock(root)
          trusted = readFileSync(join(root, 'package-lock.json'))
        }
      },
    }))
    assert.equal(calls.length, 2)
    assert.ok(calls[0].args.includes('--package-lock-only'))
    assert.ok(calls[0].args.includes('--registry=https://registry.npmjs.org/'))
    assert.equal(calls[0].settings.environment.HTTPS_PROXY, 'http://127.0.0.1:18080')
    assert.equal(calls[1].args[1], 'ci')
    assert.ok(calls[1].args.includes('--registry=https://registry.npmmirror.com/'))
    assert.equal(calls[1].settings.environment.HTTPS_PROXY, 'http://127.0.0.1:18081')
    assert.ok(readFileSync(join(root, 'package-lock.json')).equals(trusted))
    assert.deepEqual(reports.map(({ source, fallback }) => ({ source, fallback })), [
      { source: 'official', fallback: false }, { source: 'npmmirror', fallback: false },
    ])
  })

  it('falls back for missing mirror artifacts using official proxy and unchanged graph', async () => {
    const root = temporaryDirectory()
    const calls = []
    const reports = []
    await installNpmRuntimeClosure(options(root, {
      onDownloadStatus: value => { reports.push(value) },
      runProcess: async (_command, args, settings) => {
        calls.push({ args, settings })
        if (calls.length === 1) createLock(root)
        if (calls.length === 2) throw Object.assign(new Error('mirror missing artifact'), { npmCode: 'E404' })
      },
    }))
    assert.equal(calls.length, 3)
    assert.equal(calls[2].args[1], 'ci')
    assert.ok(calls[2].args.includes('--registry=https://registry.npmjs.org/'))
    assert.equal(calls[2].settings.environment.HTTP_PROXY, 'http://127.0.0.1:18080')
    assert.equal(reports.at(-1).fallback, true)
  })

  it('never falls back to bypass integrity or supply-chain errors', async () => {
    for (const code of ['EINTEGRITY', 'ELOCKVERIFY', 'E403', undefined]) {
      const root = temporaryDirectory()
      let calls = 0
      await assert.rejects(installNpmRuntimeClosure(options(root, {
        runProcess: async () => {
          calls += 1
          if (calls === 1) createLock(root)
          else throw Object.assign(new Error('verification failure'), { npmCode: code })
        },
      })), /verification failure/u)
      assert.equal(calls, 2)
    }
  })

  it('rejects graph drift even when the mirror reports a transport failure', async () => {
    const root = temporaryDirectory()
    let calls = 0
    await assert.rejects(installNpmRuntimeClosure(options(root, {
      runProcess: async () => {
        calls += 1
        createLock(root, lock => { if (calls === 2) lock.packages['node_modules/dependency'].version = '9.9.9' })
        if (calls === 2) throw Object.assign(new Error('mirror timeout'), { npmCode: 'ETIMEDOUT' })
      },
    })), /changed the trusted official dependency graph/u)
    assert.equal(calls, 2)
  })

  it('does not start mirror work after cancellation or fallback after cancellation', async () => {
    for (const abortAt of [1, 2]) {
      const root = temporaryDirectory()
      const controller = new AbortController()
      let calls = 0
      await assert.rejects(installNpmRuntimeClosure(options(root, {
        signal: controller.signal,
        runProcess: async () => {
          calls += 1
          if (calls === 1) createLock(root)
          if (calls === abortAt) controller.abort()
          if (calls === 2) throw Object.assign(new Error('mirror timeout'), { npmCode: 'ETIMEDOUT' })
        },
      })), error => error.name === 'AbortError')
      assert.equal(calls, abortAt)
    }
  })

  it('shares one 30-minute budget across metadata, mirror and fallback', async () => {
    const root = temporaryDirectory()
    const timeouts = []
    let elapsed = 0
    await installNpmRuntimeClosure(options(root, {
      now: () => elapsed,
      runProcess: async (_command, _args, settings) => {
        timeouts.push(settings.timeoutMs)
        elapsed += 1_000
        if (timeouts.length === 1) createLock(root)
        if (timeouts.length === 2) throw Object.assign(new Error('mirror timeout'), { npmCode: 'ETIMEDOUT' })
      },
    }))
    assert.deepEqual(timeouts, [UPDATE_INSTALL_TIMEOUT_MS, UPDATE_INSTALL_TIMEOUT_MS - 1_000, UPDATE_INSTALL_TIMEOUT_MS - 2_000])
    elapsed = 0
    let calls = 0
    await assert.rejects(installNpmRuntimeClosure(options(root, {
      now: () => elapsed,
      runProcess: async () => { calls += 1; createLock(root); elapsed = UPDATE_INSTALL_TIMEOUT_MS },
    })), /shared 30-minute timeout budget/u)
    assert.equal(calls, 1)
  })

  it('rejects untrusted registry URLs, missing hashes, links and mismatched official versions', () => {
    const root = temporaryDirectory()
    const invalid = [
      lock => { lock.packages['node_modules/dependency'].resolved = 'https://registry.npmmirror.com/dependency/-/dependency.tgz' },
      lock => { lock.packages['node_modules/dependency'].resolved = 'https://registry.npmjs.org.attacker.invalid/dependency.tgz' },
      lock => { lock.packages['node_modules/dependency'].resolved = 'file:../local.tgz' },
      lock => { lock.packages['node_modules/dependency'].resolved = 'https://user:password@registry.npmjs.org/dependency.tgz' },
      lock => { delete lock.packages['node_modules/dependency'].integrity },
      lock => { lock.packages['node_modules/dependency'].integrity = 'sha1-untrusted' },
      lock => { lock.packages['node_modules/dependency'].link = true },
      lock => { lock.packages['node_modules/../evil'] = lock.packages['node_modules/dependency'] },
      lock => { lock.packages['node_modules/@deepseek-ai/dsh-web-frontend'].version = '1.2.2' },
      lock => { lock.packages['node_modules/@deepseek-ai/dsh'].integrity = `sha512-${'B'.repeat(86)}==` },
    ]
    for (const edit of invalid) {
      createLock(root, edit)
      assert.throws(() => validateOfficialRuntimeLock(root, release), /official runtime/u)
    }
  })

  it('validates source before creating any runtime directory or spawning npm', async () => {
    const root = temporaryDirectory()
    await assert.rejects(installOfficialRuntime({ userData: root, release, downloadSource: 'file:///evil', smoke: async () => {} }), /unsupported/u)
    assert.equal(existsSync(join(root, 'harness-runtimes')), false)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(runProcess('does-not-exist', [], { signal: controller.signal }), error => error.name === 'AbortError')
  })

  it('extracts npm error codes from child output for transport-only fallback decisions', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', "console.error('npm error code E404'); process.exitCode=1"], {
      cwd: temporaryDirectory(), environment: process.env, timeoutMs: 2_000, log: () => {},
    }), error => error.npmCode === 'E404')
  })
})
