import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { createBackendEnvironment } from '../src/runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const packaged = process.argv.includes('--packaged')
const snapshotRecovery = process.argv.includes('--snapshot-recovery')
const resources = join(root, 'dist', 'win-unpacked', 'resources')
const application = packaged ? join(resources, 'app.asar') : root
const temporary = mkdtempSync(join(tmpdir(), 'mengluo-main-smoke-'))
try {
  const result = spawnSync(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    join(root, 'tests', 'fixtures', 'main-smoke.mjs'), temporary, application, packaged ? resources : '', snapshotRecovery ? '--snapshot-recovery' : '',
  ], { encoding: 'utf8', windowsHide: true, timeout: 40_000, env: createBackendEnvironment(process.env) })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /main-smoke:passed/u)
  process.stdout.write(`${packaged ? 'packaged' : 'source'} ${result.stdout}`)
} finally { removeTreeWithoutFollowingLinks(temporary) }
