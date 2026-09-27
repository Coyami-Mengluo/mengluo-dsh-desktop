import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { backendFailureAction } from '../src/backend-failure-policy.mjs'
import { defaultRuntimeState, markRuntimeFailed, markRuntimeReady } from '../src/runtime-store.mjs'

describe('backend failure ownership', () => {
  it('does not interpret expected lifecycle exits as runtime failures', () => {
    for (const flag of ['quitting', 'sessionEnding', 'paused']) {
      for (const ready of [true, false]) {
        assert.equal(backendFailureAction({ [flag]: true, ready, code: 1 }), 'ignore')
      }
    }
  })

  it('handles the observed Windows shutdown code even before a session-end event or readiness', () => {
    for (const code of [1073807364, 0xc000013a, -1073741510]) {
      for (const ready of [false, true]) {
        assert.equal(backendFailureAction({ platform: 'win32', code, signal: null, ready }), 'interrupted')
      }
    }
    assert.equal(backendFailureAction({ platform: 'linux', code: 1073807364 }), 'startup-failure')
  })

  it('preserves deliberate process/renderer termination without treating access violations as shutdown', () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(backendFailureAction({ signal }), 'interrupted')
    assert.equal(backendFailureAction({ rendererReason: 'killed' }), 'interrupted')
    for (const code of [1, 0xc0000005, -1073741819]) {
      assert.equal(backendFailureAction({ platform: 'win32', code }), 'startup-failure')
    }
    assert.equal(backendFailureAction({ rendererReason: 'crashed' }), 'startup-failure')
  })

  it('never permanently rejects an already-ready version due to a later exit or renderer crash', () => {
    for (const failure of [{ code: 0 }, { code: 1 }, { signal: 'SIGKILL' }, { rendererReason: 'crashed' }, { rendererReason: 'oom' }]) {
      assert.equal(backendFailureAction({ ...failure, ready: true }), 'stopped')
    }
  })

  it('keeps selected and separately prepared versions, while a genuine new-slot boot failure can fall back', () => {
    const previous = { ...defaultRuntimeState(), activeVersion: '0.1.1-rc.2', pendingVersion: '0.1.5-rc.2' }
    const runtime = { source: 'managed', version: '0.1.5-rc.2' }
    const ready = { ...markRuntimeReady(previous, runtime), pendingVersion: '0.1.7-rc.2' }
    const unchanged = structuredClone(ready)
    const apply = (state, context) => backendFailureAction(context) === 'startup-failure' ? markRuntimeFailed(state, runtime) : state
    for (const failure of [{ code: 1073807364 }, { code: 1 }, { rendererReason: 'crashed' }, { sessionEnding: true }]) {
      assert.deepEqual(apply(ready, { ...failure, platform: 'win32', ready: true }), unchanged)
    }
    assert.deepEqual(apply(previous, { platform: 'win32', code: 1073807364 }), previous)
    const rejected = apply(previous, { platform: 'win32', code: 1 })
    assert.equal(rejected.activeVersion, '0.1.1-rc.2')
    assert.equal(rejected.pendingVersion, undefined)
    assert.deepEqual(rejected.badVersions, ['0.1.5-rc.2'])
  })
})
