import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  captureTitlebarSnapshot,
  createTitlebarState,
  fallbackTitlebarSnapshot,
  isTitlebarSnapshot,
  sampleTitlebarPixels,
  TITLEBAR_IPC,
} from '../src/titlebar-sampler.mjs'

describe('shell titlebar color sampling', () => {
  it('collapses a uniform top band to a solid color with automatic dark text', () => {
    const snapshot = sampleTitlebarPixels(bitmap(6, 2, () => [240, 242, 244, 255]))
    assert.deepEqual(snapshot, {
      mode: 'solid',
      stops: [{ offset: 0, color: '#F0F2F4' }],
      foreground: '#000000',
      source: 'capture',
    })
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.stops), true)
    assert.equal(Object.isFrozen(snapshot.stops[0]), true)
  })

  it('retains narrow horizontal boundaries instead of averaging them into three broad stops', () => {
    const colors = [
      [16, 24, 32, 255],
      [32, 48, 64, 255],
      [64, 80, 96, 255],
    ]
    const snapshot = sampleTitlebarPixels(bitmap(9, 2, x => colors[Math.floor(x / 3)]))
    assert.deepEqual(snapshot, {
      mode: 'gradient',
      stops: [
        { offset: 0, color: '#101820' },
        { offset: 0.125, color: '#101820' },
        { offset: 0.25, color: '#101820' },
        { offset: 0.375, color: '#203040' },
        { offset: 0.5, color: '#203040' },
        { offset: 0.625, color: '#203040' },
        { offset: 0.75, color: '#405060' },
        { offset: 0.875, color: '#405060' },
        { offset: 1, color: '#405060' },
      ],
      foreground: '#FFFFFF',
      source: 'capture',
    })
  })

  it('supports RGBA fixtures and composites transparent pixels over the theme fallback', () => {
    const transparent = sampleTitlebarPixels(bitmap(3, 1, () => [0, 0, 0, 0], 'rgba'), {
      darkFallback: true,
    })
    assert.deepEqual(transparent, {
      mode: 'solid',
      stops: [{ offset: 0, color: '#111318' }],
      foreground: '#FFFFFF',
      source: 'capture',
    })

    const rgba = sampleTitlebarPixels(bitmap(3, 1, () => [222, 173, 190, 255], 'rgba'))
    assert.equal(rgba.stops[0].color, '#DEADBE')
  })

  it('keeps subtle sidebar and content differences that remain visible across the seam', () => {
    const snapshot = sampleTitlebarPixels(bitmap(
      8,
      2,
      x => x < 3 ? [248, 250, 253, 255] : [255, 255, 255, 255],
    ))
    assert.equal(snapshot.mode, 'gradient')
    assert.equal(snapshot.stops.length, 8)
    assert.equal(snapshot.stops[0].color, '#F8FAFD')
    assert.equal(snapshot.stops.at(-1).color, '#FFFFFF')
  })

  it('rejects ambiguous bitmap layouts instead of sampling unchecked bytes', () => {
    assert.throws(
      () => sampleTitlebarPixels({ data: new Uint8Array(3), width: 1, height: 1, format: 'bgra' }),
      /bitmap length mismatch/u,
    )
    assert.throws(
      () => sampleTitlebarPixels({ data: new Uint8Array(4), width: 1, height: 1, format: 'argb' }),
      /unsupported titlebar bitmap format/u,
    )
  })

  it('captures only the top strip and downsamples before inspecting Windows BGRA bytes', async () => {
    const calls = []
    const sampledBitmap = bitmap(64, 2, () => [170, 187, 204, 255]).data
    const resized = {
      getSize: () => ({ width: 64, height: 2 }),
      toBitmap: options => {
        calls.push(['toBitmap', options])
        return sampledBitmap
      },
    }
    const image = {
      isEmpty: () => false,
      resize: options => {
        calls.push(['resize', options])
        return resized
      },
    }
    const webContents = {
      getOwnerBrowserWindow: () => ({ getContentBounds: () => ({ width: 640, height: 480 }) }),
      capturePage: async rect => {
        calls.push(['capturePage', rect])
        return image
      },
    }

    const snapshot = await captureTitlebarSnapshot(webContents)
    assert.deepEqual(calls, [
      ['capturePage', { x: 0, y: 0, width: 640, height: 8 }],
      ['resize', { width: 64, height: 2, quality: 'good' }],
      ['toBitmap', { scaleFactor: 1 }],
    ])
    assert.deepEqual(snapshot, {
      mode: 'solid',
      stops: [{ offset: 0, color: '#AABBCC' }],
      foreground: '#000000',
      source: 'capture',
    })
  })

  it('contains capture and decoding failures behind deterministic theme fallbacks', async () => {
    const failures = []
    const rejected = await captureTitlebarSnapshot({
      capturePage: async () => { throw new Error('fixture capture failed') },
    }, {
      width: 500,
      darkFallback: true,
      onError: error => { failures.push(error) },
    })
    assert.deepEqual(rejected, fallbackTitlebarSnapshot(true))
    assert.match(failures[0].message, /fixture capture failed/u)

    const malformed = await captureTitlebarSnapshot({
      capturePage: async () => ({
        resize: () => ({
          getSize: () => ({ width: 64, height: 2 }),
          toBitmap: () => new Uint8Array(2),
        }),
      }),
    }, { width: 500 })
    assert.deepEqual(malformed, fallbackTitlebarSnapshot(false))
  })

  it('accepts only the narrow frozen titlebar state and snapshot fields', () => {
    const snapshot = fallbackTitlebarSnapshot(false)
    assert.equal(isTitlebarSnapshot(snapshot), true)
    assert.equal(isTitlebarSnapshot({
      ...snapshot,
      stops: [{ offset: 0, color: '#FFFFFF; background:url(file:///secret)' }],
    }), false)
    assert.equal(isTitlebarSnapshot({
      mode: 'gradient',
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 0.6, color: '#111111' },
        { offset: 1, color: '#222222' },
      ],
      foreground: '#FFFFFF',
      source: 'capture',
    }), false)
    const state = createTitlebarState({ focused: true, fullscreen: false, snapshot })
    assert.deepEqual(state, { focused: true, fullscreen: false, snapshot })
    assert.equal(Object.isFrozen(state), true)
    assert.throws(
      () => createTitlebarState({ focused: true, fullscreen: false, snapshot, action: 'close' }),
      /unsupported fields/u,
    )
    assert.deepEqual(TITLEBAR_IPC, {
      state: 'mengluo:titlebar:state',
      ready: 'mengluo:titlebar:ready',
    })
  })
})

function bitmap(width, height, pixel, format = 'bgra') {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y)
      const offset = (y * width + x) * 4
      data[offset] = format === 'bgra' ? blue : red
      data[offset + 1] = green
      data[offset + 2] = format === 'bgra' ? red : blue
      data[offset + 3] = alpha
    }
  }
  return { data, width, height, format }
}
