import { tr, onLanguageChange } from './i18n.js'
import { formatUpdateTiming } from './update-progress-timing.js'
import { createProgressMeter } from './progress-meter.js'

const order = ['checking', 'preparing', 'installing', 'verifying', 'smoke', 'finalizing', 'complete']
const label = document.querySelector('#stage-label')
const version = document.querySelector('#version-label')
const percent = document.querySelector('#percent-label')
const renderProgress = createProgressMeter(document.querySelector('#progress'))
const detail = document.querySelector('#detail')
const timing = document.querySelector('#timing-label')
const stages = [...document.querySelectorAll('[data-stage]')]
let latestState
let timingTimer

function renderTiming() {
  timing.textContent = formatUpdateTiming(latestState)
}

function render(state) {
  if (state === null || typeof state !== 'object' || !order.includes(state.stage)) return
  latestState = state
  document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light'
  document.body.classList.toggle('failed', state.status === 'failed')
  label.textContent = typeof state.label === 'string' ? tr(state.label) : tr('Harness 更新')
  version.textContent = typeof state.version === 'string' && state.version !== '' ? tr`目标版本 ${state.version}` : ''
  detail.textContent = typeof state.detail === 'string' ? tr(state.detail) : ''
  renderProgress(state.percent, { failed: state.status === 'failed' })
  if (state.status === 'failed') {
    percent.textContent = tr('失败')
  } else if (Number.isFinite(state.percent)) {
    percent.textContent = `${String(state.percent)}%`
  } else {
    percent.textContent = tr('进行中')
  }
  const activeIndex = order.indexOf(state.stage)
  for (const item of stages) {
    const index = order.indexOf(item.dataset.stage)
    item.classList.toggle('done', state.status === 'complete' || index < activeIndex)
    item.classList.toggle('active', index === activeIndex)
  }
  clearInterval(timingTimer)
  renderTiming()
  if (state.status === 'running') timingTimer = setInterval(renderTiming, 1_000)
}
const unsubscribe = window.harnessUpdateProgress.onState(render)
onLanguageChange(() => { if (latestState) render(latestState) })
window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(timingTimer) }, { once: true })
