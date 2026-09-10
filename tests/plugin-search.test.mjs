import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { PluginManager } from '../src/plugin-manager.mjs'

const worlds = []
afterEach(() => { for (const world of worlds.splice(0)) { world.manager.dispose(); rmSync(world.root, { recursive: true, force: true }) } })
const entry = name => ({ id: `github:example/${name}`, repo: `example/${name}`, name, author: 'example', sourceUrl: `https://github.com/example/${name}` })
const pageResult = (query, page, items, total = items.length, extra = {}) => ({
  query, page, items, total, hasMore: page < 10 && total > page * 100,
  limitReached: page === 10 && total > 1000, incomplete: false, ...extra,
})

describe('remote plugin search coordination', () => {
  it('searches remotely beyond the default first 100 without filtering README-only matches again', async () => {
    const world = fixture()
    world.catalog.list = async ({ query, page }) => query === ''
      ? pageResult(query, page, Array.from({ length: 100 }, (_, i) => entry(`default-${i}`)), 14000)
      : pageResult(query, page, [entry('readme-only-match')])
    await world.manager.refresh()
    assert.equal(world.manager.getState().catalog.length, 100)
    assert.equal(world.reads, 1)
    assert.equal((await world.manager.handleAction({ type: 'plugins-search', query: '  主题  skin ' })).ok, true)
    const state = world.manager.getState()
    assert.equal(state.query, '主题 skin')
    assert.deepEqual(state.catalog.map(item => item.name), ['readme-only-match'])
    assert.equal(state.total, 1)
    assert.equal(world.reads, 1, 'Typing does not reread/check every installed plugin')
    assert.equal(world.mutations, 0)
  })

  it('appends pages in order, deduplicates case-insensitive repository IDs, and preserves the query', async () => {
    const world = fixture()
    world.catalog.list = async ({ query, page }) => pageResult(query, page,
      page === 1 ? [entry('first'), entry('overlap')] : [entry('OVERLAP'), entry('second')], 150)
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    assert.equal(world.manager.getState().hasMore, true)
    assert.equal((await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })).ok, true)
    assert.deepEqual(world.manager.getState().catalog.map(item => item.name), ['first', 'overlap', 'second'])
    assert.equal(world.manager.getState().page, 2)
    assert.equal(world.manager.getState().hasMore, false)
    assert.equal((await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })).ok, false)
  })

  it('cancels old search and ignores its late success without resetting the latest spinner or list', async () => {
    const world = fixture()
    const old = Promise.withResolvers()
    const next = Promise.withResolvers()
    const signals = []
    world.catalog.list = ({ query, signal }) => { signals.push(signal); return query === 'old' ? old.promise : next.promise }
    const first = world.manager.handleAction({ type: 'plugins-search', query: 'old' })
    const second = world.manager.handleAction({ type: 'plugins-search', query: 'new' })
    assert.equal(signals[0].aborted, true)
    old.resolve(pageResult('old', 1, [entry('stale')]))
    assert.equal((await first).ok, true, 'Superseded requests must not trigger a failure toast')
    assert.equal(world.manager.getState().query, 'new')
    assert.equal(world.manager.getState().catalogLoading, true)
    assert.equal(world.manager.getState().catalog.length, 0)
    next.resolve(pageResult('new', 1, [entry('current')]))
    await second
    assert.equal(world.manager.getState().catalogLoading, false)
    assert.equal(world.manager.getState().catalog[0].name, 'current')
  })

  it('ignores a stale page failure after a new query finishes', async () => {
    const world = fixture()
    const oldPage = Promise.withResolvers()
    world.catalog.list = ({ query, page }) => query === 'old' && page === 2 ? oldPage.promise
      : Promise.resolve(pageResult(query, page, [entry(query)], query === 'old' ? 200 : 1))
    await world.manager.handleAction({ type: 'plugins-search', query: 'old' })
    const pending = world.manager.handleAction({ type: 'plugins-more', query: 'old' })
    await world.manager.handleAction({ type: 'plugins-search', query: 'new' })
    oldPage.reject(new Error('old request failed'))
    await pending
    assert.equal(world.manager.getState().catalogError, '')
    assert.equal(world.manager.getState().loadingMore, false)
    assert.equal(world.manager.getState().page, 1)
    assert.deepEqual(world.manager.getState().catalog.map(item => item.name), ['new'])
  })

  it('preserves a failed next page and retries exactly that page without duplicate requests', async () => {
    const world = fixture()
    const next = Promise.withResolvers()
    const calls = []
    world.catalog.list = ({ query, page }) => { calls.push({ query, page }); return page === 1
      ? Promise.resolve(pageResult(query, page, [entry('first')], 200)) : next.promise }
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    const a = world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    const b = world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    assert.equal(calls.length, 2)
    next.reject(new Error('network failed with secret diagnostic'))
    assert.equal((await a).ok, false)
    assert.equal((await b).ok, false)
    let state = world.manager.getState()
    assert.equal(state.page, 1)
    assert.equal(state.hasMore, true)
    assert.equal(state.catalog.length, 1)
    assert.doesNotMatch(state.catalogError, /secret diagnostic/u)
    world.catalog.list = async ({ query, page }) => { assert.equal(page, 2); return pageResult(query, page, [entry('second')], 200) }
    await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    state = world.manager.getState()
    assert.equal(state.catalogError, '')
    assert.equal(state.page, 2)
    assert.equal(state.catalog.length, 2)
  })

  it('refreshes the active query from page one and retains the previous list on refresh failure', async () => {
    const world = fixture()
    const calls = []
    world.catalog.list = async ({ query, page, refresh }) => { calls.push({ query, page, refresh }); return pageResult(query, page, [entry(`item-${page}`)], 300) }
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    await world.manager.handleAction({ type: 'plugins-refresh' })
    assert.deepEqual(calls.at(-1), { query: 'skin', page: 1, refresh: true })
    assert.equal(world.manager.getState().catalog.length, 1)
    world.catalog.list = async () => { throw new Error('offline') }
    assert.equal((await world.manager.handleAction({ type: 'plugins-refresh' })).ok, false)
    assert.equal(world.manager.getState().catalog[0].name, 'item-1')
    assert.ok(world.manager.getState().catalogError)
    assert.equal((await world.manager.handleAction({ type: 'plugins-search', query: 'new' })).ok, false)
    assert.equal(world.manager.getState().catalog.length, 0, 'New query failures cannot show old entries as new matches')
    assert.equal(world.manager.getState().query, 'new')
  })

  it('does not let an initial inventory/catalog refresh overwrite a later search', async () => {
    const world = fixture()
    const initial = Promise.withResolvers()
    world.catalog.list = ({ query, page }) => query === '' ? initial.promise : Promise.resolve(pageResult(query, page, [entry('matched')]))
    const pending = world.manager.refresh()
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    initial.resolve(pageResult('', 1, [entry('default')]))
    await pending
    assert.equal(world.manager.getState().query, 'skin')
    assert.equal(world.manager.getState().catalog[0].name, 'matched')
  })

  it('rejects stale page requests and malformed queries before network access', async () => {
    const world = fixture()
    for (const query of [null, undefined, [], 12, 'x'.repeat(101), 'topic:unrelated', 'a\nb', 'foo OR bar', '"escape"']) {
      assert.equal((await world.manager.handleAction({ type: 'plugins-search', query })).ok, false)
    }
    await world.manager.handleAction({ type: 'plugins-search', query: 'current' })
    const count = world.requests.length
    assert.equal((await world.manager.handleAction({ type: 'plugins-more', query: 'previous' })).ok, false)
    assert.equal(world.requests.length, count)
    assert.equal(count, 1)
  })

  it('respects the ten-page GitHub window without silently truncating the renderer at 500', async () => {
    const world = fixture()
    world.catalog.list = async ({ query, page }) => pageResult(query, page,
      Array.from({ length: 100 }, (_, index) => entry(`item-${page}-${index}`)), 1500)
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    for (let page = 2; page <= 10; page += 1) await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    const state = world.manager.getState()
    assert.equal(state.catalog.length, 1000)
    assert.equal(state.page, 10)
    assert.equal(state.total, 1500)
    assert.equal(state.limitReached, true)
    assert.equal(state.hasMore, false)
    assert.equal((await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })).ok, false)
  })

  it('retains an incomplete-search warning from earlier pages until a fresh first page succeeds', async () => {
    const world = fixture()
    world.catalog.list = async ({ query, page }) => pageResult(query, page, [entry(`page-${page}`)], 200, { incomplete: page === 1 })
    await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })
    assert.equal(world.manager.getState().incomplete, true)
    world.catalog.list = async ({ query, page }) => pageResult(query, page, [entry('fresh')], 1)
    await world.manager.handleAction({ type: 'plugins-refresh' })
    assert.equal(world.manager.getState().incomplete, false)
  })

  it('rejects a mismatched result envelope and cancels in-flight searches on dispose', async () => {
    const world = fixture()
    world.catalog.list = async () => pageResult('wrong', 1, [entry('wrong')])
    assert.equal((await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })).ok, false)
    assert.equal(world.manager.getState().catalog.length, 0)
    const pending = Promise.withResolvers()
    let signal
    world.catalog.list = options => { signal = options.signal; return pending.promise }
    const search = world.manager.handleAction({ type: 'plugins-search', query: 'pending' })
    const changes = world.changes
    world.manager.dispose()
    assert.equal(signal.aborted, true)
    pending.resolve(pageResult('pending', 1, [entry('late')]))
    await search
    assert.equal(world.changes, changes)
    assert.equal(world.manager.catalogItems.length, 0)
  })

  it('does not mutate or allow a profile operation while catalog results are being replaced', async () => {
    const world = fixture()
    const pending = Promise.withResolvers()
    world.catalog.list = () => pending.promise
    const search = world.manager.handleAction({ type: 'plugins-search', query: 'skin' })
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: entry('untrusted').id })).ok, false)
    assert.equal(world.mutations, 0)
    pending.resolve(pageResult('skin', 1, []))
    await search
  })

  it('allows read-only search during a plugin mutation without releasing the operation lock', async () => {
    const world = fixture()
    world.manager.busy = true
    assert.equal((await world.manager.handleAction({ type: 'plugins-search', query: 'skin' })).ok, true)
    assert.equal(world.manager.isBusy(), true)
    assert.equal(world.manager.getState().query, 'skin')
    assert.equal(world.mutations, 0)
    assert.equal(world.reads, 0)
    assert.equal((await world.manager.handleAction({ type: 'plugins-more', query: 'skin' })).ok, true)
    assert.equal(world.manager.isBusy(), true)
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: entry('default').id })).ok, false)
  })
})

function fixture() {
  const world = { root: mkdtempSync(join(tmpdir(), 'mengluo-plugin-search-')), requests: [], reads: 0, mutations: 0, changes: 0 }
  world.catalog = {
    list: async options => { world.requests.push(options); return pageResult(options.query, options.page, [entry('default')], 200) },
    checkUpdate: async () => { throw new Error('Unexpected installed-update query') }, dispose: () => {},
  }
  world.manager = new PluginManager({
    userData: world.root, catalog: world.catalog, getRuntime: () => ({ version: 'fixture' }), isBlocked: () => false,
    readInstalled: () => { world.reads += 1; return { plugins: [] } },
    runOperation: () => { world.mutations += 1; throw new Error('Unexpected mutation') },
    onChanged: () => { world.changes += 1 },
  })
  worlds.push(world)
  return world
}
