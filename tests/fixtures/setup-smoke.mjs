import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, ipcMain, nativeTheme, Tray, WebContentsView } from 'electron'
import { assertProgressMotion } from './progress-motion.mjs'

const [temporary, application, iconPath, screenshot, progressAssets] = process.argv.slice(2)
const profile = join(temporary, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const load = name => import(pathToFileURL(join(application, 'src', name)).href)
const { createFirstRunSetup } = await load('first-run-setup.mjs')
const { createDesktopWindow } = await load('desktop-window.mjs')
const { createUpdateProgressWindow } = await load('update-progress-window.mjs')
const { createDesktopTray } = await load('desktop-tray.mjs')
const { fallbackTitlebarSnapshot, TITLEBAR_IPC } = await load('titlebar-sampler.mjs')
const trace = []
let desktop, setup, updateProgress, tray
const deadline = setTimeout(() => { process.stderr.write('native setup smoke timed out\n'); app.exit(1) }, 35_000)
app.on('will-quit', () => { clearTimeout(deadline) })

async function run() {
  await app.whenReady()
  nativeTheme.themeSource = 'dark'
  desktop = createDesktopWindow({
    BrowserWindow, Menu, WebContentsView, ipcMain, nativeTheme,
    productName: 'DeepSeek harness 安装自测', iconPath,
    titlebarPreloadPath: join(application, 'src', 'titlebar-preload.cjs'),
    titlebarHtmlPath: join(application, 'assets', 'titlebar.html'),
    titlebarChannels: TITLEBAR_IPC,
    fallbackSnapshot: fallbackTitlebarSnapshot, captureSnapshot: async () => fallbackTitlebarSnapshot(true),
    getBackendOrigin: () => undefined, openExternal: () => {},
  })
  let attempts = 0, starts = 0, fetches = 0, source = 'official', sourceChanges = 0, connectionTests = 0, downloadActivity = ''
  const releases = [{ version: '1.0.0', recommended: true, preview: false }, { version: '0.9.0', recommended: false, preview: false }]
  setup = createFirstRunSetup({
    ipcMain, window: desktop.window, htmlPath: join(application, 'assets', 'titlebar.html'),
    showLoading: () => { desktop.showLoading() },
    downloadSettings: {
      getState: () => ({ source, activity: downloadActivity }),
      setSource: next => { assert.ok(['official', 'npmmirror'].includes(next)); source = next; sourceChanges += 1 },
      testConnection: async () => { assert.equal(source, 'npmmirror'); connectionTests += 1; return { ok: true, message: 'npmmirror 连接正常（模拟检测）' } },
    },
    onInstalled: runtime => { assert.equal(runtime.version, '0.9.0'); starts += 1; setup.complete() },
    updater: {
      fetchAvailableVersions: async () => { if (++fetches === 1) throw new Error('offline fixture'); return releases },
      installInitialRelease: async release => {
        attempts += 1
        assert.equal(release.version, '0.9.0')
        assert.equal(source, 'npmmirror')
        await expectDom("document.getElementById('setup-source').disabled && document.getElementById('setup-source-test').disabled")
        downloadActivity = '镜像缺少此文件，已回退官方源下载。'
        setup.refreshDownloadSettings()
        await expectDom("document.getElementById('setup-source-detail').textContent.includes('回退官方源')")
        downloadActivity = ''
        setup.refreshDownloadSettings()
        await expectDom("document.getElementById('setup-source-detail').textContent.includes('版本同步可能有延迟')")
        if (attempts === 1) {
          const activity = () => setup.progress('stage', 'installing', release.version, { completedFiles: 2, registryRequests: 98 })
          activity()
          await expectDom("document.getElementById('setup-progress').dataset.mode === 'indeterminate'")
          await assertProgressMotion(desktop.window.webContents, '#setup-progress', activity)
          trace.push('install:continuous-and-reduced-motion')
        }
        setup.progress('stage', 'verifying', release.version, { completedFiles: 25, totalFiles: 100 })
        await expectDom("document.getElementById('setup-progress').getAttribute('aria-valuenow') === '25'")
        if (attempts === 1) throw new Error('install failure fixture')
        return release
      },
    },
  })
  await desktop.loadShell()
  desktop.window.show()
  tray = createDesktopTray({
    Tray, Menu, window: desktop.window, iconPath, productName: 'DeepSeek harness 安装自测',
    isQuitting: () => false, focusOfficial: () => {}, requestQuit: () => {},
  })
  await expectDom("document.documentElement.dataset.maximized === 'false'")
  await expectDom("document.querySelectorAll('#titlebar [title]').length === 0")
  assert.equal(await evaluate("[...document.querySelectorAll('#window-controls svg')].every(icon => getComputedStyle(icon).strokeWidth === '1.5px' && getComputedStyle(icon).width === '16px')"), true)
  await clickCaption('#window-maximize')
  await expectDom("document.getElementById('window-maximize').getAttribute('aria-label') === '还原'")
  await expectDom("document.querySelectorAll('#titlebar [title]').length === 0")
  assert.equal(desktop.window.isMaximized(), true)
  await clickCaption('#window-maximize')
  await expectDom("document.getElementById('window-maximize').getAttribute('aria-label') === '最大化'")
  await expectDom("document.querySelectorAll('#titlebar [title]').length === 0")
  assert.equal(desktop.window.isMaximized(), false)
  await clickCaption('#window-minimize')
  await expectNative(() => desktop.window.isMinimized())
  tray.showWindow()
  await expectNative(() => !desktop.window.isMinimized())
  await clickCaption('#window-close')
  await expectNative(() => !desktop.window.isVisible())
  assert.equal(desktop.window.isDestroyed(), false)
  tray.showWindow()
  assert.equal(desktop.window.isVisible(), true)
  trace.push('caption:uniform-icons-minimize-maximize-restore-tray')
  desktop.window.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 22 })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const captionWidth = desktop.window.getContentBounds().width
  writeFileSync(join(dirname(screenshot), 'caption-smoke.png'), (await desktop.window.webContents.capturePage({ x: captionWidth - 160, y: 0, width: 160, height: 44 })).toPNG())
  await setup.show()
  await expectDom("document.getElementById('setup-status').textContent.includes('offline fixture')")
  await expectDom("document.getElementById('setup-source').options.length === 2 && !document.getElementById('setup-source').disabled")
  await evaluate("document.getElementById('setup-source').value = 'npmmirror'; document.getElementById('setup-source').dispatchEvent(new Event('change'))")
  await expectDom("document.getElementById('setup-source').value === 'npmmirror' && !document.getElementById('setup-source').disabled")
  assert.equal(source, 'npmmirror')
  assert.equal(sourceChanges, 1)
  assert.equal(attempts, 0)
  await evaluate("document.getElementById('setup-source-test').click()")
  await expectDom("document.getElementById('setup-source-status').textContent.includes('连接正常')")
  assert.equal(connectionTests, 1)
  source = 'official'
  setup.refreshDownloadSettings()
  await expectDom("document.getElementById('setup-source').value === 'official' && document.getElementById('setup-source-status').hidden")
  source = 'npmmirror'
  setup.refreshDownloadSettings()
  await expectDom("document.getElementById('setup-source').value === 'npmmirror'")
  trace.push('offline:retry-visible')
  await evaluate("document.getElementById('setup-refresh').click()")
  await expectDom("document.getElementById('setup-version').options.length === 2")
  assert.equal(attempts, 0)
  trace.push('catalog:waits-for-choice')
  await expectDom("!document.getElementById('setup-panel').hidden && getComputedStyle(document.getElementById('setup-panel')).display === 'grid'")
  await expectDom("document.images.length === 2 && [...document.images].every(image => image.complete && image.naturalWidth > 0)")
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await new Promise(resolve => setTimeout(resolve, 200))
  writeFileSync(screenshot, (await desktop.window.webContents.capturePage()).toPNG())
  await evaluate("document.getElementById('setup-version').value = '0.9.0'; document.getElementById('setup-install').click()")
  await expectDom("document.getElementById('setup-status').textContent.includes('install failure fixture')")
  assert.equal(starts, 0)
  trace.push('install:failure-with-real-progress')
  await evaluate("document.getElementById('setup-install').click()")
  await expectDom("document.getElementById('setup-panel').hidden")
  assert.equal(starts, 1)
  trace.push('retry:selected-version-started')
  await desktop.officialWebContents.loadURL('about:blank')
  assert.equal(await desktop.officialWebContents.executeJavaScript('typeof window.harnessSetup'), 'undefined')
  assert.equal(await desktop.officialWebContents.executeJavaScript('typeof window.harnessWindowControls'), 'undefined')
  trace.push('official:no-install-bridge')
  updateProgress = createUpdateProgressWindow({
    BrowserWindow, ipcMain, nativeTheme, getParent: () => desktop.window,
    preloadPath: join(application, 'src', 'update-progress-preload.cjs'),
    htmlPath: join(progressAssets, 'update-progress.html'),
  })
  updateProgress.begin('0.9.0')
  const updateWindow = BrowserWindow.getAllWindows().find(window => window !== desktop.window)
  const updateContents = updateWindow.webContents
  await expectDom("document.getElementById('progress')?.dataset.mode === 'indeterminate'", updateContents)
  const activity = () => updateProgress.stage('installing', '0.9.0', { completedFiles: 2, registryRequests: 98 })
  await assertProgressMotion(updateContents, '#progress', activity)
  trace.push('update:continuous-and-reduced-motion')
  updateProgress.stage('verifying', '0.9.0', { completedFiles: 25, totalFiles: 100 })
  await expectDom("document.getElementById('progress').getAttribute('aria-valuenow') === '25'", updateContents)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await updateContents.executeJavaScript("getComputedStyle(document.querySelector('.progress-fill')).transform"), 'matrix(0.25, 0, 0, 1, 0, 0)')
  updateProgress.complete('0.9.0')
  await expectDom("document.getElementById('progress').getAttribute('aria-valuenow') === '100'", updateContents)
  updateProgress.fail('0.9.0')
  await expectDom("document.getElementById('progress').dataset.mode === 'failed' && !document.getElementById('progress').hasAttribute('aria-valuenow')", updateContents)
  trace.push('update:measured-progress-and-failure')
  updateProgress.dispose()
  tray.dispose()
  setup.dispose()
  desktop.dispose()
  desktop.window.destroy()
  process.stdout.write(`setup-smoke:${JSON.stringify(trace)}\n`)
  app.quit()
}
const evaluate = source => desktop.window.webContents.executeJavaScript(source)
async function clickCaption(selector) {
  const point = await evaluate(`(() => { const bounds = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) } })()`)
  for (const type of ['mouseDown', 'mouseUp']) desktop.window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
}
async function expectNative(predicate) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('native caption action timed out')
}
async function expectDom(expression, contents = desktop.window.webContents) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await contents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`renderer condition timed out: ${expression}`)
}
void run().catch(error => {
  process.stderr.write(`${error.stack ?? String(error)}\n`)
  setup?.dispose()
  updateProgress?.dispose()
  tray?.dispose()
  desktop?.dispose()
  app.exit(1)
})
