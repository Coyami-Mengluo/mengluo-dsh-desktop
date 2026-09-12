import { tr, onLanguageChange } from './i18n.js'
import { createProgressMeter } from './progress-meter.js'

const byId = id => document.getElementById(id)
const meter = createProgressMeter(byId('progress'))
const labels = { idle: '客户端已是最新版', checking: '检查客户端更新', available: '发现新版客户端', downloading: '下载客户端更新', downloaded: '客户端更新已准备好', installing: '正在关闭 Harness，准备安装', error: '客户端更新未完成' }
const size = value => `${(value / 1024 / 1024).toFixed(1)} MB`
byId('check').addEventListener('click', () => { window.clientUpdate.check() })
byId('download').addEventListener('click', () => { window.clientUpdate.download() })
byId('install').addEventListener('click', () => { window.clientUpdate.install() })
let latestState
function render(state) {
  if (!state || !Object.hasOwn(labels, state.status)) return
  latestState = state
  document.documentElement.dataset.dark = String(state.dark === true)
  byId('status').textContent = tr(labels[state.status])
  byId('version').textContent = tr`当前 ${state.currentVersion ?? '—'}${state.version ? ` → ${state.version}` : ''}`
  const active = ['checking', 'downloading', 'installing'].includes(state.status)
  meter(state.percent, { hidden: !active && state.status !== 'downloaded' })
  const parts = []
  if (state.status === 'downloading' && Number.isFinite(state.transferred)) {
    parts.push(tr`已传输 ${size(state.transferred)}${state.total ? ` / ${size(state.total)}` : ''}`)
    if (state.speed) parts.push(`${size(state.speed)}/s`)
    if (Number.isFinite(state.remainingSeconds)) parts.push(tr`预计剩余 ${state.remainingSeconds < 60 ? tr`${state.remainingSeconds} 秒` : tr`${Math.ceil(state.remainingSeconds / 60)} 分钟`}`)
  }
  byId('transfer').textContent = parts.join(' · ') || (state.status === 'downloading' ? tr('正在准备差分信息或校验缓存…') : '')
  byId('error').hidden = state.status !== 'error'
  byId('error').textContent = tr(state.error ?? '')
  byId('check').disabled = active
  byId('download').hidden = !state.version || !['available', 'error'].includes(state.status)
  byId('install').hidden = state.status !== 'downloaded'
}
const unsubscribe = window.clientUpdate.onState(render)
onLanguageChange(() => { if (latestState) render(latestState) })
window.addEventListener('beforeunload', unsubscribe, { once: true })
