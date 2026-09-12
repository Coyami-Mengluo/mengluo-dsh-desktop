import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { classifyPluginSpec, createPluginCommand, isPluginPackageName, readInstalledPlugins, resolvePluginHome, runPluginOperation, sanitizePluginOutput } from '../src/plugin-runtime.mjs'

function fixture() {
  // Inventory containment is intentional; resolve macOS's system TEMP alias in the fixture.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-plugin-runtime-')))
  const runtimeRoot = join(root, 'runtime slot')
  const dshHome = join(root, 'isolated-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const cliPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const terminalBinPath = join(root, 'terminal tools')
  const npmCliPath = join(root, 'updater', 'npm', 'bin', 'npm-cli.js')
  const workspacePath = join(root, 'workspace')
  for (const directory of [dirname(cliPath), terminalBinPath, dirname(npmCliPath), workspacePath]) mkdirSync(directory, { recursive: true })
  for (const filename of [cliPath, npmCliPath, join(dirname(npmCliPath), 'npx-cli.js'), join(terminalBinPath, 'pnpm.cmd')]) writeFileSync(filename, '// fixture\n')
  writeFileSync(join(dirname(dirname(cliPath)), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', type: 'module' }))
  const options = {
    runtime: { root: runtimeRoot, version: '0.1.5-rc.2', nodePath: process.execPath, cliPath },
    dshHome, npmCliPath, terminalBinPath, workspacePath,
    environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? process.env.Path ?? '', DEEPSEEK_API_KEY: 'test-secret-must-not-leak' },
    operation: { action: 'install', name: 'example-plugin', spec: 'example-plugin@1.0.0' },
  }
  const writeProfile = dependencies => {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(dependencies)] } },
      unrelatedSecret: 'not-for-renderer',
    }))
  }
  const writePlugin = (name, version) => {
    const file = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ name, version, secret: 'not-for-renderer' }))
  }
  return { root, options, profileDir, writeProfile, writePlugin, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function fakeSpawn(onSpawn) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 123456789
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true }
    queueMicrotask(() => onSpawn(child, { command, args, options }))
    return child
  }
}

describe('read-only web plugin inventory', () => {
  it('uses explicit home, DSH_HOME, or the official default without loading user settings', () => {
    const base = resolve(tmpdir(), 'user-home')
    assert.equal(resolvePluginHome({ environment: {}, homeDirectory: base }), join(base, '.dsh'))
    assert.equal(resolvePluginHome({ environment: { DSH_HOME: ' ' }, homeDirectory: base }), join(base, '.dsh'))
    assert.equal(resolvePluginHome({ environment: { DSH_HOME: '~/custom' }, homeDirectory: base }), join(base, 'custom'))
    assert.equal(resolvePluginHome({ dshHome: join(base, 'override'), environment: { DSH_HOME: 'elsewhere' } }), join(base, 'override'))
    assert.equal(resolvePluginHome({ environment: { DSH_HOME: '../custom-home' }, workspacePath: join(base, 'workspace') }), join(base, 'custom-home'))
  })

  it('does not initialize absent profiles or list official default bundles', () => {
    const f = fixture()
    try {
      assert.deepEqual(readInstalledPlugins(f.options), { profile: 'web', exists: false, plugins: [] })
      assert.equal(existsSync(f.profileDir), false)
      f.writeProfile({})
      assert.deepEqual(readInstalledPlugins(f.options).plugins, [])
    } finally { f.cleanup() }
  })

  it('reads only direct user dependencies and bounded installed identity', () => {
    const f = fixture()
    try {
      f.writeProfile({ 'example-plugin': '^1.0.0', '@sample/theme': 'github:sample/theme#main' })
      f.writePlugin('example-plugin', '1.0.3')
      f.writePlugin('@sample/theme', '0.2.0')
      const inventory = readInstalledPlugins(f.options)
      assert.equal(inventory.plugins.length, 2)
      assert.deepEqual(inventory.plugins[0], { id: 'example-plugin', name: 'example-plugin', spec: '^1.0.0', source: 'npm', bundle: true, managed: true, version: '1.0.3' })
      assert.deepEqual(inventory.plugins[1].github, { owner: 'sample', repo: 'theme', ref: 'main' })
      assert.doesNotMatch(JSON.stringify(inventory), /not-for-renderer/u)
    } finally { f.cleanup() }
  })

  it('refuses mutation of bundled, runtime-owned, unsafe, and unsupported dependencies', () => {
    const f = fixture()
    try {
      f.writeProfile({ '@deepseek-ai/dsh-web-app': '0.1.5-rc.2', 'local-plugin': 'file:../plugin', '../escape': '1.0.0', 'runtime-library': '1.0.0' })
      const runtimeLibrary = join(f.options.runtime.root, 'node_modules', 'runtime-library', 'package.json')
      mkdirSync(dirname(runtimeLibrary), { recursive: true })
      writeFileSync(runtimeLibrary, '{}')
      const inventory = readInstalledPlugins(f.options)
      assert.ok(inventory.plugins.every(plugin => plugin.managed === false))
      assert.throws(() => createPluginCommand({ ...f.options, operation: { action: 'update', name: 'runtime-library', spec: 'runtime-library@2.0.0' } }), /官方自带组件/u)
    } finally { f.cleanup() }
  })

  it('rejects oversized, malformed, and redirected profile manifests', () => {
    const f = fixture()
    try {
      f.writeProfile({})
      writeFileSync(join(f.profileDir, 'package.json'), 'x'.repeat(1024 * 1024 + 1))
      assert.throws(() => readInstalledPlugins(f.options), /过大/u)
      writeFileSync(join(f.profileDir, 'package.json'), '[]')
      assert.throws(() => readInstalledPlugins(f.options), /格式无效/u)
      rmSync(f.profileDir, { recursive: true })
      const outside = join(f.root, 'outside-profile')
      mkdirSync(outside)
      symlinkSync(outside, f.profileDir, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => readInstalledPlugins(f.options), /普通目录/u)
    } finally { f.cleanup() }
  })

  it('does not follow a plugin link outside its profile node_modules', () => {
    const f = fixture()
    try {
      f.writeProfile({ 'example-plugin': '1.0.0' })
      const outside = join(f.root, 'outside-plugin')
      mkdirSync(outside)
      writeFileSync(join(outside, 'package.json'), '{"version":"1.0.0"}')
      mkdirSync(join(f.profileDir, 'node_modules'))
      symlinkSync(outside, join(f.profileDir, 'node_modules', 'example-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(readInstalledPlugins(f.options).plugins[0].managed, false)
    } finally { f.cleanup() }
  })
})

describe('vetted official plugin commands', () => {
  it('accepts conservative source formats and rejects shell-control package names', () => {
    assert.equal(isPluginPackageName('@sample/safe-name'), true)
    for (const name of ['--global', '../escape', 'a&calc', 'a|b', 'a b', 'a%PATH%', 'a^b', 'a!x!', 'a"b', '__proto__', 'constructor']) assert.equal(isPluginPackageName(name), false, name)
    const commit = 'a'.repeat(40)
    assert.deepEqual(classifyPluginSpec(`git+https://github.com/sample/theme.git#${commit}`).github, { owner: 'sample', repo: 'theme', ref: commit, commit })
    for (const spec of ['github:sample/theme#../main', 'file:../theme', 'npm:other@1.0.0', 'https://example.com/plugin.tgz', 'github:sample/theme#main&calc']) assert.equal(classifyPluginSpec(spec).source, 'unsupported', spec)
  })

  it('binds exact runtime Node and CLI with profile-web argv, pinned tooling and explicit proxy', () => {
    const f = fixture()
    try {
      const launch = createPluginCommand({ ...f.options, proxy: 'http://127.0.0.1:18080', environment: { ...f.options.environment, NODE_OPTIONS: '--require unwanted', http_proxy: 'http://obsolete', NO_PROXY: '*', ELECTRON_RUN_AS_NODE: '1' } })
      assert.equal(launch.command, f.options.runtime.nodePath)
      assert.deepEqual(launch.args, [f.options.runtime.cliPath, 'plugin', '--profile', 'web', 'add', 'example-plugin@1.0.0', '--save-exact', '--reporter=append-only'])
      assert.equal(launch.spawnOptions.shell, false)
      assert.equal(launch.env.DSH_HOME, f.options.dshHome)
      assert.equal(launch.env.DSH_DESKTOP_NODE, f.options.runtime.nodePath)
      assert.equal(launch.env.DSH_DESKTOP_NPX_CLI, join(dirname(f.options.npmCliPath), 'npx-cli.js'))
      assert.equal(launch.env.HTTPS_PROXY, 'http://127.0.0.1:18080')
      for (const key of ['http_proxy', 'NO_PROXY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DEEPSEEK_API_KEY']) assert.equal(launch.env[key], undefined, key)
      assert.ok(launch.env.PATH.startsWith(f.options.terminalBinPath))
      assert.equal(launch.env.NoDefaultCurrentDirectoryInExePath, '1')
    } finally { f.cleanup() }
  })

  it('preserves explicit DIRECT and rejects authenticated or path-bearing proxies', () => {
    const f = fixture()
    try {
      const launch = createPluginCommand({ ...f.options, proxy: null, environment: { ...f.options.environment, HTTPS_PROXY: 'http://old', all_proxy: 'http://old', npm_config_proxy: 'http://old' } })
      assert.equal(launch.env.HTTPS_PROXY, undefined)
      assert.equal(launch.env.all_proxy, undefined)
      assert.equal(launch.env.npm_config_proxy, undefined)
      for (const proxy of ['http://user:pass@host', 'http://host/path', 'http://host?secret=yes', 'file:///proxy']) assert.throws(() => createPluginCommand({ ...f.options, proxy }), /代理地址/u)
    } finally { f.cleanup() }
  })

  it('requires reviewed exact npm versions or full GitHub commits and cannot change another profile', () => {
    const f = fixture()
    try {
      const commit = 'b'.repeat(40)
      const github = createPluginCommand({ ...f.options, operation: { action: 'install', name: 'example-plugin', spec: `github:sample/theme#${commit}` } })
      assert.ok(github.args.includes(`example-plugin@github:sample/theme#${commit}`))
      for (const spec of ['example-plugin@latest', 'example-plugin@^1.0.0', 'different@1.0.0', 'github:sample/theme#main', 'example-plugin@1.0.0&calc']) assert.throws(() => createPluginCommand({ ...f.options, operation: { action: 'install', name: 'example-plugin', spec } }))
      assert.throws(() => createPluginCommand({ ...f.options, operation: { ...f.options.operation, profile: 'desktop' } }), /参数无效/u)
      assert.throws(() => createPluginCommand({ ...f.options, runtime: { ...f.options.runtime, cliPath: join(f.root, 'other.js') } }), /当前运行环境/u)
    } finally { f.cleanup() }
  })

  it('rechecks inventory before updating/removing and uses add-exact for updates', () => {
    const f = fixture()
    try {
      assert.throws(() => createPluginCommand({ ...f.options, operation: { action: 'remove', name: 'example-plugin' } }), /不在用户插件清单/u)
      f.writeProfile({ 'example-plugin': '^1.0.0' })
      assert.throws(() => createPluginCommand(f.options), /已安装/u)
      const update = createPluginCommand({ ...f.options, operation: { action: 'update', name: 'example-plugin', spec: 'example-plugin@2.0.0' } })
      assert.deepEqual(update.args.slice(4), ['add', 'example-plugin@2.0.0', '--save-exact', '--reporter=append-only'])
      const remove = createPluginCommand({ ...f.options, operation: { action: 'remove', name: 'example-plugin' } })
      assert.deepEqual(remove.args.slice(4), ['remove', 'example-plugin', '--reporter=append-only'])
      assert.throws(() => createPluginCommand({ ...f.options, operation: { action: 'remove', name: 'example-plugin', spec: '--global' } }), /额外安装参数/u)
    } finally { f.cleanup() }
  })
})

describe('plugin execution and output bounds', () => {
  it('runs a fake CLI in isolation and verifies add/update/remove outcomes', async () => {
    const f = fixture()
    try {
      writeFileSync(f.options.runtime.cliPath, `
        import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
        import {join,dirname} from 'node:path';
        if (process.env.DEEPSEEK_API_KEY) throw Error('secret leaked');
        const args=process.argv.slice(2);
        if (args[0]!=='plugin'||args[1]!=='--profile'||args[2]!=='web') throw Error('wrong profile');
        const file=join(process.env.DSH_HOME,'profiles','web','package.json');
        mkdirSync(dirname(file),{recursive:true});
        const value=existsSync(file)?JSON.parse(readFileSync(file)): {dependencies:{},dsh:{profile:{bundles:[]}}};
        const split=args[4].lastIndexOf('@');
        const name=args[3]==='remove'?args[4]:args[4].slice(0,split);
        if(args[3]==='remove') delete value.dependencies[name];
        else {value.dependencies[name]=args[4].slice(split+1); const pkg=join(dirname(file),'node_modules',name,'package.json');mkdirSync(dirname(pkg),{recursive:true});writeFileSync(pkg,JSON.stringify({name,version:value.dependencies[name]}));}
        writeFileSync(file,JSON.stringify(value));
        console.log('Done fixture command');
      `)
      const installed = await runPluginOperation(f.options)
      assert.equal(installed.changed, true)
      assert.equal(installed.requiresRestart, true)
      assert.equal(installed.plugins[0].version, '1.0.0')
      const updated = await runPluginOperation({ ...f.options, operation: { action: 'update', name: 'example-plugin', spec: 'example-plugin@2.0.0' } })
      assert.equal(updated.plugins[0].version, '2.0.0')
      const removed = await runPluginOperation({ ...f.options, operation: { action: 'remove', name: 'example-plugin' } })
      assert.deepEqual(removed.plugins, [])
      assert.equal(JSON.parse(readFileSync(join(f.options.runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))).version, '0.1.5-rc.2')
    } finally { f.cleanup() }
  })

  it('does not claim success when the official command did not change the profile', async () => {
    const f = fixture()
    try {
      await assert.rejects(runPluginOperation({ ...f.options, spawn: fakeSpawn(child => child.emit('close', 0)) }), /未出现预期变化/u)
    } finally { f.cleanup() }
  })

  it('does not report successful update merely because the old dependency still exists', async () => {
    const f = fixture()
    try {
      f.writeProfile({ 'example-plugin': '1.0.0' })
      f.writePlugin('example-plugin', '1.0.0')
      await assert.rejects(runPluginOperation({ ...f.options,
        operation: { action: 'update', name: 'example-plugin', spec: 'example-plugin@2.0.0' },
        spawn: fakeSpawn(child => child.emit('close', 0)),
      }), /未出现预期变化/u)
      await assert.rejects(runPluginOperation({ ...f.options,
        operation: { action: 'update', name: 'example-plugin', spec: 'example-plugin@2.0.0' },
        spawn: fakeSpawn(child => { f.writeProfile({ 'example-plugin': '2.0.0' }); child.emit('close', 0) }),
      }), /未出现预期变化/u)
    } finally { f.cleanup() }
  })

  it('limits noisy output, shortens failures, strips ANSI and redacts credential URLs', async () => {
    const f = fixture()
    const progress = []
    const logs = []
    try {
      await assert.rejects(runPluginOperation({ ...f.options,
        onProgress: item => progress.push(item), log: text => logs.push(text),
        spawn: fakeSpawn(child => {
          child.stdout.write('noise '.repeat(10000))
          child.stdout.write('\n')
          child.stderr.write('\u001b[31mERR_PNPM_FETCH\u001b[0m https://user:pass@registry.test/pkg?token=private\n')
          child.emit('close', 1)
        }),
      }), error => {
        assert.ok(error.message.length < 400)
        assert.ok(error.logTail.length <= 16 * 1024)
        assert.doesNotMatch(error.logTail, /user:pass|private|\u001b/u)
        return true
      })
      assert.ok(logs.join('').length <= 16 * 1024)
      assert.ok(progress.every(item => item.detail.length <= 512 && item.percent === undefined))
      assert.match(sanitizePluginOutput('authorization=secret-value'), /REDACTED/u)
    } finally { f.cleanup() }
  })

  it('serializes mutations per profile and cancels only its own spawned child', async () => {
    const f = fixture()
    const controller = new AbortController()
    let child
    let killArgs
    try {
      const first = runPluginOperation({ ...f.options, platform: 'win32', signal: controller.signal,
        spawn: fakeSpawn(created => { child = created }),
        killSpawn: (_command, args) => { killArgs = args; child.kill(); return new EventEmitter() },
      })
      await new Promise(resolvePromise => setImmediate(resolvePromise))
      await assert.rejects(runPluginOperation({ ...f.options, spawn: fakeSpawn(created => created.emit('close', 0)) }), /另一个插件操作/u)
      controller.abort()
      await assert.rejects(first, /已取消/u)
      assert.deepEqual(killArgs, ['/PID', '123456789', '/T', '/F'])
      await assert.rejects(runPluginOperation({ ...f.options, spawn: fakeSpawn(created => created.emit('close', 0)) }), /未出现预期变化/u)
    } finally { f.cleanup() }
  })

  it('reports spawn failures without leaking raw command paths or pretending success', async () => {
    const f = fixture()
    try {
      await assert.rejects(runPluginOperation({ ...f.options, spawn: fakeSpawn(child => child.emit('error', new Error('sensitive path detail'))) }), error => {
        assert.match(error.message, /无法启动/u)
        assert.doesNotMatch(error.message, /sensitive/u)
        return true
      })
    } finally { f.cleanup() }
  })
})
