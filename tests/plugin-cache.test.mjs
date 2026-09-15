import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PluginCatalog } from '../src/plugin-catalog.mjs'

const START = 1_800_000_000_000
const MINUTE = 60_000
const API = 'https://api.github.com/repos/example/plugin'
const NPM = 'https://registry.npmjs.org/plugin/latest'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const installed = { name: 'example-plugin', source: 'github', repo: 'example/plugin', ref: 'main', commit: A }

describe('plugin cache request counts and freshness', () => {
  it('reuses mutable metadata for 15 minutes, but a manual check still queries the branch', async () => {
    const f = fixture(() => ({ sha: A }))
    for (let index = 0; index < 15; index++) {
      assert.equal((await f.catalog.checkUpdate(installed)).status, 'current')
      f.advance(MINUTE)
    }
    assert.equal(f.calls.length, 1)
    await f.catalog.checkUpdate(installed)
    assert.equal(f.calls.length, 2, 'expired branch metadata must be fetched')
    await f.catalog.checkUpdate(installed, { refresh: true })
    assert.equal(f.calls.length, 3, 'manual checks must not silently report cached freshness')
    f.catalog.dispose()
  })

  it('reduces a repeated available-update check from three requests to one without missing new commits', async () => {
    let commit = B
    const f = fixture(url => bundleResponse(url, commit))
    assert.equal((await f.catalog.checkUpdate(installed, { refresh: true })).candidate.commit, B)
    assert.equal(f.calls.length, 3)
    for (let index = 0; index < 5; index++) {
      f.advance(30_000)
      assert.equal((await f.catalog.checkUpdate(installed, { refresh: true })).candidate.commit, B)
    }
    assert.equal(f.calls.length, 8, 'one branch GET per manual check, not three repeated GETs')
    commit = C
    assert.equal((await f.catalog.checkUpdate(installed, { refresh: true })).candidate.commit, C)
    assert.equal(f.calls.length, 11, 'a new SHA requires its own manifest and patch validation')
    const before = f.calls.length
    const error = new Error('offline before final source check')
    f.respond(() => { throw error })
    await assert.rejects(f.catalog.checkUpdate(installed, { refresh: true }), error)
    assert.equal(f.calls.length, before + 1, 'cached manifests cannot bypass final branch validation')
    f.catalog.dispose()
  })

  it('reuses exact-commit files only, with a 24-hour session TTL and independent cache values', async () => {
    const f = fixture(() => ({ path: 'package.json' }))
    const url = `${API}/contents/package.json?ref=${B}`
    const first = await f.catalog.json(url)
    first.path = 'changed by caller'
    f.advance(24 * 60 * MINUTE - 1)
    assert.equal((await f.catalog.json(url, { refresh: true })).path, 'package.json')
    assert.equal(f.calls.length, 1)
    f.advance(1)
    await f.catalog.json(url, { refresh: true })
    assert.equal(f.calls.length, 2)
    for (const mutable of [`${API}/contents/package.json?ref=main`, `${API}/contents/package.json`,
      `${API}/commits/main`, API, NPM, `${API}/contents/package.json?ref=${B}&extra=1`]) {
      const before = f.calls.length
      await f.catalog.json(mutable)
      await f.catalog.json(mutable, { refresh: true })
      assert.equal(f.calls.length, before + 2, mutable)
    }
    f.catalog.dispose()
  })

  it('revalidates repository availability before an install even when all candidate files are cached', async () => {
    let archived = false
    const f = fixture(url => url === API ? {
      full_name: 'example/plugin', owner: { login: 'example' }, default_branch: 'main',
      private: false, archived, disabled: false, fork: false,
    } : bundleResponse(url, B))
    assert.equal((await f.catalog.resolve('github:example/plugin', { refresh: true })).commit, B)
    assert.equal(f.calls.length, 4)
    assert.equal((await f.catalog.resolve('github:example/plugin', { refresh: true })).commit, B)
    assert.equal(f.calls.length, 6, 'repository and branch are fresh; only SHA-pinned files are reused')
    archived = true
    await assert.rejects(f.catalog.resolve('github:example/plugin', { refresh: true }), /仓库不可用/u)
    assert.equal(f.calls.length, 7)
    f.catalog.dispose()
  })

  it('never lets cached npm latest metadata hide a new version from a manual check', async () => {
    let version = '1.0.0'
    const f = fixture(() => ({ name: 'plugin', version, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const plugin = { name: 'plugin', version: '1.0.0', source: 'npm' }
    assert.equal((await f.catalog.checkUpdate(plugin)).status, 'current')
    version = '1.1.0'
    assert.equal((await f.catalog.checkUpdate(plugin, { refresh: true })).candidate.version, '1.1.0')
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('joins identical concurrent metadata requests and clones each result', async () => {
    const response = Promise.withResolvers()
    const f = fixture(() => response.promise)
    const requests = Array.from({ length: 12 }, () => f.catalog.json(API, { refresh: true }))
    assert.equal(f.calls.length, 1)
    assert.equal(f.catalog.rateLimiter.metadataDispatches.length, 1)
    response.resolve({ nested: { value: 1 } })
    const values = await Promise.all(requests)
    values[0].nested.value = 9
    assert.equal(values[1].nested.value, 1)
    assert.equal((await f.catalog.json(API)).nested.value, 1)
    assert.equal(f.catalog.inflight.size, 0)
    assert.equal(f.catalog.requests.size, 0)
    f.catalog.dispose()
  })

  it('joins normalized search pages without spending the search gap twice', async () => {
    const response = Promise.withResolvers()
    const f = fixture(() => response.promise)
    const one = f.catalog.list({ query: '  theme   blue ' })
    const two = f.catalog.list({ query: 'theme blue', refresh: true })
    response.resolve({ items: [], total_count: 0 })
    assert.equal((await one).query, (await two).query)
    assert.equal(f.calls.length, 1)
    f.catalog.dispose()
  })

  it('cancels just one consumer while another can complete and cache the shared request', async () => {
    const response = Promise.withResolvers()
    const f = fixture(() => response.promise)
    const controller = new AbortController()
    const one = f.catalog.json(API, { signal: controller.signal })
    const two = f.catalog.json(API, { refresh: true })
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(one, /caller cancelled/u)
    assert.equal(f.calls[0][1].signal.aborted, false)
    response.resolve({ value: 'kept' })
    assert.deepEqual(await two, { value: 'kept' })
    await f.catalog.json(API)
    assert.equal(f.calls.length, 1)
    f.catalog.dispose()
  })

  it('abandons all-cancelled work without letting its late response replace a newer request', async () => {
    const responses = [Promise.withResolvers(), Promise.withResolvers()]
    const f = fixture((_url, _options, count) => responses[count - 1].promise)
    const controller = new AbortController()
    const old = f.catalog.json(API, { signal: controller.signal })
    const abandoned = f.catalog.inflight.get(API).promise
    controller.abort(new Error('last caller cancelled'))
    await assert.rejects(old, /last caller cancelled/u)
    assert.equal(f.calls[0][1].signal.aborted, true)
    const current = f.catalog.json(API)
    responses[0].resolve({ value: 'old' })
    await assert.rejects(abandoned, /last caller cancelled/u)
    assert.equal(f.catalog.inflight.size, 1)
    assert.equal(f.catalog.cache.size, 0)
    responses[1].resolve({ value: 'new' })
    assert.deepEqual(await current, { value: 'new' })
    assert.deepEqual(await f.catalog.json(API), { value: 'new' })
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('shares errors without caching failures or leaving a retry queue', async () => {
    const response = Promise.withResolvers()
    const f = fixture(() => response.promise)
    const checks = [f.catalog.json(API), f.catalog.json(API)]
    response.resolve(new Response('{}', { status: 404 }))
    const results = await Promise.allSettled(checks)
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.equal(f.calls.length, 1)
    assert.equal(f.catalog.cache.size, 0)
    assert.equal(f.catalog.inflight.size, 0)
    f.respond(() => ({}))
    await f.catalog.json(API)
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('disposes all joined consumers without allowing a late response to refill the cache', async () => {
    const response = Promise.withResolvers()
    const f = fixture(() => response.promise)
    const pending = [f.catalog.json(API), f.catalog.json(API)]
    f.catalog.dispose()
    response.resolve({ value: 'too late' })
    const results = await Promise.allSettled(pending)
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.equal(f.calls.length, 1)
    assert.equal(f.catalog.cache.size, 0)
    assert.equal(f.catalog.cacheBytes, 0)
    assert.equal(f.catalog.inflight.size, 0)
    assert.equal(f.catalog.requests.size, 0)
  })

  it('cannot dispatch through server cooldown just because a refresh requested fresh data', async () => {
    const f = fixture(() => Response.json({}, { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((START + 44 * MINUTE) / 1000),
    } }))
    for (let index = 0; index < 10; index++) {
      await assert.rejects(f.catalog.json(API, { refresh: true }), { code: 'PLUGIN_RATE_LIMIT' })
      f.advance(30_000)
    }
    assert.equal(f.calls.length, 1)
    f.catalog.dispose()
  })

  it('evicts least-recently-used JSON within both entry and byte bounds', async () => {
    const f = fixture(() => ({ value: 'x'.repeat(1_500_000) }))
    for (let index = 0; index < 5; index++) await f.catalog.json(`${API}/${index}`)
    await f.catalog.json(`${API}/0`)
    await f.catalog.json(`${API}/5`)
    assert.equal(f.catalog.cache.has(`${API}/0`), true)
    assert.equal(f.catalog.cache.has(`${API}/1`), false)
    assert.ok(f.catalog.cacheBytes <= 8 * 1024 * 1024)
    f.catalog.dispose()
    assert.equal(f.catalog.cacheBytes, 0)
    const g = fixture(() => ({}))
    for (let index = 0; index < 257; index++) await g.catalog.json(`${NPM}?id=${index}`)
    assert.equal(g.catalog.cache.size, 256)
    assert.equal(g.catalog.cache.has(`${NPM}?id=0`), false)
    g.catalog.dispose()
  })
})

function bundleResponse(url, commit) {
  if (url.includes('/commits/')) return { sha: commit }
  if (url.includes('/contents/package.json')) {
    const bytes = Buffer.from(JSON.stringify({ name: 'example-plugin', version: '1.0.1', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    return { type: 'file', path: 'package.json', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }
  }
  if (url.includes('/contents/cordis.patch.yml')) return { type: 'file', path: 'cordis.patch.yml' }
  throw new Error(`unexpected fixture URL: ${url}`)
}

function fixture(respond = () => ({})) {
  let now = START
  const calls = []
  const catalog = new PluginCatalog({ now: () => now, fetch: async (url, options) => {
    calls.push([url, options])
    const value = await respond(url, options, calls.length)
    return value instanceof Response ? value : Response.json(value)
  } })
  return { catalog, calls, advance: milliseconds => { now += milliseconds }, respond: next => { respond = next } }
}
