import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { normalizeUpdateInterval, parseSemver } from './update-policy.mjs'

const STATE_SCHEMA = 1
const STATE_FILENAME = 'harness-runtime-state.json'
const RUNTIME_DIRECTORY = 'harness-runtimes'
const PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'dsh')
const WEB_APP_PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'dsh-web-app')
const WEB_FRONTEND_PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'dsh-web-frontend')
const NODE_EXECUTABLE_PATH = join('node-runtime', 'node.exe')
const NODE_LICENSE_PATH = join('node-runtime', 'LICENSE')
const RUNTIME_SEAL_SCHEMA = 2
const RUNTIME_SEAL_FILENAME = 'desktop-runtime-seal.json'
const SEALED_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'node-runtime/node.exe',
  'node-runtime/LICENSE',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-app/package.json',
  'node_modules/@deepseek-ai/dsh-web-frontend/package.json',
])
const SEALED_FRONTEND_TREE = 'node_modules/@deepseek-ai/dsh-web-frontend/dist'

/** Return a conservative, forward-compatible runtime update state. */
export function defaultRuntimeState() {
  return {
    schema: STATE_SCHEMA,
    autoCheck: true,
    interval: '24h',
    channel: undefined,
    lastCheckedAt: undefined,
    lastNotifiedVersion: undefined,
    etag: undefined,
    activeVersion: undefined,
    previousVersion: undefined,
    pendingVersion: undefined,
    badVersions: [],
  }
}

/** Read state without ever making application startup depend on it. */
export function readRuntimeState(userData) {
  const filename = runtimeStatePath(userData)
  try {
    return normalizeRuntimeState(JSON.parse(readFileSync(filename, 'utf8')))
  } catch {
    return defaultRuntimeState()
  }
}

/** Atomically persist state in the same directory as its final name. */
export function writeRuntimeState(userData, value) {
  const state = normalizeRuntimeState(value)
  const filename = runtimeStatePath(userData)
  mkdirSync(dirname(filename), { recursive: true })
  const temporary = `${filename}.${String(process.pid)}.${String(Date.now())}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, filename)
  return state
}

/** Normalize persisted fields while discarding path-like or invalid values. */
export function normalizeRuntimeState(value) {
  const source = isRecord(value) ? value : {}
  const channel = source.channel === 'latest' || source.channel === 'next' ? source.channel : undefined
  const badVersions = Array.isArray(source.badVersions)
    ? [...new Set(source.badVersions.filter(isSemver))]
    : []
  return {
    schema: STATE_SCHEMA,
    autoCheck: source.autoCheck !== false,
    interval: normalizeUpdateInterval(source.interval),
    channel,
    lastCheckedAt: finiteTimestamp(source.lastCheckedAt),
    lastNotifiedVersion: optionalSemver(source.lastNotifiedVersion),
    etag: typeof source.etag === 'string' && source.etag.length <= 512 ? source.etag : undefined,
    activeVersion: optionalSemver(source.activeVersion),
    previousVersion: optionalSemver(source.previousVersion),
    pendingVersion: optionalSemver(source.pendingVersion),
    badVersions,
  }
}

/** Locate the immutable per-version managed runtime slot. */
export function managedRuntimeDirectory(userData, version) {
  parseSemver(version)
  const root = resolve(userData, RUNTIME_DIRECTORY)
  const target = resolve(root, version)
  const relation = relative(root, target)
  if (relation === '' || relation.startsWith('..') || resolve(root, relation) !== target) {
    throw new Error(`Harness runtime version escaped its store: ${version}`)
  }
  return target
}

/** Validate one installed official runtime and return its launch descriptor. */
export function readManagedRuntime(userData, version) {
  const root = managedRuntimeDirectory(userData, version)
  const packageJsonPath = join(root, PACKAGE_PATH, 'package.json')
  const cliPath = join(root, PACKAGE_PATH, 'lib', 'bin.js')
  const nodePath = join(root, NODE_EXECUTABLE_PATH)
  const nodeLicensePath = join(root, NODE_LICENSE_PATH)
  if (!existsSync(packageJsonPath) || !existsSync(cliPath) || !existsSync(nodePath) || !existsSync(nodeLicensePath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version) return undefined
    const sealedNode = verifyRuntimeSeal(root, version)
    return Object.freeze({
      source: 'managed',
      version,
      root,
      cliPath,
      nodePath,
      nodeLicensePath,
      nodeVersion: sealedNode.version,
      nodeEngine: sealedNode.engine,
    })
  } catch {
    return undefined
  }
}

/** Write the immutable critical-file seal after a candidate passes its smoke test. */
export function writeRuntimeSeal(root, version, options = {}) {
  parseSemver(version)
  const dshManifest = assertRuntimePackageIdentity(root, PACKAGE_PATH, '@deepseek-ai/dsh', version)
  assertRuntimePackageIdentity(root, WEB_APP_PACKAGE_PATH, '@deepseek-ai/dsh-web-app', version)
  assertRuntimePackageIdentity(root, WEB_FRONTEND_PACKAGE_PATH, '@deepseek-ai/dsh-web-frontend', version)
  const nodeVersion = options.nodeVersion ?? inspectNodeVersion(join(root, NODE_EXECUTABLE_PATH))
  parseSemver(nodeVersion)
  const seal = {
    schema: RUNTIME_SEAL_SCHEMA,
    package: '@deepseek-ai/dsh',
    version,
    node: { version: nodeVersion, engine: readNodeEngine(dshManifest) },
    files: Object.fromEntries(SEALED_FILES.map(path => [path, hashRegularFile(join(root, ...path.split('/')))])),
    trees: { [SEALED_FRONTEND_TREE]: hashRegularTree(join(root, ...SEALED_FRONTEND_TREE.split('/'))) },
  }
  writeFileSync(join(root, RUNTIME_SEAL_FILENAME), `${JSON.stringify(seal, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return Object.freeze(seal)
}

/** Verify a managed slot's identity and critical-file seal before launch or reuse. */
export function verifyRuntimeSeal(root, version) {
  parseSemver(version)
  const filename = join(root, RUNTIME_SEAL_FILENAME)
  let seal
  try {
    seal = JSON.parse(readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new Error(`Harness runtime seal is unreadable at ${filename}: ${String(error)}`)
  }
  if (!isRecord(seal)
    || seal.schema !== RUNTIME_SEAL_SCHEMA
    || seal.package !== '@deepseek-ai/dsh'
    || seal.version !== version
    || !isRecord(seal.node)
    || !isRecord(seal.files)
    || !isRecord(seal.trees)) {
    throw new Error(`Harness runtime seal identity is invalid at ${filename}`)
  }
  const dshManifest = assertRuntimePackageIdentity(root, PACKAGE_PATH, '@deepseek-ai/dsh', version)
  assertRuntimePackageIdentity(root, WEB_APP_PACKAGE_PATH, '@deepseek-ai/dsh-web-app', version)
  assertRuntimePackageIdentity(root, WEB_FRONTEND_PACKAGE_PATH, '@deepseek-ai/dsh-web-frontend', version)
  const nodeVersion = parseSemver(seal.node.version).raw
  const nodeEngine = readNodeEngine(dshManifest)
  if (seal.node.engine !== nodeEngine) {
    throw new Error(`Harness runtime sealed Node engine changed: ${nodeEngine}`)
  }
  if (!sameKeys(seal.files, SEALED_FILES) || !sameKeys(seal.trees, [SEALED_FRONTEND_TREE])) {
    throw new Error(`Harness runtime seal file set is invalid at ${filename}`)
  }
  for (const path of SEALED_FILES) {
    if (seal.files[path] !== hashRegularFile(join(root, ...path.split('/')))) {
      throw new Error(`Harness runtime sealed file changed: ${path}`)
    }
  }
  if (seal.trees[SEALED_FRONTEND_TREE] !== hashRegularTree(join(root, ...SEALED_FRONTEND_TREE.split('/')))) {
    throw new Error(`Harness runtime sealed frontend tree changed: ${SEALED_FRONTEND_TREE}`)
  }
  return Object.freeze({ version: nodeVersion, engine: nodeEngine })
}

/** Read the package identity and Node executable of the immutable bundled fallback. */
export function readBundledRuntime(cliPath, nodePath, options = {}) {
  const packageJsonPath = resolve(dirname(cliPath), '..', 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh') throw new Error('bundled CLI has the wrong package identity')
    parseSemver(manifest.version)
    if (!existsSync(cliPath)) throw new Error('bundled CLI is missing')
    const nodeVersion = options.nodeVersion ?? inspectNodeVersion(nodePath)
    const nodeLicensePath = join(dirname(nodePath), 'LICENSE')
    hashRegularFile(nodeLicensePath)
    const root = resolve(dirname(packageJsonPath), '..', '..', '..')
    return Object.freeze({
      source: 'bundled',
      version: manifest.version,
      root,
      cliPath,
      nodePath,
      nodeLicensePath,
      nodeVersion,
      nodeEngine: readNodeEngine(manifest),
    })
  } catch (error) {
    throw new Error(`invalid bundled Harness runtime at ${packageJsonPath}: ${String(error)}`)
  }
}

/** Read and validate the SemVer reported by one standalone Node executable. */
export function inspectNodeVersion(nodePath, run = spawnSync) {
  hashRegularFile(nodePath)
  const result = run(nodePath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Node runtime version check failed with status ${String(result.status)}`)
  const output = String(result.stdout).trim()
  if (!output.startsWith('v')) throw new Error(`Node runtime reported an invalid version: ${output}`)
  return parseSemver(output.slice(1)).raw
}

/** Describe the installation-only Node without requiring any bundled Harness package. */
export function readInstallerNode(nodePath, options = {}) {
  const nodeVersion = options.nodeVersion ?? inspectNodeVersion(nodePath)
  parseSemver(nodeVersion)
  hashRegularFile(nodePath)
  const nodeLicensePath = join(dirname(nodePath), 'LICENSE')
  hashRegularFile(nodeLicensePath)
  return Object.freeze({ nodePath, nodeVersion, nodeLicensePath })
}

/** Pick a verified pending, active, or previous slot; undefined requires interactive installation. */
export function selectRuntime(userData, state) {
  const normalized = normalizeRuntimeState(state)
  const rejected = new Set(normalized.badVersions)
  for (const version of [normalized.pendingVersion, normalized.activeVersion, normalized.previousVersion]) {
    if (version === undefined || rejected.has(version)) continue
    const runtime = readManagedRuntime(userData, version)
    if (runtime !== undefined) return runtime
  }
  return undefined
}

/** Record that a selected managed runtime reached Harness readiness. */
export function markRuntimeReady(state, runtime) {
  const next = normalizeRuntimeState(state)
  if (runtime.source !== 'managed') return next
  if (next.activeVersion !== runtime.version) next.previousVersion = next.activeVersion
  next.activeVersion = runtime.version
  // Restarting the current backend must not discard a separately prepared update.
  if (next.pendingVersion === runtime.version) next.pendingVersion = undefined
  next.badVersions = next.badVersions.filter(version => version !== runtime.version)
  return next
}

/** Quarantine a failed managed runtime so startup can select another slot or request installation. */
export function markRuntimeFailed(state, runtime) {
  const next = normalizeRuntimeState(state)
  if (runtime.source !== 'managed') return next
  next.badVersions = [...new Set([...next.badVersions, runtime.version])]
  if (next.pendingVersion === runtime.version) next.pendingVersion = undefined
  if (next.activeVersion === runtime.version) next.activeVersion = undefined
  if (next.previousVersion === runtime.version) next.previousVersion = undefined
  return next
}

/** Schedule a fully verified slot for activation on the next launch. */
export function markRuntimePending(state, version) {
  parseSemver(version)
  const next = normalizeRuntimeState(state)
  next.pendingVersion = version
  next.badVersions = next.badVersions.filter(candidate => candidate !== version)
  return next
}

export function runtimeStatePath(userData) {
  return join(userData, STATE_FILENAME)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSemver(value) {
  if (typeof value !== 'string') return false
  try {
    parseSemver(value)
    return true
  } catch {
    return false
  }
}

function optionalSemver(value) {
  return isSemver(value) ? value : undefined
}

function finiteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function assertRuntimePackageIdentity(root, packagePath, expectedName, expectedVersion) {
  const path = join(root, packagePath, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Harness runtime package manifest is unreadable at ${path}: ${String(error)}`)
  }
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(`Harness runtime package identity mismatch for ${expectedName}@${expectedVersion}`)
  }
  return manifest
}

function readNodeEngine(manifest) {
  const engine = manifest.engines?.node
  if (engine === undefined) return undefined
  if (typeof engine !== 'string' || engine.trim() !== engine || engine.length === 0 || engine.length > 256 || /[\u0000-\u001f\u007f]/u.test(engine)) {
    throw new Error('Harness runtime must declare one valid engines.node range')
  }
  return engine
}

function hashRegularFile(path) {
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Harness runtime sealed path is not a regular file: ${path}`)
  return `sha256-${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function hashRegularTree(root) {
  const rootStats = lstatSync(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Harness runtime sealed tree is not a directory: ${root}`)
  }
  const digest = createHash('sha256')
  const pending = [{ absolute: root, relative: '' }]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = readdirSync(directory.absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory.absolute, entry.name)
      const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) throw new Error(`Harness runtime sealed tree contains a link: ${absolute}`)
      if (stats.isDirectory()) {
        digest.update(`directory\0${path}\0`)
        pending.push({ absolute, relative: path })
      } else if (stats.isFile()) {
        digest.update(`file\0${path}\0`)
        digest.update(createHash('sha256').update(readFileSync(absolute)).digest())
      } else {
        throw new Error(`Harness runtime sealed tree contains a non-file entry: ${absolute}`)
      }
    }
  }
  return `sha256-${digest.digest('hex')}`
}

function sameKeys(record, expected) {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}
