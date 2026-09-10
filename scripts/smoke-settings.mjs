import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { createBackendEnvironment } from '../src/runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'mengluo-settings-smoke-'))
const packaged = process.argv.includes('--packaged')
const application = packaged ? join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked') : root
const screenshots = join(root, 'build')
mkdirSync(screenshots, { recursive: true })
try {
  const result = spawnSync(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    join(root, 'tests', 'fixtures', 'settings-smoke.mjs'), temporary, application, screenshots,
  ], { encoding: 'utf8', windowsHide: true, timeout: 50_000, env: createBackendEnvironment(process.env) })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /settings-smoke:passed/u)
  process.stdout.write(`${packaged ? 'packaged' : 'source'} ${result.stdout.trim()}\n`)
} finally { removeTreeWithoutFollowingLinks(temporary) }
