import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeStagingTree } from './staging.mjs'

/** Node version that passed the official npx directory-picker smoke. */
export const EXPECTED_NODE_VERSION = 'v24.19.0'
/** Byte length of the trusted Windows x64 Node executable. */
export const EXPECTED_NODE_BYTES = 92_825_416
/** SHA-256 of the trusted Windows x64 Node executable. */
export const EXPECTED_NODE_SHA256 = '3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237'
/** Byte length of the official Node v24.19.0 license file. */
export const EXPECTED_NODE_LICENSE_BYTES = 157_606
/** SHA-256 of the official Node v24.19.0 license file. */
export const EXPECTED_NODE_LICENSE_SHA256 = '148EACF7863EF4329224A29398623077200A27194AA075569FAF4A0A85566CA5'
/** Immutable upstream source used only when no verified local license exists. */
export const NODE_LICENSE_URL = 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE'

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE_LICENSE_NAMES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md']

/**
 * Resolve the fixed system installation path without consulting PATH.
 * @param {string | undefined} programFiles absolute trusted Windows directory.
 * @returns {string} canonical Node executable path.
 */
export function resolveTrustedNodeExecutable(programFiles = process.env.ProgramFiles) {
  if (typeof programFiles !== 'string' || programFiles.length === 0 || !isAbsolute(programFiles)) {
    throw new Error('stage-node requires an absolute ProgramFiles directory')
  }
  const trustedRoot = realpathSync.native(resolve(programFiles))
  const candidate = resolve(trustedRoot, 'nodejs', 'node.exe')
  if (!existsSync(candidate)) throw new Error(`trusted Node executable is missing: ${candidate}`)
  const stats = lstatSync(candidate)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`trusted Node executable is not a physical file: ${candidate}`)
  }
  const canonical = realpathSync.native(candidate)
  const expectedRelative = join('nodejs', 'node.exe')
  if (relative(trustedRoot, canonical).toLowerCase() !== expectedRelative.toLowerCase()) {
    throw new Error(`trusted Node executable escaped ${trustedRoot}: ${canonical}`)
  }
  return canonical
}

/**
 * Return an uppercase SHA-256 digest for one staging input.
 * @param {string} path file to hash.
 * @returns {string} uppercase hexadecimal digest.
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

/**
 * Require the exact Node executable proven by the official npx smoke.
 * @param {string} executable Node executable to inspect and run.
 * @param {object} [options] injectable expectations for isolated tests.
 * @returns {string} exact validated version.
 */
export function verifyNodeExecutable(executable, options = {}) {
  const expectedVersion = options.expectedVersion ?? EXPECTED_NODE_VERSION
  const expectedBytes = options.expectedBytes ?? EXPECTED_NODE_BYTES
  const expectedSha256 = options.expectedSha256 ?? EXPECTED_NODE_SHA256
  const run = options.spawnSync ?? spawnSync
  const stats = lstatSync(executable)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Node runtime is not a physical file: ${executable}`)
  }
  if (stats.size !== expectedBytes) {
    throw new Error(`Node runtime size mismatch: expected ${String(expectedBytes)}, received ${String(stats.size)}`)
  }
  const digest = sha256File(executable)
  if (digest !== expectedSha256) {
    throw new Error(`Node runtime SHA-256 mismatch: expected ${expectedSha256}, received ${digest}`)
  }
  const result = run(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Node runtime version check failed with status ${String(result.status)}`)
  }
  const actualVersion = String(result.stdout).trim()
  if (actualVersion !== expectedVersion) {
    throw new Error(`Node runtime version mismatch: expected ${expectedVersion}, received ${actualVersion}`)
  }
  const inspectSignature = options.inspectSignature ?? inspectOfficialNodeSignature
  verifyOfficialNodeSignature(inspectSignature(executable), expectedVersion)
  return actualVersion
}

/**
 * Read Authenticode and Windows version metadata without loading the executable.
 * @param {string} executable Node executable to inspect.
 * @param {object} [options] injectable environment and subprocess function.
 * @returns {object} parsed signature and version information.
 */
export function inspectOfficialNodeSignature(executable, options = {}) {
  const environment = options.environment ?? process.env
  const windowsDirectory = environment.SystemRoot ?? environment.windir
  if (typeof windowsDirectory !== 'string' || !/^[A-Za-z]:\\/u.test(windowsDirectory)) {
    throw new Error('stage-node requires an absolute Windows system directory')
  }
  const powershell = join(resolve(windowsDirectory), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    "$ErrorActionPreference='Stop'",
    '$signature=Get-AuthenticodeSignature -LiteralPath $env:DSH_NODE_SIGNATURE_PATH',
    '$version=(Get-Item -LiteralPath $env:DSH_NODE_SIGNATURE_PATH).VersionInfo',
    "[ordered]@{status=[string]$signature.Status; subject=[string]$signature.SignerCertificate.Subject; issuer=[string]$signature.SignerCertificate.Issuer; thumbprint=[string]$signature.SignerCertificate.Thumbprint; companyName=[string]$version.CompanyName; productName=[string]$version.ProductName; productVersion=[string]$version.ProductVersion; fileVersion=[string]$version.FileVersion; originalFilename=[string]$version.OriginalFilename} | ConvertTo-Json -Compress",
  ].join('; ')
  const run = options.spawnSync ?? spawnSync
  const childEnvironment = { ...environment, DSH_NODE_SIGNATURE_PATH: executable }
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === 'PSMODULEPATH') delete childEnvironment[key]
  }
  const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: childEnvironment,
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Node Authenticode inspection failed with status ${String(result.status)}: ${String(result.stderr).trim()}`)
  }
  try {
    return JSON.parse(String(result.stdout))
  } catch (error) {
    throw new Error(`Node Authenticode inspection returned invalid JSON: ${String(error)}`)
  }
}

/**
 * Require a valid official OpenJS Node signature and matching PE version data.
 * @param {object} signature Authenticode and PE version information.
 * @param {string} expectedVersion exact Node version with a leading `v`.
 * @returns {void}
 */
export function verifyOfficialNodeSignature(signature, expectedVersion) {
  const version = expectedVersion.startsWith('v') ? expectedVersion.slice(1) : expectedVersion
  if (signature?.status !== 'Valid') {
    throw new Error(`Node Authenticode signature is not valid: ${String(signature?.status)}`)
  }
  if (typeof signature.subject !== 'string' || !/(?:^|,\s*)O=OpenJS Foundation(?:,|$)/u.test(signature.subject)) {
    throw new Error(`Node Authenticode signer is not OpenJS Foundation: ${String(signature?.subject)}`)
  }
  if (typeof signature.issuer !== 'string' || signature.issuer.length === 0
    || typeof signature.thumbprint !== 'string' || !/^[A-F0-9]{40,64}$/u.test(signature.thumbprint)) {
    throw new Error('Node Authenticode certificate metadata is incomplete')
  }
  if (signature.companyName !== 'Node.js'
    || signature.productName !== 'Node.js'
    || signature.productVersion !== version
    || signature.fileVersion !== version
    || typeof signature.originalFilename !== 'string'
    || signature.originalFilename.toLowerCase() !== 'node.exe') {
    throw new Error(`Node Windows version information does not match ${expectedVersion}`)
  }
}

/**
 * Stage the pinned Node executable and its verified official license.
 * @param {object} [options] injectable roots, fingerprints, and subprocess functions.
 * @returns {Promise<object>} staged paths and license provenance.
 */
export async function stageNodeRuntime(options = {}) {
  const appRoot = resolve(options.appRoot ?? APP_ROOT)
  const targetRoot = resolve(appRoot, 'build', 'runtime', 'node-runtime')
  if (relative(appRoot, targetRoot) !== join('build', 'runtime', 'node-runtime')) {
    throw new Error(`desktop Node runtime target escaped the application directory: ${targetRoot}`)
  }

  const sourceExecutable = resolveTrustedNodeExecutable(options.programFiles)
  const executableOptions = {
    expectedVersion: options.expectedVersion,
    expectedBytes: options.expectedBytes,
    expectedSha256: options.expectedSha256,
    spawnSync: options.spawnSync,
    inspectSignature: options.inspectSignature,
  }
  verifyNodeExecutable(sourceExecutable, executableOptions)
  const license = await loadNodeLicense({
    appRoot,
    sourceExecutable,
    targetRoot,
    fetch: options.fetch,
    expectedBytes: options.expectedLicenseBytes,
    expectedSha256: options.expectedLicenseSha256,
  })

  removeStagingTree(targetRoot)
  mkdirSync(targetRoot, { recursive: true })
  const targetExecutable = join(targetRoot, 'node.exe')
  copyFileSync(sourceExecutable, targetExecutable)
  writeFileSync(join(targetRoot, 'LICENSE'), license.bytes)
  verifyNodeExecutable(targetExecutable, executableOptions)
  verifyNodeLicense(join(targetRoot, 'LICENSE'), {
    expectedBytes: options.expectedLicenseBytes,
    expectedSha256: options.expectedLicenseSha256,
  })
  return { sourceExecutable, targetExecutable, targetRoot, licenseSource: license.source }
}

async function loadNodeLicense(options) {
  const candidates = [
    ...NODE_LICENSE_NAMES.map(name => join(dirname(options.sourceExecutable), name)),
    join(options.appRoot, 'assets', 'node-runtime', 'LICENSE'),
    join(options.appRoot, 'build', 'node-runtime', 'LICENSE'),
    join(options.targetRoot, 'LICENSE'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    verifyNodeLicense(candidate, options)
    return { bytes: readFileSync(candidate), source: candidate }
  }

  const fetchLicense = options.fetch ?? globalThis.fetch
  if (typeof fetchLicense !== 'function') {
    throw new Error(`Node license is missing and cannot be fetched from ${NODE_LICENSE_URL}`)
  }
  const response = await fetchLicense(NODE_LICENSE_URL, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new Error(`Node license download failed with HTTP ${String(response.status)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  verifyLicenseBytes(bytes, options)
  return { bytes, source: NODE_LICENSE_URL }
}

/**
 * Require the exact official Node license staged with the executable.
 * @param {string} path license file to inspect.
 * @param {object} [options] injectable expectations for isolated tests.
 * @returns {void}
 */
export function verifyNodeLicense(path, options = {}) {
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Node license is not a physical file: ${path}`)
  }
  verifyLicenseBytes(readFileSync(path), options)
}

function verifyLicenseBytes(bytes, options = {}) {
  const expectedBytes = options.expectedBytes ?? EXPECTED_NODE_LICENSE_BYTES
  const expectedSha256 = options.expectedSha256 ?? EXPECTED_NODE_LICENSE_SHA256
  if (bytes.length !== expectedBytes) {
    throw new Error(`Node license size mismatch: expected ${String(expectedBytes)}, received ${String(bytes.length)}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  if (digest !== expectedSha256) {
    throw new Error(`Node license SHA-256 mismatch: expected ${expectedSha256}, received ${digest}`)
  }
}
