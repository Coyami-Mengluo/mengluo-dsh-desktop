import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBackendReadiness } from '../src/backend-readiness.mjs'

describe('supervised backend readiness', () => {
  it('does not complete at spawn/port discovery, and settles only once at renderer readiness', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let completed = false, timeouts = 0
    const launch = createBackendReadiness({ timeoutMs: 500, onTimeout: () => timeouts++ })
    void launch.promise.then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    assert.equal(launch.ready(), true)
    await launch.promise
    assert.equal(completed, true)
    assert.equal(launch.fail(), false)
    t.mock.timers.tick(1000)
    assert.equal(timeouts, 0)
  })

  it('contains failure when ordinary startup has no promise consumer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let timeouts = 0
    const launch = createBackendReadiness({ timeoutMs: 500, onTimeout: () => timeouts++ })
    const error = new Error('stopped before renderer ready')
    assert.equal(launch.fail(error), true)
    await assert.rejects(launch.promise, error)
    assert.equal(launch.ready(), false)
    t.mock.timers.tick(1000)
    assert.equal(timeouts, 0)
  })

  it('bounds renderer loading and cannot let an old launch complete a new one', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let timeouts = 0
    const old = createBackendReadiness({ timeoutMs: 500 })
    const next = createBackendReadiness({ timeoutMs: 500, onTimeout: () => timeouts++ })
    old.fail()
    assert.equal(old.ready(), false)
    t.mock.timers.tick(500)
    await assert.rejects(next.promise, /readiness timed out/u)
    assert.equal(timeouts, 1)
    assert.equal(next.ready(), false)
    t.mock.timers.tick(500)
    assert.equal(timeouts, 1)
  })
})
