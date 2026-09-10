import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PluginCatalog, PLUGIN_CATALOG_SOURCE, normalizePluginSearchQuery } from '../src/plugin-catalog.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const repository = {
  full_name: 'example/dsh-bundle', owner: { login: 'example' }, default_branch: 'main',
  description: 'Community bundle', private: false, archived: false, disabled: false, fork: false,
  topics: ['dsh-plugin', 'theme'], html_url: 'https://attacker.invalid/ignored',
}
const manifest = { name: '@example/dsh-bundle', version: '1.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }

describe('read-only plugin catalog', () => {
  it('fetches a fixed topic directory and exposes only bounded normalized metadata', async () => {
    const f = fixture({ items: [repository, repository, { ...repository, topics: ['other-topic'], full_name: 'example/unrelated' }, { ...repository, full_name: 'other/private', private: true }, { full_name: '../../escape' }], total_count: 999, incomplete_results: false })
    const result = await f.catalog.list()
    assert.equal(result.items.length, 1)
    assert.equal(result.truncated, true)
    assert.equal(result.total, 999)
    assert.equal(result.query, '')
    assert.equal(result.page, 1)
    assert.equal(result.hasMore, true)
    assert.equal(result.nextPage, 2)
    assert.equal(result.limitReached, false)
    assert.equal(result.incomplete, false)
    assert.equal(result.source, PLUGIN_CATALOG_SOURCE.name)
    assert.deepEqual(result.items[0], {
      id: 'github:example/dsh-bundle', name: 'dsh-bundle', author: 'example', repo: 'example/dsh-bundle', ref: 'main',
      description: 'Community bundle', source: 'github', sourceUrl: 'https://github.com/example/dsh-bundle',
      category: '主题与界面', compatibility: 'unknown',
    })
    const [url, options] = f.calls[0]
    assert.match(url, /^https:\/\/api\.github\.com\/search\/repositories\?q=topic%3Adsh-plugin/u)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.headers.Authorization, undefined)
    f.catalog.dispose()
  })

  it('searches remotely within the required topic, finding a repository absent from the first directory page', async () => {
    const remote = { ...repository, full_name: 'example/rare-plugin', description: 'Does not repeat the README search word' }
    const f = fixture(url => {
      const query = new URL(url).searchParams.get('q')
      return query.includes('"独特主题"')
        ? { items: [remote], total_count: 1, incomplete_results: false }
        : { items: [repository], total_count: 150, incomplete_results: false }
    })
    assert.equal((await f.catalog.list()).items.some(item => item.name === 'rare-plugin'), false)
    const result = await f.catalog.list({ query: '  独特主题  作者/dsh-skin_v1.2  ' })
    assert.equal(result.query, '独特主题 作者/dsh-skin_v1.2')
    assert.equal(result.items[0].name, 'rare-plugin')
    assert.equal(result.total, 1)
    assert.equal(result.hasMore, false)
    assert.equal(result.nextPage, undefined)
    const url = new URL(f.calls[1][0])
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(url.pathname, '/search/repositories')
    assert.equal(url.searchParams.get('q'), 'topic:dsh-plugin archived:false fork:false "独特主题" "作者/dsh-skin_v1.2" in:name,description,readme')
    assert.deepEqual([...url.searchParams.keys()], ['q', 'sort', 'order', 'per_page', 'page'])
    assert.equal(url.searchParams.get('per_page'), '100')
    assert.equal(url.searchParams.get('page'), '1')
    f.catalog.dispose()
  })

  it('reports later pages, incomplete responses and the GitHub 1000-result ceiling separately', async () => {
    const f = fixture(url => {
      const page = Number(new URL(url).searchParams.get('page'))
      return { items: [repository], total_count: 1001, incomplete_results: page === 2 }
    })
    const second = await f.catalog.list({ query: 'theme', page: 2 })
    assert.equal(second.page, 2)
    assert.equal(second.hasMore, true)
    assert.equal(second.nextPage, 3)
    assert.equal(second.incomplete, true)
    assert.equal(second.limitReached, false)
    const last = await f.catalog.list({ query: 'theme', page: 10 })
    assert.equal(last.page, 10)
    assert.equal(last.hasMore, false)
    assert.equal(last.nextPage, undefined)
    assert.equal(last.limitReached, true)
    assert.equal(last.incomplete, false)
    assert.equal(last.truncated, true)
    const g = fixture({ items: [], total_count: 1000, incomplete_results: false })
    assert.equal((await g.catalog.list({ page: 10 })).limitReached, false)
    const h = fixture({ items: [], total_count: 0, incomplete_results: false })
    const empty = await h.catalog.list({ query: 'missing' })
    assert.equal(empty.hasMore, false)
    assert.equal(empty.truncated, false)
    f.catalog.dispose(); g.catalog.dispose(); h.catalog.dispose()
  })

  it('validates literal query words and page bounds before fetching without broadening the discovery scope', async () => {
    const f = fixture({ items: [], total_count: 0 })
    for (const query of [null, 123, {}, 'a'.repeat(101), 'topic:other', 'fork:true', 'x OR y', 'AND', 'not', 'repo:a/b',
      'x" OR topic:other', "x'", '(x)', 'x\\y', 'x\ny', 'x\ty', 'x\u0000y', 'x\u007fy', 'x\u202ey',
      'https://example.invalid', 'x&per_page=1000', 'x*', 'x|y', 'x>y', 'x;y', 'x@y', 'a '.repeat(50).trim(),
    ]) await assert.rejects(f.catalog.list({ query }), /搜索|关键词|文字/u)
    for (const page of [null, '', '2', 0, -1, 11, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
      await assert.rejects(f.catalog.list({ page }), /页码/u)
    }
    assert.equal(f.calls.length, 0)
    assert.equal(normalizePluginSearchQuery(), '')
    assert.equal(normalizePluginSearchQuery('   '), '')
    assert.equal(normalizePluginSearchQuery('  中文\u3000皮肤   dsh-skin_v1.2 owner/repo café  '), '中文 皮肤 dsh-skin_v1.2 owner/repo café')
    assert.equal(normalizePluginSearchQuery('a'.repeat(100)), 'a'.repeat(100))
    await f.catalog.list({ query: '-theme' })
    assert.equal(new URL(f.calls[0][0]).searchParams.get('q'), 'topic:dsh-plugin archived:false fork:false "-theme" in:name,description,readme')
    f.catalog.dispose()
  })

  it('caches normalized queries and pages independently, with explicit refresh for just that request', async () => {
    const f = fixture({ items: [repository], total_count: 301, incomplete_results: false })
    await f.catalog.list()
    await f.catalog.list({ query: '  主题   插件  ' })
    await f.catalog.list({ query: '主题 插件', page: 2 })
    await f.catalog.list({ query: '主题 插件', page: 1 })
    await f.catalog.list({ query: '主题 插件', page: 2 })
    await f.catalog.list({ query: '' })
    assert.equal(f.calls.length, 3)
    await f.catalog.list({ query: '主题 插件', page: 2, refresh: true })
    assert.equal(f.calls.length, 4)
    await f.catalog.list({ query: 'other', page: 2 })
    assert.equal(f.calls.length, 5)
    f.catalog.dispose()
  })

  it('keeps local topic checks and case-insensitive deduplication on every search page', async () => {
    const f = fixture({ items: [
      repository,
      { ...repository, full_name: 'EXAMPLE/DSH-BUNDLE', owner: { login: 'EXAMPLE' } },
      { ...repository, full_name: 'example/no-topic', topics: [] },
      { ...repository, full_name: 'example/fork', fork: true },
      { ...repository, full_name: 'example/archived', archived: true },
    ], total_count: 205 })
    const result = await f.catalog.list({ query: 'theme', page: 3 })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].id, 'github:example/dsh-bundle')
    assert.equal(result.hasMore, false)
    f.catalog.dispose()
  })

  it('rejects malformed search totals rather than advertising invalid pagination', async () => {
    for (const total_count of [-1, 1.5, '200', null, Number.MAX_SAFE_INTEGER + 1]) {
      const f = fixture({ items: [], total_count })
      await assert.rejects(f.catalog.list(), /格式/u)
      f.catalog.dispose()
    }
  })

  it('resolves a root bundle to an immutable commit without executing metadata instructions', async () => {
    const f = githubFixture({ ...manifest, description: 'run command supplied by third party', peerDependencies: { '@deepseek-ai/dsh': '>=0.1.5' } })
    const candidate = await f.catalog.resolve('github:example/dsh-bundle')
    assert.equal(candidate.spec, `github:example/dsh-bundle#${B}`)
    assert.equal(candidate.name, '@example/dsh-bundle')
    assert.equal(candidate.version, '1.2.0')
    assert.equal(candidate.ref, 'main')
    assert.equal(candidate.commit, B)
    assert.equal(candidate.author, 'example')
    assert.equal(candidate.compatibility, 'unknown')
    assert.equal(candidate.compatibleRange, '>=0.1.5')
    assert.ok(f.calls.some(([url]) => url.endsWith(`/contents/cordis.patch.yml?ref=${B}`)))
    assert.ok(f.calls.every(([url]) => new URL(url).origin === 'https://api.github.com'))
    f.catalog.dispose()
  })

  it('rejects arbitrary identifiers, paths, schemes and command-like specs before fetching', async () => {
    const f = githubFixture()
    for (const id of [null, '', 'npm:abc', 'https://github.com/a/b', 'github:owner/repo#main', 'github:owner/repo;echo', 'github:../repo', 'github:a/b/../../x', 'github:a/b.git', 'github:a/b?token=secret']) {
      await assert.rejects(f.catalog.resolve(id))
    }
    assert.equal(f.calls.length, 0)
    await assert.rejects(f.catalog.json('https://localhost/private'))
    await assert.rejects(f.catalog.json('https://registry.npmjs.org@attacker.invalid/private'))
    await assert.rejects(f.catalog.json('https://token:secret@api.github.com/repos/a/b'))
    assert.equal(f.calls.length, 0)
    f.catalog.dispose()
  })

  it('refuses migrated or disabled repository identities', async () => {
    for (const item of [{ ...repository, full_name: 'other/dsh-bundle', owner: { login: 'other' } }, { ...repository, archived: true }, { ...repository, owner: { login: 'different' } }]) {
      const f = fixture(item)
      await assert.rejects(f.catalog.resolve('github:example/dsh-bundle'), /仓库不可用/u)
      assert.equal(f.calls.length, 1)
      f.catalog.dispose()
    }
  })

  it('requires the declared package to be a root bundle with an ordinary in-repository patch file', async () => {
    for (const altered of [
      { name: manifest.name, dsh: { client: {} } },
      { ...manifest, dsh: { bundle: { patch: '../secrets.yml' } } },
      { ...manifest, dsh: { bundle: { patch: '/absolute.yml' } } },
      { ...manifest, dsh: { bundle: { patch: 'https://evil.invalid/patch.yml' } } },
      { ...manifest, dsh: { bundle: { patch: 'x\\y.yml' } } },
      { ...manifest, name: '@example/pkg;execute' },
    ]) {
      const f = githubFixture(altered)
      await assert.rejects(f.catalog.resolve('github:example/dsh-bundle'), /未声明/u)
      assert.equal(f.calls.length, 3)
      f.catalog.dispose()
    }
    for (const patchFile of [{ type: 'dir', path: 'cordis.patch.yml' }, { type: 'symlink', path: 'cordis.patch.yml', target: '../elsewhere' }, { type: 'file', path: 'wrong.yml' }]) {
      const f = githubFixture(manifest, patchFile)
      await assert.rejects(f.catalog.resolve('github:example/dsh-bundle'), /普通文件/u)
      f.catalog.dispose()
    }
  })

  it('rejects malformed, oversized and non-canonical package content', async () => {
    for (const file of [
      { ...manifestContent(manifest), type: 'symlink' },
      { ...manifestContent(manifest), size: 999 },
      { ...manifestContent(manifest), content: '%%%' },
      { ...manifestContent(manifest), size: 9999999 },
      { ...manifestContent(manifest), path: 'other.json' },
      manifestContent('{bad JSON', true),
    ]) {
      const f = githubFixture(manifest, undefined, file)
      await assert.rejects(f.catalog.resolve('github:example/dsh-bundle'))
      f.catalog.dispose()
    }
  })

  it('checks a recorded GitHub ref, not a guessed default branch, and compares commits', async () => {
    const f = githubFixture()
    const installed = { name: manifest.name, version: '1.2.0', source: 'github', repo: 'example/dsh-bundle', ref: 'release/stable', commit: A }
    const result = await f.catalog.checkUpdate(installed)
    assert.equal(result.status, 'available')
    assert.equal(result.candidate.spec, `github:example/dsh-bundle#${B}`)
    assert.equal(result.candidate.ref, 'release/stable')
    assert.match(f.calls[0][0], /\/commits\/release%2Fstable$/u)
    assert.equal((await f.catalog.checkUpdate({ ...installed, commit: B })).status, 'current')
    const nested = { name: manifest.name, source: 'github', github: { owner: 'example', repo: 'dsh-bundle', ref: 'main', commit: A } }
    assert.equal((await f.catalog.checkUpdate(nested)).status, 'available')
    const pinned = { ...installed, commit: undefined, spec: `github:example/dsh-bundle#${B}` }
    assert.equal((await f.catalog.checkUpdate(pinned)).status, 'current')
    f.catalog.dispose()
  })

  it('does not guess GitHub update targets when origin/ref/commit is unknown or immutable', async () => {
    const f = githubFixture()
    const base = { name: manifest.name, source: 'github', repo: 'example/dsh-bundle', ref: 'main', commit: A }
    for (const installed of [
      { ...base, ref: undefined }, { ...base, commit: undefined }, { ...base, ref: B },
      { ...base, ref: '../secret' }, { ...base, repo: 'https://evil.invalid' }, { ...base, source: 'unsupported' },
      null,
    ]) assert.equal((await f.catalog.checkUpdate(installed)).status, 'unknown')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.catalog.checkUpdate({ ...base, name: 'a-different-plugin' })).status, 'unknown')
    f.catalog.dispose()
  })

  it('checks unchanged GitHub bundles with one cached commit request, avoiding manifest and patch requests', async () => {
    const f = githubFixture()
    const installed = { name: manifest.name, source: 'github', repo: 'example/dsh-bundle', ref: 'main', commit: B }
    assert.equal((await f.catalog.checkUpdate(installed)).status, 'current')
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0][0], /\/commits\/main$/u)
    await f.catalog.checkUpdate(installed)
    assert.equal(f.calls.length, 1)
    await f.catalog.checkUpdate(installed, { refresh: true })
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('uses strict npm identities and semantic precedence including prereleases, never downgrading', async () => {
    const f = fixture({ ...manifest, version: '1.10.0', author: { name: 'Example' }, repository: { url: 'git+https://github.com/example/dsh-bundle.git' } })
    const result = await f.catalog.checkUpdate({ name: manifest.name, version: '1.9.0', source: 'npm' })
    assert.equal(result.status, 'available')
    assert.equal(result.candidate.spec, '@example/dsh-bundle@1.10.0')
    assert.equal(result.candidate.sourceUrl, 'https://github.com/example/dsh-bundle')
    assert.equal(result.candidate.compatibility, 'unknown')
    assert.equal(f.calls[0][0], 'https://registry.npmjs.org/%40example%2Fdsh-bundle/latest')
    assert.equal((await f.catalog.checkUpdate({ name: manifest.name, version: '2.0.0-rc.1', source: 'npm' })).status, 'current')
    assert.equal((await f.catalog.checkUpdate({ name: manifest.name, version: '1.10.0-beta.1', source: 'npm' })).status, 'available')
    assert.equal((await f.catalog.checkUpdate({ name: manifest.name, version: '1.10.0+local', source: 'npm' })).status, 'current')
    f.catalog.dispose()
  })

  it('rejects npm identity mismatch and treats absent bundle declarations as unknown', async () => {
    const mismatch = fixture({ ...manifest, name: 'another-package' })
    await assert.rejects(mismatch.catalog.checkUpdate({ name: manifest.name, version: '1.0.0', source: 'npm' }), /不匹配/u)
    mismatch.catalog.dispose()
    const f = fixture({ ...manifest, dsh: undefined, version: '1.3.0' })
    assert.equal((await f.catalog.checkUpdate({ name: manifest.name, version: '1.0.0', source: 'npm' })).status, 'unknown')
    const count = f.calls.length
    for (const name of ['../../file', 'pkg@latest', '@example/pkg;exec', 'git+https://x', 'PKG']) {
      assert.equal((await f.catalog.checkUpdate({ name, version: '1.0.0', source: 'npm' })).status, 'unknown')
    }
    assert.equal(f.calls.length, count)
    f.catalog.dispose()
  })

  it('caches successful metadata as isolated snapshots and refresh bypasses it', async () => {
    let now = 100
    const f = fixture({ items: [repository], total_count: 1 }, { now: () => now, cacheTtlMs: 200 })
    const first = await f.catalog.list()
    first.items[0].name = 'mutated by consumer'
    assert.equal((await f.catalog.list()).items[0].name, 'dsh-bundle')
    assert.equal(f.calls.length, 1)
    await f.catalog.list({ refresh: true })
    assert.equal(f.calls.length, 2)
    now = 301
    await f.catalog.list()
    assert.equal(f.calls.length, 3)
    f.catalog.dispose()
  })

  it('does not cache failed requests and returns brief safe rate-limit errors', async () => {
    const f = fixture(() => new Response('private diagnostics'.repeat(3000), { status: 403 }))
    await assert.rejects(f.catalog.list(), /限流/u)
    await assert.rejects(f.catalog.list(), error => !error.message.includes('private diagnostics'))
    assert.equal(f.calls.length, 2)
    f.catalog.dispose()
  })

  it('rejects redirects and enforces declared and streamed JSON size limits', async () => {
    for (const response of [
      () => ({ status: 200, redirected: true, body: { cancel: async () => {} } }),
      () => ({ status: 200, url: 'https://evil.invalid/data', body: { cancel: async () => {} } }),
      () => new Response('{}', { headers: { 'content-length': '99999999' } }),
      () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
      () => new Response('<html>not JSON</html>'),
    ]) {
      const f = fixture(response)
      await assert.rejects(f.catalog.list())
      assert.equal(f.catalog.cache.size, 0)
      f.catalog.dispose()
    }
  })

  it('propagates cancellation and aborts outstanding network calls on dispose', async () => {
    let pendingSignal
    const f = fixture((_url, options) => {
      pendingSignal = options.signal
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
    const pending = f.catalog.list()
    f.catalog.dispose()
    assert.equal(pendingSignal.aborted, true)
    await assert.rejects(pending, /已关闭/u)
    await assert.rejects(f.catalog.list(), /已关闭/u)
    assert.equal(f.catalog.requests.size, 0)
    const g = githubFixture()
    await assert.rejects(g.catalog.resolve('github:example/dsh-bundle', { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/u)
    assert.equal(g.calls.length, 0)
    g.catalog.dispose()
  })

  it('bounds network wait time', async () => {
    const f = fixture((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }), { timeoutMs: 5 })
    await assert.rejects(f.catalog.list(), /超时/u)
    assert.equal(f.catalog.requests.size, 0)
    f.catalog.dispose()
  })
})

function fixture(value, options = {}) {
  const calls = []
  const catalog = new PluginCatalog({
    fetch: async (url, init) => {
      calls.push([url, init])
      const data = typeof value === 'function' ? await value(url, init) : value
      return data instanceof Response || data?.status ? data : Response.json(data)
    },
    ...options,
  })
  return { catalog, calls }
}

function githubFixture(value = manifest, patchFile = { type: 'file', path: 'cordis.patch.yml' }, file = manifestContent(value)) {
  return fixture(url => {
    if (url.endsWith('/repos/example/dsh-bundle')) return repository
    if (url.includes('/commits/')) return { sha: B }
    if (url.includes('/contents/package.json')) return file
    if (url.includes('/contents/cordis.patch.yml')) return patchFile
    throw new Error(`Unexpected metadata URL: ${url}`)
  })
}

function manifestContent(value, raw = false) {
  const bytes = Buffer.from(raw ? value : JSON.stringify(value))
  return { type: 'file', path: 'package.json', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }
}
