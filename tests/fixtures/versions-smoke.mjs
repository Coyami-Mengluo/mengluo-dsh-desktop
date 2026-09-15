import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, net } from 'electron'

const [temporary, application, phase] = process.argv.slice(2)
assert.ok(['switch', 'resume', 'fallback'].includes(phase))
for (const name of ['appData', 'documents', 'sessionData', 'dsh']) mkdirSync(join(temporary, name), { recursive: true })
app.setPath('appData', join(temporary, 'appData'))
app.setPath('documents', join(temporary, 'documents'))
app.setPath('sessionData', join(temporary, 'sessionData'))
process.env.DSH_HOME = join(temporary, 'dsh')
app.getAppPath = () => application
app.getVersion = () => JSON.parse(readFileSync(join(application, 'package.json'))).version
const fromApp = filename => import(pathToFileURL(join(application, filename)).href)
const { managedRuntimeDirectory, writeRuntimeSeal, readRuntimeState, writeRuntimeState } = await fromApp('src/runtime-store.mjs')
const { RuntimeVersionManager } = await fromApp('src/runtime-versions.mjs')
const { HarnessUpdateManager } = await fromApp('src/update-manager.mjs')
const { DesktopSettingsController } = await fromApp('src/settings-controller.mjs')
const profile = join(temporary, 'appData', 'MengLuo DSH Desktop')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'client-updates.json'), JSON.stringify({ autoCheck: false }))
writeFileSync(join(profile, 'language-settings.json'), JSON.stringify({ language: 'zh-CN' }))
const home = process.env.DSH_HOME
const chat = join(home, 'chat-fixture.json')
const chatBytes = '{"messages":["isolated private fixture"]}'
if (phase === 'switch') {
  writeFileSync(chat, chatBytes)
  for (const version of ['1.2.0', '1.1.0', '1.0.0', '0.9.0']) {
    const root = managedRuntimeDirectory(profile, version)
    for (const [name, sub] of [['dsh', 'lib'], ['dsh-web-app', ''], ['dsh-web-frontend', 'dist']]) {
      const directory = join(root, 'node_modules', '@deepseek-ai', name)
      mkdirSync(join(directory, sub), { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version, engines: { node: '>=24' } }))
    }
    copyFileSync(join(application, 'tests', 'fixtures', 'version-backend.cjs'), join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), '<title>DeepSeek Harness</title>')
    mkdirSync(join(root, 'node-runtime'))
    for (const name of ['node.exe', 'LICENSE']) copyFileSync(join(application, 'build', 'runtime', 'node-runtime', name), join(root, 'node-runtime', name))
    // Synthetic Koffi primitive for the test-only runtime's compatibility probe.
    mkdirSync(join(root, 'node_modules', 'koffi'))
    writeFileSync(join(root, 'node_modules', 'koffi', 'index.js'), 'exports.alloc=(_,n)=>Buffer.alloc(n); exports.view=(p,n)=>new Uint8Array(p.buffer,p.byteOffset,n)')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }))
    writeFileSync(join(root, 'package-lock.json'), '{"packages":{}}')
    writeRuntimeSeal(root, version, { nodeVersion: '24.19.0' })
    if (version === '1.0.0') writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'throw Error("corrupt fixture must not execute")')
  }
  writeRuntimeState(profile, { activeVersion: '1.2.0', autoCheck: false })
}
if (phase === 'fallback') writeRuntimeState(profile, { ...readRuntimeState(profile), pendingVersion: '0.9.0' })
let versions, updater, settings, ready, relaunchCalled = false, verified = false, confirmations = 0
const changed = RuntimeVersionManager.prototype.changed
RuntimeVersionManager.prototype.changed = function () { versions = this; return changed.call(this) }
const runtimeReady = HarnessUpdateManager.prototype.runtimeReady
HarnessUpdateManager.prototype.runtimeReady = function (runtime) { updater = this; runtimeReady.call(this, runtime); ready = runtime.version }
const refresh = DesktopSettingsController.prototype.refresh
DesktopSettingsController.prototype.refresh = function () { settings = this; return refresh.call(this) }
app.relaunch = () => { relaunchCalled = true } // Relaunch only through the parent fixture with the SAME isolated paths.
app.resolveProxy = async () => 'DIRECT'
net.fetch = async () => { throw new Error('Network is forbidden in the offline version-switch fixture') }
const fail = error => { process.stderr.write(`${error.stack ?? error}\n`); app.exit(1) }
dialog.showErrorBox = (title, detail) => fail(new Error(`${title}: ${detail}`))
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  assert.equal(options.title, '切换 Harness 版本')
  assert.equal(options.defaultId, 1)
  confirmations++
  return { response: 0 }
}
const deadline = setTimeout(() => fail(new Error('version integration timeout')), 35_000)
const events = () => readFileSync(join(home, 'version-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
app.on('will-quit', () => {
  try {
    clearTimeout(deadline)
    const state = readRuntimeState(profile)
    assert.equal(readFileSync(chat, 'utf8'), chatBytes)
    if (phase === 'switch') {
      assert.equal(relaunchCalled, true)
      assert.equal(confirmations, 2)
      assert.equal(state.pendingVersion, '1.1.0')
      assert.equal(state.activeVersion, '1.2.0')
      assert.equal(state.versionLocked, true)
      const store = join(profile, 'harness-data-backups')
      const backups = readdirSync(store)
      assert.equal(backups.length, 1)
      const backup = join(store, backups[0])
      assert.equal(JSON.parse(readFileSync(join(backup, 'manifest.json'))).toVersion, '1.1.0')
      assert.equal(readFileSync(join(backup, 'dsh-home', 'chat-fixture.json'), 'utf8'), chatBytes)
      assert.deepEqual(events().map(item => item.type), ['start', 'stop'], 'Smoke candidate must use a different DSH_HOME')
    } else {
      assert.equal(verified, true)
      assert.equal(state.activeVersion, '1.1.0')
      assert.equal(state.pendingVersion, undefined)
      assert.equal(state.versionLocked, true)
      if (phase === 'fallback') assert.ok(state.badVersions.includes('0.9.0'))
    }
    process.stdout.write(`versions-smoke:${phase}:passed (isolated runtime slots and data, real worker/main lifecycle, no registry access)\n`)
  } catch (error) { fail(error) }
})
async function waitFor(predicate) {
  const until = Date.now() + 12_000
  while (Date.now() < until) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('Version integration condition timed out')
}
async function run() {
  await app.whenReady()
  await fromApp('src/main.mjs')
  await waitFor(() => ready === (phase === 'switch' ? '1.2.0' : '1.1.0'))
  assert.equal(settings.getState().versions.items.some(item => item.version === '1.1.0' && item.installed), true)
  if (phase !== 'switch') {
    const starts = events().filter(item => item.type === 'start')
    assert.equal(starts.at(-1).version, '1.1.0')
    if (phase === 'fallback') assert.ok(events().some(item => item.type === 'failed' && item.version === '0.9.0'))
    verified = true; app.quit(); return
  }
  updater.onSettingsRequested('harness')
  const window = await waitFor(async () => {
    const candidate = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/settings.html'))
    if (!candidate || candidate.webContents.isLoadingMainFrame()) return
    return await candidate.webContents.executeJavaScript('Boolean(window.clientSettings)') ? candidate : undefined
  })
  assert.deepEqual(await window.webContents.executeJavaScript("window.clientSettings.action({type:'harness-version-switch',version:'1.0.0'})"), { ok: false, message: '操作未完成，请重试或查看日志。' })
  assert.equal(updater.currentRuntime.version, '1.2.0')
  assert.equal(updater.state.pendingVersion, undefined)
  assert.equal(versions.phase, 'error')
  await window.webContents.executeJavaScript("void window.clientSettings.action({type:'harness-version-switch',version:'1.1.0'})")
}
void run().catch(fail)
