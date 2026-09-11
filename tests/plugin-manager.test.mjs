import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { PluginManager } from '../src/plugin-manager.mjs'

const worlds = []
afterEach(() => { for (const world of worlds.splice(0)) { world.manager.dispose(); rmSync(world.root, { recursive: true, force: true }) } })

describe('plugin manager: detection is never an installation', () => {
  it('only reads when browsing or checking, exposes manual updates, and handles differing repository/package names', async () => {
    const world = fixture()
    world.items.push(plugin())
    assert.equal((await world.manager.handleAction({ type: 'plugins-refresh' })).ok, true)
    assert.equal(world.operations.length, 0)
    assert.equal(world.confirmations.length, 0)
    assert.equal(world.manager.getState().installed[0].updateAvailable, true)
    assert.equal(world.manager.getState().catalog[0].installed, true)
    assert.equal(world.manager.getState().catalog[0].installedId, 'example-plugin')
    await world.manager.handleAction({ type: 'plugins-check' })
    assert.equal(world.operations.length, 0)
    assert.ok(world.manager.checkedAt)
  })

  it('keeps installed inventory available on catalog failure without claiming successful update checks', async () => {
    const world = fixture()
    world.items.push(plugin())
    world.catalog.list = async () => { throw new Error('metadata failure') }
    world.catalog.checkUpdate = async () => { throw new Error('metadata failure') }
    assert.equal((await world.manager.refresh()).ok, false)
    const state = world.manager.getState()
    assert.equal(state.installed.length, 1)
    assert.equal(state.installed[0].updateAvailable, false)
    assert.equal(state.installed[0].updateCheckStatus, 'unknown')
    assert.equal(world.operations.length, 0)
  })

  it('requires native confirmation and locks before awaiting metadata; cancel never runs the CLI', async () => {
    const world = fixture()
    await world.manager.refresh()
    const resolved = Promise.withResolvers()
    world.catalog.resolve = () => resolved.promise
    const pending = world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })
    assert.equal(world.manager.isBusy(), true)
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, false)
    world.choice = 1
    resolved.resolve(candidate())
    assert.equal((await pending).cancelled, true)
    assert.equal(world.manager.isBusy(), false)
    assert.equal(world.operations.length, 0)
    assert.equal(world.confirmations[0].defaultId, 1)
    assert.match(world.confirmations[0].detail, /第三方插件/u)
  })

  it('uses only main-resolved exact specs, same runtime, proxy and official web runner', async () => {
    const world = fixture()
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, true)
    assert.equal(world.operations.length, 1)
    const operation = world.operations[0]
    assert.equal(operation.runtime, world.runtime)
    assert.deepEqual(operation.operation, { action: 'install', name: 'example-plugin', spec: candidate().spec })
    assert.equal(operation.proxy, 'http://127.0.0.1:18080')
    assert.deepEqual(world.proxyUrls, ['https://github.com/'])
    const records = JSON.parse(readFileSync(join(world.root, 'plugin-sources.json'), 'utf8'))
    assert.equal(records['example-plugin'].ref, 'main')
    assert.equal(records['example-plugin'].commit, 'b'.repeat(40))
    assert.equal(world.manager.getState().progress.percent, 100)
  })

  it('manually updates only the selected plugin after a fresh read-only candidate check', async () => {
    const world = fixture()
    world.items.push(plugin(), { ...plugin(), id: 'second-plugin', name: 'second-plugin' })
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-update', id: 'example-plugin' })).ok, true)
    assert.equal(world.operations.length, 1)
    assert.equal(world.operations[0].operation.action, 'update')
    assert.equal(world.items[1].version, '1.0.0')
    assert.equal(world.manager.getState().installed[0].updateAvailable, false)
  })

  it('rechecks profile, runtime and external busy state after confirmation', async () => {
    for (const change of ['profile', 'runtime', 'busy']) {
      const world = fixture()
      world.items.push(plugin())
      await world.manager.refresh()
      world.options.showMessage = async () => {
        if (change === 'profile') world.items[0].spec = '^99.0.0'
        if (change === 'runtime') world.options.getRuntime = () => ({ ...world.runtime })
        if (change === 'busy') world.blocked = true
        return { response: 0 }
      }
      assert.equal((await world.manager.handleAction({ type: 'plugin-update', id: 'example-plugin' })).ok, false)
      assert.equal(world.operations.length, 0)
      assert.equal(world.manager.isBusy(), false)
    }
  })

  it('rejects operations without a runtime, during read refresh, or while Harness is busy', async () => {
    const world = fixture()
    await world.manager.refresh()
    for (const reason of ['busy', 'runtime', 'loading']) {
      world.blocked = reason === 'busy'
      world.options.getRuntime = () => reason === 'runtime' ? undefined : world.runtime
      world.manager.loading = reason === 'loading'
      assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, false)
    }
    assert.equal(world.operations.length, 0)
    assert.equal(world.confirmations.length, 0)
  })

  it('contains display and log callback failures without retaining a mutation lock', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.options.onChanged = () => { throw new Error('display unavailable') }
    world.options.log = () => { throw new Error('log unavailable') }
    world.choice = 1
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).cancelled, true)
    assert.equal(world.manager.isBusy(), false)
    world.choice = 0
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, true)
    assert.equal(world.manager.isBusy(), false)
  })

  it('rejects protected components and unknown IDs before asking for confirmation', async () => {
    const world = fixture()
    world.items.push({ ...plugin(), managed: false })
    await world.manager.refresh()
    for (const type of ['plugin-update', 'plugin-remove']) {
      assert.equal((await world.manager.handleAction({ type, id: 'example-plugin' })).ok, false)
      assert.equal((await world.manager.handleAction({ type, id: 'missing-plugin' })).ok, false)
    }
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:unlisted/repo' })).ok, false)
    assert.equal(world.confirmations.length, 0)
    assert.equal(world.operations.length, 0)
  })

  it('uninstalls only the selected extra dependency and clears its tracking metadata', async () => {
    const world = fixture()
    world.items.push(plugin())
    world.manager.saveRecord('example-plugin', candidate())
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-remove', id: 'example-plugin' })).ok, true)
    assert.deepEqual(world.operations[0].operation, { action: 'remove', name: 'example-plugin' })
    assert.deepEqual(JSON.parse(readFileSync(join(world.root, 'plugin-sources.json'), 'utf8')), {})
    assert.equal(world.manager.getState().installed.length, 0)
  })

  it('does not reuse saved tracking provenance after manual replacement', async () => {
    const world = fixture()
    world.manager.saveRecord('example-plugin', candidate())
    const tracked = { ...plugin(), spec: candidate().spec }
    assert.equal(world.manager.tracked(tracked).ref, 'main')
    assert.equal(world.manager.tracked(plugin()).ref, undefined)
    writeFileSync(join(world.root, 'plugin-sources.json'), JSON.stringify({
      'example-plugin': { ...candidate(), repo: '../untrusted', spec: 'github:../untrusted#' + 'b'.repeat(40) },
    }))
    assert.deepEqual(new PluginManager(world.options).records, {})
  })

  it('exposes a short failure summary and releases locks after command failure', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.options.runOperation = async () => { throw new Error('raw private diagnostic '.repeat(10000)) }
    world.manager.runOperation = world.options.runOperation
    const result = await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.message, /raw private/u)
    assert.ok(result.message.length < 200)
    assert.equal(world.manager.isBusy(), false)
    assert.equal(world.manager.getState().progress, null)
  })

  it('quarantines further mutations and updates when a timed-out process has not confirmed exit', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.manager.runOperation = async () => { const error = new Error('cleanup not confirmed'); error.cleanupUncertain = true; throw error }
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, false)
    assert.equal(world.manager.isBusy(), false)
    assert.equal(world.manager.blocksUpdates(), true)
    assert.equal(world.manager.getState().recoveryRequired, true)
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: 'github:example/plugin-repo' })).ok, false)
  })

  it('opens only main-resolved canonical public source links and stops read work on dispose', async () => {
    const world = fixture()
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-source', id: 'github:example/plugin-repo' })).ok, true)
    assert.deepEqual(world.links, ['https://github.com/example/plugin-repo'])
    world.manager.catalogItems[0].sourceUrl = 'https://github.com/../settings'
    assert.equal((await world.manager.handleAction({ type: 'plugin-source', id: 'github:example/plugin-repo' })).ok, false)
    world.manager.dispose()
    assert.equal((await world.manager.handleAction({ type: 'plugins-refresh' })).ok, false)
    assert.equal(world.disposals, 1)
  })

  it('reserves a separate check cooldown, stops on metadata limits and does not claim a fresh successful check', async () => {
    const world = fixture()
    world.items.push(plugin())
    await world.manager.refresh()
    const checkedAt = world.manager.checkedAt
    world.now += 1000
    let requests = 0
    const until = world.now + 120_000
    world.catalog.checkUpdate = async () => {
      requests += 1
      throw Object.assign(new Error('private rate body'), { code: 'PLUGIN_RATE_LIMIT', retryAt: until })
    }
    const result = await world.manager.handleAction({ type: 'plugins-check' })
    assert.equal(result.rateLimited, true)
    assert.equal(world.manager.checkedAt, checkedAt)
    assert.equal(world.manager.getState().installed[0].updateAvailable, true)
    assert.equal(world.manager.getState().checking, false)
    assert.equal(world.manager.getState().rateLimits.checkUntil, world.now + 30_000)
    assert.doesNotMatch(JSON.stringify(result), /private rate body/u)
    assert.equal((await world.manager.handleAction({ type: 'plugins-check' })).rateLimited, true)
    assert.equal(requests, 1)
    assert.equal(world.operations.length, 0)
    world.catalog.getRateLimitState = () => ({ metadataUntil: until, searchUntil: 0 })
    world.now += 30_000
    assert.equal((await world.manager.handleAction({ type: 'plugins-check' })).retryAt, until)
    assert.equal(requests, 1)
  })

  it('releases mutation locks after a source cooldown without confirmation or installation', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.catalog.resolve = async () => {
      throw Object.assign(new Error('private'), { code: 'PLUGIN_RATE_LIMIT', retryAt: world.now + 60_000 })
    }
    const result = await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })
    assert.equal(result.rateLimited, true)
    assert.equal(world.manager.isBusy(), false)
    assert.equal(world.manager.getState().progress, null)
    assert.equal(world.operations.length, 0)
    assert.equal(world.confirmations.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /private/u)
  })

  it('does not preserve a prior update candidate after an external plugin replacement', async () => {
    for (const changed of [{ version: '3.0.0' }, { spec: 'file:replacement' }, { source: 'npm' }, { managed: false }]) {
      const world = fixture()
      world.items.push(plugin())
      await world.manager.refresh()
      assert.equal(world.manager.getState().installed[0].updateAvailable, true)
      Object.assign(world.items[0], changed)
      world.catalog.checkUpdate = async () => {
        throw Object.assign(new Error('limited'), { code: 'PLUGIN_RATE_LIMIT', retryAt: world.now + 60_000 })
      }
      await world.manager.handleAction({ type: 'plugins-check' })
      assert.equal(world.manager.getState().installed[0].updateAvailable, false)
      assert.equal(world.manager.getState().installed[0].availableVersion, undefined)
      assert.equal(world.operations.length, 0)
    }
  })
})

function candidate() {
  return { id: 'github:example/plugin-repo', name: 'example-plugin', version: '1.1.0', source: 'github',
    spec: `github:example/plugin-repo#${'b'.repeat(40)}`, repo: 'example/plugin-repo', ref: 'main', commit: 'b'.repeat(40),
    sourceUrl: 'https://github.com/example/plugin-repo' }
}
function plugin() {
  return { id: 'example-plugin', name: 'example-plugin', version: '1.0.0', managed: true, source: 'github',
    spec: `github:example/plugin-repo#${'a'.repeat(40)}`,
    github: { owner: 'example', repo: 'plugin-repo', commit: 'a'.repeat(40) } }
}
function fixture() {
  const world = { root: mkdtempSync(join(tmpdir(), 'mengluo-plugin-manager-')), items: [], operations: [], links: [], proxyUrls: [],
    changes: [], confirmations: [], choice: 0, blocked: false, runtime: { version: '0.1.5-rc.2' }, disposals: 0, now: 1_000_000 }
  world.catalog = {
    list: async ({ query = '', page = 1 } = {}) => ({ items: [{ ...candidate(), name: 'plugin-repo' }], query, page, total: 1, hasMore: false, truncated: false }),
    resolve: async () => candidate(), checkUpdate: async () => ({ status: 'available', candidate: candidate() }),
    dispose: () => { world.disposals += 1 },
  }
  world.options = { userData: world.root, catalog: world.catalog, now: () => world.now, getRuntime: () => world.runtime, isBlocked: () => world.blocked,
    readInstalled: () => ({ plugins: world.items.map(item => ({ ...item })) }),
    runOperation: async options => {
      world.operations.push(options)
      const index = world.items.findIndex(item => item.name === options.operation.name)
      if (options.operation.action === 'remove') world.items.splice(index, 1)
      else {
        const installed = { ...plugin(), spec: candidate().spec, version: candidate().version }
        if (index < 0) world.items.push(installed)
        else world.items[index] = installed
      }
    },
    showMessage: async options => { world.confirmations.push(options); return { response: world.choice } },
    resolveProxy: async url => { world.proxyUrls.push(url); return 'http://127.0.0.1:18080' },
    onChanged: () => { world.changes.push(1) }, openExternal: url => world.links.push(url),
  }
  world.manager = new PluginManager(world.options)
  worlds.push(world)
  return world
}
