import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBackendEnvironment } from '../src/runtime.mjs'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'

const application = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'mengluo-versions-smoke-'))
try {
  for (const phase of ['switch', 'resume', 'fallback']) {
    const result = spawnSync(join(application, 'node_modules', 'electron', 'dist', 'electron.exe'), [
      join(application, 'tests', 'fixtures', 'versions-smoke.mjs'), temporary, application, phase,
    ], { encoding: 'utf8', windowsHide: true, timeout: 45_000, env: createBackendEnvironment(process.env) })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${phase}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, new RegExp(`versions-smoke:${phase}:passed`, 'u'))
    process.stdout.write(result.stdout)
  }
} finally { removeTreeWithoutFollowingLinks(temporary) }
