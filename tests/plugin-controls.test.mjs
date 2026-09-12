import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

test('the renderer applies a cooldown to its response scope, never an unrelated button', () => {
  const source = readFileSync(new URL('../assets/settings.js', import.meta.url), 'utf8')
  const start = source.indexOf('  function acceptPluginCooldown(')
  const end = source.indexOf('  function pluginView()', start)
  assert.ok(start > 0 && end > start)
  const pluginReplyLimits = {}
  const context = vm.createContext({ pluginReplyLimits,
    pluginDeadline: value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : 0 })
  vm.runInContext(source.slice(start, end), context)
  const until = Date.now() + 40 * 60_000
  assert.equal(context.acceptPluginCooldown({ type: 'plugins-refresh' }, {
    ok: false, rateLimited: true, retryAt: until, rateLimitScope: 'metadata',
  }), true)
  assert.deepEqual(pluginReplyLimits, { metadataUntil: until })
  const refreshUntil = Date.now() + 30_000
  context.acceptPluginCooldown({ type: 'plugins-refresh' }, {
    ok: false, rateLimited: true, retryAt: refreshUntil, rateLimitScope: 'refresh',
  })
  assert.deepEqual(pluginReplyLimits, { metadataUntil: until, refreshUntil })
  assert.equal(context.acceptPluginCooldown({ type: 'plugins-search' }, {
    ok: true, rateLimited: true, retryAt: until,
  }), false)
  assert.equal(context.acceptPluginCooldown({ type: 'plugins-search' }, {
    ok: false, rateLimited: true, retryAt: Infinity,
  }), false)
})
