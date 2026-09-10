import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  createBackendEnvironment,
  createHarnessLaunchEnvironment,
  createHarnessLaunchArguments,
  observeHarnessOutput,
  redactHarnessTokens,
  resolveWindowsTaskkillPath,
} from './runtime.mjs'
import { removeTreeWithoutFollowingLinks } from './safe-remove.mjs'

const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 20_000
const KOFFI_PROBE_TIMEOUT_MS = 20_000
const PAGE_TIMEOUT_MS = 15_000
const MAX_PAGE_REDIRECTS = 5
const MAX_OUTPUT = 32 * 1_024
const KOFFI_PROBE_SOURCE = String.raw`
import { createRequire } from 'node:module'
import { join } from 'node:path'

const runtimeRoot = process.argv[1]
const require = createRequire(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
const loaded = require('koffi')
const koffi = loaded.default ?? loaded
const allocation = koffi.alloc('uint8', 8)
const view = koffi.view(allocation, 8)
if (view.byteLength !== 8) throw new Error('koffi view returned the wrong byte length')
process.stdout.write('koffi-ok:8')
`

/** Boot a candidate with isolated data and require the official Web shell. */
export async function smokeOfficialRuntime(options) {
  const temporary = mkdtempSync(join(tmpdir(), 'mengluo-harness-update-smoke-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const environment = createBackendEnvironment({ ...process.env, DSH_HOME: home })
  let output = ''
  let child
  try {
    options.signal?.throwIfAborted()
    probeKoffiRuntime({
      executable: options.executable,
      root: options.root,
      environment,
    })
    options.signal?.throwIfAborted()
    child = spawn(options.executable, createHarnessLaunchArguments({
      runnerPath: options.runnerPath, cliPath: options.cliPath, version: options.version, port: 0,
    }), {
      cwd: workspace,
      env: createHarnessLaunchEnvironment(environment),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exited = childExit(child)
    const remember = (source, line) => {
      const text = `[smoke ${source}] ${line}`
      output = `${output}${text}`.slice(-MAX_OUTPUT)
      options.log?.(text)
    }
    const ready = new Promise(resolveReady => {
      observeHarnessOutput(child, { onReady: resolveReady, log: remember })
    })
    const url = await withTimeout(Promise.race([
      ready,
      exited.then(({ code, signal }) => {
        throw new Error(`candidate exited before readiness (code=${String(code)}, signal=${String(signal)})`)
      }),
    ]), STARTUP_TIMEOUT_MS, 'candidate Harness startup')
    const response = await fetchOfficialHarnessPage(url, options.fetchPage, options.signal)
    const html = await response.text()
    assertOfficialHarnessResponse(response.status, html)
    await sendShutdown(child)
    const outcome = await withTimeout(exited, SHUTDOWN_TIMEOUT_MS, 'candidate Harness shutdown')
    if (outcome.code !== 0) {
      throw new Error(`candidate shutdown failed (code=${String(outcome.code)}, signal=${String(outcome.signal)})`)
    }
    return { url }
  } catch (error) {
    const detail = output.length === 0 ? '' : `\n\n${output}`
    throw new Error(redactHarnessTokens(`${error instanceof Error ? error.message : String(error)}${detail}`))
  } finally {
    if (child !== undefined && !hasExited(child)) forceCleanup(child)
    removeSmokeDirectory(temporary)
  }
}

/**
 * Follow bounded, same-origin login redirects with smoke-local session cookies.
 * @param {string} url validated readiness URL, including the launch token.
 * @param {typeof fetch} fetchPage HTTP client supporting manual redirects.
 * @param {AbortSignal | undefined} signal update cancellation.
 * @returns {Promise<Response>} final response for official-document validation.
 */
export async function fetchOfficialHarnessPage(url, fetchPage = fetch, signal) {
  const origin = new URL(url).origin
  const deadline = AbortSignal.timeout(PAGE_TIMEOUT_MS)
  const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const cookies = new Map()
  let target = url
  for (let redirects = 0; ; redirects += 1) {
    const headers = cookies.size === 0 ? {} : {
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    }
    const response = await fetchPage(target, { redirect: 'manual', headers, signal: requestSignal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    if (redirects >= MAX_PAGE_REDIRECTS) throw new Error('candidate Harness exceeded the login redirect limit')
    const location = response.headers.get('location')
    if (location === null) throw new Error('candidate Harness login redirect has no location')
    const next = new URL(location, target)
    if (next.origin !== origin || next.username !== '' || next.password !== '') {
      throw new Error('candidate Harness login redirected to a different origin or embedded credentials')
    }
    // The official exchange issues root-path, host-only session cookies. Keep
    // them only for this candidate's bounded login check, never another origin.
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
    target = next.href
  }
}

/** Prove the candidate Node/native-addon pair can execute the picker primitive. */
export function probeKoffiRuntime(options) {
  const run = options.spawnSync ?? spawnSync
  const result = run(options.executable, [
    '--input-type=module',
    '--eval',
    KOFFI_PROBE_SOURCE,
    resolve(options.root),
  ], {
    cwd: resolve(options.root),
    env: options.environment ?? createBackendEnvironment(process.env),
    encoding: 'utf8',
    windowsHide: true,
    timeout: KOFFI_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    throw new Error(`candidate Koffi compatibility probe failed: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0 || String(result.stdout) !== 'koffi-ok:8') {
    throw new Error(`candidate Koffi compatibility probe failed (code=${String(result.status)}, signal=${String(result.signal)})`)
  }
}

/** Validate that a candidate serves the untouched official frontend. */
export function assertOfficialHarnessResponse(status, html) {
  if (status !== 200) throw new Error(`candidate Harness returned HTTP ${String(status)}`)
  if (typeof html !== 'string' || !/<title>DeepSeek Harness<\/title>/u.test(html)) {
    throw new Error('candidate runtime did not serve the official DeepSeek Harness frontend')
  }
}

function childExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => { resolvePromise({ code, signal }) })
  })
}

async function sendShutdown(child) {
  if (!child.connected) return
  await new Promise(resolvePromise => {
    try {
      child.send({ type: 'dsh:shutdown' }, () => { resolvePromise() })
    } catch {
      resolvePromise()
    }
  })
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function forceCleanup(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync(resolveWindowsTaskkillPath(process.env), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    })
    return
  }
  child.kill('SIGKILL')
}

export function removeSmokeDirectory(path) {
  const resolved = resolve(path)
  if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith('mengluo-harness-update-smoke-')) {
    throw new Error(`refusing to remove unexpected smoke directory: ${path}`)
  }
  removeTreeWithoutFollowingLinks(resolved)
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
