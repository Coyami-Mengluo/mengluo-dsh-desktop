import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { createLanguageController, LANGUAGE_IPC, readLanguagePreference, writeLanguagePreference,
  localizeMenu, localizeMessageOptions } from '../src/language.mjs'
import { resolveLocale, translateMessage } from '../assets/i18n.js'
import { ENGLISH } from '../assets/i18n-catalog.js'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'

describe('client language isolation and persistence', () => {
  it('resolves only supported shell locales with a deterministic system fallback', () => {
    for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh_HK']) assert.equal(resolveLocale('system', locale), 'zh-CN')
    for (const locale of ['en-US', 'fr', '', undefined]) assert.equal(resolveLocale('system', locale), 'en')
    assert.equal(resolveLocale('en', 'zh-CN'), 'en')
    assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN')
  })

  it('translates shell templates but preserves interpolation, unknown diagnostics and raw data', () => {
    assert.equal(translateMessage('检查更新', 'en'), 'Check for updates')
    assert.equal(translateMessage('检查更新', 'zh-CN'), '检查更新')
    assert.equal(translateMessage('目标版本 0.1.5-rc.2', 'en'), 'Target version 0.1.5-rc.2')
    assert.equal(translateMessage('作者：安装', 'en'), 'Author: 安装')
    assert.equal(translateMessage('uncatalogued 诊断信息', 'en'), 'uncatalogued 诊断信息')
    for (const [source, translated] of Object.entries(ENGLISH)) {
      const keys = value => [...new Set(value.match(/\{\d+\}/gu) ?? [])].sort()
      assert.deepEqual(keys(source), keys(translated), source)
    }
  })

  it('saves only the shell preference and falls back safely for corrupt or expanded data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mengluo-language-'))
    try {
      assert.equal(readLanguagePreference(directory), 'system')
      writeLanguagePreference(directory, 'en')
      assert.equal(readLanguagePreference(directory), 'en')
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'language-settings.json'), 'utf8')), { language: 'en' })
      assert.throws(() => writeLanguagePreference(directory, 'https://example.invalid'))
      assert.equal(readLanguagePreference(directory), 'en')
      for (const text of ['{', JSON.stringify({ language: 'en', extra: true }), JSON.stringify({ language: 'xx' }), ' '.repeat(4097)]) {
        writeFileSync(join(directory, 'language-settings.json'), text)
        assert.equal(readLanguagePreference(directory), 'system')
      }
    } finally { removeTreeWithoutFollowingLinks(directory) }
  })

  it('restricts read/write IPC to registered exact local main frames and updates every shell window', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mengluo-language-ipc-'))
    const handlers = new Map(), changes = []
    let systemLocale = 'zh-CN'
    const ipcMain = { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) }
    const language = createLanguageController({ userData: directory, ipcMain,
      getSystemLocale: () => systemLocale, onChanged: state => changes.push(state) })
    const window = () => {
      const value = new EventEmitter()
      value.title = '客户端设置'
      value.getTitle = () => value.title
      value.setTitle = title => { value.title = title }
      value.isDestroyed = () => false
      value.webContents = { mainFrame: { url: pathToFileURL(join(directory, 'settings.html')).href },
        isDestroyed: () => false, send: (...args) => changes.push(args) }
      return value
    }
    const settings = window(), progress = window(), official = window()
    const event = value => ({ sender: value.webContents, senderFrame: value.webContents.mainFrame })
    try {
      language.register(settings, join(directory, 'settings.html'), true)
      language.register(progress, join(directory, 'settings.html'))
      const read = handlers.get(LANGUAGE_IPC.get), write = handlers.get(LANGUAGE_IPC.set)
      assert.equal(read(event(settings)).locale, 'zh-CN')
      assert.equal(read(event(official)), undefined)
      assert.equal(read(event(settings), 'extra'), undefined)
      assert.equal(write(event(progress), 'en').ok, false)
      assert.equal(write(event(official), 'en').ok, false)
      assert.equal(write({ ...event(settings), senderFrame: { url: settings.webContents.mainFrame.url } }, 'en').ok, false)
      for (const args of [[], ['en', 'extra'], [{ language: 'en' }], ['fr'], ['__proto__']]) assert.equal(write(event(settings), ...args).ok, false)
      settings.webContents.mainFrame.url = 'https://example.invalid/'
      assert.equal(write(event(settings), 'en').ok, false)
      settings.webContents.mainFrame.url = pathToFileURL(join(directory, 'settings.html')).href
      assert.equal(write(event(settings), 'en').ok, true)
      assert.equal(language.state().locale, 'en')
      assert.equal(readLanguagePreference(directory), 'en')
      assert.equal(settings.title, 'Client settings')
      assert.equal(progress.title, 'Client settings')
      assert.equal(write(event(settings), 'system').ok, true)
      systemLocale = 'en-US'
      settings.emit('focus')
      assert.equal(language.state().locale, 'en')
      assert.equal(changes.at(-1).locale, 'en')
      language.dispose()
      assert.equal(handlers.size, 0)
      assert.equal(settings.listenerCount('focus'), 0)
      assert.equal(write(event(settings), 'zh-CN').ok, false)
    } finally { language.dispose(); removeTreeWithoutFollowingLinks(directory) }
  })

  it('localizes native labels without changing actions or mutating original templates', () => {
    const translate = value => translateMessage(value, 'en')
    const click = () => {}
    const menu = [{ label: '客户端设置', submenu: [{ label: '复制', click }, { type: 'separator' }] }]
    const result = localizeMenu(menu, translate)
    assert.equal(result[0].label, 'Client settings')
    assert.equal(result[0].submenu[0].click, click)
    assert.equal(menu[0].label, '客户端设置')
    const box = localizeMessageOptions({ message: '检查更新', buttons: ['取消'], defaultId: 1 }, translate)
    assert.equal(box.message, 'Check for updates')
    assert.deepEqual(box.buttons, ['Cancel'])
    assert.equal(box.defaultId, 1)
  })
})
