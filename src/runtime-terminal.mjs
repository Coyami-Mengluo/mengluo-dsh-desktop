import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { createBackendEnvironment } from './runtime.mjs'

/** Exact pnpm version exposed to the interactive Harness terminal. */
export const TERMINAL_PNPM_VERSION = '11.7.0'

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/iu
const TERMINAL_BOOTSTRAP = 'harness-terminal.cmd'
const TERMINAL_LAUNCHER = 'open-terminal.cmd'

/**
 * Build the trusted Windows command-shell launch used for local Harness
 * plugin management. The selected runtime and shell-owned npm remain exact;
 * the ambient PATH is retained only for ordinary user tools such as Git.
 * @param {object} options selected runtime, shell tooling, and user paths.
 * @returns {{command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; spawnOptions: object}} spawn specification.
 */
export function createHarnessTerminalLaunch(options) {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const pathExists = options.exists ?? existsSync
  if (platform !== 'win32') throw new Error('Harness desktop terminal is available only on Windows')

  const systemRoot = environment.SystemRoot ?? environment.windir
  if (typeof systemRoot !== 'string' || systemRoot.trim().length === 0) {
    throw new Error('Windows directory is unavailable (SystemRoot/windir)')
  }
  const normalizedSystemRoot = win32.normalize(systemRoot.trim())
  if (!/^[A-Za-z]:\\/u.test(normalizedSystemRoot) || normalizedSystemRoot.includes('\0')) {
    throw new Error(`Windows directory is not an absolute drive path: ${systemRoot}`)
  }

  const runtime = options.runtime
  const workspacePath = requiredString(options.workspacePath, 'Harness workspace')
  const terminalBinPath = requiredString(options.terminalBinPath, 'Harness terminal tools')
  const nodePath = requiredString(runtime?.nodePath, 'Harness runtime Node')
  const cliPath = requiredString(runtime?.cliPath, 'Harness runtime CLI')
  const npmCliPath = requiredString(options.npmCliPath, 'Harness npm CLI')
  const command = win32.join(normalizedSystemRoot, 'System32', 'cmd.exe')
  const required = {
    'Windows command shell': command,
    'Harness workspace': workspacePath,
    'Harness terminal tools': terminalBinPath,
    'Harness terminal bootstrap': join(terminalBinPath, TERMINAL_BOOTSTRAP),
    'Harness terminal launcher': join(terminalBinPath, TERMINAL_LAUNCHER),
    'Harness runtime Node': nodePath,
    'Harness runtime CLI': cliPath,
    'Harness npm CLI': npmCliPath,
    'Harness npx CLI': join(dirname(npmCliPath), 'npx-cli.js'),
  }
  for (const [label, path] of Object.entries(required)) {
    if (typeof path !== 'string' || path.length === 0 || !pathExists(path)) {
      throw new Error(`${label} is missing: ${String(path)}`)
    }
  }

  const childEnvironment = createBackendEnvironment(environment)
  for (const key of Object.keys(childEnvironment)) {
    if (SECRET_NAME.test(key)) delete childEnvironment[key]
    if (/^ComSpec$/iu.test(key)) delete childEnvironment[key]
  }
  childEnvironment.ComSpec = command
  childEnvironment.DSH_DESKTOP_NODE = nodePath
  childEnvironment.DSH_DESKTOP_DSH_CLI = cliPath
  childEnvironment.DSH_DESKTOP_NPM_CLI = npmCliPath
  childEnvironment.DSH_DESKTOP_NPX_CLI = required['Harness npx CLI']
  childEnvironment.DSH_DESKTOP_TERMINAL_BOOTSTRAP = required['Harness terminal bootstrap']
  childEnvironment.DSH_RUNTIME_VERSION = runtime.version
  if (options.proxy !== undefined) {
    const parsedProxy = new URL(options.proxy)
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsedProxy.protocol)
      || parsedProxy.hostname === '' || parsedProxy.username !== '' || parsedProxy.password !== '') {
      throw new Error('Harness terminal proxy is invalid')
    }
    childEnvironment.HTTP_PROXY = options.proxy
    childEnvironment.HTTPS_PROXY = options.proxy
  }
  prependPath(childEnvironment, terminalBinPath)
  prependPath(childEnvironment, dirname(nodePath))

  return Object.freeze({
    command,
    // A short hidden launcher uses Windows START to allocate a genuinely
    // independent console. Running `/k` directly with ignored stdio attaches
    // stdin to NUL, so cmd.exe reaches EOF and exits immediately after the
    // bootstrap even though the command itself succeeds.
    args: ['/d', '/c', `call ${TERMINAL_LAUNCHER}`],
    cwd: workspacePath,
    env: childEnvironment,
    spawnOptions: Object.freeze({
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    }),
  })
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} path is missing`)
  return value
}

function prependPath(environment, additionalPath) {
  const existingKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH')
  const key = existingKey ?? 'Path'
  const existing = typeof environment[key] === 'string' && environment[key].length > 0 ? environment[key] : ''
  const next = `${additionalPath}${existing.length === 0 ? '' : `;${existing}`}`
  environment[key] = next
  environment.Path = next
  environment.PATH = next
}
