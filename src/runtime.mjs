import { join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { compareSemver } from './update-policy.mjs'

/** Preferred desktop port; the emitted loopback URL remains authoritative. */
export const DESKTOP_PORT = 47_821

/** First official release that opens a browser unless explicitly disabled. */
export const NO_OPEN_MINIMUM_VERSION = '0.1.0-rc.8'

/** Begin whole-tree termination before the CLI's five-second self-exit deadline. */
export const BACKEND_TREE_KILL_DELAY_MS = 3_000

/**
 * Build version-compatible arguments for the official Web profile.
 * rc.8 introduced default-browser launch together with the official
 * `--no-open` switch. Older fallback slots reject that unknown option, so the
 * shell applies it only to releases that support it.
 * @param {string} version selected official Harness version.
 * @param {number} port fixed desktop port or zero for an isolated smoke.
 * @returns {string[]} Web-profile arguments after the CLI path.
 */
export function createHarnessWebArguments(version, port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid Harness Web port: ${String(port)}`)
  }
  const args = ['web', '--host', '127.0.0.1', '--port', String(port)]
  if (compareSemver(version, NO_OPEN_MINIMUM_VERSION) >= 0) args.push('--no-open')
  return args
}

/** Load only lifecycle supervision first; the untouched official CLI remains Node's real entry point. */
export function createHarnessLaunchArguments({ runnerPath, cliPath, version, port }) {
  if (typeof runnerPath !== 'string' || runnerPath.length === 0 || typeof cliPath !== 'string' || cliPath.length === 0) {
    throw new Error('Harness launch requires the lifecycle preload and official CLI paths')
  }
  return ['--import', pathToFileURL(resolve(runnerPath)).href, cliPath, ...createHarnessWebArguments(version, port)]
}

/**
 * Resolve the installation-only Node executable; installed Harness slots own their backend Node.
 * Packaged applications receive it as an extra resource; development uses
 * the identically-shaped staged runtime under the desktop application root.
 * @param {{ isPackaged: boolean; resourcesPath: string; applicationRoot: string }} options paths supplied by Electron.
 * @returns {string} absolute or application-root-relative Node executable path.
 */
export function resolveBundledNodePath(options) {
  return options.isPackaged
    ? join(options.resourcesPath, 'runtime', 'node-runtime', 'node.exe')
    : join(options.applicationRoot, 'build', 'runtime', 'node-runtime', 'node.exe')
}

/**
 * Resolve the shell-owned npm CLI used only to materialize official updates.
 * npm is immutable application tooling; Node comes from the selected verified
 * Harness runtime, or the installation-only executable before first setup.
 * @param {{ isPackaged: boolean; resourcesPath: string; applicationRoot: string }} options paths supplied by Electron.
 * @returns {string} filesystem path visible to standalone Node.
 */
export function resolveBundledNpmCliPath(options) {
  return options.isPackaged
    ? join(options.resourcesPath, 'updater', 'npm', 'bin', 'npm-cli.js')
    : join(options.applicationRoot, 'build', 'updater', 'npm', 'bin', 'npm-cli.js')
}

/**
 * Resolve a script executed by standalone Node rather than Electron.
 * electron-builder unpacks these scripts because plain Node cannot traverse
 * Electron's app.asar virtual filesystem.
 * @param {{ isPackaged: boolean; resourcesPath: string; applicationRoot: string }} options paths supplied by Electron.
 * @param {string} scriptName trusted desktop child entry basename.
 * @returns {string} filesystem path visible to standalone Node.
 */
export function resolveNodeChildScriptPath(options, scriptName) {
  if (!/^[a-z0-9-]+\.mjs$/u.test(scriptName)) {
    throw new Error(`invalid desktop Node child script name: ${scriptName}`)
  }
  return options.isPackaged
    ? join(options.resourcesPath, 'app.asar.unpacked', 'src', scriptName)
    : join(options.applicationRoot, 'src', scriptName)
}

/**
 * Build a standalone-Node child environment without Electron mode leakage.
 * Targeted keys are normalized case-insensitively because Windows environment
 * names are case-insensitive even though JavaScript object keys are not.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment parent environment.
 * @returns {NodeJS.ProcessEnv} isolated backend environment.
 */
export function createBackendEnvironment(environment = process.env) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    const normalized = key.toUpperCase()
    if (normalized === 'ELECTRON_RUN_AS_NODE' || normalized === 'FORCE_COLOR' || normalized === 'NO_COLOR') {
      delete result[key]
    }
  }
  result.NO_COLOR = '1'
  return result
}

/** Opt only the directly spawned official CLI into desktop lifetime supervision. */
export function createHarnessLaunchEnvironment(environment = process.env) {
  const result = createBackendEnvironment(environment)
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === 'MENG_LUO_HARNESS_PARENT_PID') delete result[key]
  }
  result.MENG_LUO_HARNESS_PARENT_PID = String(process.pid)
  return result
}

/** Harness readiness prefix printed only after the plugin tree has settled. */
const READY_PREFIX = 'dsh web:'

/**
 * Parse and validate the local Harness URL from one backend output line.
 * @param {string} line backend stdout line.
 * @returns {string | undefined} validated loopback URL, preserving the login query and fragment.
 */
export function parseReadyUrl(line) {
  const prefix = line.indexOf(READY_PREFIX)
  if (prefix < 0) return undefined
  const match = line.slice(prefix + READY_PREFIX.length).trim().match(/^(http:\/\/127\.0\.0\.1:(\d{1,5})(?:[/?#]\S*)?)(?:\s|$)/u)
  if (match === null) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  try {
    const url = new URL(match[1])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '') {
      return undefined
    }
    return url.href
  } catch {
    // A readiness line is not trusted until its complete URL can be parsed.
    return undefined
  }
}

/**
 * Hide Harness URL credentials in complete diagnostic messages.
 * @param {string} text complete line or error message, not a partial stream chunk.
 * @returns {string} diagnostic text with token query/fragment values removed.
 */
export function redactHarnessTokens(text) {
  return text.replace(/([?&#]token=)[^&#\s"'<>]*/giu, '$1[REDACTED]')
}

/**
 * Observe complete backend lines so a token split across chunks cannot leak to logs.
 * @param {{ stdout: import('node:stream').Readable | null; stderr: import('node:stream').Readable | null }} child backend pipes.
 * @param {{ onReady: (url: string) => void; log: (source: string, text: string) => void }} options raw readiness URL consumer and redacted diagnostic consumer.
 */
export function observeHarnessOutput(child, options) {
  for (const source of ['stdout', 'stderr']) {
    if (child[source] === null) continue
    const lines = createInterface({ input: child[source], crlfDelay: Infinity })
    lines.on('line', line => {
      options.log(source, `${redactHarnessTokens(line)}\n`)
      if (source !== 'stdout') return
      const url = parseReadyUrl(line)
      if (url !== undefined) options.onReady(url)
    })
  }
}

/**
 * Classify a renderer navigation without granting arbitrary local origins.
 * @param {string} target requested URL.
 * @param {string | undefined} backendOrigin trusted desktop backend origin.
 * @returns {'internal' | 'external' | 'blocked'} action for the main process.
 */
export function classifyNavigation(target, backendOrigin) {
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return 'blocked'
  }
  if (backendOrigin !== undefined && parsed.origin === backendOrigin) return 'internal'
  if (isLoopbackHost(parsed.hostname)) return 'blocked'
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return 'external'
  return 'blocked'
}

/**
 * Resolve Windows' system taskkill binary without searching the working directory or PATH.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment process environment.
 * @returns {string} absolute path to System32/taskkill.exe.
 */
export function resolveWindowsTaskkillPath(environment = process.env) {
  const windowsDirectory = environment.SystemRoot ?? environment.windir
  if (windowsDirectory === undefined || windowsDirectory.trim() === '') {
    throw new Error('Windows directory is unavailable (SystemRoot/windir)')
  }
  const normalized = win32.normalize(windowsDirectory.trim())
  if (!/^[A-Za-z]:\\/u.test(normalized) || normalized.includes('\0')) {
    throw new Error(`Windows directory is not an absolute drive path: ${windowsDirectory}`)
  }
  return win32.join(normalized, 'System32', 'taskkill.exe')
}

/**
 * Test whether a hostname names only this machine.
 * @param {string} hostname parsed URL hostname.
 * @returns {boolean} whether the hostname is a supported loopback literal/name.
 */
function isLoopbackHost(hostname) {
  // URL.hostname has already normalized IPv4 to dotted decimal and IPv6 to
  // compressed lowercase hex. Match only loopback literals and the exact name;
  // this is not a DNS lookup or an external-domain allowlist.
  return hostname === 'localhost' || hostname === 'localhost.' || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(hostname)
}
