import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, Tray } from 'electron'

const [temporary, moduleRoot, iconPath] = process.argv.slice(2)
const profile = join(temporary, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const { createDesktopTray } = await import(pathToFileURL(join(moduleRoot, 'desktop-tray.mjs')).href)
const trace = []
let quitting = false
let controller
let window
let tray
let menu
const deadline = setTimeout(() => { process.stderr.write('native tray smoke timed out\n'); app.exit(1) }, 20_000)

app.on('before-quit', () => {
  quitting = true
  controller?.dispose()
})
app.on('will-quit', () => {
  clearTimeout(deadline)
  trace.push(tray.isDestroyed() && window.isDestroyed() ? 'quit:window-and-tray-destroyed' : 'quit:incomplete')
  process.stdout.write(`tray-smoke:${JSON.stringify(trace)}\n`)
})

async function run() {
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 480, height: 280, title: 'DeepSeek harness 托盘自测' })
  controller = createDesktopTray({
    Tray: function (image) { tray = new Tray(image); return tray },
    Menu: { buildFromTemplate: template => { menu = Menu.buildFromTemplate(template); return menu } },
    window,
    iconPath,
    productName: 'DeepSeek harness 托盘自测',
    isQuitting: () => quitting,
    focusOfficial: () => { window.webContents.focus() },
    requestQuit: () => { app.quit() },
  })
  await window.loadURL('data:text/html,<title>Tray smoke</title><p>DeepSeek harness tray smoke</p>')
  window.show()
  assert.equal(tray.isDestroyed(), false)
  trace.push('visible:tray-alive')
  window.close()
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.isVisible(), false)
  assert.equal(tray.isDestroyed(), false)
  trace.push('close:hidden-window-and-live-tray')
  tray.emit('click')
  assert.equal(window.isVisible(), true)
  trace.push('click:window-restored')
  controller.setHarnessMenu([{ label: '检查 Harness 更新…', click() {} }, { label: '退出', role: 'quit' }])
  assert.equal(menu.items[0].label, '显示主窗口')
  assert.equal(menu.items[2].label, '检查 Harness 更新…')
  assert.equal(menu.items.at(-1).role, 'quit')
  trace.push('menu:show-update-quit')
  window.close()
  menu.items[0].click()
  assert.equal(window.isVisible(), true)
  trace.push('menu:window-restored')
  app.quit()
}

void run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  controller?.dispose()
  app.exit(1)
})
