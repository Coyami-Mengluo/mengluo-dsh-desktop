import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, Menu, net } from 'electron'

const [temporary, application, resources] = process.argv.slice(2)
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
const menus = []
const buildMenu = Menu.buildFromTemplate
Menu.buildFromTemplate = function (template) { menus.push(template); return buildMenu.call(this, template) }
const fail = error => { process.stderr.write(`${error.stack ?? error}\n`); app.exit(1) }
dialog.showErrorBox = (title, message) => fail(new Error(`${title}: ${message}`))
dialog.showMessageBox = async (...args) => { throw new Error(`Unexpected native dialog: ${JSON.stringify(args.at(-1))}`) }
// Keep both registries offline and disable client automatic checks in the isolated profile.
// No official runtime or model is installed or executed by this fixture.
const requests = []
net.fetch = async (url, options) => {
  requests.push({ url, method: options?.method ?? 'GET' })
  const target = new URL(url)
  if (target.origin === 'https://api.github.com' && target.pathname === '/search/repositories'
    && target.searchParams.get('q').includes('"remote-only"')) {
    const name = target.searchParams.get('page') === '2' ? 'second-result' : 'readme-match'
    return new Response(JSON.stringify({ total_count: 101, incomplete_results: false, items: [{
      full_name: `example/${name}`, name, owner: { login: 'example' }, default_branch: 'main',
      topics: ['dsh-plugin'], description: 'The search keyword matches the remote README, not these visible fields.',
    }] }))
  }
  return new URL(url).pathname === '/-/ping' ? new Response('{}') : new Response('isolated catalog offline fixture', { status: 503 })
}
app.resolveProxy = async () => 'DIRECT'
let quitRequests = 0
app.on('before-quit', () => { quitRequests += 1 })
const deadline = setTimeout(() => fail(new Error('main smoke timeout')), 30_000)
let verified = false
app.on('will-quit', () => {
  clearTimeout(deadline)
  assert.equal(verified, true)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  process.stdout.write('main-smoke:passed (isolated profile, compact menu, shared source, remote plugin search/pagination without runtime, local settings actions, X hides, clean quit)\n')
})
async function waitFor(predicate) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('Main/settings integration condition timed out')
}
async function run() {
  await app.whenReady()
  await import(pathToFileURL(join(application, 'src', 'main.mjs')).href)
  const window = await waitFor(async () => {
    const candidate = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/titlebar.html'))
    if (!candidate || candidate.webContents.isLoadingMainFrame()) return
    return await candidate.webContents.executeJavaScript("Boolean(document.getElementById('setup-status')?.textContent.includes('503'))") ? candidate : undefined
  })
  assert.equal(app.getPath('userData'), profile)
  const compact = menus.find(items => items.some(item => item.label === '客户端设置…'))
  assert.ok(compact)
  assert.deepEqual(compact.filter(item => item.label).map(item => item.label), ['打开 Harness 终端…', '客户端设置…', '退出'])
  assert.equal(compact.find(item => item.label === '打开 Harness 终端…').enabled, false)
  compact.find(item => item.label === '客户端设置…').click()
  const settings = await waitFor(async () => {
    const candidate = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/settings.html'))
    if (!candidate || candidate.webContents.isLoadingMainFrame()) return
    return await candidate.webContents.executeJavaScript("Boolean(window.clientSettings && document.getElementById('harness-primary').dataset.action === 'harness-setup')") ? candidate : undefined
  })
  assert.equal(await window.webContents.executeJavaScript('typeof window.clientSettings'), 'undefined')
  assert.equal(await settings.webContents.executeJavaScript("typeof window.harnessSetup"), 'undefined')
  assert.deepEqual(await settings.webContents.executeJavaScript("window.clientSettings.action({ type: 'download-source', source: 'npmmirror' })"), { ok: true })
  await waitFor(() => window.webContents.executeJavaScript("document.getElementById('setup-source').value === 'npmmirror'"))
  assert.equal(JSON.parse(readFileSync(join(profile, 'download-settings.json'))).source, 'npmmirror')
  await window.webContents.executeJavaScript("window.harnessSetup.setDownloadSource('official')")
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('download-source').value === 'official'"))
  assert.equal(JSON.parse(readFileSync(join(profile, 'download-settings.json'))).source, 'official')
  await settings.webContents.executeJavaScript("window.clientSettings.action({ type: 'harness-preferences', patch: { autoCheck: false, interval: '7d', channel: 'next' } })")
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('harness-interval').value === '7d' && document.getElementById('harness-channel').value === 'next'"))
  assert.deepEqual(await settings.webContents.executeJavaScript("window.clientSettings.action({ type: 'test-connection' })"), { ok: true })
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('probe-detail').textContent.includes('连接正常')"))
  const beforePlugins = requests.length
  await settings.webContents.executeJavaScript("document.getElementById('tab-plugins').click()")
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('panel-plugins').hidden === false && document.getElementById('plugins-runtime-notice').hidden === false && document.getElementById('plugins-catalog-error').hidden === false && document.getElementById('plugins-refresh').disabled === true && document.getElementById('plugins-search-cooldown').hidden === false"))
  const discovery = requests.slice(beforePlugins)
  assert.equal(discovery.length, 1)
  assert.equal(new URL(discovery[0].url).origin, 'https://api.github.com')
  assert.equal(new URL(discovery[0].url).pathname, '/search/repositories')
  assert.equal(discovery[0].method, 'GET')
  const limitedRefresh = await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-refresh'})")
  assert.equal(limitedRefresh.rateLimited, true)
  assert.equal(Number.isSafeInteger(limitedRefresh.retryAt), true)
  assert.equal(requests.length, beforePlugins + 1, 'Direct IPC cannot bypass the refresh cooldown')
  assert.equal(await settings.webContents.executeJavaScript("document.querySelectorAll('#plugins-catalog [data-action=plugin-install]').length"), 0)
  await settings.webContents.executeJavaScript("document.getElementById('plugin-tab-installed').click()")
  assert.equal(await settings.webContents.executeJavaScript("document.getElementById('plugin-panel-installed').hidden"), false)
  assert.equal(await settings.webContents.executeJavaScript("document.getElementById('plugins-check').disabled"), true)
  assert.equal(await settings.webContents.executeJavaScript("document.getElementById('plugin-installed-count').textContent"), '0')
  assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-check'})")).ok, true)
  for (const type of ['plugin-install', 'plugin-update', 'plugin-remove']) {
    assert.equal((await settings.webContents.executeJavaScript(`window.clientSettings.action({type:'${type}',id:'github:example/theme'})`)).ok, false)
  }
  assert.equal(requests.length, beforePlugins + 1, 'Rejected plugin mutations and empty-inventory checks do not make more requests')
  await settings.webContents.executeJavaScript("document.getElementById('plugin-tab-store').click()")
  await new Promise(resolve => setTimeout(resolve, 1050)) // Respect the real search dispatch gap.
  assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-search',query:'remote-only'})")).ok, true)
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('plugin-search').value === 'remote-only' && document.querySelectorAll('#plugins-catalog .plugin-card').length === 1 && document.getElementById('plugins-more').hidden === false"))
  assert.equal(await settings.webContents.executeJavaScript("document.querySelector('#plugins-catalog h2').textContent"), 'readme-match')
  assert.equal(await settings.webContents.executeJavaScript("document.querySelector('#plugins-catalog [data-action=plugin-install]').disabled"), true)
  await waitFor(() => settings.webContents.executeJavaScript("document.getElementById('plugins-more').disabled === false"))
  assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-more',query:'remote-only'})")).ok, true)
  await waitFor(() => settings.webContents.executeJavaScript("document.querySelectorAll('#plugins-catalog .plugin-card').length === 2 && document.getElementById('plugins-more').hidden === true"))
  const pageRequest = new URL(requests.at(-1).url)
  assert.equal(pageRequest.searchParams.get('page'), '2')
  assert.match(pageRequest.searchParams.get('q'), /topic:dsh-plugin/u)
  assert.match(pageRequest.searchParams.get('q'), /in:name,description,readme/u)
  const requestCount = requests.length
  assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-search',query:'topic:unrelated'})")).ok, false)
  assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-more',query:'previous-query'})")).ok, false)
  assert.equal(requests.length, requestCount)
  assert.deepEqual(readdirSync(join(temporary, 'dsh')), [], 'Browsing plugins must not create or alter the real/isolated web profile')
  assert.equal(existsSync(join(profile, 'plugin-sources.json')), false)
  assert.equal(quitRequests, 0, 'Opening plugin settings and rejected no-runtime actions cannot request application exit')
  assert.equal(window.isDestroyed(), false)
  assert.equal(settings.isDestroyed(), false)
  settings.close()
  assert.equal(settings.isDestroyed(), false)
  assert.equal(settings.isVisible(), false)
  compact.find(item => item.label === '客户端设置…').click()
  assert.equal(settings.isVisible(), true)
  assert.equal(BrowserWindow.getAllWindows().filter(item => item.webContents.getURL().endsWith('/settings.html')).length, 1)
  assert.equal(quitRequests, 0, 'Reopening settings is independent from recovery/quit confirmation')
  window.close()
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.isVisible(), false)
  verified = true
  app.quit()
}
void run().catch(fail)
