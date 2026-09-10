import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const TEST_ROOT = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(TEST_ROOT, '..', 'src', 'backend-runner.mjs')
const FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-fixture.mjs')
const PARENT_FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-parent-fixture.mjs')
const GUARDED_FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-main-fixture.mjs')
const INHERITANCE_FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-inheritance-fixture.mjs')
const launch = (fixture, ...args) => ['--import', pathToFileURL(RUNNER).href, fixture, ...args]
const rootEnvironment = () => ({ ...process.env, MENG_LUO_HARNESS_PARENT_PID: String(process.pid) })

describe('desktop backend runner', () => {
  it('fails loudly before loading the CLI under an Electron host', async () => {
    const probe = `Object.defineProperty(process.versions, 'electron', { value: 'fixture' }); await import(${JSON.stringify(pathToFileURL(RUNNER).href)})`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', probe], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })

    const outcome = await waitForExit(child)
    assert.notEqual(outcome.code, 0)
    assert.equal(outcome.signal, null)
    assert.match(stderr, /requires standalone Node; Electron is unsupported/u)
  })

  it('translates the private IPC request into the official SIGTERM path', async () => {
    const child = spawn(process.execPath, launch(FIXTURE, 'ready'), {
      env: rootEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    await waitForMessage(child, 'fixture:ready')
    child.send({ type: 'unrelated' })
    await delay(50)
    assert.equal(child.exitCode, null)
    child.send({ type: 'dsh:shutdown' })
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
  })

  it('does not orphan a boot that never installs a signal handler', async () => {
    const parent = spawn(process.execPath, [PARENT_FIXTURE, RUNNER, FIXTURE], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const ready = await waitForMessage(parent, 'backend:ready')
    assert.equal(typeof ready.pid, 'number')
    assert.deepEqual(await waitForExit(parent), { code: 0, signal: null })
    await waitForProcessExit(ready.pid, 3_000)
  })

  it('exits nonzero when the CLI top-level import fails instead of staying alive on IPC', async () => {
    const child = spawn(process.execPath, launch(FIXTURE, 'throw'), {
      env: rootEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const outcome = await waitForExit(child, 2_000)
    assert.equal(typeof outcome.code, 'number')
    assert.notEqual(outcome.code, 0)
    assert.equal(outcome.signal, null)
  })

  it('preserves import.meta.main and official argv for the newer guarded CLI', async () => {
    const child = spawn(process.execPath, launch(GUARDED_FIXTURE, 'web', '--port', '0', '--no-open'), {
      env: rootEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const ready = await waitForMessage(child, 'fixture:ready')
    assert.equal(ready.main, true)
    assert.deepEqual(ready.argv, [GUARDED_FIXTURE, 'web', '--port', '0', '--no-open'])
    assert.equal(ready.calls, 1)
    child.send({ type: 'dsh:shutdown' })
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
  })

  it('rejects executing the lifecycle preload as the CLI entry itself', async () => {
    const child = spawn(process.execPath, [RUNNER], { env: rootEnvironment(), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    assert.deepEqual(await waitForExit(child), { code: 64, signal: null })
    assert.match(stderr, /must be loaded using Node --import/u)
  })

  it('does not supervise unmarked or incorrectly marked Node processes', async () => {
    for (const marker of [undefined, '0']) {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'MENG_LUO_HARNESS_PARENT_PID') delete env[key]
      if (marker !== undefined) env.MENG_LUO_HARNESS_PARENT_PID = marker
      const source = "console.log(JSON.stringify({ marker: process.env.MENG_LUO_HARNESS_PARENT_PID, messageListeners: process.listenerCount('message'), disconnectListeners: process.listenerCount('disconnect') }));"
      const child = spawn(process.execPath, ['--import', pathToFileURL(RUNNER).href, '--input-type=module', '--eval', source], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
      const report = JSON.parse(stdout)
      assert.equal(report.marker, marker)
      assert.equal(report.messageListeners, 0)
      assert.equal(report.disconnectListeners, 0)
    }
  })

  it('leaves default inherited Worker and fork preloads out of shell lifecycle supervision', async t => {
    const child = spawn(process.execPath, launch(INHERITANCE_FIXTURE), {
      env: rootEnvironment(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const stopped = waitForExit(child)
      child.kill('SIGKILL')
      await stopped
    })
    const ready = await waitForMessage(child, 'fixture:descendants', 6_000)
    assert.equal(ready.root.marker, undefined)
    assert.equal(ready.root.messageListeners, 1)
    assert.equal(ready.root.disconnectListeners, 1)
    assert.deepEqual(ready.descendants.map(item => item.mode), ['worker', 'fork'])
    for (const descendant of ready.descendants) {
      assert.equal(descendant.marker, undefined)
      assert.equal(descendant.inheritedPreload, true)
      assert.equal(descendant.messageListeners, 0)
      assert.equal(descendant.disconnectListeners, 0)
      assert.equal(descendant.signalCount, 0)
      assert.ok(descendant.elapsedMs >= 2_200)
    }
    assert.equal(ready.descendants[1].privateMessages, 1)
    child.send({ type: 'dsh:shutdown' })
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
  })
})

function waitForMessage(child, type, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('close', closed)
      child.removeListener('error', failed)
      child.removeListener('message', received)
    }
    const failed = error => { cleanup(); reject(error) }
    const closed = code => { failed(new Error(`Child exited (${code}) before ${type}`)) }
    const received = message => { if (message?.type === type) { cleanup(); resolve(message) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); failed(new Error(`Missing ${type}`)) }, timeoutMs)
    child.once('close', closed)
    child.once('error', failed)
    child.on('message', received)
  })
}

function waitForExit(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await delay(25)
  }
  throw new Error(`orphaned backend pid ${String(pid)} remained alive`)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
