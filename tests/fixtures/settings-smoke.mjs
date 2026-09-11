import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'

const [temporary, application, screenshots] = process.argv.slice(2)
const profile = join(temporary, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const { createSettingsWindow, SETTINGS_IPC } = await import(pathToFileURL(join(application, 'src', 'settings-window.mjs')).href)
let controller
const deadline = setTimeout(() => { process.stderr.write('settings smoke timed out\n'); app.exit(1) }, 40_000)
app.on('will-quit', () => clearTimeout(deadline))
app.on('window-all-closed', () => {})

async function run() {
  await app.whenReady()
  nativeTheme.themeSource = 'light'
  const actions = [], logs = [], layouts = []
  const state = {
    harness: {
      installed: true, version: '0.1.2-rc.1', status: 'available', availableVersion: '0.1.3-rc.1',
      autoCheck: true, interval: '24h', channel: 'auto', progressAvailable: false,
    },
    client: { currentVersion: '0.5.6', status: 'idle', supported: true, autoCheck: true },
    network: {
      source: 'official', sources: [
        { id: 'official', label: '官方 npm', description: '官方 npm 软件包仓库。' },
        { id: 'npmmirror', label: '国内镜像 · npmmirror', description: '国内第三方 npm 镜像，可能存在同步延迟。' },
      ], busy: false, proxyStatus: '跟随 Windows 系统代理规则',
      probe: { status: 'idle', detail: '检测仅反映连接是否可用，不代表实际下载速度。' },
    },
    plugins: {
      installedRuntime: true, loading: false, busy: false, checking: false,
      query: '', catalogQuery: '', catalogLoading: false, loadingMore: false, catalogError: undefined,
      total: 202, page: 1, hasMore: true, limitReached: false, incomplete: false,
      catalog: [
        { id: 'npm:aurora-theme', name: '极光主题', description: '柔和的夜间配色与紧凑布局。社区内容按纯文本显示：<img src=x onerror="window.injected=true">', author: 'Example Studio', sourceLabel: '社区目录', version: '1.2.0', repositoryUrl: 'https://github.com/example/aurora' },
        { id: 'github:example/workflow', name: 'Workflow 仓库展示名', description: '整理重复任务，扩展当前工作流。', author: 'Example', sourceLabel: '社区目录', version: '2.1.0', repositoryUrl: 'https://github.com/example/workflow', installed: true, installedId: 'npm:@example/workflow' },
      ],
      installed: [
        { id: 'npm:@example/workflow', name: '@example/workflow', version: '2.0.0', availableVersion: '2.1.0', updateAvailable: true, managed: true, repositoryUrl: 'https://github.com/example/workflow' },
        { id: 'npm:official-component', name: '官方自带组件', version: '0.1.5-rc.1', managed: false },
        { id: 'github:example/local-theme', name: 'Git 来源主题', version: 'a12b456', managed: true, updateCheckStatus: 'unknown', updateCheckMessage: 'Git 来源暂时无法确定更新，请查看源码。', repositoryUrl: 'https://github.com/example/local-theme' },
      ],
      progress: null, error: undefined, notice: '插件操作使用当前 Harness 的 web 配置，完成后可能需要重启。',
    },
    about: { productName: 'MengLuo DSH Desktop', clientVersion: '0.5.6', harnessVersion: '0.1.2-rc.1', logAvailable: true },
  }
  const catalogItems = state.plugins.catalog
  const cachedSearchResults = new Map([['', [...catalogItems]]])
  let limitedSearchUntil = 0
  let searchRevision = 0
  let failNextMore = true
  controller = createSettingsWindow({
    BrowserWindow, ipcMain, nativeTheme, getParent: () => undefined,
    htmlPath: join(application, 'assets', 'settings.html'),
    preloadPath: join(application, 'src', 'settings-preload.cjs'),
    iconPath: join(application, 'assets', 'icon.png'), productName: 'MengLuo DSH Desktop',
    onAction: async request => {
      actions.push(request)
      if (request.type === 'plugins-search') {
        const revision = ++searchRevision
        if (limitedSearchUntil > Date.now()) {
          const cached = cachedSearchResults.get(request.query)
          Object.assign(state.plugins, { query: request.query, catalogLoading: false, loadingMore: false, hasMore: false })
          if (cached) Object.assign(state.plugins, { catalogQuery: request.query, catalog: [...cached], catalogError: undefined, page: 1, total: cached.length })
          else state.plugins.catalogError = '搜索请求已暂停，已有结果已保留。请等待倒计时结束后重试。'
          controller.update(state)
          return cached ? { ok: true } : { ok: false, rateLimited: true, retryAt: limitedSearchUntil, message: 'private-network-message' }
        }
        Object.assign(state.plugins, { query: request.query, catalogLoading: true, loadingMore: false, catalogError: undefined, hasMore: false })
        controller.update(state)
        await pause(request.query === 'slow' ? 250 : 25)
        if (revision !== searchRevision) return { ok: true }
        const catalog = request.query === '極光' ? [] : ['极光', '主题', 'readme-only'].includes(request.query) ? [catalogItems[0]] : [...catalogItems]
        Object.assign(state.plugins, { catalog, catalogQuery: request.query, catalogLoading: false, page: 1, total: catalog.length, hasMore: false })
        cachedSearchResults.set(request.query, [...catalog])
      }
      if (request.type === 'plugins-more') {
        assert.equal(request.query, state.plugins.query)
        Object.assign(state.plugins, { loadingMore: true, catalogError: undefined })
        controller.update(state)
        await pause(60)
        state.plugins.loadingMore = false
        if (failNextMore) {
          failNextMore = false
          state.plugins.catalogError = 'token=private-remote-error'
          controller.update(state)
          return { ok: false }
        }
        state.plugins.catalog.push(...Array.from({ length: 100 }, (_, index) => ({ id: `github:example/more-${index}`, name: `More ${index}`, author: 'Example', repositoryUrl: 'https://github.com/example/plugin' })))
        state.plugins.page += 1
      }
      if (request.type === 'download-source') state.network.source = request.source
      if (request.type === 'harness-preferences') Object.assign(state.harness, request.patch)
      if (request.type === 'client-preferences') Object.assign(state.client, request.patch)
      if (request.type === 'test-connection') state.network.probe = { status: 'success', detail: '模拟检测成功 · 响应时间 120 ms（未发起网络请求）' }
      if (request.type === 'plugins-check') state.plugins.checkedAt = '2026-09-10T10:00:00Z'
      controller.update(state)
    },
    log: message => logs.push(message),
  })
  controller.update(state)
  controller.show('harness')
  const window = BrowserWindow.getAllWindows()[0]
  const contents = window.webContents
  await expectDom(contents, "document.getElementById('harness-version')?.textContent === '0.1.2-rc.1'")
  assert.equal(await contents.executeJavaScript("typeof require + ':' + typeof process"), 'undefined:undefined')
  assert.equal(await contents.executeJavaScript("Object.keys(window.clientSettings).sort().join(',')"), 'action,onState,ready')
  await checkLayout(contents, 'harness-normal-light', layouts)
  await screenshot(contents, 'harness-light')
  await contents.executeJavaScript("document.getElementById('harness-primary').click()")
  await expect(() => actions.length === 1)
  assert.deepEqual(actions[0], { type: 'harness-download' })
  await contents.executeJavaScript("document.getElementById('harness-channel').focus(); document.getElementById('harness-channel').value = 'next'")
  controller.update({ ...state, client: { ...state.client, status: 'checking' } })
  assert.equal(await contents.executeJavaScript("document.activeElement.id + ':' + document.getElementById('harness-channel').value"), 'harness-channel:next')
  await contents.executeJavaScript("document.getElementById('harness-channel').dispatchEvent(new Event('change', {bubbles:true}))")
  await expect(() => actions.length === 2)
  assert.deepEqual(actions[1], { type: 'harness-preferences', patch: { channel: 'next' } })
  await contents.executeJavaScript("document.getElementById('tab-network').click()")
  await expectDom(contents, "document.getElementById('panel-network').hidden === false")
  await contents.executeJavaScript("document.getElementById('download-source').value = 'npmmirror'; document.getElementById('download-source').dispatchEvent(new Event('change', {bubbles:true}))")
  await expect(() => actions.length === 3)
  assert.deepEqual(actions[2], { type: 'download-source', source: 'npmmirror' })
  await expectDom(contents, "document.getElementById('mirror-notice').hidden === false")
  const beforeInvalid = actions.length
  const invalid = await contents.executeJavaScript("window.clientSettings.action({type:'download-source', source:'https://untrusted.invalid'})")
  assert.equal(invalid.ok, false)
  assert.equal(actions.length, beforeInvalid)
  await contents.executeJavaScript("document.getElementById('test-connection').click()")
  await expect(() => actions.length === 4)
  assert.deepEqual(actions[3], { type: 'test-connection' })
  await expectDom(contents, "document.getElementById('probe-detail').textContent.includes('模拟检测成功')")
  await expectDom(contents, "document.getElementById('test-connection').disabled === false")
  controller.update(state)
  await expectDom(contents, "document.getElementById('panel-network').hidden === false")
  await screenshot(contents, 'network-light')

  await contents.executeJavaScript("document.getElementById('tab-plugins').click()")
  await expect(() => actions.length === 5)
  assert.deepEqual(actions.at(-1), { type: 'plugins-refresh' })
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog .plugin-card').length === 2")
  assert.equal(await contents.executeJavaScript("window.injected === undefined && document.querySelector('#plugins-catalog img') === null"), true)
  assert.equal(actions.some(action => ['plugin-install', 'plugin-update', 'plugin-remove'].includes(action.type)), false, 'Browsing must never mutate plugins')
  assert.equal(await contents.executeJavaScript("document.querySelectorAll('#plugins-catalog [data-action=plugin-install]').length"), 1, 'Repository identity suppresses a duplicate install despite a different display name')
  assert.equal(await contents.executeJavaScript("document.querySelector('#plugins-catalog [data-action=plugin-update]').dataset.pluginId"), 'npm:@example/workflow')
  state.plugins.catalog[1].installedId = undefined
  controller.update(state)
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog [data-action=plugin-install]').length === 1 && document.querySelectorAll('#plugins-catalog [data-action=plugin-update]').length === 0")
  state.plugins.catalog[1].installedId = 'npm:@example/workflow'
  controller.update(state)
  await screenshot(contents, 'plugins-store-light')
  await contents.executeJavaScript("document.getElementById('plugin-search').focus(); document.getElementById('plugin-search').value = '極光'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true}))")
  await expectDom(contents, "!document.getElementById('plugins-catalog').hidden && document.getElementById('plugins-catalog-status').textContent.includes('当前保留社区插件的 2 条结果')")
  await expect(() => actions.at(-1)?.type === 'plugins-search' && actions.at(-1).query === '極光')
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('没有匹配')")
  await contents.executeJavaScript("document.getElementById('plugin-search').value = '极光'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true}))")
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog .plugin-card').length === 1")
  controller.update(state)
  assert.equal(await contents.executeJavaScript("document.activeElement.id + ':' + document.getElementById('plugin-search').value"), 'plugin-search:极光')
  const searchCount = actions.filter(action => action.type === 'plugins-search').length
  await contents.executeJavaScript("document.getElementById('plugin-search').value = '主题'; document.getElementById('plugin-search').dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true}))")
  await pause(550)
  assert.equal(actions.filter(action => action.type === 'plugins-search').length, searchCount, 'IME composition must not send incomplete queries')
  await contents.executeJavaScript("document.getElementById('plugin-search').dispatchEvent(new CompositionEvent('compositionend', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expect(() => actions.at(-1)?.query === '主题')
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('已加载 1')")
  await contents.executeJavaScript("document.getElementById('plugin-search').value = 'slow'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expect(() => actions.at(-1)?.query === 'slow')
  await contents.executeJavaScript("document.getElementById('plugin-search').value = 'readme-only'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expect(() => actions.at(-1)?.query === 'readme-only')
  await pause(300)
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('readme-only') && document.querySelectorAll('#plugins-catalog .plugin-card').length === 1")
  assert.equal(await contents.executeJavaScript("document.getElementById('plugins-catalog').textContent.includes('readme-only')"), false, 'Remote README matches must not be removed by local substring filtering')
  Object.assign(state.plugins, {
    catalog: Array.from({ length: 100 }, (_, index) => ({ id: `github:example/page-${index}`, name: `Result ${index}`, author: 'Example', repositoryUrl: 'https://github.com/example/plugin' })),
    page: 1, total: 1250, hasMore: true,
  })
  controller.update(state)
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog .plugin-card').length === 100 && !document.getElementById('plugins-more').disabled")
  await contents.executeJavaScript("window.firstPluginCard = document.querySelector('#plugins-catalog .plugin-card'); document.getElementById('settings-content').scrollTop = 300; document.getElementById('plugins-more').click()")
  await expectDom(contents, "document.getElementById('plugins-catalog-error').hidden === false")
  assert.equal(await contents.executeJavaScript("document.body.textContent.includes('private-remote-error')"), false)
  assert.equal(await contents.executeJavaScript("document.querySelectorAll('#plugins-catalog .plugin-card').length === 100 && window.firstPluginCard === document.querySelector('#plugins-catalog .plugin-card')"), true, 'Failed next page preserves cards')
  await expectDom(contents, "document.getElementById('plugins-more').disabled === false")
  await contents.executeJavaScript("document.getElementById('plugins-more').click()")
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog .plugin-card').length === 200")
  assert.equal(await contents.executeJavaScript("window.firstPluginCard === document.querySelector('#plugins-catalog .plugin-card') && document.getElementById('settings-content').scrollTop === 300"), true, 'Appending a page preserves existing DOM and scroll')
  assert.equal(await contents.executeJavaScript("document.getElementById('plugins-catalog-limit').textContent.includes('1000') && document.getElementById('plugins-catalog-limit').hidden === false"), true)

  // A synthetic clock exercises expiry without making requests or waiting out real rate limits.
  const cooldownNow = Date.now()
  await contents.executeJavaScript(`(() => {
    window.pluginCooldownNow = ${cooldownNow}
    window.originalDateNow = Date.now
    Date.now = () => window.pluginCooldownNow
    window.originalSetInterval = window.setInterval
    window.originalClearInterval = window.clearInterval
    window.pluginCooldownIntervals = new Map()
    window.setInterval = (callback, delay) => {
      const id = window.originalSetInterval(callback, delay)
      window.pluginCooldownIntervals.set(id, { callback, delay })
      return id
    }
    window.clearInterval = id => { window.pluginCooldownIntervals.delete(id); window.originalClearInterval(id) }
    window.advancePluginClock = ms => {
      window.pluginCooldownNow += ms
      for (const { callback } of [...window.pluginCooldownIntervals.values()]) callback()
    }
  })()`)
  state.plugins.rateLimits = { searchUntil: cooldownNow + 5000, refreshUntil: cooldownNow + 6000,
    metadataUntil: cooldownNow + 7000, checkUntil: cooldownNow + 4000 }
  controller.update(state)
  await expectDom(contents, "document.getElementById('plugins-refresh').textContent.includes('6秒') && document.getElementById('plugins-check').textContent.includes('7秒') && document.getElementById('plugins-more').textContent.includes('5秒')")
  assert.equal(await contents.executeJavaScript("['plugins-refresh','plugins-check','plugins-more'].every(id => document.getElementById(id).disabled) && !document.getElementById('plugin-search').disabled"), true)
  await contents.executeJavaScript("document.getElementById('toast').hidden = true; document.getElementById('settings-content').scrollTop = 0")
  window.setSize(680, 520)
  await pause(80)
  await checkLayout(contents, 'plugins-cooldown-narrow-light', layouts)
  await screenshot(contents, 'plugins-cooldown-narrow-light')
  await contents.executeJavaScript("document.getElementById('plugin-tab-installed').click()")
  await checkLayout(contents, 'plugins-check-cooldown-narrow-light', layouts)
  await screenshot(contents, 'plugins-check-cooldown-narrow-light')
  await contents.executeJavaScript("document.getElementById('plugin-tab-store').click()")
  window.setSize(820, 660)
  await pause(80)
  await contents.executeJavaScript("document.getElementById('toast').hidden = true; window.cooldownCard = document.querySelector('#plugins-catalog .plugin-card'); window.cooldownFocus = window.cooldownCard.querySelector('[data-action=plugin-source]'); window.cooldownFocus.focus({preventScroll:true}); document.getElementById('settings-content').scrollTop = 300; window.advancePluginClock(1000)")
  const beforeCooldownExpiry = actions.length
  assert.equal(await contents.executeJavaScript("document.getElementById('plugins-refresh').textContent.includes('5秒') && document.getElementById('plugins-check').textContent.includes('6秒') && document.getElementById('plugins-more').textContent.includes('4秒')"), true)
  assert.equal(await contents.executeJavaScript("window.cooldownCard === document.querySelector('#plugins-catalog .plugin-card') && document.activeElement === window.cooldownFocus && document.getElementById('settings-content').scrollTop === 300"), true, 'Countdown ticks preserve card identity, focus and scroll')
  assert.equal(await contents.executeJavaScript("window.pluginCooldownIntervals.size === 1 && [...window.pluginCooldownIntervals.values()][0].delay === 1000"), true, 'One local timer runs once per second')
  await contents.executeJavaScript("window.advancePluginClock(5000)")
  assert.equal(await contents.executeJavaScript("!document.getElementById('plugins-refresh').disabled && !document.getElementById('plugins-more').disabled && document.getElementById('plugins-check').disabled"), true, 'Independent request budgets expire separately')
  await contents.executeJavaScript("window.advancePluginClock(1000)")
  assert.equal(await contents.executeJavaScript("!document.getElementById('plugins-check').disabled && window.pluginCooldownIntervals.size === 0"), true, 'Timer stops when the last cooldown expires')
  assert.equal(await contents.executeJavaScript("window.cooldownCard === document.querySelector('#plugins-catalog .plugin-card') && document.activeElement === window.cooldownFocus && document.getElementById('settings-content').scrollTop === 300"), true, 'Expiry also preserves cards, focus and scroll')
  await pause(80)
  assert.equal(actions.length, beforeCooldownExpiry, 'Cooldown expiry sends no automatic IPC or network requests')

  limitedSearchUntil = cooldownNow + 30_000
  state.plugins.rateLimits = { searchUntil: limitedSearchUntil }
  controller.update(state)
  await contents.executeJavaScript("document.getElementById('plugin-search').focus(); document.getElementById('plugin-search').value = '主题'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('“主题”：GitHub') && document.querySelectorAll('#plugins-catalog .plugin-card').length === 1")
  assert.equal(await contents.executeJavaScript("document.getElementById('plugins-refresh').disabled && !document.getElementById('plugin-search').disabled"), true, 'Cached queries remain available during a server cooldown')
  await contents.executeJavaScript("window.retainedCooldownCard = document.querySelector('#plugins-catalog .plugin-card'); document.getElementById('plugin-search').value = 'uncached'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expect(() => actions.at(-1)?.query === 'uncached')
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('当前保留“主题”的 1 条结果') && !document.getElementById('plugins-catalog').hidden")
  assert.equal(await contents.executeJavaScript("window.retainedCooldownCard === document.querySelector('#plugins-catalog .plugin-card') && document.activeElement.id === 'plugin-search' && document.getElementById('plugin-search').value === 'uncached' && document.getElementById('toast').hidden && !document.body.textContent.includes('private-network-message')"), true, 'Rate-limited uncached query retains correctly labeled results and shows no generic failure toast')
  const beforeSearchCooldownExpiry = actions.length
  limitedSearchUntil = 0
  await contents.executeJavaScript("window.advancePluginClock(30_000)")
  await pause(80)
  assert.equal(actions.length, beforeSearchCooldownExpiry, 'A rejected query is not automatically retried at expiry')
  await contents.executeJavaScript("document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expect(() => actions.length === beforeSearchCooldownExpiry + 1)
  await expectDom(contents, "document.getElementById('plugins-catalog-status').textContent.includes('“uncached”：GitHub')")
  assert.equal(await contents.executeJavaScript("window.pluginCooldownIntervals.size === 0"), true)
  state.plugins.rateLimits = {}
  controller.update(state)
  await contents.executeJavaScript("Date.now = window.originalDateNow; window.setInterval = window.originalSetInterval; window.clearInterval = window.originalClearInterval; void 0")
  const beforeBadSearch = actions.length
  await contents.executeJavaScript("document.getElementById('plugin-search').value = 'topic:other'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await pause(550)
  assert.equal(actions.length, beforeBadSearch, 'Advanced syntax is not sent to the main process')
  await contents.executeJavaScript("document.getElementById('plugin-search').value = 'a '.repeat(50).trim(); document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await pause(550)
  assert.equal(actions.length, beforeBadSearch, 'Overlong constructed search expressions are rejected inline')
  assert.equal(await contents.executeJavaScript("document.getElementById('plugin-search').getAttribute('aria-invalid') === 'true' && document.getElementById('plugins-catalog-status').textContent.includes('关键词过多')"), true)
  await contents.executeJavaScript("document.getElementById('plugin-search').value = '极光'; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))")
  await expectDom(contents, "document.querySelectorAll('#plugins-catalog .plugin-card').length === 1 && !document.querySelector('#plugins-catalog [data-action=plugin-install]').disabled")
  await contents.executeJavaScript("document.querySelector('#plugins-catalog [data-action=plugin-install]').click()")
  await expect(() => actions.at(-1)?.type === 'plugin-install')
  assert.deepEqual(actions.at(-1), { type: 'plugin-install', id: 'npm:aurora-theme' })
  await contents.executeJavaScript("document.querySelector('#plugins-catalog [data-action=plugin-source]').click()")
  await expect(() => actions.at(-1)?.type === 'plugin-source')
  assert.deepEqual(actions.at(-1), { type: 'plugin-source', id: 'npm:aurora-theme' })
  await expectDom(contents, "document.querySelector('#plugins-catalog [data-action=plugin-source]').disabled === false")
  await contents.executeJavaScript("document.getElementById('plugin-search').value = ''; document.getElementById('plugin-search').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('plugin-search').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); document.getElementById('plugin-tab-installed').click()")
  await expectDom(contents, "document.getElementById('plugin-panel-installed').hidden === false")
  await expectDom(contents, "document.querySelector('#plugins-installed [data-action=plugin-update]').disabled === false")
  assert.equal(await contents.executeJavaScript("document.querySelector('#plugins-installed [data-plugin-id=\"npm:official-component\"]').disabled"), true)
  await contents.executeJavaScript("document.querySelector('#plugins-installed [data-action=plugin-update]').click()")
  await expect(() => actions.at(-1)?.type === 'plugin-update')
  assert.deepEqual(actions.at(-1), { type: 'plugin-update', id: 'npm:@example/workflow' })
  await contents.executeJavaScript("document.querySelector('#plugins-installed [data-action=plugin-remove][data-plugin-id=\"github:example/local-theme\"]').click()")
  await expect(() => actions.at(-1)?.type === 'plugin-remove')
  assert.deepEqual(actions.at(-1), { type: 'plugin-remove', id: 'github:example/local-theme' })
  await contents.executeJavaScript("document.getElementById('plugins-check').click()")
  await expect(() => actions.at(-1)?.type === 'plugins-check')
  assert.deepEqual(actions.at(-1), { type: 'plugins-check' })
  await expectDom(contents, "document.getElementById('plugins-checked-at').textContent.includes('上次检查')")
  const beforePluginInvalid = actions.length
  assert.equal((await contents.executeJavaScript("window.clientSettings.action({type:'plugin-install',id:'plugin',command:'npm install'})")).ok, false)
  assert.equal(actions.length, beforePluginInvalid)
  await screenshot(contents, 'plugins-installed-light')
  state.plugins.busy = true
  state.plugins.progress = { label: '正在更新插件', detail: '正在校验软件包，完成后更新本地配置。', percent: 45 }
  controller.update(state)
  await expectDom(contents, "document.querySelector('#plugins-installed [data-action=plugin-update]').disabled === true")
  await expectDom(contents, "document.getElementById('plugins-progress-meter').value === 45")
  controller.update(state)
  assert.equal(await contents.executeJavaScript("document.querySelector('#plugins-installed [data-action=plugin-update]').disabled"), true, 'Repeated state updates retain disabled plugin actions')
  await screenshot(contents, 'plugins-progress-light')
  state.plugins.busy = false
  state.plugins.progress = null
  state.plugins.error = 'secret token=123 stack trace'
  controller.update(state)
  await expectDom(contents, "document.getElementById('plugins-error').hidden === false")
  assert.equal(await contents.executeJavaScript("document.body.textContent.includes('secret token')"), false)
  state.plugins.error = undefined
  controller.update(state)
  await contents.executeJavaScript("document.getElementById('tab-network').click(); document.getElementById('tab-plugins').click()")
  await pause(80)
  assert.equal(actions.filter(action => action.type === 'plugins-refresh').length, 1, 'Returning to the page does not re-fetch unnecessarily')

  window.setSize(680, 520)
  await pause(150)
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await expectDom(contents, `document.documentElement.dataset.theme === '${theme}'`)
    for (const section of ['harness', 'plugins', 'network', 'client', 'about']) {
      await contents.executeJavaScript(`document.getElementById('tab-${section}').click(); document.getElementById('toast').hidden = true`)
      await expectDom(contents, `document.getElementById('panel-${section}').hidden === false`)
      await pause(60)
      await checkLayout(contents, `${section}-narrow-${theme}`, layouts)
      await screenshot(contents, `${section}-narrow-${theme}`)
      if (section === 'plugins') {
        await contents.executeJavaScript("document.getElementById('plugin-tab-store').click()")
        await checkLayout(contents, `plugins-store-narrow-${theme}`, layouts)
        await screenshot(contents, `plugins-store-narrow-${theme}`)
        await contents.executeJavaScript("document.getElementById('plugin-tab-installed').click()")
      }
    }
  }
  await contents.executeJavaScript("document.getElementById('settings-content').scrollTop = 40")
  const scroll = await contents.executeJavaScript("document.getElementById('settings-content').scrollTop")
  assert.ok(scroll > 0, 'Narrow about panel should scroll within main')
  state.harness.status = 'installing'
  controller.update(state)
  await expectDom(contents, "document.getElementById('harness-primary').disabled === true")
  assert.equal(await contents.executeJavaScript("document.getElementById('settings-content').scrollTop"), scroll)
  assert.equal(await contents.executeJavaScript("document.getElementById('panel-about').hidden"), false)
  assert.equal(await contents.executeJavaScript("document.getElementById('download-source').disabled"), true)
  window.close()
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.isVisible(), false)
  controller.show('network')
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await expectDom(contents, "document.getElementById('panel-network').hidden === false")
  assert.equal(window.isVisible(), true)
  await contents.executeJavaScript("window.setInterval = (callback, delay) => { const id = window.originalSetInterval(callback, delay); window.pluginCooldownIntervals.set(id, {callback,delay}); return id }; window.clearInterval = id => { window.pluginCooldownIntervals.delete(id); window.originalClearInterval(id) }; void 0")
  state.plugins.rateLimits = { checkUntil: Date.now() + 30_000 }
  controller.update(state)
  await expectDom(contents, 'window.pluginCooldownIntervals.size === 1')
  await contents.executeJavaScript("window.dispatchEvent(new Event('beforeunload'))")
  assert.equal(await contents.executeJavaScript('window.pluginCooldownIntervals.size'), 0, 'Unloading clears the live countdown timer')
  controller.dispose()
  assert.equal(window.isDestroyed(), true)
  assert.equal(ipcMain.listenerCount(SETTINGS_IPC.ready), 0)
  assert.deepEqual(logs, [])
  writeFileSync(join(screenshots, 'settings-smoke-result.json'), `${JSON.stringify({ passed: true, layouts, actions, isolatedProfile: true, realNetworkRequests: false }, null, 2)}\n`)
  process.stdout.write('settings-smoke:passed (five sections, plugin discovery/manual actions, safe text, narrow layout, themes, real preload/actions, focus/scroll retention, hide/reopen, disposal; isolated mock data only)\n')
  app.quit()
}

async function checkLayout(contents, name, layouts) {
  const layout = await contents.executeJavaScript(`(() => {
    const main = document.getElementById('settings-content')
    const panel = document.querySelector('section:not([hidden])')
    const outside = [...panel.querySelectorAll('button,select,input,h1,h2,.card,.notice')].filter(element => {
      if (!element.getClientRects().length) return false
      const rect = element.getBoundingClientRect()
      return rect.left < main.getBoundingClientRect().left - 1 || rect.right > innerWidth + 1
    }).map(element => element.id || element.tagName)
    return { width:innerWidth,height:innerHeight,rootWidth:document.documentElement.scrollWidth,
      mainWidth:main.clientWidth,mainScrollWidth:main.scrollWidth,mainScrollHeight:main.scrollHeight,
      panelWidth:panel.clientWidth,panelScrollWidth:panel.scrollWidth,outside }
  })()`)
  layouts.push({ name, ...layout })
  assert.ok(layout.rootWidth <= layout.width, `${name}: root horizontal overflow ${JSON.stringify(layout)}`)
  assert.ok(layout.mainScrollWidth <= layout.mainWidth + 1, `${name}: main horizontal overflow ${JSON.stringify(layout)}`)
  assert.ok(layout.panelScrollWidth <= layout.panelWidth + 1, `${name}: panel horizontal overflow ${JSON.stringify(layout)}`)
  assert.deepEqual(layout.outside, [], `${name}: controls outside main viewport`)
}
async function screenshot(contents, name) {
  await pause(80)
  writeFileSync(join(screenshots, `settings-smoke-${name}.png`), (await contents.capturePage()).toPNG())
}
const pause = duration => new Promise(resolve => setTimeout(resolve, duration))
async function expect(predicate) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return
    await pause(20)
  }
  throw new Error('Settings smoke condition timed out')
}
const expectDom = (contents, expression) => expect(() => contents.executeJavaScript(expression))
void run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); controller?.dispose(); app.exit(1) })
