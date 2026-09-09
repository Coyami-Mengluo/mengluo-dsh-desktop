import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'

const [temporary, application, dependencies, screenshots] = process.argv.slice(2)
const profile = join(temporary, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const load = name => import(pathToFileURL(join(application, 'src', name)).href)
const { createNativeShellUpdater } = await load('native-shell-updater.mjs')
const { createShellUpdateWindow, CLIENT_UPDATE_CHANNELS } = await load('shell-update-window.mjs')
let controller
const deadline = setTimeout(() => { process.stderr.write('client smoke timed out\n'); app.exit(1) }, 30_000)
app.on('will-quit', () => clearTimeout(deadline))
app.on('window-all-closed', () => {})

async function run() {
  await app.whenReady()
  const { updater, createCancellationToken } = createNativeShellUpdater(dependencies)
  assert.equal(updater.constructor.name, 'NsisUpdater')
  assert.equal(createCancellationToken().cancelled, false)
  // Only construct the real packaged dependency. Never call its network or installer API here.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  nativeTheme.themeSource = 'light'
  const actions = []
  const errors = []
  const htmlPath = join(application, 'assets', 'shell-update.html')
  controller = createShellUpdateWindow({
    BrowserWindow, ipcMain, nativeTheme, htmlPath,
    preloadPath: join(application, 'src', 'shell-update-preload.cjs'),
    iconPath: join(application, 'assets', 'icon.png'), getParent: () => undefined,
    onAction: action => actions.push(action), log: message => errors.push(message),
  })
  const state = { currentVersion: '0.5.0', version: '0.5.1', status: 'downloading', percent: 25,
    transferred: 1024 * 1024, total: 4 * 1024 * 1024, speed: 1024 * 1024, remainingSeconds: 3 }
  controller.update(state)
  controller.show()
  const window = BrowserWindow.getAllWindows()[0]
  const contents = window.webContents
  await expectDom(contents, "document.getElementById('progress')?.getAttribute('aria-valuenow') === '25'")
  assert.equal(await contents.executeJavaScript("typeof require + ':' + typeof process"), 'undefined:undefined')
  assert.equal(await contents.executeJavaScript("Object.keys(window.clientUpdate).sort().join(',')"), 'check,download,install,onState')
  assert.match(await contents.executeJavaScript("document.getElementById('transfer').textContent"), /1\.0 MB \/ 4\.0 MB.*预计剩余 3 秒/u)
  assert.equal(await contents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  for (const rejected of [
    { sender: {}, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { url: pathToFileURL(htmlPath).href } },
  ]) ipcMain.emit(CLIENT_UPDATE_CHANNELS.action, rejected, 'install')
  ipcMain.emit(CLIENT_UPDATE_CHANNELS.action, event, 'arbitrary-command')
  ipcMain.emit(CLIENT_UPDATE_CHANNELS.action, event, 'install', 'extra')
  assert.deepEqual(actions, [])
  await new Promise(resolve => setTimeout(resolve, 300))
  writeFileSync(join(screenshots, 'client-update-light.png'), (await contents.capturePage()).toPNG())
  nativeTheme.themeSource = 'dark'
  await expectDom(contents, "document.documentElement.dataset.dark === 'true'")
  writeFileSync(join(screenshots, 'client-update-dark.png'), (await contents.capturePage()).toPNG())
  window.close()
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.isVisible(), false)
  controller.update({ ...state, status: 'available', percent: undefined })
  controller.show()
  await expectDom(contents, "!document.getElementById('download').hidden")
  await contents.executeJavaScript("document.getElementById('download').click()")
  await expect(() => actions.length === 1)
  assert.deepEqual(actions, ['download'])
  controller.update({ ...state, status: 'downloaded', percent: 100 })
  await expectDom(contents, "!document.getElementById('install').hidden")
  await contents.executeJavaScript("document.getElementById('install').click()")
  await expect(() => actions.length === 2)
  assert.deepEqual(actions, ['download', 'install'])
  controller.dispose()
  assert.equal(ipcMain.listenerCount(CLIENT_UPDATE_CHANNELS.action), 0)
  assert.equal(window.isDestroyed(), true)
  assert.deepEqual(errors, [])
  process.stdout.write('client-update-smoke:passed (dependencies, IPC isolation, real progress, themes, hide/reopen, actions)\n')
  app.quit()
}
async function expect(predicate) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Client update smoke condition timed out')
}
const expectDom = (contents, expression) => expect(() => contents.executeJavaScript(expression))
void run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); controller?.dispose(); app.exit(1) })
