/**
 * Shell-owned titlebar appearance sampling and its narrow IPC protocol.
 *
 * The module depends only on duck-typed Electron objects so its color decisions
 * remain executable under plain Node tests.
 */

const LIGHT_FALLBACK = Object.freeze([245, 247, 251])
const DARK_FALLBACK = Object.freeze([17, 19, 24])
// Sample only the pixels touching the shell/renderer seam. A taller band blends
// toolbar content into the background and makes the two surfaces visibly differ.
const DEFAULT_BAND_HEIGHT = 8
const DEFAULT_SAMPLE_WIDTH = 64
const DEFAULT_SAMPLE_HEIGHT = 2
// Sidebar and content surfaces often differ by fewer than ten RGB units but the
// seam is still visible across a wide window. Only truly near-uniform captures
// should collapse to one solid color.
const DEFAULT_SOLID_THRESHOLD = 4
const MAX_CAPTURE_DIMENSION = 16_384
const MAX_SAMPLE_DIMENSION = 64
const MIN_GRADIENT_STOPS = 2
const MAX_GRADIENT_STOPS = 64
const HEX_COLOR = /^#[0-9A-F]{6}$/u

/** IPC channels used only by the isolated titlebar WebContentsView. */
export const TITLEBAR_IPC = Object.freeze({
  state: 'mengluo:titlebar:state',
  ready: 'mengluo:titlebar:ready',
})

/**
 * Return a stable light or dark titlebar when renderer capture is unavailable.
 * @param {boolean} dark whether native theme currently resolves to dark.
 * @returns {Readonly<object>} sanitized titlebar appearance snapshot.
 */
export function fallbackTitlebarSnapshot(dark) {
  return freezeSnapshot({
    mode: 'solid',
    stops: [{ offset: 0, color: rgbToHex(dark ? DARK_FALLBACK : LIGHT_FALLBACK) }],
    foreground: dark ? '#FFFFFF' : '#000000',
    source: 'fallback',
  })
}

/**
 * Reduce a small pixel band to either one color or a high-resolution horizontal gradient.
 * @param {object} bitmap decoded pixel data.
 * @param {Uint8Array} bitmap.data tightly packed four-channel pixels.
 * @param {number} bitmap.width pixel width.
 * @param {number} bitmap.height pixel height.
 * @param {'bgra' | 'rgba'} [bitmap.format] channel order; Electron on Windows uses BGRA.
 * @param {object} [options] sampling policy.
 * @param {boolean} [options.darkFallback] fallback used for transparent pixels.
 * @param {number} [options.solidThreshold] maximum RGB distance treated as one color.
 * @returns {Readonly<object>} sanitized titlebar appearance snapshot.
 */
export function sampleTitlebarPixels(bitmap, options = {}) {
  if (bitmap === null || typeof bitmap !== 'object') throw new TypeError('titlebar bitmap must be an object')
  const width = requireDimension(bitmap.width, 'bitmap width', MAX_CAPTURE_DIMENSION)
  const height = requireDimension(bitmap.height, 'bitmap height', MAX_CAPTURE_DIMENSION)
  const format = bitmap.format ?? 'bgra'
  if (format !== 'bgra' && format !== 'rgba') throw new TypeError(`unsupported titlebar bitmap format: ${String(format)}`)
  if (!(bitmap.data instanceof Uint8Array)) throw new TypeError('titlebar bitmap data must be a Uint8Array')
  const expectedBytes = width * height * 4
  if (bitmap.data.byteLength !== expectedBytes) {
    throw new RangeError(`titlebar bitmap length mismatch: expected ${String(expectedBytes)}, received ${String(bitmap.data.byteLength)}`)
  }
  const threshold = options.solidThreshold ?? DEFAULT_SOLID_THRESHOLD
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError('titlebar solid threshold must be a non-negative finite number')
  }

  const fallback = options.darkFallback === true ? DARK_FALLBACK : LIGHT_FALLBACK
  // Each downsampled column becomes one gradient stop. This retains sidebar and
  // content boundaries instead of averaging the entire window into three broad
  // regions that cannot meet the official renderer cleanly.
  const anchors = Array.from(
    { length: width },
    (_unused, x) => averageRegion(bitmap.data, width, height, x, x + 1, format, fallback),
  )
  const maximumDistance = maximumColorDistance(anchors)
  const colors = maximumDistance <= threshold
    ? [averageRegion(bitmap.data, width, height, 0, width, format, fallback)]
    : anchors
  const stops = colors.map((color, index) => ({
    offset: colors.length === 1 ? 0 : index / (colors.length - 1),
    color: rgbToHex(color),
  }))
  return freezeSnapshot({
    mode: colors.length === 1 ? 'solid' : 'gradient',
    stops,
    foreground: selectForeground(colors),
    source: 'capture',
  })
}

/**
 * Capture and downsample the official renderer's top band without renderer injection.
 * @param {object} webContents official renderer WebContents.
 * @param {object} [options] capture dimensions and fallback policy.
 * @param {number} [options.width] visible official-view width in device-independent pixels.
 * @param {number} [options.bandHeight] captured top-band height.
 * @param {number} [options.sampleWidth] horizontal downsample width.
 * @param {number} [options.sampleHeight] vertical downsample height.
 * @param {number} [options.solidThreshold] maximum RGB distance treated as one color.
 * @param {boolean} [options.darkFallback] native-theme fallback and alpha-composite color.
 * @param {(error: unknown) => void} [options.onError] contained diagnostic callback.
 * @returns {Promise<Readonly<object>>} captured appearance or a light/dark fallback.
 */
export async function captureTitlebarSnapshot(webContents, options = {}) {
  const darkFallback = options.darkFallback === true
  try {
    if (webContents === null || typeof webContents !== 'object' || typeof webContents.capturePage !== 'function') {
      throw new TypeError('official webContents does not support capturePage')
    }
    const width = resolveCaptureWidth(webContents, options.width)
    const bandHeight = optionalDimension(options.bandHeight, DEFAULT_BAND_HEIGHT, 'capture band height', MAX_CAPTURE_DIMENSION)
    const sampleWidth = Math.min(width, optionalDimension(
      options.sampleWidth,
      DEFAULT_SAMPLE_WIDTH,
      'sample width',
      MAX_SAMPLE_DIMENSION,
    ))
    const sampleHeight = optionalDimension(
      options.sampleHeight,
      DEFAULT_SAMPLE_HEIGHT,
      'sample height',
      MAX_SAMPLE_DIMENSION,
    )
    const image = await webContents.capturePage({ x: 0, y: 0, width, height: bandHeight })
    if (image === null || typeof image !== 'object' || image.isEmpty?.() === true || typeof image.resize !== 'function') {
      throw new Error('official renderer capture returned an empty image')
    }
    const resized = image.resize({ width: sampleWidth, height: sampleHeight, quality: 'good' })
    if (resized === null || typeof resized !== 'object' || typeof resized.getSize !== 'function' || typeof resized.toBitmap !== 'function') {
      throw new Error('official renderer capture could not be downsampled')
    }
    const size = resized.getSize()
    if (size?.width !== sampleWidth || size?.height !== sampleHeight) {
      throw new Error('official renderer capture returned an unexpected sample size')
    }
    return sampleTitlebarPixels({
      data: resized.toBitmap({ scaleFactor: 1 }),
      width: sampleWidth,
      height: sampleHeight,
      format: 'bgra',
    }, {
      darkFallback,
      solidThreshold: options.solidThreshold,
    })
  } catch (error) {
    reportCaptureError(options.onError, error)
    return fallbackTitlebarSnapshot(darkFallback)
  }
}

/**
 * Test whether an IPC payload is one sanitized titlebar appearance snapshot.
 * @param {unknown} value candidate payload.
 * @returns {boolean} whether the payload is safe to project into CSS.
 */
export function isTitlebarSnapshot(value) {
  if (!hasExactKeys(value, ['mode', 'stops', 'foreground', 'source'])) return false
  if (value.mode !== 'solid' && value.mode !== 'gradient') return false
  if (value.source !== 'capture' && value.source !== 'fallback') return false
  if (value.foreground !== '#000000' && value.foreground !== '#FFFFFF') return false
  if (!Array.isArray(value.stops)) return false
  if (value.mode === 'solid' && value.stops.length !== 1) return false
  if (value.mode === 'gradient'
    && (value.stops.length < MIN_GRADIENT_STOPS || value.stops.length > MAX_GRADIENT_STOPS)) return false
  return value.stops.every((stop, index) => (
    hasExactKeys(stop, ['offset', 'color'])
    && stop.offset === (value.mode === 'solid' ? 0 : index / (value.stops.length - 1))
    && typeof stop.color === 'string'
    && HEX_COLOR.test(stop.color)
  ))
}

/**
 * Build the only state object accepted by the titlebar renderer.
 * @param {object} value native-window and sampled appearance state.
 * @param {boolean} value.focused whether the owner window is focused.
 * @param {boolean} value.fullscreen whether the owner window is fullscreen.
 * @param {unknown} value.snapshot sampled titlebar appearance.
 * @returns {Readonly<object>} frozen, narrow IPC state.
 */
export function createTitlebarState(value) {
  if (!hasExactKeys(value, ['focused', 'fullscreen', 'snapshot'])) {
    throw new TypeError('titlebar state contains unsupported fields')
  }
  if (typeof value.focused !== 'boolean') throw new TypeError('titlebar state focused must be boolean')
  if (typeof value.fullscreen !== 'boolean') throw new TypeError('titlebar state fullscreen must be boolean')
  if (!isTitlebarSnapshot(value.snapshot)) throw new TypeError('titlebar state snapshot is invalid')
  return Object.freeze({
    focused: value.focused,
    fullscreen: value.fullscreen,
    snapshot: freezeSnapshot(value.snapshot),
  })
}

function resolveCaptureWidth(webContents, configuredWidth) {
  if (configuredWidth !== undefined) {
    return requireDimension(configuredWidth, 'capture width', MAX_CAPTURE_DIMENSION)
  }
  const owner = typeof webContents.getOwnerBrowserWindow === 'function'
    ? webContents.getOwnerBrowserWindow()
    : undefined
  const bounds = owner !== null && typeof owner === 'object' && typeof owner.getContentBounds === 'function'
    ? owner.getContentBounds()
    : undefined
  return requireDimension(bounds?.width, 'capture width', MAX_CAPTURE_DIMENSION)
}

function optionalDimension(value, fallback, label, maximum) {
  return value === undefined ? fallback : requireDimension(value, label, maximum)
}

function requireDimension(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${String(maximum)}`)
  }
  return value
}

function averageRegion(data, width, height, startX, endX, format, fallback) {
  const sum = [0, 0, 0]
  let pixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = data[offset + 3] / 255
      const red = data[offset + (format === 'bgra' ? 2 : 0)]
      const green = data[offset + 1]
      const blue = data[offset + (format === 'bgra' ? 0 : 2)]
      sum[0] += red * alpha + fallback[0] * (1 - alpha)
      sum[1] += green * alpha + fallback[1] * (1 - alpha)
      sum[2] += blue * alpha + fallback[2] * (1 - alpha)
      pixels += 1
    }
  }
  return sum.map(channel => Math.round(channel / pixels))
}

function colorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])
}

function maximumColorDistance(colors) {
  let maximum = 0
  for (let left = 0; left < colors.length; left += 1) {
    for (let right = left + 1; right < colors.length; right += 1) {
      maximum = Math.max(maximum, colorDistance(colors[left], colors[right]))
    }
  }
  return maximum
}

function selectForeground(colors) {
  const luminances = colors.map(relativeLuminance)
  const minimumBlackContrast = Math.min(...luminances.map(luminance => (luminance + 0.05) / 0.05))
  const minimumWhiteContrast = Math.min(...luminances.map(luminance => 1.05 / (luminance + 0.05)))
  return minimumBlackContrast >= minimumWhiteContrast ? '#000000' : '#FFFFFF'
}

function relativeLuminance(color) {
  const channels = color.map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function rgbToHex(color) {
  return `#${color.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function freezeSnapshot(snapshot) {
  return Object.freeze({
    mode: snapshot.mode,
    stops: Object.freeze(snapshot.stops.map(stop => Object.freeze({ offset: stop.offset, color: stop.color }))),
    foreground: snapshot.foreground,
    source: snapshot.source,
  })
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const required = [...expected].sort()
  return keys.length === required.length && keys.every((key, index) => key === required[index])
}

function reportCaptureError(onError, error) {
  if (typeof onError !== 'function') return
  try {
    onError(error)
  } catch {
    // A diagnostic callback cannot make the deterministic visual fallback unavailable.
  }
}
