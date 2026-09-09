import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { inflateSync } from 'node:zlib'
import { ICON_SOURCE, verifyIconSource } from '../scripts/icon-source.mjs'
import { listSourceFiles } from '../scripts/source-files.mjs'

const root = resolve(import.meta.dirname, '..')
const source = readFileSync(resolve(root, ICON_SOURCE))

// Decode the reviewed, non-interlaced RGBA PNG so the tests check actual alpha,
// rather than accepting an opaque checkerboard or only trusting its PNG header.
function rgbaPixels(png) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(png[24], 8)
  assert.equal(png[25], 6)
  assert.equal(png[28], 0)
  const chunks = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const stride = width * 4
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: height * (stride + 1) })
  assert.equal(raw.length, height * (stride + 1))
  const pixels = Buffer.alloc(width * height * 4)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter <= 4)
    for (let x = 0; x < stride; x += 1) {
      const i = y * stride + x
      const a = x >= 4 ? pixels[i - 4] : 0
      const b = y ? pixels[i - stride] : 0
      const c = y && x >= 4 ? pixels[i - stride - 4] : 0
      const predicted = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      pixels[i] = (raw[y * (stride + 1) + x + 1] + predicted) & 255
    }
  }
  return { pixels, width }
}

describe('reviewed application artwork', () => {
  it('preserves the source asset through preparation and includes it in source exports', () => {
    verifyIconSource(source)
    assert.deepEqual(readFileSync(resolve(root, 'assets/icon.png')), source)
    const files = listSourceFiles(root)
    assert.ok(files.includes(ICON_SOURCE))
    assert.ok(files.includes('assets/ARTWORK.md'))
    assert.ok(!files.includes('assets/icon.png'))
  })

  it('rejects unreviewed changes to the binary source asset', () => {
    const changed = Buffer.from(source)
    changed[changed.length - 1] ^= 1
    assert.throws(() => verifyIconSource(changed), /differs from the reviewed artwork/u)
  })

  it('has transparent backdrop holes, smooth edge alpha and opaque white subject details', () => {
    const { pixels, width } = rgbaPixels(source)
    const alpha = (x, y) => pixels[(y * width + x) * 4 + 3]
    for (const [x, y] of [[0, 0], [1253, 0], [1253, 800], [500, 80], [1015, 720], [1080, 850], [169, 794], [242, 630], [222, 736]]) {
      assert.equal(alpha(x, y), 0, `Backdrop at ${x},${y}`)
    }
    for (const [x, y] of [[561, 909], [484, 641], [664, 120], [400, 1220], [557, 569], [660, 270]]) {
      assert.equal(alpha(x, y), 255, `Subject at ${x},${y}`)
    }
    let transparent = 0
    let antialiased = 0
    for (let i = 3; i < pixels.length; i += 4) {
      if (!pixels[i]) transparent += 1
      else if (pixels[i] < 255) antialiased += 1
    }
    assert.ok(transparent > 500_000)
    assert.ok(antialiased > 1_000)
  })
})
