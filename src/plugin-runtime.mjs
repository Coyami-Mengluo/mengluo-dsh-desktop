import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { createBackendEnvironment, resolveWindowsTaskkillPath } from './runtime.mjs'
import { parseSemver } from './update-policy.mjs'

const MANIFEST_LIMIT = 1024 * 1024
const LOG_LIMIT = 16 * 1024
const LINE_LIMIT = 512
const OPERATIONS = new Set(['install', 'add', 'update', 'remove'])
const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const GITHUB_SPEC = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})(?:#([A-Za-z0-9][A-Za-z0-9._/-]{0,199}))?$/u
const activeProfiles = new Set()

/** Match the official home-path precedence without reading private settings or patches. */
export function resolvePluginHome(options = {}) {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const inherited = environment.DSH_HOME
  let candidate = options.dshHome ?? (typeof inherited === 'string' && inherited.trim() !== '' ? inherited : join(homeDirectory, '.dsh'))
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.includes('\0')) throw new Error('Harness 插件目录无效')
  if (candidate === '~') candidate = homeDirectory
  else if (/^~[/\\]/u.test(candidate)) candidate = join(homeDirectory, candidate.slice(2))
  // The official CLI resolves relative DSH_HOME against its invoking cwd.
  return resolve(options.workspacePath ?? process.cwd(), candidate)
}

/** Only dependency declarations in the user's web profile are plugin inventory. */
export function readInstalledPlugins(options) {
  const dshHome = resolvePluginHome(options)
  const profileDir = join(dshHome, 'profiles', 'web')
  assertProfileDirectories(dshHome)
  const manifest = readManifest(join(profileDir, 'package.json'), true)
  if (manifest === undefined) return { profile: 'web', exists: false, plugins: [] }
  const dependencies = manifest.dependencies ?? {}
  if (!isRecord(dependencies) || Object.keys(dependencies).length > 500) throw new Error('Harness 插件清单格式无效')
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const plugins = Object.entries(dependencies).map(([name, declaration]) => {
    const spec = typeof declaration === 'string' && declaration.length <= 1024 ? declaration : ''
    const source = classifyPluginSpec(spec)
    const item = { id: name, name, spec, ...source, bundle: bundles.includes(name), managed: true }
    if (!isPluginPackageName(name)) return { ...item, managed: false, reason: '包名不受支持，请使用 Harness 终端管理' }
    if (isRuntimePackage(options.runtime, name)) return { ...item, managed: false, reason: '属于官方运行环境，不由插件商店修改' }
    const packageFile = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    try {
      if (existsSync(packageFile)) {
        const actualFile = realpathSync(packageFile)
        if (!isWithin(join(profileDir, 'node_modules'), actualFile)) {
          return { ...item, managed: false, reason: '插件链接位于 profile 外，请使用 Harness 终端管理' }
        }
        const installed = readManifest(actualFile)
        if (typeof installed.version === 'string' && installed.version.length <= 128) item.version = installed.version
      }
    } catch {
      return { ...item, managed: false, reason: '无法读取已安装插件，请检查 Harness 终端' }
    }
    if (source.source === 'unsupported') return { ...item, managed: false, reason: '安装来源暂不支持，请使用 Harness 终端管理' }
    return item
  })
  return { profile: 'web', exists: true, plugins }
}

/** Conservative npm names also remain safe through the official Windows pnpm forwarder. */
export function isPluginPackageName(value) {
  return typeof value === 'string' && value.length <= 214 && PACKAGE_NAME.test(value)
    && !value.split('/').some(part => part === '.' || part === '..' || part === '__proto__' || part === 'constructor' || part === 'prototype')
}

/** Parse persisted supported sources without evaluating arbitrary pnpm specifications. */
export function classifyPluginSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > 1024) return { source: 'unsupported' }
  let candidate = spec
  if (/^(?:git\+)?https:\/\/github\.com\//u.test(candidate)) candidate = candidate.replace(/^(?:git\+)?https:\/\/github\.com\//u, 'github:').replace(/\.git(?=#|$)/u, '')
  const github = GITHUB_SPEC.exec(candidate)
  if (github !== null && !github[2].endsWith('.git') && !github[3]?.includes('..') && !github[3]?.includes('//') && !github[3]?.endsWith('/')) {
    const ref = github[3]
    return { source: 'github', github: { owner: github[1], repo: github[2], ...(ref === undefined ? {} : { ref }), ...(/^[a-f0-9]{40}$/iu.test(ref ?? '') ? { commit: ref.toLowerCase() } : {}) } }
  }
  // npm range/tag declarations are read-only here. Mutations require one exact version below.
  if (/^[A-Za-z0-9*~^<>=|.+ -]+$/u.test(spec) && spec.trim() === spec) return { source: 'npm' }
  return { source: 'unsupported' }
}

/** Build only one vetted profile mutation; never expose an arbitrary command surface to IPC. */
export function createPluginCommand(options) {
  const operation = options.operation
  if (!isRecord(operation) || !OPERATIONS.has(operation.action) || !isPluginPackageName(operation.name)
    || Object.keys(operation).some(key => !['action', 'name', 'spec'].includes(key))) throw new Error('插件操作参数无效')
  const runtime = options.runtime
  if (!runtime || !isAbsolute(runtime.root ?? '') || !isAbsolute(runtime.nodePath ?? '') || !isAbsolute(runtime.cliPath ?? '')) throw new Error('请先启动已安装的 Harness')
  if (resolve(runtime.cliPath) !== resolve(runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) throw new Error('Harness CLI 不属于当前运行环境')
  const inventory = readInstalledPlugins(options)
  const existing = inventory.plugins.find(item => item.name === operation.name)
  if (isRuntimePackage(runtime, operation.name)) throw new Error('不能通过插件商店修改官方自带组件')
  if (existing && !existing.managed) throw new Error('此插件需使用 Harness 终端管理')
  if (['update', 'remove'].includes(operation.action) && existing === undefined) throw new Error('该插件已不在用户插件清单中，请刷新后重试')
  if (['install', 'add'].includes(operation.action) && existing !== undefined) throw new Error('该插件已安装，请刷新后使用更新按钮')
  const args = [runtime.cliPath, 'plugin', '--profile', 'web']
  if (operation.action === 'remove') {
    if (operation.spec !== undefined) throw new Error('卸载不接受额外安装参数')
    args.push('remove', operation.name, '--reporter=append-only')
  } else {
    args.push('add', exactInstallSpec(operation.name, operation.spec), '--save-exact', '--reporter=append-only')
  }
  const npmCliPath = requirePath(options.npmCliPath, 'npm')
  const terminalBinPath = requirePath(options.terminalBinPath, '插件工具')
  const workspacePath = requirePath(options.workspacePath, '工作目录')
  const exists = options.exists ?? existsSync
  for (const path of [runtime.nodePath, runtime.cliPath, npmCliPath, join(dirname(npmCliPath), 'npx-cli.js'), join(terminalBinPath, 'pnpm.cmd'), workspacePath]) {
    if (!exists(path)) throw new Error('插件管理工具缺失，请修复客户端安装')
  }
  const env = createBackendEnvironment(options.environment ?? process.env)
  for (const key of Object.keys(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/iu.test(key) || /^(?:NODE_OPTIONS|NODE_PATH|MENG_LUO_HARNESS_PARENT_PID|DSH_HOME|COMSPEC|DSH_DESKTOP_.*)$/iu.test(key)) delete env[key]
    if (options.proxy !== undefined && /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|npm_config_(?:proxy|https_proxy|noproxy))$/iu.test(key)) delete env[key]
  }
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.windir
    if (typeof systemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(systemRoot) || systemRoot.includes('\0')) throw new Error('Windows 系统目录无效')
    env.ComSpec = win32.join(systemRoot, 'System32', 'cmd.exe')
  }
  if (options.proxy !== undefined && options.proxy !== null) {
    const proxy = new URL(options.proxy)
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname || proxy.username || proxy.password || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error('系统代理地址无效')
    env.HTTP_PROXY = options.proxy
    env.HTTPS_PROXY = options.proxy
  }
  env.DSH_HOME = resolvePluginHome(options)
  env.DSH_DESKTOP_NODE = runtime.nodePath
  env.DSH_DESKTOP_DSH_CLI = runtime.cliPath
  env.DSH_DESKTOP_NPM_CLI = npmCliPath
  env.DSH_DESKTOP_NPX_CLI = join(dirname(npmCliPath), 'npx-cli.js')
  env.CI = '1'
  // The official Windows CLI launches pnpm by name. Prefer our pinned wrapper,
  // and do not let a profile-local pnpm.cmd take priority over that PATH entry.
  env.NoDefaultCurrentDirectoryInExePath = '1'
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = [terminalBinPath, dirname(runtime.nodePath), inheritedPath].filter(Boolean).join(platform === 'win32' ? ';' : ':')
  return { command: runtime.nodePath, args, cwd: workspacePath, env, profileDir: join(env.DSH_HOME, 'profiles', 'web'), spawnOptions: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } }
}

/** Execute the official reconciler using its own Node, with bounded human-readable output. */
export async function runPluginOperation(options) {
  const launch = createPluginCommand(options)
  const lockKey = process.platform === 'win32' ? launch.profileDir.toLowerCase() : launch.profileDir
  if (activeProfiles.has(lockKey)) throw new Error('另一个插件操作正在进行，请稍后重试')
  if (options.signal?.aborted) throw new Error('插件操作已取消')
  activeProfiles.add(lockKey)
  let releaseLock = true
  try {
    const logTail = await executeCommand(launch, options)
    const inventory = readInstalledPlugins(options)
    const item = inventory.plugins.find(plugin => plugin.name === options.operation.name)
    if (!operationReachedTarget(options.operation, item)) {
      const error = new Error('命令已结束，但插件清单未出现预期变化，请刷新或查看 Harness 终端')
      error.logTail = logTail
      throw error
    }
    return { changed: true, requiresRestart: true, logTail, plugins: inventory.plugins }
  } catch (error) {
    // If a forced cancellation cannot confirm process exit, keep this profile
    // reserved until the client restarts rather than permit concurrent writes.
    if (error.cleanupUncertain === true) releaseLock = false
    throw error
  } finally {
    if (releaseLock) activeProfiles.delete(lockKey)
  }
}

function executeCommand(launch, options) {
  return new Promise((resolvePromise, reject) => {
    let child
    let settled = false
    let ending
    let tail = ''
    let lastProgressAt = 0
    let lastLine = ''
    let logged = 0
    const pending = { stdout: '', stderr: '' }
    const emit = line => {
      const clean = sanitizePluginOutput(line).slice(0, LINE_LIMIT).trim()
      if (clean === '') return
      tail = `${tail}${clean}\n`.slice(-LOG_LIMIT)
      lastLine = clean
      if (logged < LOG_LIMIT) {
        const text = `${clean}\n`.slice(0, LOG_LIMIT - logged)
        logged += text.length
        try { options.log?.(text) } catch { /* Diagnostics cannot alter plugin execution. */ }
      }
      if (Date.now() - lastProgressAt > 120) {
        lastProgressAt = Date.now()
        try { options.onProgress?.({ label: '正在处理插件', detail: clean }) } catch { /* UI is advisory. */ }
      }
    }
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      for (const name of Object.keys(pending)) if (pending[name]) emit(pending[name])
      if (error) { error.logTail = tail; reject(error) }
      else resolvePromise(tail)
    }
    const stop = reason => {
      if (settled || ending) return
      ending = reason
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return finish(new Error(reason))
      if ((options.platform ?? process.platform) === 'win32') {
        try {
          const killer = (options.killSpawn ?? spawn)(resolveWindowsTaskkillPath(launch.env), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
          killer.on('error', () => { try { child.kill() } catch { /* Best effort. */ } })
        } catch { try { child.kill() } catch { /* Best effort. */ } }
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill() } catch { /* Best effort. */ } }
      }
      killTimer = setTimeout(() => {
        const error = new Error(`${reason}；子进程退出状态不明，请退出客户端后检查终端`)
        error.cleanupUncertain = true
        finish(error)
      }, 5_000)
      killTimer.unref?.()
    }
    const abort = () => stop('插件操作已取消；请刷新插件清单确认当前状态')
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
    const timer = setTimeout(() => stop('插件操作超时；请检查网络后刷新插件清单'), timeoutMs)
    let killTimer
    try {
      child = (options.spawn ?? spawn)(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, ...launch.spawnOptions, detached: (options.platform ?? process.platform) !== 'win32' })
      for (const name of ['stdout', 'stderr']) {
        child[name]?.setEncoding('utf8')
        child[name]?.on('data', text => {
          // Bound even output without newlines before invoking user-visible callbacks.
          const chunks = `${pending[name]}${String(text).slice(-LOG_LIMIT)}`.split(/\r?\n|\r/u)
          pending[name] = chunks.pop().slice(-2048)
          for (const line of chunks) emit(line)
        })
      }
      child.once('error', () => finish(new Error('无法启动插件管理工具，请检查客户端安装')))
      child.once('close', code => {
        if (ending) return finish(new Error(ending))
        if (code === 0) return finish()
        const detail = lastLine.includes('ERR_PNPM') ? `（${lastLine.slice(0, 160)}）` : ''
        finish(new Error(`插件操作失败，请查看详情或使用 Harness 终端重试${detail}`))
      })
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    } catch { finish(new Error('无法启动插件管理工具，请检查客户端安装')) }
  })
}

/** Strip terminal controls and common credential-bearing URL fields before logging. */
export function sanitizePluginOutput(value) {
  return String(value).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(/([?&#](?:token|access_token|auth|key|password|secret)=)[^&#\s"'<>]*/giu, '$1[REDACTED]')
    .replace(/((?:_authToken|authorization|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
}

function exactInstallSpec(name, spec) {
  if (typeof spec !== 'string' || spec.length > 400) throw new Error('安装必须指定已确认的精确版本或 GitHub 提交')
  if (spec.startsWith('github:')) {
    const source = classifyPluginSpec(spec)
    if (source.source !== 'github' || source.github.commit === undefined) throw new Error('GitHub 插件必须指定完整提交编号')
    return `${name}@github:${source.github.owner}/${source.github.repo}#${source.github.commit}`
  }
  const prefix = `${name}@`
  if (!spec.startsWith(prefix)) throw new Error('插件包名与安装版本不一致')
  try { parseSemver(spec.slice(prefix.length)) } catch { throw new Error('npm 插件必须指定精确版本') }
  return spec
}

function operationReachedTarget(operation, item) {
  if (operation.action === 'remove') return item === undefined
  if (item === undefined || !item.managed || typeof item.version !== 'string') return false
  if (operation.spec.startsWith('github:')) {
    const desired = classifyPluginSpec(operation.spec).github
    return item.source === 'github' && item.github?.commit === desired.commit
      && item.github.owner.toLowerCase() === desired.owner.toLowerCase()
      && item.github.repo.toLowerCase() === desired.repo.toLowerCase()
  }
  const version = operation.spec.slice(operation.name.length + 1)
  return item.source === 'npm' && item.version === version && item.spec === version
}

function isRuntimePackage(runtime, name) {
  return INBOX_BUNDLES.has(name) || (typeof runtime?.root === 'string' && existsSync(join(runtime.root, 'node_modules', ...name.split('/'), 'package.json')))
}

function assertProfileDirectories(dshHome) {
  for (const target of [join(dshHome, 'profiles'), join(dshHome, 'profiles', 'web')]) {
    if (!existsSync(target)) continue
    const stat = lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Harness web profile 目录不是普通目录，拒绝自动修改')
  }
}

function readManifest(filename, optional = false) {
  let stat
  try { stat = lstatSync(filename) } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_LIMIT) throw new Error('插件清单文件无效或过大')
  const value = JSON.parse(readFileSync(filename, 'utf8'))
  if (!isRecord(value)) throw new Error('插件清单格式无效')
  return value
}

function requirePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${label}路径无效`)
  return value
}

function isWithin(parent, child) {
  const delta = relative(resolve(parent), resolve(child))
  return delta !== '' && delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
