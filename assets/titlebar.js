const HEX_COLOR = /^#[0-9A-F]{6}$/u
const root = document.documentElement
const MAX_GRADIENT_STOPS = 64
let activeBackgroundLayer = 'a'
let currentBackground

const unsubscribe = window.harnessTitlebar.onState(value => {
  if (!isTitlebarState(value)) return
  const background = value.snapshot.mode === 'solid'
    ? value.snapshot.stops[0].color
    : `linear-gradient(90deg, ${value.snapshot.stops.map(stop => `${stop.color} ${String(stop.offset * 100)}%`).join(', ')})`
  applyBackground(background)
  root.style.setProperty('--titlebar-foreground', value.snapshot.foreground)
  root.dataset.focused = String(value.focused)
  root.dataset.fullscreen = String(value.fullscreen)
})

const maximizeButton = document.getElementById('window-maximize')
document.getElementById('window-minimize').addEventListener('click', () => { window.harnessWindowControls.minimize() })
maximizeButton.addEventListener('click', () => { window.harnessWindowControls.toggleMaximize() })
document.getElementById('window-close').addEventListener('click', () => { window.harnessWindowControls.close() })
const unsubscribeControls = window.harnessWindowControls.onState(value => {
  if (!hasExactKeys(value, ['maximized']) || typeof value.maximized !== 'boolean') return
  root.dataset.maximized = String(value.maximized)
  const label = value.maximized ? '还原' : '最大化'
  maximizeButton.setAttribute('aria-label', label)
})

window.addEventListener('beforeunload', () => { unsubscribe(); unsubscribeControls() }, { once: true })

function isTitlebarState(value) {
  if (!hasExactKeys(value, ['focused', 'fullscreen', 'snapshot'])) return false
  if (typeof value.focused !== 'boolean' || typeof value.fullscreen !== 'boolean') return false
  return isSnapshot(value.snapshot)
}

function isSnapshot(value) {
  if (!hasExactKeys(value, ['mode', 'stops', 'foreground', 'source'])) return false
  if (value.mode !== 'solid' && value.mode !== 'gradient') return false
  if (value.source !== 'capture' && value.source !== 'fallback') return false
  if (value.foreground !== '#000000' && value.foreground !== '#FFFFFF') return false
  if (!Array.isArray(value.stops)) return false
  if (value.mode === 'solid' && value.stops.length !== 1) return false
  if (value.mode === 'gradient' && (value.stops.length < 2 || value.stops.length > MAX_GRADIENT_STOPS)) return false
  return value.stops.every((stop, index) => (
    hasExactKeys(stop, ['offset', 'color'])
    && stop.offset === (value.mode === 'solid' ? 0 : index / (value.stops.length - 1))
    && typeof stop.color === 'string'
    && HEX_COLOR.test(stop.color)
  ))
}

function applyBackground(background) {
  if (background === currentBackground) return
  if (currentBackground === undefined) {
    root.style.setProperty('--titlebar-background-a', background)
    root.style.setProperty('--titlebar-background-b', background)
    currentBackground = background
    return
  }
  const nextLayer = activeBackgroundLayer === 'a' ? 'b' : 'a'
  root.style.setProperty(`--titlebar-background-${nextLayer}`, background)
  root.dataset.backgroundLayer = nextLayer
  activeBackgroundLayer = nextLayer
  currentBackground = background
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const required = [...expected].sort()
  return keys.length === required.length && keys.every((key, index) => key === required[index])
}
