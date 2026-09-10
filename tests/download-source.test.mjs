import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DOWNLOAD_SOURCES, readDownloadPreferences, resolveDownloadSource, writeDownloadPreferences } from '../src/download-source.mjs'

const directories = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'mengluo-download-settings-'))
  directories.push(path)
  return path
}

describe('Harness download source preferences', () => {
  it('only allows two immutable fixed HTTPS registry choices', () => {
    assert.ok(Object.isFrozen(DOWNLOAD_SOURCES))
    for (const choice of DOWNLOAD_SOURCES) assert.ok(Object.isFrozen(choice))
    assert.equal(resolveDownloadSource().id, 'official')
    assert.equal(resolveDownloadSource('npmmirror').registry, 'https://registry.npmmirror.com/')
    for (const value of [null, {}, 1, '', 'https://registry.npmmirror.com/', '../official', 'OFFICIAL', 'official\n']) {
      assert.throws(() => resolveDownloadSource(value), /unsupported/u)
    }
  })

  it('saves the selected source atomically in app user data without touching npm settings', () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, '.npmrc'), 'registry=https://example.invalid/\n')
    assert.deepEqual(readDownloadPreferences(root), { source: 'official' })
    assert.deepEqual(writeDownloadPreferences(root, { source: 'npmmirror' }), { source: 'npmmirror' })
    assert.deepEqual(readDownloadPreferences(root), { source: 'npmmirror' })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'download-settings.json'), 'utf8')), { source: 'npmmirror' })
    writeDownloadPreferences(root, { source: 'official' })
    assert.deepEqual(readDownloadPreferences(root), { source: 'official' })
    assert.equal(readFileSync(join(root, '.npmrc'), 'utf8'), 'registry=https://example.invalid/\n')
    assert.deepEqual(readdirSync(root).sort(), ['.npmrc', 'download-settings.json'])
  })

  it('recovers corrupt persisted preferences to official but refuses invalid writes', () => {
    const root = temporaryDirectory()
    for (const value of ['not-json', '{"source":"evil"}', '{"source":"npmmirror","token":"no"}', 'null', 'x'.repeat(5_000)]) {
      writeFileSync(join(root, 'download-settings.json'), value)
      assert.deepEqual(readDownloadPreferences(root), { source: 'official' })
    }
    for (const value of [undefined, null, [], {}, { source: undefined }, { source: 'evil' }, { source: 'official', registry: 'https://example.invalid' }]) {
      assert.throws(() => writeDownloadPreferences(root, value), /invalid|unsupported/u)
    }
  })

  it('refuses a non-file settings target', () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'download-settings.json'))
    assert.deepEqual(readDownloadPreferences(root), { source: 'official' })
    assert.throws(() => writeDownloadPreferences(root, { source: 'npmmirror' }), /regular file/u)
  })

  it('never follows a settings symlink', { skip: process.platform === 'win32' }, () => {
    const root = temporaryDirectory()
    const outside = join(temporaryDirectory(), 'settings.json')
    writeFileSync(outside, '{"source":"npmmirror"}')
    symlinkSync(outside, join(root, 'download-settings.json'))
    assert.deepEqual(readDownloadPreferences(root), { source: 'official' })
    assert.throws(() => writeDownloadPreferences(root, { source: 'official' }), /regular file/u)
    assert.equal(readFileSync(outside, 'utf8'), '{"source":"npmmirror"}')
  })
})
