(() => {
  'use strict'
  const api = window.clientSettings
  const byId = id => document.getElementById(id)
  const tabs = [...document.querySelectorAll('[data-section]')]
  const busyActions = new Set()
  let latest = {}
  let section = 'harness'
  let lastSectionRevision = -1
  let pluginTab = 'store'
  let pluginsRequested = false
  let pluginSearchTimer
  let pluginSearchComposing = false
  let pluginSearchEdited = false
  let pluginSearchRevision = 0
  let pluginSearchPending
  let toastTimer
  const scrollPositions = new Map()
  const pluginListSignatures = new Map()
  const text = (id, value) => { const element = byId(id); const next = String(value ?? ''); if (element.textContent !== next) element.textContent = next }
  const show = (id, visible) => { byId(id).hidden = !visible }
  const disable = (id, value) => { byId(id).disabled = Boolean(value) }
  const selectValue = (id, value) => { const input = byId(id); if (document.activeElement !== input && value !== undefined) input.value = value }
  const checkbox = (id, value) => { byId(id).checked = Boolean(value) }
  const badge = (id, label, tone = '') => { text(id, label); byId(id).dataset.tone = tone }
  const version = value => typeof value === 'string' && value.length < 80 ? value : '—'
  const bytes = value => Number.isFinite(value) && value >= 0 ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—'
  const primary = (scope, label, action, disabled = false) => {
    text(`${scope}-primary`, label)
    byId(`${scope}-primary`).dataset.action = action
    disable(`${scope}-primary`, disabled || busyActions.has(action))
  }
  function chooseSection(next, focus = false) {
    if (!tabs.some(tab => tab.dataset.section === next)) return
    const content = byId('settings-content')
    scrollPositions.set(section, content.scrollTop)
    section = next
    for (const tab of tabs) {
      const selected = tab.dataset.section === section
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      byId(`panel-${tab.dataset.section}`).hidden = !selected
      if (selected && focus) tab.focus()
    }
    content.scrollTop = scrollPositions.get(section) ?? 0
    if (next === 'plugins' && !pluginsRequested) {
      pluginsRequested = true
      void act({ type: 'plugins-refresh' })
    }
  }
  function toast(message) {
    clearTimeout(toastTimer)
    text('toast', message)
    show('toast', true)
    toastTimer = setTimeout(() => show('toast', false), 4200)
  }
  function choosePluginTab(next, focus = false) {
    if (!['store', 'installed'].includes(next)) return
    pluginTab = next
    for (const tab of document.querySelectorAll('[data-plugin-tab]')) {
      const selected = tab.dataset.pluginTab === next
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      byId(`plugin-panel-${tab.dataset.pluginTab}`).hidden = !selected
      if (selected && focus) tab.focus()
    }
  }
  const pluginItems = items => Array.isArray(items) ? items.filter(item => item && typeof item.id === 'string'
    && /^[A-Za-z0-9@][A-Za-z0-9@/_.:-]{0,239}$/u.test(item.id)).slice(0, 1000) : []
  const pluginText = (value, limit = 800) => typeof value === 'string' ? value.slice(0, limit) : ''
  const normalizedPluginQuery = value => {
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
      || /[^\p{L}\p{M}\p{N}\s._/-]/u.test(value)) return undefined
    const query = value.trim().replace(/\s+/gu, ' ')
    if (query.split(' ').some(word => /^(?:AND|OR|NOT)$/iu.test(word))) return undefined
    const expression = query ? `topic:dsh-plugin archived:false fork:false ${query.split(' ').map(word => `"${word}"`).join(' ')} in:name,description,readme` : ''
    return expression.length > 256 ? undefined : query
  }
  function renderPluginList(id, items, installedItems, pluginState, operationBusy) {
    const isInstalledList = id === 'plugins-installed'
    const itemSignatures = items.map(item => JSON.stringify(item))
    const context = JSON.stringify([installedItems, operationBusy, pluginState.installedRuntime, busyActions.has('plugin-source')])
    const signature = JSON.stringify([itemSignatures, context])
    const previous = pluginListSignatures.get(id)
    if (previous?.signature === signature) return
    const append = previous?.context === context && itemSignatures.length >= previous.items.length
      && previous.items.every((value, index) => itemSignatures[index] === value)
    const firstNew = append ? previous.items.length : 0
    pluginListSignatures.set(id, { signature, context, items: itemSignatures })
    const container = byId(id)
    const previousScroll = byId('settings-content').scrollTop
    const focused = container.contains(document.activeElement) ? {
      action: document.activeElement.dataset.action, id: document.activeElement.dataset.pluginId,
    } : undefined
    const create = (tag, className, value) => {
      const element = document.createElement(tag)
      if (className) element.className = className
      if (value !== undefined) element.textContent = value
      return element
    }
    const cards = items.slice(firstNew).map(item => {
      const matched = isInstalledList ? item : installedItems.find(entry => entry.id === item.installedId
        || entry.id === item.id || (entry.name && entry.name === item.name))
      const installed = matched ?? (item.installed === true ? { id: item.installedId } : undefined)
      const card = create('article', 'card plugin-card')
      const heading = create('div', 'card-heading')
      const title = create('div')
      title.append(create('h2', '', pluginText(item.name, 160) || item.id))
      if (item.name !== item.id) title.append(create('p', 'plugin-package', item.id))
      heading.append(title)
      const label = installed?.managed === false ? '仅展示' : installed?.updateAvailable ? '可更新' : installed ? '已安装' : item.sourceLabel || '社区插件'
      const tag = create('span', 'badge', pluginText(label, 32))
      if (installed && !installed.updateAvailable) tag.dataset.tone = 'good'
      heading.append(tag)
      card.append(heading)
      if (item.description) card.append(create('p', 'detail', pluginText(item.description)))
      const meta = create('div', 'plugin-meta')
      if (item.author) meta.append(create('span', '', `作者：${pluginText(item.author, 160)}`))
      if (item.sourceLabel) meta.append(create('span', '', `来源：${pluginText(item.sourceLabel, 100)}`))
      card.append(meta)
      if (installed) {
        const update = installed.updateAvailable && installed.availableVersion ? ` → ${version(installed.availableVersion)}` : ''
        card.append(create('p', 'plugin-version', `已安装 ${version(installed.version)}${update}`))
        if (installed.managed === false) card.append(create('p', 'detail', '由官方或其他配置管理，不提供更新和卸载。'))
        else if (installed.updateCheckMessage) card.append(create('p', 'detail', pluginText(installed.updateCheckMessage, 240)))
        else if (['unknown', 'unsupported', 'error'].includes(installed.updateCheckStatus)) card.append(create('p', 'detail', '暂时无法确认是否有更新，可查看源码或在终端管理。'))
      } else if (item.version) card.append(create('p', 'plugin-version', `版本 ${version(item.version)}`))
      const actions = create('div', 'actions')
      const action = (label, type, disabled, style = '', identity = item.id) => {
        const button = create('button', style, label)
        button.dataset.action = type
        button.dataset.pluginId = identity
        button.dataset.pluginUnavailable = String(Boolean(disabled))
        button.disabled = Boolean(disabled)
        actions.append(button)
      }
      const unavailable = operationBusy || !pluginState.installedRuntime || installed?.managed === false
      if (!installed) action('安装', 'plugin-install', unavailable, 'primary')
      else if (installed.updateAvailable && (isInstalledList || typeof item.installedId === 'string')) {
        action('更新', 'plugin-update', unavailable, 'primary', isInstalledList ? installed.id : item.installedId)
      }
      if (item.repositoryUrl || installed?.repositoryUrl) action('查看源码', 'plugin-source', false)
      if (isInstalledList) action('卸载', 'plugin-remove', unavailable, 'danger')
      card.append(actions)
      return card
    })
    if (append) container.append(...cards)
    else container.replaceChildren(...cards)
    byId('settings-content').scrollTop = previousScroll
    if (focused?.action && focused.id) {
      [...container.querySelectorAll('button')].find(button => button.dataset.action === focused.action
        && button.dataset.pluginId === focused.id && !button.disabled)?.focus({ preventScroll: true })
    }
  }
  function renderPlugins(state) {
    const plugins = state.plugins ?? {}
    const catalog = pluginItems(plugins.catalog)
    const installed = pluginItems(plugins.installed)
    if (!pluginSearchEdited && typeof plugins.query === 'string') byId('plugin-search').value = plugins.query
    const query = normalizedPluginQuery(byId('plugin-search').value)
    const currentQuery = typeof plugins.query === 'string' ? plugins.query : ''
    const draftPending = pluginSearchComposing || query !== currentQuery
    const queryInvalid = query === undefined
    const catalogPending = draftPending || plugins.catalogLoading || pluginSearchPending?.query === query
    const operationBusy = plugins.busy || plugins.loading || plugins.checking || plugins.recoveryRequired
      || state.harness?.status === 'installing' || state.client?.status === 'installing'
      || ['plugin-install', 'plugin-update', 'plugin-remove'].some(type => busyActions.has(type))
    const progress = plugins.progress ?? {}
    show('plugins-runtime-notice', !plugins.installedRuntime)
    show('plugins-operation', Boolean(plugins.busy || plugins.progress))
    text('plugins-progress-label', pluginText(progress.label, 160) || '正在处理插件…')
    text('plugins-progress-detail', pluginText(progress.detail, 512) || '正在通过当前 Harness 的插件管理机制处理，请稍候。')
    const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : undefined
    if (percent !== undefined) byId('plugins-progress-meter').value = percent
    else byId('plugins-progress-meter').removeAttribute('value')
    show('plugins-progress-percent', percent !== undefined)
    text('plugins-progress-percent', percent !== undefined ? `${Math.floor(percent)}%` : '')
    show('plugins-error', Boolean(plugins.error))
    text('plugins-notice', pluginText(plugins.notice, 800))
    show('plugins-notice', Boolean(plugins.notice))
    text('plugin-installed-count', installed.length)
    text('plugins-refresh', plugins.catalogLoading ? '正在搜索…' : '刷新目录')
    disable('plugins-refresh', operationBusy || plugins.catalogLoading || plugins.loadingMore || draftPending || busyActions.has('plugins-refresh'))
    text('plugins-check', plugins.checking ? '正在检查…' : '检查更新')
    disable('plugins-check', operationBusy || !plugins.installedRuntime || !installed.length || busyActions.has('plugins-check'))
    const checked = plugins.checkedAt ? new Date(plugins.checkedAt) : undefined
    text('plugins-checked-at', checked && Number.isFinite(checked.getTime())
      ? `上次检查：${checked.toLocaleString()} · 不会自动安装` : '只检查更新，不会自动安装。')
    const total = Number.isSafeInteger(plugins.total) && plugins.total >= 0 ? plugins.total : catalog.length
    const queryLabel = currentQuery ? `“${currentQuery}”` : '社区插件'
    text('plugins-catalog-status', queryInvalid ? '搜索词格式不支持或关键词过多，请缩短并使用文字、数字、空格或 . _ / -。'
      : pluginSearchComposing ? '正在输入，选字完成后开始搜索…'
        : draftPending ? '等待搜索新关键词…'
          : catalogPending ? `正在搜索${queryLabel}…${catalog.length ? ` 已保留 ${catalog.length} 条结果。` : ''}`
            : plugins.catalogError ? `搜索未完成。${catalog.length ? `已保留 ${catalog.length} 条结果，可重试。` : '请稍后点击刷新目录重试。'}`
              : catalog.length ? `${queryLabel}：GitHub 匹配 ${total} 个，已加载 ${catalog.length} 个${plugins.loadingMore ? ' · 正在加载更多…' : ''}`
                : plugins.page > 0 ? '没有匹配的插件，试试其他关键词。' : '暂无插件，请点击刷新目录。')
    byId('plugin-search').setAttribute('aria-invalid', String(queryInvalid))
    byId('plugins-catalog').setAttribute('aria-busy', String(Boolean(catalogPending || plugins.loadingMore)))
    show('plugins-catalog', !draftPending && !queryInvalid)
    show('plugins-catalog-error', Boolean(plugins.catalogError && !draftPending && !plugins.catalogLoading))
    text('plugins-catalog-error', '目录搜索未完成，请检查系统代理或稍后重试；GitHub 可能暂时限流。已有结果不会被清除。')
    const moreVisible = plugins.hasMore || plugins.loadingMore
    show('plugins-more', Boolean(moreVisible && !draftPending && !queryInvalid))
    text('plugins-more', plugins.loadingMore ? '正在加载…' : plugins.catalogError ? '重试加载更多' : '加载更多')
    disable('plugins-more', !plugins.hasMore || catalogPending || plugins.loadingMore || draftPending || busyActions.has('plugins-more'))
    text('plugins-catalog-limit', plugins.limitReached || total > 1000
      ? 'GitHub 单次搜索最多展示 1000 条结果。请细化关键词，查找更多插件。'
      : plugins.incomplete ? 'GitHub 本次搜索返回的结果可能不完整，可以稍后刷新重试。' : '')
    show('plugins-catalog-limit', Boolean(!draftPending && (plugins.limitReached || total > 1000 || plugins.incomplete)))
    text('plugins-installed-status', installed.length ? `共 ${installed.length} 个插件${installed.some(item => item.updateAvailable) ? `，${installed.filter(item => item.updateAvailable).length} 个可更新` : ''}`
      : plugins.loading ? '正在读取已安装插件…' : plugins.installedRuntime ? '当前配置还没有额外安装的插件。' : '安装 Harness 后可以在这里管理插件。')
    renderPluginList('plugins-catalog', catalog, installed, plugins, operationBusy)
    renderPluginList('plugins-installed', installed, installed, plugins, operationBusy)
    // Metadata reads temporarily lock mutations without rebuilding otherwise unchanged cards.
    for (const button of document.querySelectorAll('button[data-plugin-id]')) {
      if (['plugin-install', 'plugin-update', 'plugin-remove'].includes(button.dataset.action)) {
        button.disabled = button.dataset.pluginUnavailable === 'true' || Boolean(plugins.catalogLoading || plugins.loadingMore)
      }
    }
  }
  function render(state) {
    latest = state
    for (const button of document.querySelectorAll('button[data-action]:not([data-plugin-id])')) button.disabled = false
    document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light'
    if (Number.isInteger(state.sectionRevision) && state.sectionRevision !== lastSectionRevision) {
      lastSectionRevision = state.sectionRevision
      chooseSection(state.section)
    }
    const harness = state.harness ?? {}
    const client = state.client ?? {}
    const network = state.network ?? {}
    const about = state.about ?? {}
    const installing = harness.status === 'installing'
    const checking = harness.status === 'checking'
    const clientBusy = ['checking', 'downloading', 'installing'].includes(client.status)
    text('harness-version', harness.installed ? version(harness.version) : '尚未安装')
    const harnessStates = {
      idle: [harness.installed ? '已安装' : '未安装', harness.installed ? '可检查官方新版本，或在终端管理插件。' : '首次安装时可选择官方版本和下载源。'],
      checking: ['正在检查', '正在获取官方版本信息…'],
      available: ['发现更新', `可更新至 ${version(harness.availableVersion)}。当前版本仍可继续使用。`],
      installing: ['安装中', '正在准备新的运行环境。可以关闭设置窗口，安装会继续。'],
      pending: ['等待重启', `${version(harness.pendingVersion)} 已准备好，重启后切换版本。`],
      error: ['暂未完成', '操作未完成，当前运行环境未被替换。请重试或查看日志。'],
    }
    const harnessInfo = harnessStates[harness.status] ?? ['准备中', '正在读取 Harness 状态。']
    badge('harness-badge', harnessInfo[0], harness.status === 'error' ? 'error' : harness.status === 'idle' && harness.installed ? 'good' : '')
    text('harness-status', harnessInfo[1])
    if (installing) primary('harness', '正在安装…', 'harness-check', true)
    else if (checking) primary('harness', '正在检查…', 'harness-check', true)
    else if (harness.status === 'pending') primary('harness', '重启并切换', 'harness-restart', client.status === 'installing')
    else if (!harness.installed) primary('harness', '选择版本并安装', 'harness-setup', network.busy)
    else if (harness.status === 'available') primary('harness', '下载更新', 'harness-download', network.busy || client.status === 'installing')
    else primary('harness', '检查更新', 'harness-check', client.status === 'installing')
    show('harness-progress', harness.progressAvailable || installing)
    disable('terminal', !harness.installed || client.status === 'installing')
    if (!busyActions.has('harness-preferences')) checkbox('harness-auto', harness.autoCheck)
    selectValue('harness-interval', harness.interval)
    selectValue('harness-channel', harness.channel)
    disable('harness-auto', installing || checking || busyActions.has('harness-preferences'))
    disable('harness-interval', installing || checking || !harness.autoCheck || busyActions.has('harness-preferences'))
    disable('harness-channel', installing || checking || busyActions.has('harness-preferences'))
    selectValue('download-source', network.source)
    disable('download-source', network.busy || installing || busyActions.has('download-source'))
    show('mirror-notice', network.source === 'npmmirror')
    const source = network.sources?.find(item => item.id === network.source)
    text('source-description', source?.description ?? (network.source === 'npmmirror' ? '国内第三方 npm 镜像，适合部分国内网络。' : '官方 npm 软件包仓库。'))
    text('network-activity', network.activity || (network.probe?.status === 'checking'
      ? '连接检测进行中，完成后可切换下载源。'
      : '安装进行中，下载源将在任务结束后允许切换。'))
    show('network-activity', network.busy || Boolean(network.activity))
    const probing = network.probe?.status === 'checking'
    text('test-connection', probing ? '正在检测…' : '检测当前下载源')
    disable('test-connection', probing || network.busy || busyActions.has('test-connection'))
    text('probe-detail', network.probe?.detail || '检测连通性及响应时间，不下载完整运行环境。')
    text('proxy-status', network.proxyStatus || '跟随系统设置')
    text('client-version', version(client.currentVersion))
    const clientStates = {
      idle: ['已安装', '可检查是否有新的客户端版本。'],
      checking: ['正在检查', '正在从 GitHub 检查客户端更新…'],
      available: ['发现更新', `客户端 ${version(client.version)} 可更新。下载完成后由你确认重启。`],
      downloading: ['下载中', '正在下载并校验安装包，优先复用已有文件。'],
      downloaded: ['等待安装', `客户端 ${version(client.version)} 已准备好。重启安装前请保存工作。`],
      installing: ['安装中', '正在准备退出客户端并启动安装程序…'],
      error: ['暂未完成', '更新未完成，当前客户端仍可使用。请重试或查看日志。'],
    }
    const clientInfo = clientStates[client.status] ?? ['准备中', '正在读取客户端状态。']
    badge('client-badge', client.supported === false ? '手动更新' : clientInfo[0], client.status === 'error' ? 'error' : '')
    text('client-status', clientInfo[1])
    if (client.supported === false) primary('client', '打开下载页面', 'open-client-releases')
    else if (client.status === 'downloaded') primary('client', '重启并安装', 'client-install', installing)
    else if (client.status === 'available') primary('client', '下载更新', 'client-download')
    else primary('client', clientBusy ? { checking: '正在检查…', downloading: '正在下载…', installing: '正在安装…' }[client.status] : '检查更新', 'client-check', clientBusy)
    show('client-progress', ['downloading', 'downloaded', 'installing', 'error'].includes(client.status))
    show('client-download-progress', client.status === 'downloading')
    const meter = byId('client-progress-meter')
    if (Number.isFinite(client.percent)) meter.value = Math.max(0, Math.min(100, client.percent))
    else meter.removeAttribute('value')
    const timing = Number.isFinite(client.remainingSeconds) && client.remainingSeconds > 0 ? ` · 预计剩余 ${Math.ceil(client.remainingSeconds / 60)} 分钟` : ''
    const speed = Number.isFinite(client.speed) && client.speed > 0 ? ` · ${bytes(client.speed)}/s` : ''
    text('client-download-detail', `${bytes(client.transferred)} / ${bytes(client.total)}${speed}${timing}`)
    if (!busyActions.has('client-preferences')) checkbox('client-auto', client.autoCheck)
    disable('client-auto', client.supported === false || client.status === 'installing' || busyActions.has('client-preferences'))
    show('client-support', client.supported === false)
    text('about-product', about.productName || 'MengLuo DSH Desktop')
    text('about-client-version', version(about.clientVersion || client.currentVersion))
    text('sidebar-version', `v${version(about.clientVersion || client.currentVersion)}`)
    text('about-harness-version', harness.installed ? version(about.harnessVersion || harness.version) : '尚未安装')
    disable('open-log', about.logAvailable === false)
    renderPlugins(state)
    for (const button of document.querySelectorAll('button[data-action]')) {
      if (busyActions.has(button.dataset.action)) button.disabled = true
    }
  }
  async function act(request) {
    if (!api || busyActions.has(request.type)) return
    busyActions.add(request.type)
    render(latest)
    try {
      const result = await api.action(request)
      if (result?.ok !== true) toast('操作未完成，请重试或查看日志。')
      else if (['harness-preferences', 'client-preferences'].includes(request.type)) toast('设置已保存。')
      else if (request.type === 'download-source') toast('下载源已保存，仅影响后续安装和更新。')
    } catch { toast('暂时无法完成操作，请重新打开设置后重试。') }
    finally { busyActions.delete(request.type); render(latest) }
  }
  async function searchPlugins() {
    clearTimeout(pluginSearchTimer)
    pluginSearchTimer = undefined
    if (!api || pluginSearchComposing) return
    const query = normalizedPluginQuery(byId('plugin-search').value)
    if (query === undefined) { render(latest); return }
    const plugins = latest.plugins ?? {}
    if (pluginSearchPending?.query === query && pluginSearchPending.revision === pluginSearchRevision) return
    if (query === (plugins.query ?? '') && !plugins.catalogError && (plugins.page > 0 || plugins.catalogLoading)) return
    const revision = pluginSearchRevision
    pluginSearchPending = { query, revision }
    render(latest)
    try {
      // Search requests deliberately bypass busyActions: a newer query must supersede an older request.
      const result = await api.action({ type: 'plugins-search', query })
      if (revision === pluginSearchRevision && result?.ok !== true) toast('搜索未完成，请稍后重试。')
    } catch {
      if (revision === pluginSearchRevision) toast('暂时无法搜索，请稍后重试。')
    } finally {
      if (pluginSearchPending?.revision === revision) pluginSearchPending = undefined
      render(latest)
    }
  }
  function queuePluginSearch() {
    pluginSearchEdited = true
    pluginSearchRevision += 1
    clearTimeout(pluginSearchTimer)
    pluginSearchTimer = undefined
    if (!pluginSearchComposing && normalizedPluginQuery(byId('plugin-search').value) !== undefined) {
      pluginSearchTimer = setTimeout(() => { void searchPlugins() }, 500)
    }
    render(latest)
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => chooseSection(tab.dataset.section))
    tab.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.indexOf(tab)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length
      chooseSection(tabs[next].dataset.section, true)
    })
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]')
    if (!button || button.disabled) return
    if (button.dataset.action === 'plugins-more') {
      const query = normalizedPluginQuery(byId('plugin-search').value)
      if (query !== undefined && query === (latest.plugins?.query ?? '')) void act({ type: 'plugins-more', query })
      return
    }
    void act({ type: button.dataset.action, ...(button.dataset.pluginId ? { id: button.dataset.pluginId } : {}) })
  })
  for (const tab of document.querySelectorAll('[data-plugin-tab]')) {
    tab.addEventListener('click', () => choosePluginTab(tab.dataset.pluginTab))
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      choosePluginTab(event.key === 'Home' ? 'store' : event.key === 'End' ? 'installed'
        : pluginTab === 'store' ? 'installed' : 'store', true)
    })
  }
  byId('plugin-search').addEventListener('input', queuePluginSearch)
  byId('plugin-search').addEventListener('compositionstart', () => {
    pluginSearchComposing = true
    queuePluginSearch()
  })
  byId('plugin-search').addEventListener('compositionend', () => {
    pluginSearchComposing = false
    queuePluginSearch()
  })
  byId('plugin-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || pluginSearchComposing) return
    event.preventDefault()
    void searchPlugins()
  })
  window.addEventListener('beforeunload', () => { clearTimeout(pluginSearchTimer) })
  const preferences = (id, type, key, check = false) => byId(id).addEventListener('change', event => {
    void act({ type, patch: { [key]: check ? event.target.checked : event.target.value } })
  })
  preferences('harness-auto', 'harness-preferences', 'autoCheck', true)
  preferences('harness-interval', 'harness-preferences', 'interval')
  preferences('harness-channel', 'harness-preferences', 'channel')
  preferences('client-auto', 'client-preferences', 'autoCheck', true)
  byId('download-source').addEventListener('change', event => { void act({ type: 'download-source', source: event.target.value }) })
  for (const input of document.querySelectorAll('select')) input.addEventListener('blur', () => render(latest))
  if (api) { api.onState(render); api.ready() }
  else {
    for (const input of document.querySelectorAll('button[data-action], select, input')) input.disabled = true
    toast('无法连接客户端设置，请关闭此窗口后重试。')
  }
})()
