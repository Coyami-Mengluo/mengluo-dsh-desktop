import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PluginCatalog, PluginRateLimitError } from '../src/plugin-catalog.mjs'

const START = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEARCH = 'https://api.github.com/search/repositories?q=topic%3Adsh-plugin'
const CORE = 'https://api.github.com/repos/example/plugin'
const NPM = 'https://registry.npmjs.org/plugin/latest'
const directory = { items: [], total_count: 0 }

describe('plugin metadata request protection', () => {
  it('shares one rolling 8/minute budget across search words, pages and refreshes', async () => {
    const f = fixture(() => Response.json(directory))
    await f.catalog.list({ query: 'first' })
    for (let index = 1; index < 7; index++) {
      f.advance(1_000)
      await f.catalog.list({ query: `word${index}`, page: index + 1 })
    }
    f.advance(1_000)
    await f.catalog.list({ query: 'first', refresh: true })
    assert.equal(f.calls.length, 8)
    assert.equal(f.catalog.getRateLimitState().searchUntil, START + MINUTE)
    await rejectsRate(f.catalog.list({ query: 'ninth' }), START + MINUTE)
    await rejectsRate(f.catalog.list({ query: 'first', refresh: true }), START + MINUTE)
    await f.catalog.list({ query: 'first' })
    assert.equal(f.calls.length, 8, 'cache reads and rejected requests spend no dispatches')
    await f.catalog.json(CORE)
    assert.equal(f.calls.length, 9, 'core metadata does not consume the search budget')
    f.set(START + MINUTE - 1)
    await rejectsRate(f.catalog.list({ query: 'boundary' }), START + MINUTE)
    f.advance(1)
    await f.catalog.list({ query: 'boundary' })
    assert.equal(f.calls.length, 10)
    assert.equal(f.catalog.getRateLimitState().searchUntil, START + MINUTE + 1_000)
    f.catalog.dispose()
  })

  it('enforces the one-second dispatch gap and reports zero/empty fields after expiry', async () => {
    const f = fixture(() => Response.json(directory))
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    await f.catalog.list()
    await rejectsRate(f.catalog.list({ query: 'different' }), START + 1_000)
    await rejectsRate(f.catalog.list({ refresh: true }), START + 1_000)
    assert.equal(f.calls.length, 1)
    f.advance(999)
    await rejectsRate(f.catalog.list({ page: 2 }), START + 1_000)
    f.advance(1)
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    await f.catalog.list({ page: 2 })
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('limits core metadata separately to 50 actual requests in a rolling hour', async () => {
    const f = fixture(() => Response.json({}))
    for (let index = 0; index < 50; index++) await f.catalog.json(`${CORE}/${index}`)
    assert.equal(f.catalog.getRateLimitState().metadataUntil, START + HOUR)
    await rejectsRate(f.catalog.json(`${CORE}/extra`), START + HOUR)
    await rejectsRate(f.catalog.json(`${CORE}/0`, { refresh: true }), START + HOUR)
    await f.catalog.json(`${CORE}/0`)
    await f.catalog.json(SEARCH)
    await f.catalog.json(NPM)
    assert.equal(f.calls.length, 52)
    f.advance(HOUR)
    await f.catalog.json(`${CORE}/extra`)
    assert.equal(f.calls.length, 53)
    f.catalog.dispose()
  })

  it('allows five-minute cached data during server cooldown and never exempts refresh', async () => {
    const f = fixture((_url, _init, count) => count === 1 ? Response.json(directory)
      : Response.json({ message: 'API rate limit exceeded: private data' }, { status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((START + 10 * MINUTE) / 1_000) } }))
    await f.catalog.list()
    f.advance(1_000)
    await rejectsRate(f.catalog.list({ query: 'other' }), START + 10 * MINUTE)
    await f.catalog.list()
    await rejectsRate(f.catalog.list({ refresh: true }), START + 10 * MINUTE)
    f.set(START + 5 * MINUTE - 1)
    await f.catalog.list()
    f.advance(1)
    await rejectsRate(f.catalog.list(), START + 10 * MINUTE)
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('honors exhausted successful-response quota before a subsequent fetch', async () => {
    for (const url of [SEARCH, CORE]) {
      const f = fixture(() => Response.json({}, { headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((START + 2 * MINUTE) / 1_000),
      } }))
      await f.catalog.json(url)
      await f.catalog.json(url)
      await rejectsRate(f.catalog.json(url, { refresh: true }), START + 2 * MINUTE)
      const state = f.catalog.getRateLimitState()
      assert.equal(url === SEARCH ? state.searchUntil : state.metadataUntil, START + 2 * MINUTE)
      assert.equal(url === SEARCH ? state.metadataUntil : state.searchUntil, 0)
      assert.equal(f.calls.length, 1)
      f.catalog.dispose()
    }
  })

  it('honors Retry-After seconds, HTTP dates and the later valid reset deadline', async () => {
    for (const headers of [
      { 'retry-after': '120' },
      { 'retry-after': new Date(START + 2 * MINUTE).toUTCString() },
      { 'retry-after': '10', 'x-ratelimit-reset': String((START + 2 * MINUTE) / 1_000) },
    ]) {
      const f = fixture(() => Response.json({ message: 'private diagnostics' }, { status: 429, headers }))
      await rejectsRate(f.catalog.json(SEARCH), START + 2 * MINUTE)
      await rejectsRate(f.catalog.json(CORE), START + 2 * MINUTE)
      assert.equal(f.catalog.getRateLimitState().metadataUntil, START + 2 * MINUTE)
      assert.equal(f.calls.length, 1)
      f.catalog.dispose()
    }
  })

  it('treats secondary-limit evidence as a GitHub-wide cooldown even with exhausted primary quota', async () => {
    const f = fixture(() => Response.json({ message: 'You have exceeded a secondary rate limit. secret' }, {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '90' },
    }))
    await rejectsRate(f.catalog.json(CORE), START + 90_000)
    await rejectsRate(f.catalog.list(), START + 90_000)
    assert.equal(f.calls.length, 1)
    assert.equal(f.catalog.getRateLimitState().searchUntil, START + 90_000)
    f.catalog.dispose()
  })

  it('rounds fractional deadlines up for the integer IPC countdown contract', async () => {
    const f = fixture(() => Response.json({}, { status: 429, headers: { 'retry-after': '1.2345' } }))
    await rejectsRate(f.catalog.json(CORE), START + 1235)
    assert.equal(Number.isSafeInteger(f.catalog.getRateLimitState().metadataUntil), true)
    f.catalog.dispose()
  })

  it('recognizes rate-related 403 bodies and valid Retry-After without leaking external messages', async () => {
    for (const [body, headers] of [
      [{ message: 'API rate limit exceeded for secret-ip' }, {}],
      [{ message: 'You triggered an abuse detection mechanism. secret' }, {}],
      [{ message: 'You have exceeded a secondary rate limit. secret' }, { 'x-ratelimit-remaining': '42' }],
      [{ message: 'private diagnostics' }, { 'retry-after': '60' }],
    ]) {
      const f = fixture(() => Response.json(body, { status: 403, headers }))
      await rejectsRate(f.catalog.json(CORE), START + MINUTE)
      await rejectsRate(f.catalog.json(SEARCH), START + MINUTE)
      assert.equal(f.calls.length, 1)
      f.catalog.dispose()
    }
  })

  it('blocks from rate headers while a bounded error body is still arriving', async () => {
    let finishBody
    const f = fixture(() => new Response(new ReadableStream({ start(controller) {
      finishBody = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close() }
    } }), { status: 429, headers: { 'retry-after': '60' } }))
    const pending = f.catalog.json(CORE)
    // Allow fetch headers to arrive without completing the error body.
    await new Promise(resolve => setImmediate(resolve))
    await rejectsRate(f.catalog.json(SEARCH), START + MINUTE)
    assert.equal(f.calls.length, 1)
    finishBody()
    await rejectsRate(pending, START + MINUTE)
    f.advance(MINUTE)
    const second = f.catalog.json(CORE)
    await new Promise(resolve => setImmediate(resolve))
    finishBody()
    await rejectsRate(second, START + 2 * MINUTE)
    f.catalog.dispose()
  })

  it('keeps permission-only 403 responses ordinary even when GitHub reset headers are present', async () => {
    const f = fixture(() => Response.json({ message: 'Resource not accessible by integration: secret' }, {
      status: 403, headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': String((START + HOUR) / 1_000) },
    }))
    await assert.rejects(f.catalog.json(CORE), error => error.code === undefined && /访问被拒绝/u.test(error.message) && !error.message.includes('secret'))
    await assert.rejects(f.catalog.json(CORE), error => error.code === undefined)
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    f.catalog.dispose()
  })

  it('backs off repeatedly for missing, malformed, past and nonfinite retry headers', async () => {
    for (const headers of [{}, { 'retry-after': '-1', 'x-ratelimit-reset': 'bogus' },
      { 'retry-after': '999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999' },
      { 'retry-after': new Date(START - MINUTE).toUTCString(), 'x-ratelimit-reset': String((START - MINUTE) / 1_000) },
    ]) {
      const f = fixture(() => Response.json({}, { status: 429, headers }))
      await rejectsRate(f.catalog.json(CORE), START + MINUTE)
      f.advance(MINUTE)
      await rejectsRate(f.catalog.json(CORE), START + 3 * MINUTE)
      f.advance(2 * MINUTE)
      await rejectsRate(f.catalog.json(CORE), START + 7 * MINUTE)
      assert.equal(f.calls.length, 3, 'no automatic retries or pending retry queue')
      f.catalog.dispose()
    }
  })

  it('keeps npm 429 cooldown separate from GitHub and combines its metadata UI deadline', async () => {
    const f = fixture(url => url.startsWith('https://registry.npmjs.org')
      ? Response.json({ message: 'secret' }, { status: 429, headers: { 'retry-after': '180' } })
      : Response.json({}))
    await rejectsRate(f.catalog.json(NPM), START + 3 * MINUTE)
    await rejectsRate(f.catalog.json(`${NPM}?other=1`), START + 3 * MINUTE)
    assert.equal(f.catalog.getRateLimitState().metadataUntil, START + 3 * MINUTE)
    assert.equal(f.catalog.getRateLimitState().searchUntil, 0)
    await f.catalog.json(CORE)
    await f.catalog.json(SEARCH)
    assert.equal(f.calls.length, 3)
    f.catalog.dispose()
  })

  it('does not refund cancelled or failed dispatches, and a cancelled caller cannot cancel a later search', async () => {
    const f = fixture((_url, init, count) => count === 1 ? new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }) : Response.json(directory))
    const controller = new AbortController()
    const pending = f.catalog.list({ signal: controller.signal })
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(pending, /caller cancelled/u)
    await rejectsRate(f.catalog.list({ query: 'newest' }), START + 1_000)
    f.advance(1_000)
    await f.catalog.list({ query: 'newest' })
    assert.equal(f.calls.length, 2)
    assert.equal(f.catalog.requests.size, 0)
    f.catalog.dispose()

    const failed = fixture(() => { throw new Error('network unavailable') })
    await assert.rejects(failed.catalog.list(), /network unavailable/u)
    await rejectsRate(failed.catalog.list(), START + 1_000)
    assert.equal(failed.calls.length, 1)
    failed.catalog.dispose()
  })

  it('rejects pre-aborted requests before dispatch and clears transient state on dispose', async () => {
    const f = fixture(() => Response.json(directory))
    await assert.rejects(f.catalog.list({ signal: AbortSignal.abort(new Error('already cancelled')) }), /already cancelled/u)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    await f.catalog.list()
    f.catalog.dispose()
    assert.equal(f.catalog.requests.size, 0)
    assert.equal(f.catalog.cache.size, 0)
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    await assert.rejects(f.catalog.list(), /已关闭/u)
  })

  it('does not recreate cooldown or cache state when a late response arrives after disposal', async () => {
    let respond
    const f = fixture(() => new Promise(resolve => { respond = resolve }))
    const pending = f.catalog.json(CORE)
    f.catalog.dispose()
    respond(Response.json({}, { status: 429, headers: { 'retry-after': '60' } }))
    await assert.rejects(pending, /已关闭/u)
    assert.deepEqual(f.catalog.getRateLimitState(), emptyState())
    assert.equal(f.catalog.requests.size, 0)
    assert.equal(f.catalog.cache.size, 0)
  })
})

function emptyState() { return { searchUntil: 0, metadataUntil: 0, searchReason: '', metadataReason: '' } }

async function rejectsRate(promise, retryAt) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof PluginRateLimitError)
    assert.equal(error.code, 'PLUGIN_RATE_LIMIT')
    assert.equal(error.retryAt, retryAt)
    assert.ok(Number.isFinite(error.retryAt))
    assert.ok(error.message.length < 80)
    assert.doesNotMatch(error.message, /secret|private|diagnostics|https?:|<script/iu)
    return true
  })
}

function fixture(fetch) {
  let now = START
  const calls = []
  const catalog = new PluginCatalog({ now: () => now, fetch: async (url, init) => {
    calls.push([url, init])
    return fetch(url, init, calls.length)
  } })
  return { catalog, calls, advance: milliseconds => { now += milliseconds }, set: value => { now = value } }
}
