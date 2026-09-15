import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { PluginManager } from '../src/plugin-manager.mjs'
import { PluginCatalog } from '../src/plugin-catalog.mjs'

const worlds = []
afterEach(() => { for (const world of worlds.splice(0)) { world.manager.dispose(); rmSync(world.root, { recursive: true, force: true }) } })

describe('plugin manager: detection is never an installation', () => {
  it('opens cached plugin pages without force-refreshing or spending a manual refresh cooldown', async () => {
    const world = fixture()
    const calls = []
    world.items.push({ ...plugin(), github: { ...plugin().github, ref: 'main' } })
    world.manager.catalog = new PluginCatalog({ now: () => world.now, fetch: async url => {
      calls.push(url)
      if (url.includes('/search/')) return Response.json({ items: [], total_count: 0 })
      if (url.includes('/commits/')) return Response.json({ sha: 'b'.repeat(40) })
      if (url.includes('/contents/package.json')) {
        const content = Buffer.from(JSON.stringify({ name: 'example-plugin', version: '1.1.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
        return Response.json({ type: 'file', path: 'package.json', encoding: 'base64', size: content.length, content: content.toString('base64') })
      }
      return Response.json({ type: 'file', path: 'cordis.patch.yml' })
    } })
    for (let index = 0; index < 20; index++) {
      assert.equal((await world.manager.handleAction({ type: 'plugins-load' })).ok, true)
      world.now += 1000
    }
    assert.equal(calls.length, 4, '20 page opens share one directory GET and one initial three-GET update check')
    assert.equal(world.manager.getState().rateLimits.refreshUntil, 0)
    assert.equal(world.manager.getState().installed[0].updateAvailable, true)
    await world.manager.handleAction({ type: 'plugins-check' })
    assert.equal(calls.length, 5, 'manual check revalidates just the branch when the candidate SHA is unchanged')
    await world.manager.handleAction({ type: 'plugins-refresh' })
    assert.equal(calls.length, 6, 'manual directory refresh still reaches the network')
    assert.equal((await world.manager.handleAction({ type: 'plugins-load' })).ok, true)
    assert.equal(calls.length, 6, 'cached page opens work even during the search dispatch cooldown')
    world.now += 15 * 60_000
    await world.manager.handleAction({ type: 'plugins-load' })
    assert.equal(calls.length, 8, 'expired directory and branch caches refresh; SHA-pinned files remain reusable')
    assert.equal(world.operations.length, 0)
    assert.equal(world.confirmations.length, 0)
  })

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

  it('does not report a 40-minute metadata cooldown as a catalog refresh failure', async () => {
    const world = fixture()
    world.items.push(plugin())
    const until = world.now + 40 * 60_000
    world.catalog.getRateLimitState = () => ({ metadataUntil: until, searchUntil: 0 })
    world.catalog.checkUpdate = async () => {
      throw Object.assign(new Error('private metadata response'), { code: 'PLUGIN_RATE_LIMIT', retryAt: until })
    }
    assert.deepEqual(await world.manager.handleAction({ type: 'plugins-refresh' }), { ok: true })
    assert.equal(world.manager.getState().rateLimits.refreshUntil, world.now + 30_000)
    assert.equal(world.manager.getState().rateLimits.metadataUntil, until)
    const refresh = await world.manager.handleAction({ type: 'plugins-refresh' })
    assert.equal(refresh.rateLimitScope, 'refresh')
    assert.equal(refresh.retryAt, world.now + 30_000)
    const check = await world.manager.handleAction({ type: 'plugins-check' })
    assert.equal(check.rateLimitScope, 'metadata')
    assert.equal(check.retryAt, until)
    world.now += 30_000
    assert.equal((await world.manager.handleAction({ type: 'plugins-refresh' })).ok, true)
    assert.equal(world.operations.length, 0)
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

describe('plugin snapshot coordination', () => {
  it('requires a completed backup before dispatching a plugin command', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.manager.snapshots.create = async () => { throw new Error('private backup path') }
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })).ok, false)
    assert.equal(world.operations.length, 0)
    assert.equal(world.manager.isBusy(), false)
    assert.doesNotMatch(world.manager.error, /private backup path/u)
  })

  it('does not create snapshots on browsing, detection or cancelled confirmation', async () => {
    const world = fixture()
    await world.manager.refresh()
    await world.manager.refreshSnapshots()
    world.choice = 1
    await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })
    assert.deepEqual(await world.manager.snapshots.list(), [])
    assert.equal(existsSync(join(world.root, 'plugin-snapshots')), false)
  })

  it('restores real dependency bytes, config and source records after a failed command, without any registry calls', async () => {
    const world = fixture()
    const profile = seedProfile(world)
    const config = join(profile, 'settings.json')
    const dependency = join(profile, 'node_modules', 'example-plugin', 'index.js')
    world.manager.runOperation = async options => {
      world.operations.push(options)
      writeFileSync(config, 'changed config')
      writeFileSync(dependency, 'changed dependency')
      writeFileSync(join(world.root, 'plugin-sources.json'), '{}')
      throw new Error('isolated CLI failure')
    }
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })).ok, false)
    const [snapshot] = world.manager.getState().snapshots.items
    assert.equal(snapshot.status, 'failed')
    assert.equal(readFileSync(dependency, 'utf8'), 'changed dependency')
    let paused = false
    world.options.withBackendStopped = async work => {
      assert.equal(world.manager.isBusy(), true)
      paused = true
      await work()
      assert.equal(world.manager.snapshotRecoveryRequired, false)
      paused = false
    }
    const restore = world.manager.snapshots.restore.bind(world.manager.snapshots)
    world.manager.snapshots.restore = async id => { assert.equal(paused, true); return restore(id) }
    world.catalog.resolve = world.catalog.checkUpdate = world.options.resolveProxy = async () => { throw new Error('unexpected network') }
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, true)
    assert.equal(readFileSync(config, 'utf8'), 'original config')
    assert.equal(readFileSync(dependency, 'utf8'), 'original dependency')
    assert.equal(existsSync(join(world.root, 'plugin-sources.json')), false)
    assert.equal(readFileSync(join(world.root, 'dsh', 'conversation.json'), 'utf8'), 'untouched conversation fixture')
    assert.equal(world.operations.length, 1)
    assert.equal(world.manager.isBusy(), false)
    assert.match(world.confirmations.at(-1).detail, /整个 web profile/u)
    assert.equal(world.confirmations.at(-1).defaultId, 1)
  })

  it('refuses runtime mismatch and later edits without overwriting files', async () => {
    const world = fixture()
    const profile = seedProfile(world)
    await world.manager.refresh()
    assert.equal((await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })).ok, true)
    const [snapshot] = world.manager.getState().snapshots.items
    let pauses = 0
    world.options.withBackendStopped = async work => { pauses += 1; await work() }
    world.runtime = { version: '99.0.0' }
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, false)
    assert.equal(pauses, 0)
    world.runtime = { version: snapshot.runtimeVersion }
    writeFileSync(join(profile, 'settings.json'), 'external edit')
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, false)
    assert.equal(readFileSync(join(profile, 'settings.json'), 'utf8'), 'external edit')
    assert.equal(world.manager.snapshotRecoveryRequired, false)
    assert.equal(world.operations.length, 1)
  })

  it('cancelled restore or failed backend shutdown never swaps the profile', async () => {
    const world = fixture()
    await world.manager.refresh()
    await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })
    const [snapshot] = world.manager.getState().snapshots.items
    let attempts = 0
    world.manager.snapshots.restore = async () => { attempts += 1 }
    world.options.withBackendStopped = async () => { throw new Error('backend still active') }
    world.choice = 1
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).cancelled, true)
    world.choice = 0
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, false)
    assert.equal(attempts, 0)
    assert.equal(world.manager.isBusy(), false)
  })

  it('does not offer an unfinished process snapshot for restore or repair while process cleanup is uncertain', async () => {
    const world = fixture()
    await world.manager.refresh()
    world.manager.runOperation = async () => { throw Object.assign(new Error('timeout'), { cleanupUncertain: true }) }
    await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })
    const [snapshot] = world.manager.getState().snapshots.items
    assert.equal(snapshot.status, 'pending')
    world.options.withBackendStopped = async () => { throw new Error('must not pause') }
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, false)
    assert.equal((await world.manager.handleAction({ type: 'plugins-recover' })).ok, false)
    assert.equal(world.manager.blocksUpdates(), true)
  })

  it('requires explicit confirmation to repair a pending journal, and refreshes recovery before backend resume', async () => {
    const world = fixture()
    let pending = true, repairs = 0
    world.manager.snapshots = {
      getRecoveryState: async () => ({ recoveryRequired: pending }), list: async () => [],
      recover: async () => { repairs += 1; pending = false },
    }
    await world.manager.refreshSnapshots()
    assert.equal(world.manager.blocksUpdates(), true)
    world.options.withBackendStopped = async work => {
      assert.equal(world.manager.snapshotRecoveryRequired, true)
      await work()
      assert.equal(world.manager.snapshotRecoveryRequired, false)
    }
    world.choice = 1
    assert.equal((await world.manager.handleAction({ type: 'plugins-recover' })).cancelled, true)
    assert.equal(repairs, 0)
    world.choice = 0
    assert.equal((await world.manager.handleAction({ type: 'plugins-recover' })).ok, true)
    assert.equal(repairs, 1)
    assert.equal(world.manager.blocksUpdates(), false)
  })

  it('projects persistent recovery to the backend gate even when restore throws', async () => {
    const world = fixture()
    await world.manager.refresh()
    await world.manager.handleAction({ type: 'plugin-install', id: candidate().id })
    const [snapshot] = world.manager.getState().snapshots.items
    let pending = false
    world.manager.snapshots.getRecoveryState = async () => ({ recoveryRequired: pending })
    world.manager.snapshots.restore = async () => { pending = true; throw new Error('interrupted swap') }
    world.options.withBackendStopped = async work => {
      try { await work() } finally { assert.equal(world.manager.snapshotRecoveryRequired, true) }
    }
    assert.equal((await world.manager.handleAction({ type: 'plugin-restore', id: snapshot.id })).ok, false)
    assert.equal(world.manager.blocksUpdates(), true)
    assert.equal(world.manager.isBusy(), false)
  })
})

describe('explicit plugin backend restart', () => {
  it('offers a restart after install/update/remove but never starts it automatically', async () => {
    for (const action of ['install', 'update', 'remove']) {
      const world = fixture()
      let restarts = 0
      world.options.restartBackend = async () => { restarts++ }
      if (action !== 'install') world.items.push(plugin())
      assert.equal(world.manager.getState().restartRecommended, false)
      await world.manager.refresh()
      assert.equal((await world.manager.handleAction({ type: `plugin-${action}`, id: action === 'install' ? candidate().id : plugin().id })).ok, true)
      assert.equal(world.manager.getState().restartRecommended, true)
      assert.match(world.manager.getState().notice, /点击“重启 Harness”/u)
      assert.equal(restarts, 0)
    }
  })

  it('locks before confirmation, keeps the completion card on cancel and waits for backend readiness', async () => {
    const world = fixture()
    world.manager.restartRecommended = true
    world.manager.progress = { label: '安装完成', percent: 100 }
    const confirmed = Promise.withResolvers(), ready = Promise.withResolvers()
    let restarts = 0
    world.options.restartBackend = runtime => {
      assert.equal(runtime, world.runtime)
      restarts++
      return ready.promise
    }
    world.options.showMessage = async options => {
      assert.equal(options.defaultId, 1)
      assert.equal(options.cancelId, 1)
      assert.match(options.detail, /任务会中断/u)
      return confirmed.promise
    }
    const cancelled = world.manager.handleAction({ type: 'plugins-restart' })
    assert.equal(world.manager.blocksUpdates(), true)
    assert.equal((await world.manager.handleAction({ type: 'plugins-restart' })).ok, false)
    confirmed.resolve({ response: 1 })
    assert.equal((await cancelled).cancelled, true)
    assert.equal(world.manager.getState().progress.percent, 100)
    assert.equal(world.manager.restartRecommended, true)
    assert.equal(restarts, 0)
    world.options.showMessage = async () => ({ response: 0 })
    const restart = world.manager.handleAction({ type: 'plugins-restart' })
    await Promise.resolve()
    assert.equal(restarts, 1)
    assert.equal(world.manager.getState().restarting, true)
    assert.equal(world.manager.getState().progress.percent, undefined)
    assert.equal((await world.manager.handleAction({ type: 'plugin-remove', id: plugin().id })).ok, false)
    assert.equal((await world.manager.handleAction({ type: 'plugins-restart' })).ok, false)
    ready.resolve()
    assert.equal((await restart).ok, true)
    assert.equal(world.manager.restartRecommended, false)
    assert.equal(world.manager.getState().progress.label, '重启完成')
    assert.equal(world.manager.blocksUpdates(), false)
    assert.equal(world.operations.length, 0)
  })

  it('rejects missing runtime, busy/recovery states and a runtime changed during confirmation', async () => {
    for (const reason of ['runtime', 'busy', 'loading', 'checking', 'snapshotsLoading', 'recoveryRequired', 'snapshotRecoveryRequired', 'changed', 'disposed']) {
      const world = fixture()
      world.manager.restartRecommended = true
      let restarts = 0
      world.options.restartBackend = async () => { restarts++ }
      if (reason === 'runtime') world.runtime = undefined
      else if (reason === 'busy') world.blocked = true
      else if (reason === 'changed') world.options.showMessage = async () => { world.runtime = { ...world.runtime }; return { response: 0 } }
      else world.manager[reason] = true
      assert.equal((await world.manager.handleAction({ type: 'plugins-restart' })).ok, false, reason)
      assert.equal(restarts, 0, reason)
      assert.equal(world.manager.restartRecommended, true)
    }
  })

  it('retains a retry after shutdown/start failure and does not expose raw diagnostics', async () => {
    const world = fixture()
    world.manager.restartRecommended = true
    world.options.restartBackend = async () => { throw new Error('private token=diagnostic') }
    const result = await world.manager.handleAction({ type: 'plugins-restart' })
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.message, /private|token=/u)
    assert.equal(world.manager.restartRecommended, true)
    assert.equal(world.manager.isBusy(), false)
    assert.equal(world.manager.restarting, false)
    assert.equal(world.manager.progress, null)
    assert.equal(world.operations.length, 0)
    world.options.restartBackend = async () => {}
    assert.equal((await world.manager.handleAction({ type: 'plugins-restart' })).ok, true)
  })
})

function seedProfile(world) {
  const profile = join(world.root, 'dsh', 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'example-plugin'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))
  writeFileSync(join(profile, 'settings.json'), 'original config')
  writeFileSync(join(profile, 'node_modules', 'example-plugin', 'index.js'), 'original dependency')
  writeFileSync(join(world.root, 'dsh', 'conversation.json'), 'untouched conversation fixture')
  return profile
}

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
  const world = { root: realpathSync.native(mkdtempSync(join(tmpdir(), 'mengluo-plugin-manager-'))), items: [], operations: [], links: [], proxyUrls: [],
    changes: [], confirmations: [], choice: 0, blocked: false, runtime: { version: '0.1.5-rc.2' }, disposals: 0, now: 1_000_000 }
  world.catalog = {
    list: async ({ query = '', page = 1 } = {}) => ({ items: [{ ...candidate(), name: 'plugin-repo' }], query, page, total: 1, hasMore: false, truncated: false }),
    resolve: async () => candidate(), checkUpdate: async () => ({ status: 'available', candidate: candidate() }),
    dispose: () => { world.disposals += 1 },
  }
  world.options = { userData: world.root, dshHome: join(world.root, 'dsh'), catalog: world.catalog, now: () => world.now, getRuntime: () => world.runtime, isBlocked: () => world.blocked,
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
