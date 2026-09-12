import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow } from 'electron'

/** A sealed synthetic slot with the staged Node; all state is in the caller's temp profile. */
export async function prepareRestartFixture({ application, profile, dshHome, menus, waitFor }) {
  const fromApp = path => import(pathToFileURL(join(application, path)).href)
  const { managedRuntimeDirectory, writeRuntimeSeal, writeRuntimeState } = await fromApp('src/runtime-store.mjs')
  const { PluginManager } = await fromApp('src/plugin-manager.mjs')
  const { HarnessUpdateManager } = await fromApp('src/update-manager.mjs')
  let plugins, harness
  const changed = PluginManager.prototype.changed, runtimeReady = HarnessUpdateManager.prototype.runtimeReady
  PluginManager.prototype.changed = function () { plugins = this; return changed.call(this) }
  HarnessUpdateManager.prototype.runtimeReady = function (runtime) { harness = this; return runtimeReady.call(this, runtime) }
  const version = '0.1.5-rc.2'
  const root = managedRuntimeDirectory(profile, version)
  for (const [name, subdir] of [['dsh', 'lib'], ['dsh-web-app', ''], ['dsh-web-frontend', 'dist']]) {
    const directory = join(root, 'node_modules', '@deepseek-ai', name)
    mkdirSync(join(directory, subdir), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version, engines: { node: '>=24' } }))
  }
  copyFileSync(join(application, 'tests', 'fixtures', 'restart-backend.cjs'), join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), '<title>fixture</title>')
  mkdirSync(join(root, 'node-runtime'))
  for (const name of ['node.exe', 'LICENSE']) copyFileSync(join(application, 'build', 'runtime', 'node-runtime', name), join(root, 'node-runtime', name))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }))
  writeFileSync(join(root, 'package-lock.json'), '{"packages":{}}')
  writeRuntimeSeal(root, version, { nodeVersion: '24.19.0' })
  writeRuntimeState(profile, { activeVersion: version, autoCheck: false })
  const events = () => readFileSync(join(dshHome, 'restart-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return async () => {
    await waitFor(() => harness?.currentRuntime)
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/titlebar.html'))
    const runtime = harness.currentRuntime
    harness.state.pendingVersion = '9.9.9'
    // Simulate a successfully finished plugin mutation; the restart itself uses the real manager and main lifecycle.
    plugins.restartRecommended = true
    plugins.progress = { label: '安装完成', detail: '保存工作后可重启 Harness，加载插件变更。', percent: 100 }
    plugins.changed()
    menus.find(items => items.some(item => item.label === '客户端设置…')).find(item => item.label === '客户端设置…').click()
    const settings = await waitFor(async () => {
      const candidate = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/settings.html'))
      if (!candidate || candidate.webContents.isLoadingMainFrame()) return
      return await candidate.webContents.executeJavaScript('Boolean(window.clientSettings)') ? candidate : undefined
    })
    const before = events()
    assert.equal(before.length, 1)
    const result = settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-restart'})")
    await waitFor(() => plugins.restarting)
    assert.equal(plugins.getState().progress.percent, undefined)
    assert.equal((await settings.webContents.executeJavaScript("window.clientSettings.action({type:'plugins-restart'})")).ok, false)
    assert.deepEqual(await result, { ok: true })
    assert.equal(harness.currentRuntime, runtime)
    assert.equal(harness.state.pendingVersion, '9.9.9', 'Plugin restart must not select a downloaded Harness update')
    assert.equal(plugins.restartRecommended, false)
    assert.equal(plugins.getState().progress.label, '重启完成')
    assert.equal(window.isDestroyed(), false)
    assert.equal(settings.isDestroyed(), false)
    const sequence = events()
    assert.deepEqual(sequence.map(item => item.type), ['start', 'stop', 'start'])
    assert.equal(sequence[0].pid, sequence[1].pid)
    assert.notEqual(sequence[0].pid, sequence[2].pid)
    process.stdout.write('plugin-restart:passed (real supervised stop/start, random port discovery, renderer readiness, same runtime, no pending update activation, windows preserved)\n')
    PluginManager.prototype.changed = changed
    HarnessUpdateManager.prototype.runtimeReady = runtimeReady
  }
}
