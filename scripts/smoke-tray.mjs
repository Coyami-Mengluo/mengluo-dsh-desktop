import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { createBackendEnvironment } from '../src/runtime.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'mengluo-tray-smoke-'))
const packaged = process.argv.includes('--packaged')
const moduleRoot = packaged
  ? resolve(appRoot, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'src')
  : join(appRoot, 'src')
const electron = join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const iconPath = packaged
  ? resolve(appRoot, 'dist', 'win-unpacked', 'resources', 'app.asar', 'assets', 'icon.png')
  : join(appRoot, 'assets', 'icon.png')
const fixture = join(appRoot, 'tests', 'fixtures', 'tray-smoke.mjs')
const expected = JSON.parse(readFileSync(join(appRoot, 'tests', 'fixtures', 'tray-smoke.expected.json'), 'utf8'))

try {
  const result = spawnSync(electron, [fixture, temporary, moduleRoot, iconPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: createBackendEnvironment(process.env),
  })
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const record = result.stdout.split(/\r?\n/u).find(line => line.startsWith('tray-smoke:'))
  assert.notEqual(record, undefined, `tray smoke emitted no snapshot: ${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(record.slice('tray-smoke:'.length)), expected)
  process.stdout.write(`${packaged ? 'packaged' : 'source'} native tray smoke passed: ${JSON.stringify(expected)}\n`)
} finally {
  removeTreeWithoutFollowingLinks(temporary)
}
