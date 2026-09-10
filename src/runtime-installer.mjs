import { spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { DSH_PACKAGE_NAME, NPM_REGISTRY_ORIGIN, parseSemver } from './update-policy.mjs'
import { resolveDownloadSource } from './download-source.mjs'
import {
  inspectNodeVersion,
  managedRuntimeDirectory,
  readManagedRuntime,
  writeRuntimeSeal,
} from './runtime-store.mjs'
import { removeTreeWithoutFollowingLinks } from './safe-remove.mjs'
import {
  isUpdateProgressStage,
  normalizeUpdateFileProgress,
  UPDATE_INSTALL_TIMEOUT_MS,
} from './update-progress-window.mjs'

const MAX_INSTALL_OUTPUT = 64 * 1_024
const MAX_NODE_LICENSE_BYTES = 2 * 1_024 * 1_024
const INSTALL_ACTIVITY_INTERVAL_MS = 5_000

/** Build the fixed-registry, exact-version, script-disabled npm invocation. */
export function npmInstallArguments({ npmCliPath, staging, cache, userConfig, version }) {
  parseSemver(version)
  return [
    npmCliPath,
    'install',
    '--prefix', staging,
    '--omit=dev',
    '--ignore-scripts',
    '--save-exact',
    '--package-lock=true',
    '--engine-strict=true',
    '--audit=false',
    '--fund=false',
    '--loglevel=silly',
    `--registry=${NPM_REGISTRY_ORIGIN}/`,
    `--userconfig=${userConfig}`,
    `--globalconfig=${userConfig}.global`,
    `--cache=${cache}`,
    `${DSH_PACKAGE_NAME}@${version}`,
  ]
}

/** Reify an already verified official lock; npm substitutes only npmjs tarball hosts. */
export function npmCiArguments({ npmCliPath, staging, cache, userConfig, downloadSource }) {
  const source = resolveDownloadSource(downloadSource)
  return [
    npmCliPath, 'ci', '--prefix', staging, '--omit=dev', '--ignore-scripts',
    '--package-lock=true', '--engine-strict=true', '--audit=false', '--fund=false',
    '--loglevel=silly', '--replace-registry-host=npmjs',
    `--registry=${source.registry}`, `--userconfig=${userConfig}`,
    `--globalconfig=${userConfig}.global`, `--cache=${cache}`,
    ...(source.id === 'npmmirror' ? ['--fetch-timeout=45000', '--fetch-retries=1'] : []),
  ]
}

/** Install bytes with one shared timeout budget; mirrors never choose the dependency graph. */
export async function installNpmRuntimeClosure(options) {
  const source = resolveDownloadSource(options.downloadSource)
  const { npm, staging, cache, userConfig, release, signal, log = () => {} } = options
  parseSemver(release.version)
  signal?.throwIfAborted()
  const run = options.runProcess ?? runProcess
  const now = options.now ?? (() => performance.now())
  const deadline = now() + UPDATE_INSTALL_TIMEOUT_MS
  const notify = (selected, fallback, detail) => {
    const status = Object.freeze({ source: selected, fallback, detail })
    log(`[download source] ${detail}\n`)
    try { options.onDownloadStatus?.(status) } catch (error) { log(`download source callback failed: ${String(error)}\n`) }
  }
  const invoke = async (args, proxy) => {
    signal?.throwIfAborted()
    const timeoutMs = Math.floor(deadline - now())
    if (timeoutMs <= 0) throw new Error('npm installation exceeded its shared 30-minute timeout budget')
    await run(npm.nodePath, args, {
      cwd: staging, environment: createNpmInstallEnvironment(proxy), timeoutMs, signal, log,
      activityRoot: staging, onActivity: options.onActivity,
    })
    signal?.throwIfAborted()
  }
  const argumentsOptions = { npmCliPath: npm.npmCliPath, staging, cache, userConfig, version: release.version }
  if (source.id === 'official') {
    notify('official', false, '通过官方 npm 下载并安装')
    await invoke(npmInstallArguments(argumentsOptions), options.proxy)
    return
  }

  notify('official', false, '从官方 npm 确定版本、依赖和完整性校验值')
  const lockArguments = npmInstallArguments(argumentsOptions)
  lockArguments.splice(-1, 0, '--package-lock-only')
  await invoke(lockArguments, options.officialProxy)
  validateOfficialRuntimeLock(staging, release)
  const lockPath = join(staging, 'package-lock.json')
  const manifestPath = join(staging, 'package.json')
  const trustedLock = readFileSync(lockPath)
  const trustedManifest = readFileSync(manifestPath)
  const verifyUnchanged = () => {
    if (!readFileSync(lockPath).equals(trustedLock) || !readFileSync(manifestPath).equals(trustedManifest)) {
      throw new Error('npm ci changed the trusted official dependency graph; refusing this runtime')
    }
  }
  notify('npmmirror', false, '通过 npmmirror 下载官方锁定的安装文件')
  try {
    await invoke(npmCiArguments({ ...argumentsOptions, downloadSource: 'npmmirror' }), options.proxy)
    verifyUnchanged()
  } catch (error) {
    signal?.throwIfAborted()
    verifyUnchanged()
    if (!isMirrorTransportFailure(error)) throw error
    notify('official', true, '镜像连接失败或缺少文件，改用官方 npm 下载同一版本和依赖')
    await invoke(npmCiArguments({ ...argumentsOptions, downloadSource: 'official' }), options.officialProxy)
    verifyUnchanged()
  }
}

/** A mirror may only transport integrity-pinned HTTPS npm artifacts from this official graph. */
export function validateOfficialRuntimeLock(root, release) {
  parseSemver(release.version)
  const manifest = readJson(join(root, 'package.json'), 'official runtime manifest')
  const lock = readJson(join(root, 'package-lock.json'), 'official runtime lock')
  if (manifest.dependencies?.[DSH_PACKAGE_NAME] !== release.version
    || lock.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== 'object'
    || Array.isArray(lock.packages)
    || lock.packages['']?.dependencies?.[DSH_PACKAGE_NAME] !== release.version) {
    throw new Error('official runtime lock must pin the exact Harness version in lockfile v3')
  }
  for (const name of [DSH_PACKAGE_NAME, '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-frontend']) {
    const entry = lock.packages[`node_modules/${name}`]
    if (entry?.version !== release.version || (name === DSH_PACKAGE_NAME && entry.integrity !== release.integrity)) {
      throw new Error(`official runtime lock does not match the selected Harness release: ${name}`)
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue
    if (!path.startsWith('node_modules/') || path.split('/').some(part => part === '..' || part === '.')
      || path.includes('\\') || entry === null || typeof entry !== 'object' || entry.link) {
      throw new Error('official runtime lock contains an unsafe dependency path or link')
    }
    let url
    try { url = new URL(entry.resolved) } catch { throw new Error('official runtime dependency has no verifiable npm artifact') }
    if (url.origin !== NPM_REGISTRY_ORIGIN || url.username !== '' || url.password !== ''
      || url.search !== '' || url.hash !== '' || !url.pathname.endsWith('.tgz')) {
      throw new Error('official runtime dependency is not an official HTTPS npm artifact')
    }
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity)
      || Buffer.from(entry.integrity.slice(7), 'base64').toString('base64') !== entry.integrity.slice(7)) {
      throw new Error('official runtime dependency is missing canonical SHA-512 integrity')
    }
  }
  return lock
}

function isMirrorTransportFailure(error) {
  return new Set([
    'E404', 'ETARGET', 'E408', 'E429', 'E500', 'E502', 'E503', 'E504',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ]).has(error?.npmCode)
}

/** Install and verify one immutable official npm runtime slot. */
export async function installOfficialRuntime(options) {
  const {
    userData,
    release,
    npm,
    log = () => {},
    smoke,
    signal,
  } = options
  resolveDownloadSource(options.downloadSource)
  const progress = (stage, files) => {
    if (!isUpdateProgressStage(stage)) throw new Error(`unsupported update progress stage: ${String(stage)}`)
    const normalizedFiles = normalizeUpdateFileProgress(files)
    try {
      options.progress?.(stage, normalizedFiles)
    } catch (error) {
      log(`runtime progress callback failed: ${String(error)}\n`)
    }
  }
  parseSemver(release.version)
  signal?.throwIfAborted()
  progress('preparing')
  const runtimeRoot = resolve(userData, 'harness-runtimes')
  mkdirSync(runtimeRoot, { recursive: true })
  const target = managedRuntimeDirectory(userData, release.version)
  if (existsSync(target)) {
    try {
      progress('verifying')
      verifyReleaseInstallation(target, release)
      assertMaterializedTree(target, {
        progress: files => { progress('verifying', files) },
      })
      const installed = readManagedRuntime(userData, release.version)
      if (installed === undefined) throw new Error('existing Harness runtime failed its launch-time seal check')
      progress('smoke')
      await smoke(installed)
      signal?.throwIfAborted()
      progress('finalizing')
      return installed
    } catch (error) {
      signal?.throwIfAborted()
      const quarantine = join(runtimeRoot, `.quarantine-${release.version}-${String(Date.now())}`)
      log(`quarantining invalid existing runtime: ${String(error)}\n`)
      renameSync(target, quarantine)
    }
  }

  if (npm === undefined) throw new Error('客户端内置 npm 更新组件不可用，无法下载官方 Harness 更新。')
  const staging = mkdtempSync(join(runtimeRoot, '.staging-'))
  try {
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
      name: 'mengluo-managed-harness-runtime',
      version: '0.0.0',
      private: true,
    }, null, 2)}\n`)
    const userConfig = join(staging, 'empty.npmrc')
    writeFileSync(userConfig, '')
    writeFileSync(`${userConfig}.global`, '')
    const cache = join(userData, 'npm-cache')
    mkdirSync(cache, { recursive: true })
    log(`installing official ${DSH_PACKAGE_NAME}@${release.version}\n`)
    progress('installing')
    await installNpmRuntimeClosure({
      npm, staging, cache, userConfig, release,
      downloadSource: options.downloadSource,
      proxy: options.proxy,
      officialProxy: options.officialProxy,
      onDownloadStatus: options.onDownloadStatus,
      signal,
      log,
      onActivity: activity => {
        progress('installing', activity)
      },
    })
    progress('verifying')
    const verified = verifyReleaseInstallation(staging, release)
    if (npm.verified !== true) throw new Error('current runtime Node/npm descriptor was not verified')
    const stagedNode = stageManagedNode(staging, npm.nodePath, { expectedVersion: npm.nodeVersion })
    await stageNodeLicense(staging, stagedNode.nodeVersion, {
      preferred: options.preferredNodeLicense,
      fetch: options.fetch,
      signal,
    })
    assertMaterializedTree(staging, {
      progress: files => { progress('verifying', files) },
    })
    progress('smoke')
    await smoke({
      source: 'managed',
      root: staging,
      cliPath: verified.cliPath,
      version: release.version,
      nodePath: stagedNode.nodePath,
      nodeLicensePath: join(staging, 'node-runtime', 'LICENSE'),
      nodeVersion: stagedNode.nodeVersion,
      nodeEngine: verified.nodeEngine,
    })
    signal?.throwIfAborted()
    progress('finalizing')
    writeRuntimeSeal(staging, release.version, { nodeVersion: stagedNode.nodeVersion })
    renameSync(staging, target)
    const installed = readManagedRuntime(userData, release.version)
    if (installed === undefined) throw new Error('已安装的 Harness runtime 在提升后无法读取')
    return installed
  } catch (error) {
    removeStagingDirectory(runtimeRoot, staging)
    throw error
  }
}

/** Verify npm package identity plus the registry integrity recorded in lock v3. */
export function verifyReleaseInstallation(root, release) {
  parseSemver(release.version)
  const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = readJson(join(packageRoot, 'package.json'), 'installed Harness manifest')
  if (manifest.name !== DSH_PACKAGE_NAME || manifest.version !== release.version) {
    throw new Error(`installed Harness identity mismatch (expected ${DSH_PACKAGE_NAME}@${release.version})`)
  }
  const cliPath = join(packageRoot, 'lib', 'bin.js')
  if (!existsSync(cliPath)) throw new Error(`installed Harness CLI is missing: ${cliPath}`)
  const nodeEngine = manifest.engines?.node
  if (nodeEngine !== undefined && (typeof nodeEngine !== 'string'
    || nodeEngine.trim() !== nodeEngine
    || nodeEngine.length === 0
    || nodeEngine.length > 256)) {
    throw new Error('installed Harness must declare one engines.node range')
  }
  const project = readJson(join(root, 'package.json'), 'managed runtime manifest')
  if (project.dependencies?.[DSH_PACKAGE_NAME] !== release.version) {
    throw new Error('managed runtime does not pin the exact Harness version')
  }
  const lock = readJson(join(root, 'package-lock.json'), 'managed runtime package lock')
  const locked = lock.packages?.[`node_modules/${DSH_PACKAGE_NAME}`]
  if (locked?.version !== release.version || locked?.integrity !== release.integrity) {
    throw new Error('managed runtime package lock does not match official registry integrity')
  }
  for (const name of ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-frontend']) {
    const packageRoot = join(root, 'node_modules', ...name.split('/'))
    const dependencyManifest = readJson(join(packageRoot, 'package.json'), `installed ${name} manifest`)
    if (dependencyManifest.name !== name || dependencyManifest.version !== release.version) {
      throw new Error(`installed ${name} must match Harness ${release.version}`)
    }
    const lockPath = `node_modules/${name}`
    if (lock.packages?.[lockPath]?.version !== release.version) {
      throw new Error(`managed runtime lock must pin ${name}@${release.version}`)
    }
  }
  return Object.freeze({ packageRoot, cliPath, nodeEngine })
}

/** Copy the currently selected trusted Node executable into a candidate runtime slot. */
export function stageManagedNode(root, sourceNodePath, options = {}) {
  if (!isAbsolute(sourceNodePath)) throw new Error('trusted runtime Node source path is not absolute')
  const sourceStats = lstatSync(sourceNodePath)
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error(`trusted runtime Node source is not a regular file: ${sourceNodePath}`)
  }
  const verifyNode = options.verifyNode ?? verifyTrustedNodeExecutable
  const sourceVersion = verifyNode(sourceNodePath, options)
  if (options.expectedVersion !== undefined && sourceVersion !== options.expectedVersion) {
    throw new Error(`trusted runtime Node changed after slot selection: ${sourceVersion}`)
  }
  const nodeRoot = join(root, 'node-runtime')
  if (existsSync(nodeRoot)) {
    const rootStats = lstatSync(nodeRoot)
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(`candidate runtime Node directory is unsafe: ${nodeRoot}`)
    }
  } else {
    mkdirSync(nodeRoot)
  }
  const nodePath = join(nodeRoot, 'node.exe')
  copyFileSync(sourceNodePath, nodePath, constants.COPYFILE_EXCL)
  const nodeVersion = verifyNode(nodePath, options)
  parseSemver(nodeVersion)
  if (nodeVersion !== sourceVersion) throw new Error('candidate runtime Node copy changed its reported version')
  return Object.freeze({ nodePath, nodeVersion })
}

/** Stage the exact-version Node license beside a managed executable. */
export async function stageNodeLicense(root, nodeVersion, options = {}) {
  parseSemver(nodeVersion)
  options.signal?.throwIfAborted()
  const target = join(root, 'node-runtime', 'LICENSE')
  const preferred = options.preferred
  if (preferred?.nodeVersion === nodeVersion && typeof preferred.nodeLicensePath === 'string') {
    const stats = lstatSync(preferred.nodeLicensePath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`preferred Node license is not a regular file: ${preferred.nodeLicensePath}`)
    }
    copyFileSync(preferred.nodeLicensePath, target, constants.COPYFILE_EXCL)
    return target
  }

  const fetchLicense = options.fetch ?? globalThis.fetch
  if (typeof fetchLicense !== 'function') throw new Error('Node license fetch is unavailable')
  const url = `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`
  const response = await fetchLicense(url, { redirect: 'error', signal: options.signal })
  if (!response.ok) throw new Error(`Node ${nodeVersion} license download failed with HTTP ${String(response.status)}`)
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_NODE_LICENSE_BYTES) {
    throw new Error(`Node ${nodeVersion} license exceeded the size limit`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  options.signal?.throwIfAborted()
  if (bytes.length === 0 || bytes.length > MAX_NODE_LICENSE_BYTES
    || !bytes.subarray(0, 64).toString('utf8').startsWith('Node.js is licensed for use as follows:')) {
    throw new Error(`Node ${nodeVersion} license content is invalid`)
  }
  writeFileSync(target, bytes, { flag: 'wx' })
  return target
}

/** Require a valid OpenJS-signed current-runtime Node before it enters a new slot. */
export function verifyTrustedNodeExecutable(nodePath, options = {}) {
  if (!isAbsolute(nodePath)) throw new Error(`trusted runtime Node path is not absolute: ${nodePath}`)
  const stats = lstatSync(nodePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`trusted runtime Node is not a physical file: ${nodePath}`)
  }
  const environment = options.environment ?? process.env
  const windowsDirectory = environment.SystemRoot ?? environment.windir
  if (typeof windowsDirectory !== 'string' || !/^[A-Za-z]:[\\/]/u.test(windowsDirectory)) {
    throw new Error('Windows system directory is unavailable for Node signature verification')
  }
  const powershell = win32.join(win32.normalize(windowsDirectory), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:DSH_NODE_SIGNATURE_TARGET',
    '$product = (Get-Item -LiteralPath $env:DSH_NODE_SIGNATURE_TARGET).VersionInfo.ProductName',
    '[Console]::Out.WriteLine([string]$signature.Status)',
    '[Console]::Out.WriteLine([string]$signature.SignerCertificate.Subject)',
    '[Console]::Out.WriteLine([string]$product)',
  ].join('; ')
  const run = options.spawnSync ?? spawnSync
  const signatureEnvironment = { ...environment }
  for (const key of Object.keys(signatureEnvironment)) {
    if (/^PSModulePath$/iu.test(key)) delete signatureEnvironment[key]
  }
  signatureEnvironment.DSH_NODE_SIGNATURE_TARGET = nodePath
  const result = run(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: signatureEnvironment,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Node Authenticode verification failed with status ${String(result.status)}`)
  const [status, subject, product] = String(result.stdout).split(/\r?\n/u)
  if (status !== 'Valid'
    || !/(?:OpenJS|Node\.js) Foundation/iu.test(subject ?? '')
    || product !== 'Node.js') {
    throw new Error('trusted runtime Node Authenticode identity is not valid OpenJS Node.js')
  }
  return inspectNodeVersion(nodePath, options.nodeSpawnSync)
}

/** Refuse symlink/junction based closures before a runtime becomes active. */
export function assertMaterializedTree(root, options = {}) {
  const totalFiles = countMaterializedFiles(root)
  let completedFiles = 0
  const report = () => {
    try {
      options.progress?.(Object.freeze({ completedFiles, totalFiles }))
    } catch {
      // Progress reporting cannot weaken the link-free security audit.
    }
  }
  report()
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`managed runtime contains a link: ${path}`)
      if (stat.isDirectory()) pending.push(path)
      else {
        completedFiles += 1
        if (completedFiles % 512 === 0) report()
      }
    }
  }
  report()
  return Object.freeze({ completedFiles, totalFiles })
}

/** Count physical files without following links in a candidate runtime tree. */
export function countMaterializedFiles(root) {
  let files = 0
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
      else files += 1
    }
  }
  return files
}

/** Run a bounded child process while keeping only a diagnostic output tail. */
export function runProcess(command, args, options) {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Harness update installation was cancelled'))
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    let forcedError
    let lastActivityCount = -1
    let lastActivitySignature = ''
    let npmLineBuffer = ''
    let npmCode
    const activity = {
      completedFiles: 0,
      registryRequests: 0,
      resolvedDependencies: 0,
    }
    const publishActivity = () => {
      if (typeof options.onActivity !== 'function') return
      const signature = `${String(activity.completedFiles)}:${String(activity.registryRequests)}:${String(activity.resolvedDependencies)}`
      if (signature === lastActivitySignature) return
      lastActivitySignature = signature
      options.onActivity(Object.freeze({ ...activity }))
    }
    const observeNpmLine = line => {
      const code = /^(?:npm\s+)?error\s+code\s+([A-Z][A-Z0-9_]*)\s*$/u.exec(line.trim())
      if (code !== null) npmCode = code[1]
      if (/\bhttp fetch\b.*\b(?:200|304)\b/iu.test(line)) activity.registryRequests += 1
      if (/\bsill(?:y)? placeDep\b/iu.test(line)) activity.resolvedDependencies += 1
      if (/^(?:npm\s+)?(?:warn|error)\b/iu.test(line)) options.log(`[npm] ${line}\n`)
    }
    const observeNpmChunk = chunk => {
      npmLineBuffer += chunk.toString()
      const lines = npmLineBuffer.split(/\r?\n/u)
      npmLineBuffer = lines.pop() ?? ''
      for (const line of lines) observeNpmLine(line)
      publishActivity()
    }
    const remember = (source, chunk) => {
      const text = `[${source}] ${chunk.toString()}`
      output = `${output}${text}`.slice(-MAX_INSTALL_OUTPUT)
      if (source === 'npm stderr') observeNpmChunk(chunk)
      else options.log(text)
    }
    child.stdout?.on('data', chunk => { remember('npm stdout', chunk) })
    child.stderr?.on('data', chunk => { remember('npm stderr', chunk) })
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activityTimer !== undefined) clearInterval(activityTimer)
      options.signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const reportActivity = () => {
      if (typeof options.activityRoot !== 'string' || typeof options.onActivity !== 'function') return
      try {
        const count = countMaterializedFiles(options.activityRoot)
        if (count === lastActivityCount) return
        lastActivityCount = count
        activity.completedFiles = count
        publishActivity()
      } catch (error) {
        options.log(`[npm progress] file activity scan failed: ${String(error)}\n`)
      }
    }
    const abort = () => {
      forcedError = new Error('Harness update installation was cancelled')
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      forcedError = new Error(`npm install timed out after ${String(options.timeoutMs)}ms\n${output}`)
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const activityTimer = typeof options.onActivity === 'function'
      ? setInterval(reportActivity, options.activityIntervalMs ?? INSTALL_ACTIVITY_INTERVAL_MS)
      : undefined
    activityTimer?.unref?.()
    reportActivity()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.once('error', error => { finish(rejectPromise, error) })
    child.once('close', (code, signal) => {
      if (npmLineBuffer.length > 0) {
        observeNpmLine(npmLineBuffer)
        npmLineBuffer = ''
        publishActivity()
      }
      reportActivity()
      if (forcedError !== undefined) finish(rejectPromise, forcedError)
      else if (code === 0) finish(resolvePromise, undefined)
      else finish(rejectPromise, Object.assign(new Error(`npm install failed (code=${String(code)}, signal=${String(signal)})\n${output}`), { npmCode }))
    })
  })
}

/**
 * Isolate npm configuration while applying an optional validated system proxy.
 * @param {string | null | undefined} proxy URL selected by Electron; null explicitly means DIRECT.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [source] parent environment.
 * @returns {NodeJS.ProcessEnv} npm child environment.
 */
export function createNpmInstallEnvironment(proxy, source = process.env) {
  const environment = { ...source, NO_COLOR: '1' }
  delete environment.FORCE_COLOR
  delete environment.NODE_OPTIONS
  for (const key of Object.keys(environment)) {
    if (/^npm_config_/iu.test(key)) delete environment[key]
  }
  if (proxy !== undefined && proxy !== null) {
    const parsed = new URL(proxy)
    const authority = proxy.slice(proxy.indexOf('//') + 2)
    const portMatch = authority.match(/:(\d{1,5})$/u)
    const port = Number(portMatch?.[1])
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)
      || parsed.hostname === '' || !Number.isInteger(port) || port < 1 || port > 65_535
      || parsed.username !== '' || parsed.password !== '' || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('resolved npm proxy is invalid')
    }
  }
  if (proxy !== undefined) {
    for (const key of Object.keys(environment)) {
      if (/^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu.test(key)) delete environment[key]
    }
  }
  if (proxy !== undefined && proxy !== null) {
    environment.HTTP_PROXY = proxy
    environment.HTTPS_PROXY = proxy
  }
  return environment
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is unreadable at ${path}: ${String(error)}`)
  }
}

function removeStagingDirectory(root, staging) {
  const resolvedRoot = resolve(root)
  const resolvedStaging = resolve(staging)
  if (dirname(resolvedStaging) !== resolvedRoot || !basename(resolvedStaging).startsWith('.staging-')) {
    throw new Error(`refusing to remove unexpected staging path: ${staging}`)
  }
  removeTreeWithoutFollowingLinks(resolvedStaging)
}
