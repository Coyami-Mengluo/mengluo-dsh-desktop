import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build, Platform, Arch } from 'electron-builder'
import { assertMaterializedTree } from './staging.mjs'
import { verifyNodeExecutable, verifyNodeLicense } from './staging-node.mjs'
import { verifyNpmTree } from './staging-npm.mjs'
import { SHELL_RELEASE_SOURCE } from '../src/release-config.mjs'
import { verifyArtifacts } from './verify-artifacts.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))
const electronDist = join(APP_ROOT, 'node_modules', 'electron', 'dist')
for (const path of ['build/runtime/node-runtime/node.exe', 'build/updater/npm/package.json', 'assets/icon.png']) {
  if (!existsSync(join(APP_ROOT, path))) throw new Error(`Missing packaging input: ${path}`)
}
await build({
  projectDir: APP_ROOT,
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
  publish: 'never',
  // electron-builder already reads package.json/build. Passing those arrays twice
  // concatenates extraResources and races duplicate copies of the same Node EXE.
  config: {
    electronDist, publish: [SHELL_RELEASE_SOURCE],
    afterPack: context => {
      // electron-builder's file filter omits empty directories from extraResources.
      // Preserve the exact official npm closure before NSIS/portable compression.
      const source = join(APP_ROOT, 'build', 'updater', 'npm')
      assertMaterializedTree(source)
      const destination = join(context.appOutDir, 'resources', 'updater', 'npm')
      const copyDirectories = (from, to) => {
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const target = join(to, entry.name)
          mkdirSync(target, { recursive: true })
          copyDirectories(join(from, entry.name), target)
        }
      }
      copyDirectories(source, destination)
    },
  },
})

const output = join(APP_ROOT, 'dist')
const resources = join(output, 'win-unpacked', 'resources')
const nodeRoot = join(resources, 'runtime', 'node-runtime')
const nodePath = join(nodeRoot, 'node.exe')
verifyNodeExecutable(nodePath)
verifyNodeLicense(join(nodeRoot, 'LICENSE'))
verifyNpmTree(join(resources, 'updater', 'npm'), { nodePath })
assertMaterializedTree(join(resources, 'runtime'))
assertMaterializedTree(join(resources, 'updater'))
if (existsSync(join(resources, 'runtime', 'node_modules'))) throw new Error('The desktop installer must not bundle Harness.')
for (const path of [
  'app.asar', 'app-update.yml', 'app.asar.unpacked/src/shell-updater.mjs',
  'app.asar.unpacked/src/shell-update-preload.cjs', 'app.asar.unpacked/assets/shell-update.html',
  'app.asar.unpacked/assets/progress-meter.js',
  'app.asar.unpacked/src/settings-window.mjs', 'app.asar.unpacked/src/settings-preload.cjs',
  'app.asar.unpacked/src/settings-controller.mjs', 'app.asar.unpacked/src/download-source.mjs',
  'app.asar.unpacked/src/plugin-manager.mjs', 'app.asar.unpacked/src/plugin-catalog.mjs',
  'app.asar.unpacked/src/plugin-runtime.mjs', 'app.asar.unpacked/src/plugin-rate-limit.mjs',
  'app.asar.unpacked/assets/settings.html', 'app.asar.unpacked/assets/settings.css',
  'app.asar.unpacked/assets/settings.js',
]) {
  if (!existsSync(join(resources, path))) throw new Error(`Missing packaged resource: ${path}`)
}
for (const name of [
  `MengLuo-DSH-Desktop-${manifest.version}-setup.exe`,
  `MengLuo-DSH-Desktop-${manifest.version}-setup.exe.blockmap`,
  `MengLuo-DSH-Desktop-${manifest.version}-portable.exe`, 'latest.yml',
]) {
  if (!existsSync(join(output, name))) throw new Error(`Missing release artifact: ${name}`)
}
verifyArtifacts()
process.stdout.write('Packaged the standalone client and differential-update metadata. Nothing was uploaded.\n')
