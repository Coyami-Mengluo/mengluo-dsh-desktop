import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { createWindowControls, WINDOW_CONTROL_IPC } from '../src/window-controls.mjs'

describe('local caption controls', () => {
  it('minimizes, toggles real maximize state, and closes through the window close policy', () => {
    const world = fixture()
    world.send('minimize')
    assert.deepEqual(world.calls, ['minimize'])
    world.send('toggle-maximize')
    assert.equal(world.window.maximized, true)
    assert.deepEqual(world.messages.at(-1), { maximized: true })
    world.send('toggle-maximize')
    assert.equal(world.window.maximized, false)
    assert.deepEqual(world.messages.at(-1), { maximized: false })
    world.send('close')
    assert.equal(world.calls.at(-1), 'close')
    assert.equal(world.window.destroyed, false)
    world.window.fullscreen = true
    world.send('toggle-maximize')
    assert.equal(world.window.maximized, false)
    world.controller.dispose()
  })

  it('denies foreign contents, child frames, navigated documents, and arbitrary actions', () => {
    const world = fixture()
    for (const event of [
      { sender: {}, senderFrame: world.frame },
      { sender: world.contents, senderFrame: { url: world.frame.url } },
      { sender: world.contents, senderFrame: undefined },
    ]) world.ipcMain.emit(WINDOW_CONTROL_IPC.action, event, 'close')
    world.frame.url = 'https://example.com/'
    world.send('close')
    world.frame.url = world.url
    for (const invalid of ['quit', 'destroy', '__proto__', null, { action: 'close' }]) world.send(invalid)
    world.send('close', 'extra')
    assert.deepEqual(world.calls, [])
    world.ipcMain.emit(WINDOW_CONTROL_IPC.ready, world.event)
    assert.deepEqual(world.messages.at(-1), { maximized: false })
    world.controller.dispose()
  })

  it('removes all listeners and ignores late events after owner destruction', () => {
    const world = fixture()
    world.window.destroyed = true
    world.send('close')
    world.window.emit('closed')
    world.send('minimize')
    world.controller.dispose()
    assert.deepEqual(world.calls, [])
    assert.equal(world.ipcMain.listenerCount(WINDOW_CONTROL_IPC.action), 0)
    assert.equal(world.ipcMain.listenerCount(WINDOW_CONTROL_IPC.ready), 0)
    assert.equal(world.window.listenerCount('maximize'), 0)
    assert.equal(world.window.listenerCount('unmaximize'), 0)
  })
})

function fixture() {
  const ipcMain = new EventEmitter()
  const htmlPath = join(import.meta.dirname, 'fixture-caption.html')
  const url = pathToFileURL(htmlPath).href
  const frame = { url }
  const calls = [], messages = []
  const contents = { mainFrame: frame, isDestroyed: () => false, send: (_channel, state) => { messages.push(state) } }
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, destroyed: false, maximized: false, fullscreen: false,
    isDestroyed() { return this.destroyed }, isMaximized() { return this.maximized }, isFullScreen() { return this.fullscreen },
    minimize() { calls.push('minimize') },
    maximize() { calls.push('maximize'); this.maximized = true; this.emit('maximize') },
    unmaximize() { calls.push('unmaximize'); this.maximized = false; this.emit('unmaximize') },
    close() { calls.push('close') },
  })
  const controller = createWindowControls({ window, ipcMain, htmlPath })
  const event = { sender: contents, senderFrame: frame }
  return { ipcMain, window, contents, frame, url, event, calls, messages, controller,
    send: (...args) => ipcMain.emit(WINDOW_CONTROL_IPC.action, event, ...args) }
}
