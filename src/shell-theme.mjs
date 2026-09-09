import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_THEME = 'system'
const SETTINGS_FILE = 'settings.yaml'
const WATCH_INTERVAL_MS = 500
const THEME_SECTION = /^ui-theme:[ \t]*(?:#.*)?$/u
const ANY_THEME_SECTION = /^ui-theme[ \t]*:/u
const THEME_PREFERENCE = /^ {2}preference:[ \t]*(?:(light|dark|system)|'(light|dark|system)'|"(light|dark|system)")[ \t]*(?:#.*)?$/u
const ANY_THEME_PREFERENCE = /^[ \t]+preference[ \t]*:/u

/**
 * Resolve the Harness home exactly as the backend does from its workspace cwd.
 * @param {NodeJS.ProcessEnv} environment environment inherited by the backend.
 * @param {string} cwd backend working directory.
 * @param {string} home operating-system home directory.
 * @returns {string} absolute Harness home.
 */
export function resolveShellDshHome(environment = process.env, cwd = process.cwd(), home = homedir()) {
  const configured = environment.DSH_HOME
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(home, '.dsh')
  const expanded = selected === '~'
    ? home
    : (selected.startsWith('~/') || selected.startsWith('~\\') ? join(home, selected.slice(2)) : selected)
  return resolve(cwd, expanded)
}

/**
 * Read the official block-mapping form of `ui-theme.preference`.
 * @param {string} text settings YAML text.
 * @returns {'light' | 'dark' | 'system'} stored preference or its official default.
 */
export function parseShellThemePreference(text) {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  let foundSection = false
  let inThemeSection = false
  let preference

  for (const line of lines) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      inThemeSection = false
      if (!ANY_THEME_SECTION.test(line)) continue
      if (foundSection || !THEME_SECTION.test(line)) {
        throw new Error('settings.yaml has an invalid or duplicate ui-theme section')
      }
      foundSection = true
      inThemeSection = true
      continue
    }
    if (!inThemeSection || !ANY_THEME_PREFERENCE.test(line)) continue
    const match = THEME_PREFERENCE.exec(line)
    if (preference !== undefined || match === null) {
      throw new Error('settings.yaml has an invalid or duplicate ui-theme.preference')
    }
    preference = match[1] ?? match[2] ?? match[3]
  }

  return preference ?? DEFAULT_THEME
}

/**
 * Apply and watch the official renderer theme preference for Electron chrome.
 * @param {object} options synchronization dependencies.
 * @param {{ themeSource: string }} options.nativeTheme Electron nativeTheme singleton.
 * @param {string} options.cwd backend working directory.
 * @param {NodeJS.ProcessEnv} [options.environment] environment inherited by the backend.
 * @param {(path: string, encoding: BufferEncoding) => string} [options.readFile] settings reader.
 * @param {typeof watchFile} [options.watch] file watcher.
 * @param {typeof unwatchFile} [options.unwatch] file watcher cleanup.
 * @param {(error: unknown) => void} [options.onError] contained read/parse failure reporter.
 * @returns {() => void} idempotent watcher cleanup.
 */
export function startShellThemeSync({
  nativeTheme,
  cwd,
  environment = process.env,
  readFile = readFileSync,
  watch = watchFile,
  unwatch = unwatchFile,
  onError = () => {},
}) {
  const settingsPath = join(resolveShellDshHome(environment, cwd), SETTINGS_FILE)
  let disposed = false

  const apply = () => {
    if (disposed) return
    let preference
    try {
      preference = parseShellThemePreference(readFile(settingsPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') preference = DEFAULT_THEME
      else {
        onError(error)
        return
      }
    }
    nativeTheme.themeSource = preference
  }
  const listener = () => { apply() }

  apply()
  watch(settingsPath, { persistent: false, interval: WATCH_INTERVAL_MS }, listener)

  return () => {
    if (disposed) return
    disposed = true
    unwatch(settingsPath, listener)
  }
}
