import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHarnessTerminalLaunch, TERMINAL_PNPM_VERSION } from '../src/runtime-terminal.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Harness terminal launch', () => {
  it('uses exact slot and shell tooling while removing inherited secrets', () => {
    const launch = createHarnessTerminalLaunch({
      platform: 'win32',
      exists: () => true,
      environment: {
        SystemRoot: 'C:\\Windows',
        Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
        DEEPSEEK_API_KEY: 'must-not-leak',
        access_token: 'must-not-leak-either',
        ELECTRON_RUN_AS_NODE: '1',
      },
      runtime: {
        version: '0.1.0-rc.6',
        nodePath: 'C:\\runtime\\node-runtime\\node.exe',
        cliPath: 'C:\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      },
      npmCliPath: 'C:\\resources\\updater\\npm\\bin\\npm-cli.js',
      terminalBinPath: 'C:\\resources\\app.asar.unpacked\\assets\\terminal-bin',
      workspacePath: 'C:\\Users\\test\\Documents\\DeepSeek harness Workspace',
      proxy: 'http://127.0.0.1:18080',
    })

    assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(launch.args, ['/d', '/c', 'call open-terminal.cmd'])
    assert.equal(launch.cwd, 'C:\\Users\\test\\Documents\\DeepSeek harness Workspace')
    assert.equal(launch.env.DSH_RUNTIME_VERSION, '0.1.0-rc.6')
    assert.equal(launch.env.DSH_DESKTOP_NODE, 'C:\\runtime\\node-runtime\\node.exe')
    assert.equal(launch.env.DSH_DESKTOP_NPM_CLI, 'C:\\resources\\updater\\npm\\bin\\npm-cli.js')
    assert.equal(
      launch.env.DSH_DESKTOP_TERMINAL_BOOTSTRAP,
      'C:\\resources\\app.asar.unpacked\\assets\\terminal-bin\\harness-terminal.cmd',
    )
    assert.equal(launch.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(launch.env.access_token, undefined)
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(launch.env.ComSpec, 'C:\\Windows\\System32\\cmd.exe')
    assert.equal(launch.env.HTTPS_PROXY, 'http://127.0.0.1:18080')
    assert.match(launch.env.Path, /^C:\\runtime\\node-runtime;C:\\resources\\app\.asar\.unpacked\\assets\\terminal-bin;/u)
    assert.deepEqual(launch.spawnOptions, { stdio: 'ignore', windowsHide: true, detached: false })
  })

  it('rejects relative Windows roots and missing shell assets', () => {
    const base = {
      platform: 'win32',
      environment: { SystemRoot: 'Windows' },
      runtime: { version: '1.0.0', nodePath: 'node.exe', cliPath: 'dsh.js' },
      npmCliPath: 'npm-cli.js',
      terminalBinPath: 'terminal-bin',
      workspacePath: 'workspace',
      exists: () => true,
    }
    assert.throws(() => createHarnessTerminalLaunch(base), /not an absolute drive path/u)
    assert.throws(() => createHarnessTerminalLaunch({
      ...base,
      environment: { SystemRoot: 'C:\\Windows' },
      exists: path => !path.endsWith('harness-terminal.cmd'),
    }), /terminal bootstrap is missing/u)
  })

  it('ships a START launcher that gives the interactive shell its own console', () => {
    const launcher = readFileSync(resolve(desktopRoot, 'assets', 'terminal-bin', 'open-terminal.cmd'), 'utf8')
    assert.match(launcher, /START "DeepSeek Harness Terminal" "%ComSpec%" \/d \/k call harness-terminal\.cmd/u)
    assert.doesNotMatch(launcher, /[A-Za-z]:\\|Users\\|AppData\\/u)
  })

  it('ships wrappers for exact node, npm, npx, pnpm, and dsh commands', () => {
    const root = resolve(desktopRoot, 'assets', 'terminal-bin')
    const pnpm = readFileSync(resolve(root, 'pnpm.cmd'), 'utf8')
    assert.match(pnpm, new RegExp(`pnpm@${TERMINAL_PNPM_VERSION.replaceAll('.', '\\.')}`, 'u'))
    for (const name of ['node.cmd', 'npm.cmd', 'npx.cmd', 'dsh.cmd']) {
      const source = readFileSync(resolve(root, name), 'utf8')
      assert.match(source, /DSH_DESKTOP_/u)
      assert.doesNotMatch(source, /Users\\|AppData\\|Program Files/u)
    }
  })

  it('runs a bootstrap whose physical path contains spaces through cmd.exe', {
    skip: process.platform !== 'win32',
  }, () => {
    const root = mkdtempSync(resolve(tmpdir(), 'deepseek terminal '))
    try {
      const terminalBinPath = resolve(root, 'terminal tools')
      const workspacePath = resolve(root, 'Harness Workspace')
      const runtimeRoot = resolve(root, 'runtime slot')
      const nodePath = resolve(runtimeRoot, 'node-runtime', 'node.exe')
      const cliPath = resolve(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const npmCliPath = resolve(root, 'updater npm', 'bin', 'npm-cli.js')
      const markerPath = resolve(root, 'terminal marker.txt')
      for (const directory of [
        terminalBinPath,
        workspacePath,
        dirname(nodePath),
        dirname(cliPath),
        dirname(npmCliPath),
      ]) mkdirSync(directory, { recursive: true })
      writeFileSync(resolve(terminalBinPath, 'harness-terminal.cmd'), '@ECHO OFF\r\n> "%DSH_TERMINAL_MARKER%" ECHO ready\r\n')
      writeFileSync(resolve(terminalBinPath, 'open-terminal.cmd'), '@ECHO OFF\r\nCALL harness-terminal.cmd\r\n')
      for (const path of [nodePath, cliPath, npmCliPath, resolve(dirname(npmCliPath), 'npx-cli.js')]) {
        writeFileSync(path, 'fixture')
      }
      const launch = createHarnessTerminalLaunch({
        platform: 'win32',
        environment: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          Path: process.env.Path,
          DSH_TERMINAL_MARKER: markerPath,
        },
        runtime: { version: '0.1.0-rc.6', nodePath, cliPath },
        npmCliPath,
        terminalBinPath,
        workspacePath,
      })
      const args = [...launch.args]
      const result = spawnSync(launch.command, args, {
        cwd: launch.cwd,
        env: launch.env,
        windowsHide: true,
        timeout: 5_000,
      })
      assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`)
      assert.equal(readFileSync(markerPath, 'utf8').trim(), 'ready')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
