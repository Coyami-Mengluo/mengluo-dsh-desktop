import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, Menu, net } from 'electron'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const temporary = process.argv[2]
const expected = JSON.parse(readFileSync(join(temporary, 'expected-update.json'), 'utf8'))
const resources = join(expected.installRoot, 'resources')
const application = join(resources, 'app.asar')
const installed = JSON.parse(readFileSync(join(application, 'package.json'), 'utf8'))
assert.equal(installed.version, expected.from)
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: resources })
app.getAppPath = () => application
app.getVersion = () => installed.version
const session = join(temporary, 'test-session')
mkdirSync(session)
app.setPath('sessionData', session)
const report = { from: expected.from, to: expected.to, transferred: 0, installerSize: expected.info.files[0].size, downloadVerified: false, requestedInstall: false }
const save = () => writeFileSync(join(temporary, 'update-report.json'), JSON.stringify(report, null, 2) + '\n')
const fail = error => { report.error = String(error.stack ?? error); save(); process.stderr.write(`${report.error}\n`); app.exit(1) }
let quitRequested = false
app.on('before-quit', () => { quitRequested = true })
const require = createRequire(join(application, 'package.json'))
const { NsisUpdater } = require('electron-updater')
const download = NsisUpdater.prototype.doDownloadUpdate
NsisUpdater.prototype.doDownloadUpdate = function (...args) {
  this.on('download-progress', progress => { report.transferred = Math.max(report.transferred, progress.transferred); report.transferTotal = progress.total })
  return download.apply(this, args)
}
const install = NsisUpdater.prototype.quitAndInstall
NsisUpdater.prototype.quitAndInstall = function (silent, forceRun) {
  assert.equal(silent, false, 'Production menu must request its normal assisted install')
  assert.equal(forceRun, true)
  const bytes = readFileSync(this.installerPath)
  assert.equal(bytes.length, expected.info.files[0].size)
  assert.equal(createHash('sha512').update(bytes).digest('base64'), expected.info.files[0].sha512)
  report.downloadVerified = true
  // BaseUpdater starts the installer and then calls app.quit(). At this point
  // the main titlebar window may still exist; progress windows and the official
  // WebContentsView must already have been disposed by the packaged main entry.
  const remainingWindows = BrowserWindow.getAllWindows()
  report.shutdownPreparedBeforeInstaller = quitRequested
    && remainingWindows.length === 1
    && remainingWindows[0].contentView.children.length === 0
    && !remainingWindows[0].getTitle().includes('客户端更新')
  assert.equal(report.shutdownPreparedBeforeInstaller, true, 'Packaged main must prepare shutdown before calling the installer')
  report.requestedInstall = true
  report.mode = 'Real packaged main/menu/updater; installer UI is silent only for the disposable CI VM'
  save()
  this.installDirectory = expected.installRoot
  // Keep the real installer spawn, verification and restart; only replace its
  // interactive wizard with /S on the unattended, disposable Windows runner.
  return install.call(this, true, true)
}
const templates = []
const buildMenu = Menu.buildFromTemplate
Menu.buildFromTemplate = function (template) { templates.push(template); return buildMenu.call(this, template) }
const findMenu = label => {
  const walk = items => {
    for (const item of items) {
      if (item.label === label && item.enabled !== false) return item
      if (Array.isArray(item.submenu)) { const found = walk(item.submenu); if (found) return found }
    }
  }
  for (const items of [...templates].reverse()) { const found = walk(items); if (found) return found }
}
dialog.showErrorBox = (title, message) => fail(new Error(`${title}: ${message}`))
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  if (options.title === '客户端更新' && options.buttons?.[0] === '下载更新' && options.message.includes(expected.to)) return { response: 0 }
  if (options.title === '重启并安装客户端更新' && options.buttons?.[0] === '重启安装' && options.message.includes(expected.to)) return { response: 0 }
  throw new Error(`Unexpected app dialog during update smoke: ${options.title}: ${options.message}`)
}
// Only the separate Harness catalogue is kept offline. The client updater uses
// Electron net.request against the real, fixed public GitHub release provider.
net.fetch = async () => new Response('No Harness installation during client update test', { status: 503 })
const deadline = setTimeout(() => fail(new Error('Real GitHub client update timed out')), 7 * 60_000)
app.on('will-quit', () => {
  clearTimeout(deadline)
  report.windowsClosedOnQuit = BrowserWindow.getAllWindows().length === 0
  save()
})
async function waitFor(predicate, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the packaged menu/update state')
}
async function run() {
  await app.whenReady()
  await import(pathToFileURL(join(application, 'src', 'main.mjs')).href)
  const entry = await waitFor(() => findMenu('检查客户端更新…') ?? findMenu('客户端设置…'))
  assert.equal(app.getPath('userData'), expected.profile)
  let settings
  let restart
  if (entry.label === '客户端设置…') {
    entry.click()
    settings = await waitFor(async () => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/settings.html'))
      if (!window || window.webContents.isLoadingMainFrame()) return
      return await window.webContents.executeJavaScript('Boolean(window.clientSettings)') ? window : undefined
    })
    await settings.webContents.executeJavaScript("document.getElementById('tab-client').click(); void window.clientSettings.action({ type: 'client-check' })")
    await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('client-primary').dataset.action === 'client-install'"), 6 * 60_000)
  } else {
    entry.click()
    restart = await waitFor(() => findMenu(`重启并安装客户端 ${expected.to}…`), 6 * 60_000)
  }
  const progress = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('客户端更新'))
  assert.ok(progress)
  writeFileSync(join(temporary, 'update-downloaded.png'), (await progress.webContents.capturePage()).toPNG())
  if (settings) await settings.webContents.executeJavaScript("void window.clientSettings.action({ type: 'client-install' })")
  else restart.click()
}
void run().catch(fail)
