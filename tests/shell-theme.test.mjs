import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  parseShellThemePreference,
  resolveShellDshHome,
  startShellThemeSync,
} from '../src/shell-theme.mjs'

describe('desktop shell theme synchronization', () => {
  it('strictly parses the official theme section and defaults missing preferences', () => {
    assert.equal(parseShellThemePreference('locale:\n  preference: zh\n'), 'system')
    assert.equal(parseShellThemePreference('ui-theme:\n  preference: dark\n'), 'dark')
    assert.equal(parseShellThemePreference('ui-theme:\n  preference: "light" # retained style\n'), 'light')
    assert.throws(
      () => parseShellThemePreference('ui-theme:\n  preference: sepia\n'),
      /invalid or duplicate ui-theme\.preference/u,
    )
    assert.throws(
      () => parseShellThemePreference('ui-theme:\n  preference: dark\nui-theme:\n  preference: light\n'),
      /invalid or duplicate ui-theme section/u,
    )
  })

  it('resolves relative DSH_HOME from the same cwd used by the backend', () => {
    const workspace = resolve('fixture-workspace')
    const home = resolve('fixture-user-home')
    assert.equal(resolveShellDshHome({ DSH_HOME: 'relative-home' }, workspace, home), join(workspace, 'relative-home'))
    assert.equal(resolveShellDshHome({ DSH_HOME: '  ' }, workspace, home), join(home, '.dsh'))
    assert.equal(resolveShellDshHome({ DSH_HOME: '~/.custom-dsh' }, workspace, home), join(home, '.custom-dsh'))
  })

  it('applies live changes, contains invalid edits, and disposes a non-persistent watcher', () => {
    const workspace = resolve('fixture-workspace')
    const settingsPath = join(workspace, 'relative-home', 'settings.yaml')
    const documents = new Map([[settingsPath, 'ui-theme:\n  preference: dark\n']])
    const errors = []
    const nativeTheme = { themeSource: 'system' }
    let watched
    let unwatched

    const dispose = startShellThemeSync({
      nativeTheme,
      cwd: workspace,
      environment: { DSH_HOME: 'relative-home' },
      readFile: path => {
        if (!documents.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return documents.get(path)
      },
      watch: (path, options, listener) => { watched = { path, options, listener } },
      unwatch: (path, listener) => { unwatched = { path, listener } },
      onError: error => { errors.push(error) },
    })

    assert.equal(nativeTheme.themeSource, 'dark')
    assert.deepEqual({ path: watched.path, options: watched.options }, {
      path: settingsPath,
      options: { persistent: false, interval: 500 },
    })

    documents.set(settingsPath, 'ui-theme:\n  preference: sepia\n')
    watched.listener()
    assert.equal(nativeTheme.themeSource, 'dark')
    assert.equal(errors.length, 1)

    documents.set(settingsPath, 'ui-theme:\n  preference: light\n')
    watched.listener()
    assert.equal(nativeTheme.themeSource, 'light')

    documents.delete(settingsPath)
    watched.listener()
    assert.equal(nativeTheme.themeSource, 'system')

    dispose()
    dispose()
    assert.deepEqual(unwatched, { path: settingsPath, listener: watched.listener })
  })
})
