import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { assertOfficialHarnessResponse, fetchOfficialHarnessPage, probeKoffiRuntime, removeSmokeDirectory } from '../src/runtime-smoke.mjs'

describe('official runtime smoke policy', () => {
  it('exchanges the launch token for cookies before fetching the official page', async t => {
    const requests = []
    const server = createServer((request, response) => {
      requests.push({ path: request.url, cookie: request.headers.cookie })
      if (request.url === '/?token=fixture-token') {
        response.writeHead(303, {
          location: '/',
          'set-cookie': [
            'fixture_session=issued; Max-Age=3600; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict',
            'fixture_extra=second; Path=/; HttpOnly',
          ],
        })
        response.end()
        return
      }
      const authorized = request.headers.cookie === 'fixture_session=issued; fixture_extra=second'
      response.writeHead(authorized ? 200 : 401)
      response.end(authorized ? '<title>DeepSeek Harness</title>' : 'Unauthorized')
    })
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => { server.close(resolve) }) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const response = await fetchOfficialHarnessPage(`${origin}/?token=fixture-token`)
    assertOfficialHarnessResponse(response.status, await response.text())
    assert.deepEqual(requests, [
      { path: '/?token=fixture-token', cookie: undefined },
      { path: '/', cookie: 'fixture_session=issued; fixture_extra=second' },
    ])
    const unauthenticated = await fetchOfficialHarnessPage(`${origin}/`)
    assert.equal(unauthenticated.status, 401)
    await unauthenticated.body.cancel()
  })

  it('refuses cross-origin redirects and bounds login loops', async t => {
    let requests = 0
    const server = createServer((request, response) => {
      requests += 1
      response.writeHead(303, {
        location: request.url === '/outside' ? 'http://127.0.0.1:1/' : '/loop',
        'set-cookie': 'fixture_session=private; Path=/',
      })
      response.end()
    })
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => { server.close(resolve) }) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(fetchOfficialHarnessPage(`${origin}/outside`), /different origin/u)
    assert.equal(requests, 1)
    await assert.rejects(fetchOfficialHarnessPage(`${origin}/loop`), /redirect limit/u)
    assert.equal(requests, 7)
  })

  it('accepts only the official Harness document title on HTTP 200', () => {
    assert.doesNotThrow(() => { assertOfficialHarnessResponse(200, '<title>DeepSeek Harness</title>') })
    assert.throws(() => { assertOfficialHarnessResponse(500, '<title>DeepSeek Harness</title>') }, /HTTP 500/u)
    assert.throws(() => { assertOfficialHarnessResponse(200, '<title>MengLuo AI</title>') }, /official DeepSeek Harness/u)
  })

  it('runs a bounded alloc/view Koffi probe under the candidate Node and root', () => {
    let invocation
    probeKoffiRuntime({
      executable: 'C:\\runtime\\node.exe',
      root: 'C:\\runtime',
      environment: { NO_COLOR: '1' },
      spawnSync: (command, args, options) => {
        invocation = { command, args, options }
        return { status: 0, signal: null, stdout: 'koffi-ok:8' }
      },
    })
    assert.equal(invocation.command, 'C:\\runtime\\node.exe')
    assert.deepEqual(invocation.args.slice(0, 2), ['--input-type=module', '--eval'])
    assert.match(invocation.args[2], /koffi\.alloc\('uint8', 8\)/u)
    assert.match(invocation.args[2], /koffi\.view\(allocation, 8\)/u)
    assert.equal(invocation.options.cwd, 'C:\\runtime')
    assert.equal(invocation.options.timeout, 20_000)
    assert.throws(() => {
      probeKoffiRuntime({
        executable: 'C:\\runtime\\node.exe',
        root: 'C:\\runtime',
        spawnSync: () => ({ status: 134, signal: null, stdout: '' }),
      })
    }, /Koffi compatibility probe failed/u)
  })

  it('unlinks profile junctions without deleting the candidate runtime', { skip: process.platform !== 'win32' }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-harness-update-smoke-'))
    const candidate = mkdtempSync(join(tmpdir(), 'mengluo-smoke-candidate-'))
    const profileModules = join(temporary, 'home', 'profiles', 'node_modules')
    const sentinel = join(candidate, 'package.json')
    mkdirSync(profileModules, { recursive: true })
    writeFileSync(sentinel, '{"name":"candidate"}')
    symlinkSync(candidate, join(profileModules, 'candidate'), 'junction')

    try {
      removeSmokeDirectory(temporary)
      assert.equal(existsSync(temporary), false)
      assert.equal(existsSync(sentinel), true)
    } finally {
      rmSync(candidate, { recursive: true, force: true })
    }
  })
})
