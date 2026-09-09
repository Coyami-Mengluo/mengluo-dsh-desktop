import { createProgressMeter } from './progress-meter.js'

(() => {
  const panel = document.getElementById('setup-panel')
  const select = document.getElementById('setup-version')
  const install = document.getElementById('setup-install')
  const refresh = document.getElementById('setup-refresh')
  const status = document.getElementById('setup-status')
  const reason = document.getElementById('setup-reason')
  const renderProgress = createProgressMeter(document.getElementById('setup-progress'))
  const files = document.getElementById('setup-files')
  const timing = document.getElementById('setup-timing')
  let current
  let catalogKey = ''

  const renderTiming = () => {
    if (current?.status !== 'installing' && current?.status !== 'starting') {
      timing.textContent = ''
      return
    }
    const seconds = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000))
    timing.textContent = `已用 ${Math.floor(seconds / 60)}分${seconds % 60}秒 · 安装参考耗时 10–20 分钟，实际取决于网络和磁盘 · npm 安装上限 30 分钟`
  }
  const unsubscribe = window.harnessSetup.onState(value => {
    current = value
    panel.hidden = !value.visible
    const busy = ['loading', 'installing', 'starting'].includes(value.status)
    const nextKey = JSON.stringify(value.releases)
    if (nextKey !== catalogKey) {
      const selected = select.value
      select.replaceChildren()
      for (const release of value.releases) {
        const option = document.createElement('option')
        option.value = release.version
        option.textContent = `${release.version} · ${release.preview ? '预览版' : '稳定版'}${release.recommended ? '（官方 latest）' : ''}`
        select.append(option)
      }
      select.value = value.releases.some(item => item.version === selected) ? selected
        : (value.releases.find(item => item.recommended)?.version ?? value.releases[0]?.version ?? '')
      catalogKey = nextKey
    }
    if (value.version && busy && value.status !== 'loading') select.value = value.version
    select.disabled = busy || value.releases.length === 0
    install.disabled = busy || value.releases.length === 0
    refresh.disabled = busy
    install.textContent = value.status === 'installing' ? '正在安装…' : value.status === 'starting' ? '正在启动…' : '安装并启动'
    status.textContent = value.detail
    reason.hidden = !value.reason
    reason.textContent = value.reason
    renderProgress(value.percent, { hidden: !busy })
    const activity = value.files
    const counters = []
    if (typeof value.percent === 'number') counters.push(`校验 ${value.percent}%`)
    if (activity?.completedFiles !== undefined) counters.push(`已处理 ${activity.completedFiles}${activity.totalFiles === undefined ? '' : ` / ${activity.totalFiles}`} 个文件`)
    if (activity?.registryRequests !== undefined) counters.push(`仓库请求 ${activity.registryRequests} 次`)
    if (activity?.resolvedDependencies !== undefined) counters.push(`已解析依赖 ${activity.resolvedDependencies} 个`)
    files.textContent = counters.join(' · ')
    renderTiming()
  })
  const report = error => { status.textContent = error.message ?? String(error) }
  refresh.addEventListener('click', () => { void window.harnessSetup.refresh().catch(report) })
  install.addEventListener('click', () => { void window.harnessSetup.install(select.value).catch(report) })
  const timer = setInterval(renderTiming, 1000)
  window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(timer) }, { once: true })
})()
