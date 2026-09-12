import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const desktopRoot = join(import.meta.dirname, '..')

describe('isolated shell titlebar resources', () => {
  it('uses external assets, a strict CSP, and consistent SVG controls outside the drag region', () => {
    const html = readFileSync(join(desktopRoot, 'assets', 'titlebar.html'), 'utf8')
    const css = readFileSync(join(desktopRoot, 'assets', 'titlebar.css'), 'utf8')
    const script = readFileSync(join(desktopRoot, 'assets', 'titlebar.js'), 'utf8')

    assert.match(html, /default-src 'none'/u)
    assert.match(html, /script-src 'self'/u)
    assert.match(html, /style-src 'self'/u)
    assert.match(html, /connect-src 'none'/u)
    assert.match(html, /frame-ancestors 'none'/u)
    assert.match(html, /require-trusted-types-for 'script'/u)
    assert.match(html, /<link rel="stylesheet" href="\.\/titlebar\.css">/u)
    assert.match(html, /<script src="\.\/titlebar\.js" type="module"><\/script>/u)
    assert.match(html, /<img src="\.\/icon\.png"/u)
    assert.match(html, /id="titlebar-background-a"/u)
    assert.match(html, /id="titlebar-background-b"/u)
    assert.match(html, />MengLuo DSH Desktop</u)
    assert.match(html, /正在启动 DeepSeek Harness…/u)
    assert.match(html, /id="loading-spinner" role="status" aria-label="正在启动"/u)
    assert.doesNotMatch(html, /<script(?!\s+src=)|\sstyle=|\son\w+=/u)
    const header = html.match(/<header[\s\S]*?<\/header>/u)?.[0] ?? ''
    assert.equal((header.match(/<button /gu) ?? []).length, 3)
    assert.equal((header.match(/<svg /gu) ?? []).length, 4)
    assert.doesNotMatch(header, /\stitle\s*=/u)
    assert.match(header, /id="window-minimize".*aria-label="最小化"/u)
    assert.match(header, /id="window-maximize".*aria-label="最大化"/u)
    assert.match(header, /id="window-close".*aria-label="关闭到托盘"/u)

    assert.match(css, /width: calc\(100% - 144px\)/u)
    assert.match(css, /-webkit-app-region: no-drag/u)
    assert.match(css, /stroke-width: 1\.5/u)
    assert.match(css, /stroke: currentColor/u)
    assert.match(css, /-webkit-app-region: drag/u)
    assert.match(css, /#loading-panel/u)
    assert.match(css, /@keyframes spin/u)
    assert.match(css, /transition: opacity 560ms/u)
    assert.match(css, /prefers-reduced-motion: reduce/u)

    assert.match(script, /window\.harnessTitlebar\.onState/u)
    assert.match(script, /linear-gradient\(90deg/u)
    assert.match(script, /applyBackground/u)
    assert.match(script, /backgroundLayer/u)
    assert.match(script, /HEX_COLOR\.test/u)
    assert.doesNotMatch(
      script,
      /innerHTML|outerHTML|eval\(|new Function|mouse(?:move|enter)|pointermove|clientX|screenX/u,
    )
  })

  it('updates maximize and restore accessibility labels without adding hover tooltips', () => {
    const script = readFileSync(join(desktopRoot, 'assets', 'titlebar.js'), 'utf8')
    const buttons = new Map(['window-minimize', 'window-maximize', 'window-close'].map(id => [id, {
      title: '',
      attributes: new Map(),
      addEventListener() {},
      setAttribute(name, value) { this.attributes.set(name, value) },
    }]))
    const root = { dataset: {} }
    let receiveState
    vm.runInNewContext(script.replace(/^import .* from '\.\/i18n\.js'\r?\n/u, ''), {
      tr: text => text, onLanguageChange() {},
      document: { documentElement: root, getElementById: id => buttons.get(id) },
      window: {
        harnessTitlebar: { onState: () => () => {} },
        harnessWindowControls: { onState: listener => { receiveState = listener; return () => {} } },
        addEventListener() {},
      },
    })

    for (const maximized of [false, true, false, true]) {
      receiveState({ maximized })
      assert.equal(root.dataset.maximized, String(maximized))
      assert.equal(buttons.get('window-maximize').attributes.get('aria-label'), maximized ? '还原' : '最大化')
      for (const button of buttons.values()) {
        assert.equal(button.title, '')
        assert.equal(button.attributes.has('title'), false)
      }
    }
  })

  it('keeps appearance read-only and exposes only bounded setup operations separately', async () => {
    const preload = readFileSync(join(desktopRoot, 'src', 'titlebar-preload.cjs'), 'utf8')
    const ipcRenderer = new EventEmitter()
    const sent = []
    ipcRenderer.send = (...args) => { sent.push(args) }
    ipcRenderer.invoke = async (...args) => { sent.push(args) }
    let exposed
    let setup
    let controls
    let language
    const contextBridge = {
      exposeInMainWorld: (name, value) => {
        if (name === 'harnessTitlebar') exposed = { name, value }
        else if (name === 'harnessSetup') setup = value
        else if (name === 'harnessWindowControls') controls = value
        else if (name === 'desktopLanguage') language = value
        else throw new Error(`unexpected preload API: ${name}`)
      },
    }
    vm.runInNewContext(preload, {
      require: name => {
        assert.equal(name, 'electron')
        return { contextBridge, ipcRenderer }
      },
    })

    assert.equal(exposed.name, 'harnessTitlebar')
    assert.deepEqual([...Object.keys(exposed.value)], ['onState'])
    assert.equal(Object.isFrozen(exposed.value), true)
    assert.deepEqual(Object.keys(language), ['getState', 'setPreference', 'onState'])
    assert.equal(Object.isFrozen(language), true)
    assert.throws(() => exposed.value.onState('not a function'), /listener must be a function/u)
    const received = []
    const unsubscribe = exposed.value.onState(state => { received.push(state) })
    assert.deepEqual(sent, [['mengluo:titlebar:ready']])
    assert.equal(ipcRenderer.listenerCount('mengluo:titlebar:state'), 1)
    const state = { focused: true, fullscreen: false, snapshot: { mode: 'solid' } }
    ipcRenderer.emit('mengluo:titlebar:state', {}, state)
    assert.equal(received[0], state)
    unsubscribe()
    assert.equal(ipcRenderer.listenerCount('mengluo:titlebar:state'), 0)

    assert.deepEqual([...Object.keys(setup)], ['refresh', 'install', 'setDownloadSource', 'testConnection', 'onState'])
    await setup.refresh()
    await setup.install('1.2.3')
    assert.equal(sent.at(-2)[0], 'mengluo:setup:action')
    assert.equal(sent.at(-1)[1].type, 'install')
    assert.equal(sent.at(-1)[1].version, '1.2.3')
    await setup.setDownloadSource('npmmirror')
    assert.equal(sent.at(-1)[0], 'mengluo:setup:action')
    assert.equal(sent.at(-1)[1].type, 'download-source')
    assert.equal(sent.at(-1)[1].source, 'npmmirror')
    await setup.testConnection()
    assert.equal(sent.at(-1)[1].type, 'test-connection')
    const stopSetup = setup.onState(() => {})
    assert.equal(ipcRenderer.listenerCount('mengluo:setup:state'), 1)
    stopSetup()
    assert.equal(ipcRenderer.listenerCount('mengluo:setup:state'), 0)
    assert.deepEqual([...Object.keys(controls)], ['minimize', 'toggleMaximize', 'close', 'onState'])
    for (const method of ['minimize', 'toggleMaximize', 'close']) controls[method]()
    assert.deepEqual(sent.slice(-3), [
      ['mengluo:window-controls:action', 'minimize'],
      ['mengluo:window-controls:action', 'toggle-maximize'],
      ['mengluo:window-controls:action', 'close'],
    ])
    const stopControls = controls.onState(() => {})
    assert.equal(ipcRenderer.listenerCount('mengluo:window-controls:state'), 1)
    stopControls()
    assert.equal(ipcRenderer.listenerCount('mengluo:window-controls:state'), 0)
    assert.doesNotMatch(preload, /node:fs|child_process|process\.env/u)
  })
})
