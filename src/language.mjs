import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveLocale, translateMessage } from '../assets/i18n.js'

export const LANGUAGE_IPC = Object.freeze({ get: 'mengluo:language:get', set: 'mengluo:language:set', state: 'mengluo:language:state' })
export const validLanguage = value => ['system', 'zh-CN', 'en'].includes(value)
export function readLanguagePreference(userData) {
  try {
    const file = join(userData, 'language-settings.json')
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return 'system'
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && Object.keys(value).length === 1 && validLanguage(value.language) ? value.language : 'system'
  } catch { return 'system' }
}
export function writeLanguagePreference(userData, language) {
  if (!validLanguage(language)) throw new Error('unsupported client language')
  mkdirSync(userData, { recursive: true })
  const file = join(userData, 'language-settings.json')
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('language settings must be a regular file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = join(userData, `.language-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({ language }) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally { try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}

/** A separate, narrow bridge. Only registered local main frames can read/change shell language. */
export function createLanguageController({ userData, ipcMain, getSystemLocale, onChanged, log = () => {} }) {
  let preference = readLanguagePreference(userData)
  let disposed = false
  const windows = new Map()
  const state = () => Object.freeze({ preference, locale: resolveLocale(preference, getSystemLocale()) })
  const notifyWindow = (contents, entry, value) => {
    if (entry.window.isDestroyed() || contents.isDestroyed()) return
    try {
      entry.window.setTitle?.(translateMessage(entry.title, value.locale))
      if (contents.mainFrame?.url === entry.url) contents.send(LANGUAGE_IPC.state, value)
    } catch { /* A closing window must not turn a saved preference into a failure. */ }
  }
  const trusted = (event, write) => {
    const entry = windows.get(event.sender)
    return !disposed && entry && (!write || entry.canChange) && !entry.window.isDestroyed()
      && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === entry.url
  }
  const broadcast = () => {
    const value = state()
    for (const [contents, entry] of windows) notifyWindow(contents, entry, value)
    try { onChanged?.(value) } catch { log('client language menu refresh failed\n') }
  }
  const read = (event, ...args) => trusted(event, false) && args.length === 0 ? state() : undefined
  const write = (event, ...args) => {
    if (!trusted(event, true) || args.length !== 1 || !validLanguage(args[0])) return { ok: false }
    try {
      writeLanguagePreference(userData, args[0])
      preference = args[0]
      broadcast()
      return { ok: true, state: state() }
    } catch { log('client language preference could not be saved\n'); return { ok: false } }
  }
  ipcMain.handle(LANGUAGE_IPC.get, read)
  ipcMain.handle(LANGUAGE_IPC.set, write)
  return Object.freeze({
    state,
    translate: value => translateMessage(value, state().locale),
    register(window, htmlPath, canChange = false) {
      if (disposed) return
      const contents = window.webContents
      const focus = () => { if (!disposed && preference === 'system') broadcast() }
      const entry = { window, url: pathToFileURL(htmlPath).href, canChange, focus, title: window.getTitle?.() ?? '' }
      windows.set(contents, entry)
      notifyWindow(contents, entry, state())
      window.on('focus', focus)
      window.once('closed', () => { window.removeListener('focus', focus); windows.delete(contents) })
    },
    dispose() {
      disposed = true
      ipcMain.removeHandler(LANGUAGE_IPC.get); ipcMain.removeHandler(LANGUAGE_IPC.set)
      for (const entry of windows.values()) entry.window.removeListener('focus', entry.focus)
      windows.clear()
    },
  })
}

export function localizeMessageOptions(options, translate) {
  if (!options) return options
  const result = { ...options }
  for (const key of ['title', 'message', 'detail', 'body']) if (typeof result[key] === 'string') result[key] = translate(result[key])
  if (Array.isArray(result.buttons)) result.buttons = result.buttons.map(translate)
  return result
}
export function localizeMenu(template, translate) {
  return template.map(item => ({ ...item,
    ...(typeof item.label === 'string' ? { label: translate(item.label) } : {}),
    ...(Array.isArray(item.submenu) ? { submenu: localizeMenu(item.submenu, translate) } : {}),
  }))
}
