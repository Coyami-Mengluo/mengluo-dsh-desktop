import { tr } from './i18n.js'
/** Format the bounded update estimate without claiming false percentage precision. */
export function formatUpdateTiming(state, currentTime = Date.now()) {
  const timing = state?.timing
  if (timing === null || typeof timing !== 'object'
    || !Number.isFinite(timing.startedAt)
    || !Number.isFinite(timing.estimateMinMs)
    || !Number.isFinite(timing.estimateMaxMs)
    || !Number.isFinite(timing.timeoutMs)) return ''

  const elapsedMs = Math.max(0, currentTime - timing.startedAt)
  const elapsed = formatDuration(elapsedMs)
  if (state.status === 'complete') return tr`本次共用时 ${elapsed}`
  if (state.status === 'failed') return tr`本次在 ${elapsed} 后停止，当前版本未受影响`

  const timeoutMinutes = Math.round(timing.timeoutMs / 60_000)
  if (elapsedMs > timing.estimateMaxMs) {
    return state.stage === 'installing'
      ? tr`已用 ${elapsed} · 已超过通常耗时，npm 安装上限 ${String(timeoutMinutes)} 分钟`
      : tr`已用 ${elapsed} · 已超过通常耗时，正在完成后续校验`
  }
  const minimumMinutes = Math.round(timing.estimateMinMs / 60_000)
  const maximumMinutes = Math.round(timing.estimateMaxMs / 60_000)
  return tr`预计总耗时 ${String(minimumMinutes)}–${String(maximumMinutes)} 分钟 · 已用 ${elapsed} · npm 安装上限 ${String(timeoutMinutes)} 分钟`
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return tr`${String(minutes)}分${String(seconds).padStart(2, '0')}秒`
}
