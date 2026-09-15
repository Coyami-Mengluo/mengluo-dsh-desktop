import assert from 'node:assert/strict'
import { it } from 'node:test'
import { centeredChildPosition, centerHiddenChild } from '../src/window-placement.mjs'

const child = { x: 0, y: 0, width: 500, height: 400 }
it('centers shell windows on an off-center parent instead of on the screen', () => {
  assert.deepEqual(centeredChildPosition({ x: 1000, y: 40, width: 800, height: 700 }, child,
    { x: 0, y: 0, width: 1920, height: 1040 }), [1150, 190])
})
it('keeps dialogs on the parent display including negative and fractional-DPI coordinates', () => {
  assert.deepEqual(centeredChildPosition({ x: -1920, y: -50, width: 600, height: 300 }, child,
    { x: -1920, y: 0, width: 1920, height: 1040 }), [-1870, 0])
  assert.deepEqual(centeredChildPosition({ x: 1800, y: 850, width: 120, height: 180 }, child,
    { x: 0, y: 0, width: 1920, height: 1040 }), [1420, 640])
  assert.deepEqual(centeredChildPosition({ x: 10.5, y: 12.5, width: 801, height: 701 }, child), [161, 163])
})
it('handles oversize children and rejects invalid geometry', () => {
  assert.deepEqual(centeredChildPosition({ x: 10, y: 10, width: 200, height: 200 }, child,
    { x: -20, y: 30, width: 320, height: 240 }), [-20, 30])
  assert.equal(centeredChildPosition({ x: NaN, y: 0, width: 20, height: 30 }, child), undefined)
})
it('only repositions hidden windows and safely handles a missing parent/display', () => {
  const moves = []
  let visible = false
  const window = { isDestroyed: () => false, isVisible: () => visible, getBounds: () => child,
    setPosition: (...args) => moves.push(args) }
  const parent = { isDestroyed: () => false, getBounds: () => ({ x: 700, y: 100, width: 800, height: 600 }) }
  assert.equal(centerHiddenChild(window, parent), true)
  assert.deepEqual(moves, [[850, 200, false]])
  visible = true
  assert.equal(centerHiddenChild(window, parent), false)
  visible = false
  assert.equal(centerHiddenChild(window, undefined), false)
  assert.equal(centerHiddenChild(window, parent, { getDisplayMatching() { throw new Error('gone') } }), false)
  assert.equal(moves.length, 1)
})
