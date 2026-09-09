import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const TEST_ROOT = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(TEST_ROOT, '..', 'src', 'backend-runner.mjs')
const FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-fixture.mjs')
const PARENT_FIXTURE = join(TEST_ROOT, 'fixtures', 'backend-parent-fixture.mjs')

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
    const child = spawn(process.execPath, [RUNNER, FIXTURE, 'ready'], {
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
    const child = spawn(process.execPath, [RUNNER, FIXTURE, 'throw'], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const outcome = await waitForExit(child, 2_000)
    assert.equal(typeof outcome.code, 'number')
    assert.notEqual(outcome.code, 0)
    assert.equal(outcome.signal, null)
  })
})

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', (message) => {
      if (message?.type === type) resolve(message)
    })
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
