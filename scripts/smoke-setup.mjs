import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { createBackendEnvironment } from '../src/runtime.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'mengluo-setup-smoke-'))
const packaged = process.argv.includes('--packaged')
const application = packaged
  ? resolve(appRoot, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked') : appRoot
const iconPath = packaged
  ? resolve(application, '..', 'app.asar', 'assets', 'icon.png') : join(appRoot, 'assets', 'icon.png')
const screenshot = join(appRoot, 'build', 'setup-smoke.png')
const progressAssets = packaged ? resolve(application, '..', 'app.asar', 'assets') : join(appRoot, 'assets')
mkdirSync(join(appRoot, 'build'), { recursive: true })
try {
  const result = spawnSync(join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    join(appRoot, 'tests', 'fixtures', 'setup-smoke.mjs'), temporary, application, iconPath, screenshot, progressAssets,
  ], { encoding: 'utf8', windowsHide: true, timeout: 45_000, env: createBackendEnvironment(process.env) })
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const record = result.stdout.split(/\r?\n/u).find(line => line.startsWith('setup-smoke:'))
  assert.notEqual(record, undefined, `${result.stdout}\n${result.stderr}`)
  const expectedPath = join(appRoot, 'tests', 'fixtures', 'setup-smoke.expected.json')
  const snapshot = JSON.parse(record.slice('setup-smoke:'.length))
  if (process.argv.includes('--record')) writeFileSync(expectedPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  assert.deepEqual(snapshot, expected)
  process.stdout.write(`${packaged ? 'packaged' : 'source'} native first-install smoke passed: ${JSON.stringify(expected)}\n`)
} finally {
  removeTreeWithoutFollowingLinks(temporary)
}
