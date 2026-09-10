import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { validateShellRelease } from '../src/shell-updater.mjs'
import { SHELL_RELEASE_SOURCE } from '../src/release-config.mjs'

// Use the parser/archive dependencies belonging to the locked packaging tool.
const require = createRequire(import.meta.url)
const buildRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { load } = buildRequire('js-yaml')
const asar = buildRequire('@electron/asar')
const root = resolve(import.meta.dirname, '..')

export function verifyArtifacts() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const output = join(root, 'dist')
  const info = load(readFileSync(join(output, 'latest.yml'), 'utf8'))
  const release = validateShellRelease(info)
  assert.equal(release.version, manifest.version)
  const bytes = readFileSync(join(output, release.name))
  assert.equal(bytes.length, release.size)
  assert.equal(createHash('sha512').update(bytes).digest('base64'), info.files[0].sha512)
  const blockmap = JSON.parse(gunzipSync(readFileSync(join(output, `${release.name}.blockmap`))))
  assert.equal(blockmap.version, '2')
  assert.equal(blockmap.files.length, 1)
  assert.equal(blockmap.files[0].offset, 0)
  assert.equal(blockmap.files[0].sizes.reduce((sum, size) => sum + size, 0), bytes.length)
  assert.equal(blockmap.files[0].sizes.length, blockmap.files[0].checksums.length)
  const unpacked = join(output, 'win-unpacked')
  const resources = join(unpacked, 'resources')
  const config = load(readFileSync(join(resources, 'app-update.yml'), 'utf8'))
  for (const [key, value] of Object.entries(SHELL_RELEASE_SOURCE)) assert.equal(config[key], value)
  const archive = join(resources, 'app.asar')
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString())
  assert.equal(packaged.version, manifest.version)
  assert.deepEqual(packaged.dependencies, manifest.dependencies)
  for (const file of ['src/main.mjs', 'src/release-config.mjs', 'src/shell-updater.mjs',
    'src/plugin-manager.mjs', 'src/plugin-catalog.mjs', 'src/plugin-runtime.mjs',
    'src/settings-window.mjs', 'src/settings-controller.mjs', 'assets/settings.js',
    'assets/settings.html', 'assets/settings.css',
    'src/shell-update-window.mjs', 'src/shell-update-preload.cjs', 'assets/shell-update.js',
    'assets/shell-update.html', 'assets/icon.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'licenses/DeepSeek-Harness.LICENSE', 'licenses/lazy-val.NOTICE']) {
    assert.deepEqual(asar.extractFile(archive, file), readFileSync(join(root, file)), `Packaged file mismatch: ${file}`)
  }
  for (const file of ['node_modules/electron-updater/LICENSE', 'node_modules/builder-util-runtime/LICENSE']) {
    assert.ok(asar.extractFile(archive, join(...file.split('/'))).length > 100)
  }
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) assert.ok(readFileSync(join(unpacked, file)).length > 100)
  assert.equal(existsSync(join(resources, 'runtime', 'node_modules')), false)
  process.stdout.write(`Release artifacts verified: ${release.version}, ${release.size} bytes, matching SHA-512/blockmap/feed/source/licenses.\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyArtifacts()
