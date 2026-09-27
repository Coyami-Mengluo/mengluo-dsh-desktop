import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { createBackendEnvironment } from '../src/runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const modes = ['ready-interrupted', 'ready-crash', 'early-interrupted', 'early-crash', 'ready-renderer-crash', 'child-before-session', 'session-first-busy']
const requested = process.argv[2]
assert.ok(requested === undefined || modes.includes(requested), 'Unknown lifecycle smoke scenario')
if (process.platform !== 'win32') {
  process.stdout.write('lifecycle-smoke:skipped (Windows native integration)\n')
} else for (const mode of requested ? [requested] : modes) {
  const temporary = mkdtempSync(join(tmpdir(), 'mengluo-lifecycle-smoke-'))
  try {
    const result = spawnSync(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
      join(root, 'tests', 'fixtures', 'lifecycle-smoke.mjs'), temporary, root, mode,
    ], { encoding: 'utf8', windowsHide: true, timeout: 35_000, env: createBackendEnvironment(process.env) })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${mode}\n${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.includes(`lifecycle-smoke:passed ${mode}`))
    process.stdout.write(result.stdout)
  } finally { removeTreeWithoutFollowingLinks(temporary) }
}
