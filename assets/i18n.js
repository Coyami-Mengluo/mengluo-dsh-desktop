import { ENGLISH } from './i18n-catalog.js'

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const placeholders = /\{(\d+)\}/gu
const interpolate = (format, values) => format.replace(placeholders, (token, index) => index < values.length ? String(values[index]) : token)
const patterns = Object.entries(ENGLISH).filter(([key]) => /\{\d+\}/u.test(key)).map(([key, english]) => {
  const indices = []
  let offset = 0, expression = '^'
  for (const match of key.matchAll(placeholders)) {
    expression += escape(key.slice(offset, match.index)) + '([\\s\\S]*?)'
    indices.push(Number(match[1])); offset = match.index + match[0].length
  }
  expression += escape(key.slice(offset)) + '$'
  return { match: new RegExp(expression, 'u'), english, indices, specificity: key.replace(placeholders, '').length }
}).sort((a, b) => b.specificity - a.specificity)

export function resolveLocale(preference = 'system', systemLocale = 'en') {
  if (preference === 'zh-CN' || preference === 'en') return preference
  return /^zh(?:[-_]|$)/iu.test(String(systemLocale)) ? 'zh-CN' : 'en'
}

/** Translate only a shell-owned message. Interpolated names, paths and URLs stay verbatim. */
export function translateMessage(value, locale = 'zh-CN') {
  if (typeof value !== 'string' || locale !== 'en') return value
  if (Object.hasOwn(ENGLISH, value)) return ENGLISH[value]
  if (value.length > 16_384 || !/\p{Script=Han}/u.test(value)) return value
  for (const pattern of patterns) {
    const match = pattern.match.exec(value)
    if (!match) continue
    const values = []
    pattern.indices.forEach((index, capture) => { values[index] = match[capture + 1] })
    return interpolate(pattern.english, values)
  }
  // Dialogs concatenate independently authored paragraphs. Never rewrite arbitrary substrings.
  if (value.includes('\n')) return value.split('\n').map(line => translateMessage(line, locale)).join('\n')
  return value
}

let current = Object.freeze({ preference: 'system', locale: 'zh-CN', available: false })
const listeners = new Set()
export const languageState = () => current
export function tr(key, ...values) {
  if (Array.isArray(key) && Object.hasOwn(key, 'raw')) {
    const format = key.map((part, index) => part + (index < values.length ? `{${index}}` : '')).join('')
    return interpolate(current.locale === 'en' && Object.hasOwn(ENGLISH, format) ? ENGLISH[format] : format, values)
  }
  return translateMessage(key, current.locale)
}
export function onLanguageChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export async function setLanguagePreference(preference) {
  if (!['system', 'zh-CN', 'en'].includes(preference) || !globalThis.window?.desktopLanguage) return false
  const result = await window.desktopLanguage.setPreference(preference)
  if (result?.ok) receive(result.state)
  return result?.ok === true
}

// Capture static shell text once, before any dynamic/plugin content is rendered.
// No MutationObserver, remote requests, HTML insertion or official-page access.
const staticNodes = []
function capture(document) {
  const walker = document.createTreeWalker(document.documentElement, 4)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (/\p{Script=Han}/u.test(node.nodeValue) && !['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)
      && !node.parentElement?.closest('[data-language-name]')) staticNodes.push({ node, original: node.nodeValue })
  }
  for (const element of document.querySelectorAll('[aria-label], [placeholder], [alt], [title]')) {
    for (const name of ['aria-label', 'placeholder', 'alt', 'title']) {
      const value = element.getAttribute(name)
      if (value && /\p{Script=Han}/u.test(value)) staticNodes.push({ node: element, attribute: name, original: value })
    }
  }
}
function receive(value) {
  if (!value || !['system', 'zh-CN', 'en'].includes(value.preference) || !['zh-CN', 'en'].includes(value.locale)) return
  const changed = current.preference !== value.preference || current.locale !== value.locale || !current.available
  current = Object.freeze({ preference: value.preference, locale: value.locale, available: true })
  if (!changed) return
  document.documentElement.lang = current.locale
  for (const { node, attribute, original } of staticNodes) {
    if (!node.isConnected) continue
    const translated = original.replace(/\S[\s\S]*\S|\S/u, text => tr(text))
    if (attribute) node.setAttribute(attribute, translated)
    else node.nodeValue = translated
  }
  for (const listener of listeners) listener(current)
}
if (typeof document !== 'undefined') {
  capture(document)
  const api = globalThis.window?.desktopLanguage
  if (api) {
    const unsubscribe = api.onState(receive)
    void api.getState().then(receive).catch(() => {})
    window.addEventListener('beforeunload', () => { unsubscribe(); listeners.clear() }, { once: true })
  }
}
