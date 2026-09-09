import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  assertMaterializedTree,
  countMaterializedFiles,
  createNpmInstallEnvironment,
  installOfficialRuntime,
  npmInstallArguments,
  runProcess,
  stageManagedNode,
  stageNodeLicense,
  verifyReleaseInstallation,
  verifyTrustedNodeExecutable,
} from '../src/runtime-installer.mjs'
import { managedRuntimeDirectory, writeRuntimeSeal } from '../src/runtime-store.mjs'

const INTEGRITY = `sha512-${'A'.repeat(86)}==`
const release = { version: '1.2.3', integrity: INTEGRITY }
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('official runtime installer policy', () => {
  it('pins exact official registry installation and disables scripts', () => {
    const args = npmInstallArguments({
      npmCliPath: 'npm-cli.js',
      staging: 'stage',
      cache: 'cache',
      userConfig: 'empty.npmrc',
      version: '1.2.3',
    })
    assert.ok(args.includes('--ignore-scripts'))
    assert.ok(args.includes('--save-exact'))
    assert.ok(args.includes('--engine-strict=true'))
    assert.ok(args.includes('--loglevel=silly'))
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'))
    assert.equal(args.at(-1), '@deepseek-ai/dsh@1.2.3')
  })

  it('applies a resolved system proxy without retaining conflicting npm proxy settings', () => {
    const environment = createNpmInstallEnvironment('http://127.0.0.1:18080', {
      npm_config_proxy: 'http://wrong:1',
      HTTPS_PROXY: 'http://wrong:2',
      http_proxy: 'http://wrong:3',
      Path: 'C:\\Windows\\System32',
    })
    assert.equal(environment.npm_config_proxy, undefined)
    assert.equal(environment.http_proxy, undefined)
    assert.equal(environment.HTTP_PROXY, 'http://127.0.0.1:18080')
    assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:18080')
    assert.equal(environment.Path, 'C:\\Windows\\System32')
    assert.throws(() => createNpmInstallEnvironment('http://proxy-without-port'), /invalid/u)
    assert.throws(() => createNpmInstallEnvironment('http://user:password@proxy:8080'), /invalid/u)
  })

  it('verifies package identity, exact root spec, and npm integrity', () => {
    const root = fixtureRuntime()
    assert.match(verifyReleaseInstallation(root, release).cliPath, /bin\.js$/u)
    const lockPath = join(root, 'package-lock.json')
    writeFileSync(lockPath, JSON.stringify({ packages: {
      'node_modules/@deepseek-ai/dsh': { version: '1.2.3', integrity: 'sha512-wrong' },
    } }))
    assert.throws(() => { verifyReleaseInstallation(root, release) }, /registry integrity/u)
  })

  it('rejects web-app or frontend versions that differ from the official CLI', () => {
    const root = fixtureRuntime()
    const frontendManifest = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json')
    writeFileSync(frontendManifest, JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: '1.2.2' }))
    assert.throws(() => { verifyReleaseInstallation(root, release) }, /must match Harness 1\.2\.3/u)
  })

  it('link-audits, seal-checks, and smoke-tests an existing slot before reuse', async () => {
    const userData = temporaryDirectory()
    const target = managedRuntimeDirectory(userData, release.version)
    fixtureRuntime(target)
    writeRuntimeSeal(target, release.version, { nodeVersion: '24.19.0' })
    let smokes = 0
    const stages = []
    const installed = await installOfficialRuntime({
      userData,
      release,
      npm: { nodePath: 'unused', npmCliPath: 'unused' },
      progress: (stage, files) => { stages.push([stage, files]) },
      smoke: async candidate => {
        smokes += 1
        assert.equal(candidate.root, target)
      },
    })
    assert.equal(installed?.version, release.version)
    assert.equal(smokes, 1)
    assert.deepEqual(stages.map(([stage]) => stage), [
      'preparing', 'verifying', 'verifying', 'verifying', 'smoke', 'finalizing',
    ])
    assert.equal(stages[2][1].completedFiles, 0)
    assert.equal(stages[2][1].totalFiles, stages[3][1].completedFiles)
  })

  it('honors cancellation before finalizing without quarantining a valid slot', async () => {
    const userData = temporaryDirectory()
    const target = managedRuntimeDirectory(userData, release.version)
    fixtureRuntime(target)
    writeRuntimeSeal(target, release.version, { nodeVersion: '24.19.0' })
    const controller = new AbortController()
    const stages = []
    await assert.rejects(installOfficialRuntime({
      userData,
      release,
      npm: { nodePath: 'unused', npmCliPath: 'unused' },
      signal: controller.signal,
      progress: (stage, files) => { stages.push([stage, files]) },
      smoke: async () => { controller.abort() },
    }), error => error?.name === 'AbortError')
    assert.deepEqual(stages.map(([stage]) => stage), [
      'preparing', 'verifying', 'verifying', 'verifying', 'smoke',
    ])
    assert.equal(existsSync(target), true)
  })

  it('rejects links anywhere in a candidate closure', { skip: process.platform === 'win32' }, () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'linked'))
    assert.throws(() => { assertMaterializedTree(root) }, /contains a link/u)
  })

  it('counts and reports real physical-file verification progress', () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'one.txt'), 'one')
    writeFileSync(join(root, 'nested', 'two.txt'), 'two')
    const reports = []
    assert.equal(countMaterializedFiles(root), 2)
    assert.deepEqual(assertMaterializedTree(root, {
      progress: value => { reports.push(value) },
    }), { completedFiles: 2, totalFiles: 2 })
    assert.deepEqual(reports[0], { completedFiles: 0, totalFiles: 2 })
    assert.deepEqual(reports.at(-1), { completedFiles: 2, totalFiles: 2 })
  })

  it('reports physical file activity while npm-style child work is still running', async () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, 'one.txt'), 'one')
    const counts = []
    await runProcess(process.execPath, [
      '-e',
      "const fs=require('node:fs');console.error('npm http fetch GET 200 https://registry.npmjs.org/example 10ms');console.error('npm silly placeDep ROOT example@1.0.0 OK');setTimeout(()=>fs.writeFileSync('two.txt','two'),20);setTimeout(()=>{},60)",
    ], {
      cwd: root,
      environment: process.env,
      timeoutMs: 2_000,
      activityRoot: root,
      activityIntervalMs: 10,
      onActivity: activity => { counts.push(activity) },
      log: () => {},
    })
    assert.equal(counts[0].completedFiles, 1)
    assert.deepEqual(counts.at(-1), {
      completedFiles: 2,
      registryRequests: 1,
      resolvedDependencies: 1,
    })
  })

  it('copies and re-verifies a physical Node executable inside the slot', () => {
    const root = temporaryDirectory()
    const source = join(temporaryDirectory(), 'node.exe')
    writeFileSync(source, 'signed-node-fixture')
    const verified = []
    const staged = stageManagedNode(root, source, {
      expectedVersion: '24.19.0',
      verifyNode: path => {
        verified.push(path)
        return '24.19.0'
      },
    })
    assert.equal(verified.length, 2)
    assert.equal(verified[0], source)
    assert.equal(verified[1], staged.nodePath)
    assert.equal(staged.nodeVersion, '24.19.0')
  })

  it('copies an exact-version trusted license or fetches the exact official tag', async () => {
    const preferredRoot = temporaryDirectory()
    const preferred = join(preferredRoot, 'LICENSE')
    writeFileSync(preferred, 'trusted sealed license')
    const copiedRoot = temporaryDirectory()
    mkdirSync(join(copiedRoot, 'node-runtime'))
    await stageNodeLicense(copiedRoot, '24.19.0', {
      preferred: { nodeVersion: '24.19.0', nodeLicensePath: preferred },
      fetch: () => { throw new Error('fetch should not run') },
    })
    assert.equal(existsSync(join(copiedRoot, 'node-runtime', 'LICENSE')), true)

    const fetchedRoot = temporaryDirectory()
    mkdirSync(join(fetchedRoot, 'node-runtime'))
    let request
    await stageNodeLicense(fetchedRoot, '25.1.0', {
      preferred: { nodeVersion: '24.19.0', nodeLicensePath: preferred },
      fetch: async (url, init) => {
        request = { url, init }
        const bytes = Buffer.from('Node.js is licensed for use as follows:\nfixture')
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(bytes.length) },
          arrayBuffer: async () => bytes,
        }
      },
    })
    assert.equal(request.url, 'https://raw.githubusercontent.com/nodejs/node/v25.1.0/LICENSE')
    assert.equal(request.init.redirect, 'error')
  })

  it('requires a valid OpenJS identity for the trusted runtime Node and strips inherited PowerShell modules', () => {
    const root = temporaryDirectory()
    const nodePath = join(root, 'node.exe')
    writeFileSync(nodePath, 'fixture')
    let environment
    const versionRun = () => ({ status: 0, stdout: 'v24.19.0\n' })
    const version = verifyTrustedNodeExecutable(nodePath, {
      environment: { SystemRoot: 'C:\\Windows', PSModulePath: 'poisoned', pSmOdUlEpAtH: 'also-poisoned' },
      spawnSync: (_command, _args, options) => {
        environment = options.env
        return { status: 0, stdout: 'Valid\nCN=OpenJS Foundation\nNode.js\n' }
      },
      nodeSpawnSync: versionRun,
    })
    assert.equal(version, '24.19.0')
    assert.equal(Object.keys(environment).some(key => /^PSModulePath$/iu.test(key)), false)
    assert.equal(environment.DSH_NODE_SIGNATURE_TARGET, nodePath)
    assert.throws(() => verifyTrustedNodeExecutable(nodePath, {
      environment: { SystemRoot: 'C:\\Windows' },
      spawnSync: () => ({ status: 0, stdout: 'NotSigned\n\nNode.js\n' }),
      nodeSpawnSync: versionRun,
    }), /not valid OpenJS Node\.js/u)
  })
})

function fixtureRuntime(target) {
  const root = target ?? temporaryDirectory()
  const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const webAppRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  const frontendRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  mkdirSync(webAppRoot, { recursive: true })
  mkdirSync(join(frontendRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
  writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
  writeFileSync(join(webAppRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '1.2.3' }))
  writeFileSync(join(frontendRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: '1.2.3' }))
  writeFileSync(join(frontendRoot, 'dist', 'index.html'), '<title>DeepSeek Harness</title>')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '1.2.3' } }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@deepseek-ai/dsh': { version: '1.2.3', integrity: INTEGRITY },
    'node_modules/@deepseek-ai/dsh-web-app': { version: '1.2.3', integrity: INTEGRITY },
    'node_modules/@deepseek-ai/dsh-web-frontend': { version: '1.2.3', integrity: INTEGRITY },
  } }))
  mkdirSync(join(root, 'node-runtime'), { recursive: true })
  writeFileSync(join(root, 'node-runtime', 'node.exe'), 'fixture-node')
  writeFileSync(join(root, 'node-runtime', 'LICENSE'), 'Node.js is licensed for use as follows:\nfixture')
  return root
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'mengluo-runtime-installer-'))
  temporaryDirectories.push(directory)
  return directory
}
