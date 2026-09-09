import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  EXPECTED_NPM_TREE_SHA256,
  EXPECTED_NPM_VERSION,
  hashMaterializedTree,
  resolveTrustedNpmRoot,
  stageNpmTooling,
  verifyNpmTree,
} from '../scripts/staging-npm.mjs'

describe('shell npm updater staging', () => {
  it('pins the exact standard npm closure', () => {
    assert.equal(EXPECTED_NPM_VERSION, '11.17.0')
    assert.equal(EXPECTED_NPM_TREE_SHA256, 'BBBF12FD2C6664D1E86017C8AD42DB4F60495A0A074586CD452AA3602C6B3E56')
  })

  it('rejects a changed critical npm CLI before execution', () => {
    const fixture = npmFixture()
    try {
      const expectations = fixtureExpectations(fixture.root)
      writeFileSync(join(fixture.root, 'bin', 'npm-cli.js'), 'changed')
      assert.throws(() => {
        verifyNpmTree(fixture.root, { ...expectations, nodePath: 'node.exe', spawnSync: npmVersion })
      }, /critical file changed: bin\/npm-cli\.js/u)
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true })
    }
  })

  it('replaces only the updater npm target and runs it with the slot Node', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-npm-stage-'))
    const programFiles = join(temporary, 'Program Files')
    const sourceRoot = join(programFiles, 'nodejs', 'node_modules', 'npm')
    const appRoot = join(temporary, 'desktop')
    const targetRoot = join(appRoot, 'build', 'updater', 'npm')
    const runtimeNodePath = join(appRoot, 'build', 'runtime', 'node-runtime', 'node.exe')
    const sentinel = join(appRoot, 'build', 'keep.txt')
    writeNpmFixture(sourceRoot)
    mkdirSync(targetRoot, { recursive: true })
    mkdirSync(join(runtimeNodePath, '..'), { recursive: true })
    writeFileSync(join(programFiles, 'nodejs', 'node.exe'), 'fixture-node')
    writeFileSync(runtimeNodePath, 'fixture-runtime-node')
    writeFileSync(join(targetRoot, 'stale.txt'), 'remove')
    writeFileSync(sentinel, 'keep')
    const expectations = fixtureExpectations(sourceRoot)
    const calls = []

    try {
      // Compare canonical paths, including when Windows TEMP uses an 8.3 alias.
      assert.equal(resolveTrustedNpmRoot(programFiles), realpathSync.native(sourceRoot))
      const staged = stageNpmTooling({
        appRoot,
        programFiles,
        runtimeNodePath,
        verifyNode: () => 'v24.19.0',
        spawnSync: (nodePath, args) => {
          calls.push({ nodePath, args })
          return npmVersion()
        },
        ...expectations,
      })
      assert.equal(staged.root, targetRoot)
      assert.equal(existsSync(join(targetRoot, 'stale.txt')), false)
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
      assert.equal(calls.length, 2)
      assert.equal(calls[1].nodePath, runtimeNodePath)
      assert.equal(calls[1].args[0], join(targetRoot, 'bin', 'npm-cli.js'))
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

function npmFixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'mengluo-npm-fixture-'))
  const root = join(temporary, 'npm')
  writeNpmFixture(root)
  return { temporary, root }
}

function writeNpmFixture(root) {
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'npm',
    version: EXPECTED_NPM_VERSION,
    license: 'Artistic-2.0',
  }))
  writeFileSync(join(root, 'bin', 'npm-cli.js'), 'fixture cli')
  writeFileSync(join(root, 'LICENSE'), 'fixture license')
  writeFileSync(join(root, 'lib', 'index.js'), 'fixture library')
}

function fixtureExpectations(root) {
  const tree = hashMaterializedTree(root)
  return {
    expectedTreeSha256: tree.sha256,
    expectedFiles: tree.files,
    expectedBytes: tree.bytes,
    expectedCriticalFiles: Object.fromEntries(['package.json', 'bin/npm-cli.js', 'LICENSE'].map(path => [
      path,
      createHash('sha256').update(readFileSync(join(root, ...path.split('/')))).digest('hex').toUpperCase(),
    ])),
  }
}

function npmVersion() {
  return { status: 0, stdout: `${EXPECTED_NPM_VERSION}\n` }
}
