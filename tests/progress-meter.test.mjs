import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createProgressMeter } from '../assets/progress-meter.js'

describe('continuous progress meter', () => {
  it('keeps one indeterminate animation through repeated activity messages without guessing a percentage', () => {
    const { element, render, mutations, fill } = fixture()
    render()
    const baseline = mutations.length
    for (let i = 0; i < 100; i += 1) render()
    assert.equal(mutations.length, baseline)
    assert.equal(element.dataset.mode, 'indeterminate')
    assert.equal(element.getAttribute('aria-valuenow'), undefined)
    assert.equal(fill.style.transform, 'scaleX(0)')
    assert.match(element.getAttribute('aria-valuetext'), /尚无可用总量/u)
  })

  it('targets only the measured value, suppresses equal targets, and clears stale values between stages', () => {
    const { element, render, mutations, fill } = fixture()
    render(25)
    assert.equal(element.dataset.mode, 'determinate')
    assert.equal(element.getAttribute('aria-valuenow'), '25')
    assert.equal(fill.style.transform, 'scaleX(0.25)')
    const baseline = mutations.length
    render(25)
    assert.equal(mutations.length, baseline)
    render(75)
    assert.equal(fill.style.transform, 'scaleX(0.75)')
    render()
    assert.equal(element.getAttribute('aria-valuenow'), undefined)
    assert.equal(fill.style.transform, 'scaleX(0)')
    render(0)
    assert.equal(element.getAttribute('aria-valuenow'), '0')
    render(100)
    assert.equal(element.getAttribute('aria-valuenow'), '100')
  })

  it('rejects invalid percentages, stops failed motion, and supports hidden setup screens', () => {
    const { element, render } = fixture()
    for (const invalid of [NaN, Infinity, -1, 101, '25', null]) {
      render(invalid)
      assert.equal(element.dataset.mode, 'indeterminate')
      assert.equal(element.getAttribute('aria-valuenow'), undefined)
    }
    render(undefined, { failed: true })
    assert.equal(element.dataset.mode, 'failed')
    assert.equal(element.getAttribute('aria-valuetext'), '失败')
    assert.equal(element.getAttribute('aria-valuenow'), undefined)
    render(undefined, { hidden: true })
    assert.equal(element.hidden, true)
    render(10)
    assert.equal(element.hidden, false)
    assert.equal(element.getAttribute('aria-valuetext'), undefined)
  })

  it('shares external transform-only animation assets across setup and update, with reduced motion', () => {
    const assets = join(import.meta.dirname, '..', 'assets')
    const css = readFileSync(join(assets, 'progress-meter.css'), 'utf8')
    assert.match(css, /transition: transform 240ms linear/u)
    assert.match(css, /will-change: transform/u)
    assert.match(css, /prefers-reduced-motion: reduce/u)
    assert.match(css, /animation: none/u)
    const animation = css.slice(css.indexOf('@keyframes'), css.indexOf('@media'))
    assert.match(animation, /translate3d/u)
    assert.doesNotMatch(animation, /width:|left:|margin:|background-position:/u)
    for (const name of ['titlebar.html', 'update-progress.html']) {
      const html = readFileSync(join(assets, name), 'utf8')
      assert.match(html, /href="\.\/progress-meter\.css"/u)
      assert.match(html, /role="progressbar" aria-valuemin="0" aria-valuemax="100"/u)
      assert.doesNotMatch(html, /<progress[\s>]/u)
    }
  })
})

function fixture() {
  const mutations = []
  const observed = () => new Proxy({}, { set(object, key, value) { mutations.push([key, value]); object[key] = value; return true } })
  const attributes = new Map()
  const fill = { style: observed() }
  const element = {
    hidden: false,
    dataset: observed(),
    querySelector: selector => { assert.equal(selector, '.progress-fill'); return fill },
    setAttribute: (name, value) => { mutations.push([name, value]); attributes.set(name, value) },
    removeAttribute: name => { mutations.push([name]); attributes.delete(name) },
    getAttribute: name => attributes.get(name),
  }
  return { element, render: createProgressMeter(element), mutations, fill }
}
