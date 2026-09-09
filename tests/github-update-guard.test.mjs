import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('real release installation smoke refuses to run on a workstation', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '..', 'scripts', 'smoke-github-update.mjs')], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000,
    env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'local' },
  })
  assert.notEqual(result.status, 0)
  if (process.platform === 'win32') assert.match(result.stderr, /Only run in GitHub Actions/u)
})
