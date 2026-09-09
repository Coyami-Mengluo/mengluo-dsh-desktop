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

window.harnessUpdateProgress.onState(state => {
  if (state === null || typeof state !== 'object' || !order.includes(state.stage)) return
  latestState = state
  document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light'
  document.body.classList.toggle('failed', state.status === 'failed')
  label.textContent = typeof state.label === 'string' ? state.label : 'Harness 更新'
  version.textContent = typeof state.version === 'string' && state.version !== '' ? `目标版本 ${state.version}` : ''
  detail.textContent = typeof state.detail === 'string' ? state.detail : ''
  renderProgress(state.percent, { failed: state.status === 'failed' })
  if (state.status === 'failed') {
    percent.textContent = '失败'
  } else if (Number.isFinite(state.percent)) {
    percent.textContent = `${String(state.percent)}%`
  } else {
    percent.textContent = '进行中'
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
})
