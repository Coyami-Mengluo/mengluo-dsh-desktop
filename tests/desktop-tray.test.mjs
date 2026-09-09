import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { createDesktopTray } from '../src/desktop-tray.mjs'

describe('persistent desktop tray', () => {
  it('keeps one tray while X hides and clicks restore the same main window', () => {
    const world = fixture()
    const { window, tray, controller } = world
    assert.equal(tray.image, 'application-icon.png')
    assert.equal(tray.tooltip, 'DeepSeek harness')
    assert.equal(tray.isDestroyed(), false)
    window.close()
    assert.equal(window.visible, false)
    assert.equal(window.destroyed, false)
    assert.equal(tray.isDestroyed(), false)
    tray.emit('click')
    assert.equal(window.visible, true)
    assert.equal(window.focused, true)
    assert.equal(world.officialFocusCalls, 1)
    window.minimized = true
    tray.emit('double-click')
    assert.equal(window.minimized, false)
    assert.equal(world.trays.length, 1)
    controller.dispose()
  })

  it('uses the current Harness actions in the native right-click menu', () => {
    const { controller, tray, window } = fixture()
    let checks = 0
    const quit = { label: '退出', role: 'quit' }
    controller.setHarnessMenu([
      { label: '检查 Harness 更新…', click: () => { checks += 1 } },
      quit,
    ])
    window.close()
    tray.menu.find(item => item.label === '检查 Harness 更新…').click()
    assert.equal(checks, 1)
    controller.setHarnessMenu([{ label: '正在后台准备更新…', enabled: false }, quit])
    assert.equal(tray.menu.some(item => item.label === '检查 Harness 更新…'), false)
    assert.equal(tray.menu.at(-1).role, 'quit')
    tray.menu[0].click()
    assert.equal(window.visible, true)
    controller.dispose()
  })

  it('allows explicit quit, restart and session-end shutdown without hiding again', () => {
    const world = fixture()
    world.quitting = true
    world.window.close()
    assert.equal(world.window.destroyed, true)
    assert.equal(world.controller.showWindow(), false)
    world.controller.dispose()
    assert.equal(world.tray.destroyCalls, 1)
    world.controller.dispose()
    assert.equal(world.tray.destroyCalls, 1)
    assert.equal(world.tray.listenerCount('click'), 0)
    assert.equal(world.window.listenerCount('close'), 0)

    const session = fixture()
    session.window.emit('session-end')
    assert.equal(session.quitRequests, 1)
    session.window.close()
    assert.equal(session.window.destroyed, true)
    session.controller.dispose()
  })

  it('retains ordinary close when the tray is unavailable and ignores late events', () => {
    const world = fixture()
    world.tray.destroy()
    world.window.close()
    assert.equal(world.window.destroyed, true)
    world.controller.dispose()
    world.controller.setHarnessMenu([])
    assert.equal(world.controller.showWindow(), false)
  })
})

function fixture() {
  const world = { trays: [], quitting: false, officialFocusCalls: 0, quitRequests: 0 }
  class Tray extends EventEmitter {
    constructor(image) {
      super()
      this.image = image
      this.destroyCalls = 0
      world.trays.push(this)
    }
    setToolTip(tooltip) { this.tooltip = tooltip }
    setContextMenu(menu) { this.menu = menu }
    closeContextMenu() {}
    isDestroyed() { return this.destroyCalls > 0 }
    destroy() { this.destroyCalls += 1 }
  }
  const window = new EventEmitter()
  Object.assign(window, {
    visible: true,
    destroyed: false,
    minimized: false,
    focused: false,
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    show() { this.visible = true },
    hide() { this.visible = false },
    focus() { this.focused = true },
    restore() { this.minimized = false },
    close() {
      let prevented = false
      this.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) { this.destroyed = true; this.emit('closed') }
    },
  })
  const controller = createDesktopTray({
    Tray,
    Menu: { buildFromTemplate: template => template },
    window,
    iconPath: 'application-icon.png',
    productName: 'DeepSeek harness',
    isQuitting: () => world.quitting,
    focusOfficial: () => { world.officialFocusCalls += 1 },
    requestQuit: () => { world.quitRequests += 1; world.quitting = true },
  })
  return Object.assign(world, { controller, tray: world.trays[0], window })
}
