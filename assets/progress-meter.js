/**
 * Render measured progress without coupling continuous motion to IPC cadence.
 * @param {HTMLElement} element local meter with a progress-fill child and progressbar semantics.
 * @returns {(percent?: number, options?: { hidden?: boolean, failed?: boolean }) => void} renderer; unknown or invalid totals remain indeterminate.
 */
export function createProgressMeter(element) {
  const fill = element.querySelector('.progress-fill')
  let previousMode
  let previousPercent
  return (percent, { hidden = false, failed = false } = {}) => {
    const measured = Number.isFinite(percent) && percent >= 0 && percent <= 100
    const mode = failed ? 'failed' : measured ? 'determinate' : 'indeterminate'
    if (element.hidden !== hidden) element.hidden = hidden
    if (mode !== previousMode) {
      element.dataset.mode = mode
      if (mode === 'determinate') element.removeAttribute('aria-valuetext')
      else {
        element.removeAttribute('aria-valuenow')
        element.setAttribute('aria-valuetext', failed ? '失败' : '进行中，尚无可用总量')
      }
    }
    const target = failed ? 100 : measured ? percent : 0
    if (target !== previousPercent || mode !== previousMode) {
      fill.style.transform = `scaleX(${target / 100})`
      if (mode === 'determinate') element.setAttribute('aria-valuenow', String(percent))
    }
    previousMode = mode
    previousPercent = target
  }
}
