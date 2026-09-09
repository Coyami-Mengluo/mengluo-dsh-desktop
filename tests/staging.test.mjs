import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { assertMaterializedTree, removeStagingTree } from '../scripts/staging.mjs'

describe('desktop runtime staging', () => {
  it('rejects links before electron-builder copies the runtime', { skip: process.platform !== 'win32' }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-audit-'))
    const external = join(temporary, 'external')
    const staging = join(temporary, 'staging')
    mkdirSync(external)
    mkdirSync(staging)
    writeFileSync(join(staging, 'ordinary.txt'), 'keep')
    assert.doesNotThrow(() => { assertMaterializedTree(staging) })
    symlinkSync(external, join(staging, 'junction'), 'junction')

    try {
      assert.throws(
        () => { assertMaterializedTree(staging) },
        /desktop runtime contains a filesystem link/,
      )
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('unlinks a nested junction without touching its target', { skip: process.platform !== 'win32' }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-stage-'))
    const external = join(temporary, 'external')
    const staging = join(temporary, 'staging')
    const sentinel = join(external, 'sentinel.txt')
    mkdirSync(external)
    mkdirSync(staging)
    writeFileSync(sentinel, 'keep')
    writeFileSync(join(staging, 'ordinary.txt'), 'remove')
    symlinkSync(external, join(staging, 'junction'), 'junction')

    try {
      removeStagingTree(staging)
      assert.equal(existsSync(staging), false)
      assert.equal(existsSync(sentinel), true)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
