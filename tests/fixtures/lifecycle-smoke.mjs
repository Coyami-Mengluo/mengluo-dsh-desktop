import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, net, webContents } from 'electron'

const [temporary, application, mode, resources, fixtureRoot] = process.argv.slice(2)
for (const name of ['appData', 'documents', 'sessionData', 'dsh']) mkdirSync(join(temporary, name))
app.setPath('appData', join(temporary, 'appData'))
app.setPath('documents', join(temporary, 'documents'))
app.setPath('sessionData', join(temporary, 'sessionData'))
process.env.DSH_HOME = join(temporary, 'dsh')
if (resources) {
  Object.defineProperty(app, 'isPackaged', { value: true })
  Object.defineProperty(process, 'resourcesPath', { value: resources })
}
app.getAppPath = () => application
app.getVersion = () => JSON.parse(readFileSync(join(application, 'package.json'))).version
const profile = join(temporary, 'appData', 'MengLuo DSH Desktop')
mkdirSync(profile)
writeFileSync(join(profile, 'client-updates.json'), JSON.stringify({ autoCheck: false }))
writeFileSync(join(profile, 'language-settings.json'), JSON.stringify({ language: 'zh-CN' }))
writeFileSync(join(process.env.DSH_HOME, 'lifecycle-mode.txt'), mode)
const fromApp = name => import(pathToFileURL(join(application, 'src', name)).href)
const { managedRuntimeDirectory, writeRuntimeSeal, writeRuntimeState, readRuntimeState } = await fromApp('runtime-store.mjs')
const { HarnessUpdateManager } = await fromApp('update-manager.mjs')
const { PluginManager } = await fromApp('plugin-manager.mjs')
const old = '0.1.5-rc.2', candidate = '0.1.7-rc.2'
let harness, plugins, verified = false, dialogs = 0, expectedState
const ready = HarnessUpdateManager.prototype.runtimeReady, changed = PluginManager.prototype.changed
HarnessUpdateManager.prototype.runtimeReady = function (runtime) { const result = ready.call(this, runtime); harness = this; return result }
PluginManager.prototype.changed = function () { plugins = this; return changed.call(this) }
const nativeFailure = Promise.withResolvers()
const fail = error => { process.stderr.write(`${error.stack ?? error}\n`); app.exit(1) }
dialog.showErrorBox = (title, detail) => fail(new Error(`${title}: ${detail}`))
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  assert.equal(options.type, 'error', `Unexpected confirmation: ${options.title}`)
  dialogs++
  return nativeFailure.promise
}
net.fetch = async () => { throw new Error('Lifecycle fixture must remain offline') }
app.resolveProxy = async () => 'DIRECT'
const deadline = setTimeout(() => fail(new Error(`lifecycle smoke timed out: ${mode}`)), 25_000)
const state = () => readRuntimeState(profile)
const events = () => {
  const filename = join(process.env.DSH_HOME, 'lifecycle-events.jsonl')
  return existsSync(filename) ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
app.on('will-quit', () => {
  clearTimeout(deadline)
  assert.equal(verified, true)
  assert.deepEqual(state(), expectedState, 'Shutdown must not change the selected/pending runtime or bad-version list')
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  process.stdout.write(`lifecycle-smoke:passed ${mode}\n`)
})
async function waitFor(predicate) {
  const until = Date.now() + 12_000
  while (Date.now() < until) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Lifecycle condition timed out: ${mode}`)
}
function slot(version) {
  const root = managedRuntimeDirectory(profile, version)
  for (const [name, subdir] of [['dsh', 'lib'], ['dsh-web-app', ''], ['dsh-web-frontend', 'dist']]) {
    const directory = join(root, 'node_modules', '@deepseek-ai', name)
    mkdirSync(join(directory, subdir), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version, engines: { node: '>=24' } }))
  }
  copyFileSync(join(fixtureRoot, 'tests', 'fixtures', 'lifecycle-backend.cjs'), join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), '<title>fixture</title>')
  mkdirSync(join(root, 'node-runtime'))
  const nodeRoot = resources ? join(resources, 'runtime', 'node-runtime') : join(application, 'build', 'runtime', 'node-runtime')
  for (const name of ['node.exe', 'LICENSE']) copyFileSync(join(nodeRoot, name), join(root, 'node-runtime', name))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }))
  writeFileSync(join(root, 'package-lock.json'), '{"packages":{}}')
  writeRuntimeSeal(root, version, { nodeVersion: '24.19.0' })
}
async function stopSyntheticBackend() {
  const listening = events().findLast(event => event.type === 'listening')
  const url = new URL('__fixture_stop', listening.url)
  assert.equal(url.hostname, '127.0.0.1')
  await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, response => { response.resume(); response.on('end', resolve) })
    request.on('error', reject)
    request.end()
  })
}
async function run() {
  await app.whenReady()
  slot(old); slot(candidate)
  writeRuntimeState(profile, { activeVersion: old, pendingVersion: candidate, autoCheck: false, versionLocked: true })
  const before = state()
  await import(pathToFileURL(join(application, 'src', 'main.mjs')).href)
  if (mode === 'early-interrupted') {
    await waitFor(() => dialogs === 1)
    assert.deepEqual(state(), before, 'A system-terminated unready candidate must remain pending, not quarantined')
    assert.deepEqual(events().filter(event => event.type === 'start').map(event => event.version), [candidate])
    expectedState = before
    verified = true
    nativeFailure.resolve({ response: 0 })
    return
  }
  if (mode === 'early-crash') {
    await waitFor(() => harness?.currentRuntime.version === old)
    assert.equal(state().activeVersion, old)
    assert.equal(state().pendingVersion, undefined)
    assert.deepEqual(state().badVersions, [candidate])
    assert.deepEqual(events().filter(event => event.type === 'start').map(event => event.version), [candidate, old])
    expectedState = state()
    verified = true
    app.quit()
    return
  }
  await waitFor(() => harness?.currentRuntime.version === candidate)
  // A later interrupted session must also preserve a separately prepared update and version pinning.
  harness.persistState({ ...harness.state, pendingVersion: '9.9.9' }, 'isolated lifecycle fixture')
  expectedState = state()
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/titlebar.html'))
  assert.ok(window)
  if (mode === 'session-first-busy') {
    assert.ok(plugins)
    plugins.busy = true
    verified = true
    window.emit('session-end', {})
    assert.equal(dialogs, 0, 'OS shutdown must bypass interactive busy-operation exit prompts')
    return
  }
  if (mode === 'ready-renderer-crash') {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:'))
    assert.ok(contents)
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  } else await stopSyntheticBackend()
  if (mode === 'child-before-session') {
    await waitFor(() => readdirSync(join(profile, 'logs')).some(name => readFileSync(join(profile, 'logs', name), 'utf8').includes('preserving runtime selection after interrupted')))
    assert.equal(dialogs, 0, 'A late session-end must suppress the delayed failure dialog')
    assert.deepEqual(state(), expectedState)
    verified = true
    window.emit('session-end', {})
    return
  }
  await waitFor(() => dialogs === 1)
  assert.deepEqual(state(), expectedState, 'A later backend/renderer exit must not downgrade a ready runtime')
  assert.deepEqual(events().filter(event => event.type === 'start').map(event => event.version), [candidate])
  verified = true
  nativeFailure.resolve({ response: 0 })
}
void run().catch(fail)
