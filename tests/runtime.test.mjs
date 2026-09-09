import assert from 'node:assert/strict'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import {
  BACKEND_TREE_KILL_DELAY_MS,
  classifyNavigation,
  createBackendEnvironment,
  createHarnessWebArguments,
  observeHarnessOutput,
  parseReadyUrl,
  redactHarnessTokens,
  resolveBundledNpmCliPath,
  resolveBundledNodePath,
  resolveNodeChildScriptPath,
  resolveWindowsTaskkillPath,
} from '../src/runtime.mjs'

describe('desktop backend readiness', () => {
  it('disables rc.8 browser auto-open without breaking older fallback slots', () => {
    assert.deepEqual(
      createHarnessWebArguments('0.1.0-rc.7', 47_821),
      ['web', '--host', '127.0.0.1', '--port', '47821'],
    )
    assert.deepEqual(
      createHarnessWebArguments('0.1.0-rc.8', 0),
      ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    )
    assert.deepEqual(
      createHarnessWebArguments('0.1.0', 47_821),
      ['web', '--host', '127.0.0.1', '--port', '47821', '--no-open'],
    )
    assert.throws(() => createHarnessWebArguments('0.1.0-rc.8', 65_536), /invalid Harness Web port/u)
  })

  it('accepts the settled loopback URL line', () => {
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:47821'), 'http://127.0.0.1:47821/')
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:61997'), 'http://127.0.0.1:61997/')
    assert.equal(
      parseReadyUrl('info dsh web: http://127.0.0.1:47821 (LAN: http://192.0.2.1:47821)'),
      'http://127.0.0.1:47821/',
    )
  })

  it('rejects remote, malformed, and invalid-port readiness lines', () => {
    assert.equal(parseReadyUrl('dsh web: https://127.0.0.1:47821'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://localhost:47821'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:0'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:65536'), undefined)
    assert.equal(parseReadyUrl('not ready'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:51134@evil.example/?token=test'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:51134.evil.example/?token=test'), undefined)
    assert.equal(parseReadyUrl('dsh web: http://192.0.2.1:51134/?token=test'), undefined)
  })

  it('preserves login tokens and routes on the actual assigned port', () => {
    const url = 'http://127.0.0.1:51134/?token=fixture%2Btoken%3D&view=web#sessions'
    assert.equal(parseReadyUrl(`dsh web: ${url}`), url)
    assert.equal(parseReadyUrl(`info dsh web: ${url} (LAN: http://192.0.2.1:51134)`), url)
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:51134?token=test'), 'http://127.0.0.1:51134/?token=test')
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:51134/sessions/one?token=test'), 'http://127.0.0.1:51134/sessions/one?token=test')
  })

  it('redacts repeated query and fragment tokens without hiding other diagnostics', () => {
    assert.equal(
      redactHarnessTokens('loading http://127.0.0.1:51134/?view=web&token=secret&token=second#token=third'),
      'loading http://127.0.0.1:51134/?view=web&token=[REDACTED]&token=[REDACTED]#token=[REDACTED]',
    )
    assert.equal(redactHarnessTokens('candidate returned HTTP 401'), 'candidate returned HTTP 401')
  })

  it('keeps split-stream tokens for navigation while redacting complete log lines', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const urls = []
    const logs = []
    observeHarnessOutput({ stdout, stderr }, {
      onReady: url => { urls.push(url) },
      log: (source, text) => { logs.push(`[${source}] ${text}`) },
    })
    stdout.write('dsh web: http://127.0.0.1:51134/?to')
    stdout.write('ken=fixture-')
    stdout.write('secret')
    assert.deepEqual(logs, [])
    stdout.end('&view=web\r\n')
    stderr.write('failure at http://127.0.0.1:51134/?token=stderr-')
    stderr.end('secret\n')
    assert.deepEqual(urls, ['http://127.0.0.1:51134/?token=fixture-secret&view=web'])
    assert.deepEqual(logs, [
      '[stdout] dsh web: http://127.0.0.1:51134/?token=[REDACTED]&view=web\n',
      '[stderr] failure at http://127.0.0.1:51134/?token=[REDACTED]\n',
    ])
  })
})

describe('desktop window navigation', () => {
  const origin = 'http://127.0.0.1:47821'

  it('allows only the exact backend origin inside the application window', () => {
    assert.equal(classifyNavigation(`${origin}/sessions/one`, origin), 'internal')
    assert.equal(classifyNavigation('http://127.0.0.1:3080/', origin), 'blocked')
    assert.equal(classifyNavigation('http://localhost:47821/', origin), 'blocked')
  })

  it('sends ordinary web links outside and blocks privileged protocols', () => {
    assert.equal(classifyNavigation('https://deepseek.com/', origin), 'external')
    assert.equal(classifyNavigation('http://example.com/', origin), 'external')
    assert.equal(classifyNavigation('file:///C:/Windows/System32/', origin), 'blocked')
    assert.equal(classifyNavigation('javascript:alert(1)', origin), 'blocked')
    assert.equal(classifyNavigation('not a URL', origin), 'blocked')
  })
})

describe('desktop backend termination', () => {
  it('starts whole-tree termination before the CLI self-exit deadline', () => {
    assert.ok(BACKEND_TREE_KILL_DELAY_MS < 5_000)
  })

  it('resolves taskkill from an absolute Windows system directory', () => {
    assert.equal(
      resolveWindowsTaskkillPath({ SystemRoot: 'D:\\Windows' }),
      'D:\\Windows\\System32\\taskkill.exe',
    )
    assert.equal(
      resolveWindowsTaskkillPath({ windir: 'C:\\Windows\\' }),
      'C:\\Windows\\System32\\taskkill.exe',
    )
  })

  it('refuses missing, relative, and UNC Windows directories', () => {
    assert.throws(() => { resolveWindowsTaskkillPath({}) }, /Windows directory is unavailable/u)
    assert.throws(
      () => { resolveWindowsTaskkillPath({ SystemRoot: 'Windows' }) },
      /not an absolute drive path/u,
    )
    assert.throws(
      () => { resolveWindowsTaskkillPath({ SystemRoot: '\\\\server\\Windows' }) },
      /not an absolute drive path/u,
    )
  })
})

describe('desktop standalone Node runtime', () => {
  it('resolves the packaged and development executables from fixed roots', () => {
    assert.equal(
      resolveBundledNodePath({
        isPackaged: true,
        resourcesPath: join('C:', 'installed', 'resources'),
        applicationRoot: join('C:', 'source', 'apps', 'desktop'),
      }),
      join('C:', 'installed', 'resources', 'runtime', 'node-runtime', 'node.exe'),
    )
    assert.equal(
      resolveBundledNodePath({
        isPackaged: false,
        resourcesPath: join('C:', 'installed', 'resources'),
        applicationRoot: join('C:', 'source', 'apps', 'desktop'),
      }),
      join('C:', 'source', 'apps', 'desktop', 'build', 'runtime', 'node-runtime', 'node.exe'),
    )
    assert.equal(
      resolveBundledNpmCliPath({
        isPackaged: true,
        resourcesPath: join('C:', 'installed', 'resources'),
        applicationRoot: join('C:', 'source', 'apps', 'desktop'),
      }),
      join('C:', 'installed', 'resources', 'updater', 'npm', 'bin', 'npm-cli.js'),
    )
    assert.equal(
      resolveBundledNpmCliPath({
        isPackaged: false,
        resourcesPath: join('C:', 'installed', 'resources'),
        applicationRoot: join('C:', 'source', 'apps', 'desktop'),
      }),
      join('C:', 'source', 'apps', 'desktop', 'build', 'updater', 'npm', 'bin', 'npm-cli.js'),
    )
  })

  it('keeps standalone-Node scripts outside app.asar in packaged builds', () => {
    const packaged = {
      isPackaged: true,
      resourcesPath: join('installed', 'resources'),
      applicationRoot: join('source', 'apps', 'desktop'),
    }
    const development = { ...packaged, isPackaged: false }

    assert.equal(
      resolveNodeChildScriptPath(packaged, 'backend-runner.mjs'),
      join('installed', 'resources', 'app.asar.unpacked', 'src', 'backend-runner.mjs'),
    )
    assert.equal(
      resolveNodeChildScriptPath(packaged, 'update-worker.mjs'),
      join('installed', 'resources', 'app.asar.unpacked', 'src', 'update-worker.mjs'),
    )
    assert.equal(
      resolveNodeChildScriptPath(development, 'backend-runner.mjs'),
      join('source', 'apps', 'desktop', 'src', 'backend-runner.mjs'),
    )
    assert.throws(
      () => resolveNodeChildScriptPath(packaged, '..\\main.mjs'),
      /invalid desktop Node child script name/u,
    )
  })

  it('removes Electron mode and color overrides without mutating the parent', () => {
    const parent = {
      Path: 'C:\\Windows',
      Electron_Run_As_Node: '1',
      FORCE_COLOR: '3',
      no_color: '0',
      DSH_HOME: 'C:\\Harness',
    }
    const environment = createBackendEnvironment(parent)

    assert.deepEqual(environment, {
      Path: 'C:\\Windows',
      DSH_HOME: 'C:\\Harness',
      NO_COLOR: '1',
    })
    assert.equal(parent.Electron_Run_As_Node, '1')
    assert.equal(parent.FORCE_COLOR, '3')
    assert.equal(parent.no_color, '0')
  })
})
