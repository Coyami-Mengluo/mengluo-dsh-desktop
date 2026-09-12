import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { probeRegistryVersion, describeRegistryVersion } from '../src/registry-probe.mjs'
import { translateMessage } from '../assets/i18n.js'

const version = '0.1.5-rc.2'
const metadata = { name: '@deepseek-ai/dsh', version, dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } }
const response = value => new Response(JSON.stringify(value))
const probe = fetch => probeRegistryVersion({ fetch, source: 'npmmirror', version, signal: new AbortController().signal })

describe('bounded read-only mirror version checks', () => {
  it('only requests allowlisted exact-version metadata and compares the official digest', async () => {
    const calls = []
    const result = await probe(async (url, init) => { calls.push([url, init]); return response(metadata) })
    assert.deepEqual(result, { status: 'synced', version })
    assert.deepEqual(calls.map(([url]) => url), [
      `https://registry.npmjs.org/@deepseek-ai%2Fdsh/${version}`,
      `https://registry.npmmirror.com/@deepseek-ai%2Fdsh/${version}`,
    ])
    for (const [, init] of calls) {
      assert.equal(init.redirect, 'error')
      assert.equal(init.method, 'GET')
      assert.ok(init.signal instanceof AbortSignal)
      assert.deepEqual(init.headers, { Accept: 'application/json' })
    }
  })

  it('distinguishes unsynchronized, mismatched and unknown metadata without choosing a fallback version', async () => {
    for (const [expected, reply] of [
      ['missing', () => new Response('', { status: 404 })],
      ['mismatch', () => response({ ...metadata, dist: { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` } })],
      ['unknown', () => response({ ...metadata, version: '0.1.5-rc.1' })],
      ['unknown', () => response({ ...metadata, name: 'unrelated' })],
      ['unknown', () => new Response('invalid json')],
      ['unknown', () => new Response('', { status: 429 })],
      ['unknown', () => { throw new Error('private diagnostic') }],
    ]) {
      assert.deepEqual(await probe(async url => url.includes('npmmirror') ? reply() : response(metadata)), { status: expected, version })
    }
    assert.deepEqual(await probe(async url => url.includes('npmjs') ? new Response('', { status: 404 }) : response(metadata)), { status: 'unknown', version })
  })

  it('bounds declared and streaming response sizes, and observes cancellation', async () => {
    const replies = [
      () => new Response('{}', { headers: { 'Content-Length': '1048577' } }),
      () => new Response(' '.repeat(1048577)),
      () => new Response('{}'),
    ]
    for (const reply of replies) assert.equal((await probe(async () => reply())).status, 'unknown')
    const abort = new AbortController()
    abort.abort()
    const result = await probeRegistryVersion({ version, source: 'npmmirror', signal: abort.signal,
      fetch: async (_url, options) => { options.signal.throwIfAborted() },
    })
    assert.equal(result.status, 'unknown')
  })

  it('uses one official request and rejects malformed version selectors before any request', async () => {
    let calls = 0
    const fetch = async () => { calls++; return response(metadata) }
    assert.deepEqual(await probeRegistryVersion({ fetch, source: 'official', version }), { status: 'official', version })
    assert.equal(calls, 1)
    for (const invalid of ['../file', 'https://example.invalid', 'latest', {}, '1.2.3\n']) {
      assert.equal((await probeRegistryVersion({ fetch, source: 'npmmirror', version: invalid })).status, 'unknown')
    }
    assert.equal((await probeRegistryVersion({ fetch, source: 'npmmirror' })).status, 'not-selected')
    assert.equal(calls, 1)
    await assert.rejects(probeRegistryVersion({ fetch, source: 'https://example.invalid', version }))
  })

  it('localizes every synchronization outcome without reflecting remote text', () => {
    for (const status of ['not-selected', 'synced', 'official', 'missing', 'mismatch', 'unknown']) {
      const description = describeRegistryVersion({ status, ...(status === 'not-selected' ? {} : { version }) })
      const translated = translateMessage(description, 'en')
      assert.doesNotMatch(translated, /\p{Script=Han}/u)
      if (status !== 'not-selected') assert.ok(translated.includes(version))
    }
  })
})
