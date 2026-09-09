import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeStagingTree } from './staging.mjs'
import { resolveTrustedNodeExecutable, verifyNodeExecutable } from './staging-node.mjs'

/** Exact npm version shipped as the shell's single updater toolchain. */
export const EXPECTED_NPM_VERSION = '11.17.0'
/** Deterministic SHA-256 of npm from the checksum-pinned official Node Windows ZIP.
 * Unlike an MSI installation this does not include the machine-added global npmrc. */
export const EXPECTED_NPM_TREE_SHA256 = 'BBBF12FD2C6664D1E86017C8AD42DB4F60495A0A074586CD452AA3602C6B3E56'
/** Number of regular files in the trusted npm tree. */
export const EXPECTED_NPM_FILES = 1_921
/** Aggregate bytes of regular files in the trusted npm tree. */
export const EXPECTED_NPM_BYTES = 12_404_730

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CRITICAL_FILES = Object.freeze({
  'package.json': '40C49AEC1EF9A0CD1EDB50B900D678705319FAF9E3117F5336960BA7B3619E47',
  'bin/npm-cli.js': '3CE7CBA6F5128DD5F54C98B6A5036B0F850496878CC2E21044B675FE3C594E3E',
  LICENSE: 'AF1573A67C9D9051FBF8A9C123A22B7F51EC58CB6A588B4C23BEAD776DD046AB',
})

/**
 * Resolve npm from the fixed standard Node installation without consulting PATH.
 * @param {string | undefined} programFiles absolute trusted Windows directory.
 * @returns {string} canonical npm package root.
 */
export function resolveTrustedNpmRoot(programFiles = process.env.ProgramFiles) {
  if (typeof programFiles !== 'string' || programFiles.length === 0 || !isAbsolute(programFiles)) {
    throw new Error('stage-npm requires an absolute ProgramFiles directory')
  }
  const trustedRoot = realpathSync.native(resolve(programFiles))
  const candidate = resolve(trustedRoot, 'nodejs', 'node_modules', 'npm')
  if (!existsSync(candidate)) throw new Error(`trusted npm package is missing: ${candidate}`)
  const stats = lstatSync(candidate)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`trusted npm package is not a physical directory: ${candidate}`)
  }
  const canonical = realpathSync.native(candidate)
  const expectedRelative = join('nodejs', 'node_modules', 'npm')
  if (relative(trustedRoot, canonical).toLowerCase() !== expectedRelative.toLowerCase()) {
    throw new Error(`trusted npm package escaped ${trustedRoot}: ${canonical}`)
  }
  return canonical
}

/**
 * Hash one fully materialized tree while rejecting every link and special entry.
 * @param {string} root physical directory root.
 * @returns {{sha256: string; files: number; directories: number; bytes: number}} deterministic tree facts.
 */
export function hashMaterializedTree(root) {
  const rootStats = lstatSync(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`npm updater root is not a physical directory: ${root}`)
  }
  const digest = createHash('sha256')
  let files = 0
  let directories = 0
  let bytes = 0
  const visit = (absolute, relativePath = '') => {
    for (const name of readdirSync(absolute).sort(compareNames)) {
      const path = join(absolute, name)
      const childPath = relativePath === '' ? name : `${relativePath}/${name}`
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) throw new Error(`npm updater tree contains a filesystem link: ${path}`)
      if (stats.isDirectory()) {
        directories += 1
        digest.update(`directory\0${childPath}\0`)
        visit(path, childPath)
      } else if (stats.isFile()) {
        files += 1
        bytes += stats.size
        digest.update(`file\0${childPath}\0${String(stats.size)}\0`)
        digest.update(createHash('sha256').update(readFileSync(path)).digest())
      } else {
        throw new Error(`npm updater tree contains a non-file entry: ${path}`)
      }
    }
  }
  visit(root)
  return Object.freeze({ sha256: digest.digest('hex').toUpperCase(), files, directories, bytes })
}

/**
 * Verify npm identity, closure fingerprint, critical files, and executable CLI.
 * @param {string} root npm package root.
 * @param {object} options Node executable and injectable fixture expectations.
 * @returns {object} verified npm paths and tree facts.
 */
export function verifyNpmTree(root, options) {
  const expectedVersion = options.expectedVersion ?? EXPECTED_NPM_VERSION
  const expectedTreeSha256 = options.expectedTreeSha256 ?? EXPECTED_NPM_TREE_SHA256
  const expectedFiles = options.expectedFiles ?? EXPECTED_NPM_FILES
  const expectedBytes = options.expectedBytes ?? EXPECTED_NPM_BYTES
  const expectedCriticalFiles = options.expectedCriticalFiles ?? CRITICAL_FILES
  const packagePath = join(root, 'package.json')
  const cliPath = join(root, 'bin', 'npm-cli.js')
  const licensePath = join(root, 'LICENSE')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (manifest.name !== 'npm' || manifest.version !== expectedVersion || manifest.license !== 'Artistic-2.0') {
    throw new Error(`npm updater identity mismatch: expected npm@${expectedVersion}`)
  }
  for (const [relativePath, expectedHash] of Object.entries(expectedCriticalFiles)) {
    const path = join(root, ...relativePath.split('/'))
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`npm updater critical path is not a physical file: ${path}`)
    }
    const actualHash = createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
    if (actualHash !== expectedHash) throw new Error(`npm updater critical file changed: ${relativePath}`)
  }
  const tree = hashMaterializedTree(root)
  if (tree.sha256 !== expectedTreeSha256 || tree.files !== expectedFiles || tree.bytes !== expectedBytes) {
    throw new Error(`npm updater tree fingerprint mismatch: ${JSON.stringify(tree)}`)
  }
  if (typeof options.nodePath !== 'string' || options.nodePath.length === 0) {
    throw new Error('npm updater verification requires its standalone Node executable')
  }
  const run = options.spawnSync ?? spawnSync
  const result = run(options.nodePath, [cliPath, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 || String(result.stdout).trim() !== expectedVersion) {
    throw new Error(`npm updater CLI version check failed: ${String(result.stdout).trim()}`)
  }
  return Object.freeze({ root, cliPath, licensePath, version: expectedVersion, tree })
}

/**
 * Copy the trusted npm closure into the one shell-level updater directory.
 * @param {object} [options] injectable roots and validators for isolated tests.
 * @returns {object} staged npm descriptor.
 */
export function stageNpmTooling(options = {}) {
  const appRoot = resolve(options.appRoot ?? APP_ROOT)
  const target = resolve(appRoot, 'build', 'updater', 'npm')
  if (relative(appRoot, target) !== join('build', 'updater', 'npm')) {
    throw new Error(`desktop npm updater target escaped the application directory: ${target}`)
  }
  const source = resolveTrustedNpmRoot(options.programFiles)
  const sourceNodePath = options.sourceNodePath ?? resolveTrustedNodeExecutable(options.programFiles)
  const verifyNode = options.verifyNode ?? verifyNodeExecutable
  verifyNode(sourceNodePath)
  const verificationOptions = {
    expectedVersion: options.expectedVersion,
    expectedTreeSha256: options.expectedTreeSha256,
    expectedFiles: options.expectedFiles,
    expectedBytes: options.expectedBytes,
    expectedCriticalFiles: options.expectedCriticalFiles,
    spawnSync: options.spawnSync,
  }
  verifyNpmTree(source, { ...verificationOptions, nodePath: sourceNodePath })
  removeStagingTree(target)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  const runtimeNodePath = options.runtimeNodePath ?? resolve(appRoot, 'build', 'runtime', 'node-runtime', 'node.exe')
  return verifyNpmTree(target, { ...verificationOptions, nodePath: runtimeNodePath })
}

function compareNames(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}
