import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { NsisUpdater } from 'electron-updater'
import { HttpExecutor, configureRequestOptionsFromUrl } from 'builder-util-runtime'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'

// Exercise the production NSIS downloader against synthetic, non-executable data.
// The transport is restricted to loopback and retains the library's hash checking.
class LoopbackExecutor extends HttpExecutor {
  createRequest(options, callback) {
    assert.equal(options.hostname, '127.0.0.1')
    assert.equal(options.protocol, 'http:')
    return request(options, callback)
  }
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      this.doDownload(configureRequestOptionsFromUrl(url.toString(), { headers: options.headers }), {
        destination, options, onCancel, responseHandler: null,
        callback: error => { if (error) reject(error); else resolve(destination) },
      }, 0)
    })
  }
}

const digest = bytes => createHash('sha512').update(bytes).digest('base64')
const blockSize = 64 * 1024
const oldBlocks = [1, 2, 3, 4].map(value => Buffer.alloc(blockSize, value))
const newBlocks = [oldBlocks[0], oldBlocks[1], Buffer.alloc(blockSize, 5), oldBlocks[3]]
const windowsOnly = { skip: process.platform !== 'win32' && 'NSIS uses the Windows installer and latest.yml update channel' }
const map = blocks => ({ version: '2', files: [{ name: 'file', offset: 0,
  checksums: blocks.map(digest), sizes: blocks.map(block => block.length) }] })

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mengluo-differential-'))
  const payload = Buffer.concat(newBlocks)
  const served = options.corrupt ? Buffer.alloc(payload.length, 9) : payload
  const name = 'MengLuo-DSH-Desktop-0.5.1-setup.exe'
  const stats = { bytes: 0, rangeRequests: 0, fullRequests: 0, downloaded: 0 }
  const info = { version: '0.5.1', files: [{ url: name, size: payload.length, sha512: digest(payload) }] }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/latest.yml') { res.end(JSON.stringify(info)); return }
    if (path.endsWith('.blockmap')) {
      res.end(gzipSync(JSON.stringify(map(path.includes('0.5.1') ? newBlocks : oldBlocks))))
      return
    }
    if (path === `/${name}`) {
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/u)
      if (range && !options.ignoreRanges) {
        const start = Number(range[1]), end = Number(range[2])
        const bytes = served.subarray(start, end + 1)
        stats.rangeRequests += 1; stats.bytes += bytes.length
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${served.length}`, 'content-length': bytes.length })
        res.end(bytes)
      } else {
        stats.fullRequests += 1; stats.bytes += served.length
        res.writeHead(200, { 'content-length': served.length }); res.end(served)
      }
      return
    }
    res.writeHead(404); res.end()
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    removeTreeWithoutFollowingLinks(root)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const configPath = join(root, 'app-update.yml')
  writeFileSync(configPath, JSON.stringify({ updaterCacheDirName: 'fixture-cache' }))
  const cache = join(root, 'fixture-cache')
  mkdirSync(cache)
  if (!options.noCache) writeFileSync(join(cache, 'installer.exe'), Buffer.concat(oldBlocks))
  const updater = new NsisUpdater(undefined, {
    version: '0.5.0', name: 'fixture', isPackaged: true, userDataPath: root, baseCachePath: root,
    appUpdateConfigPath: configPath, whenReady: async () => {},
    quit: () => { throw new Error('This fixture must never quit/install') },
    onQuit: () => { throw new Error('Automatic installation must remain disabled') },
  })
  updater.httpExecutor = new LoopbackExecutor()
  updater.logger = { info() {}, warn() {}, error() {} }
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.disableWebInstaller = true
  updater.disableDifferentialDownload = false
  updater.doInstall = () => { throw new Error('Synthetic update files must never execute') }
  updater.on('update-downloaded', () => { stats.downloaded += 1 })
  updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}`, useMultipleRangeRequest: false })
  assert.equal((await updater.checkForUpdates()).isUpdateAvailable, true)
  return { updater, stats, payload }
}

test('real NSIS differential download transfers only changed blocks and verifies the complete result', windowsOnly, async t => {
  const f = await fixture(t)
  const [path] = await f.updater.downloadUpdate()
  assert.deepEqual(readFileSync(path), f.payload)
  assert.equal(f.stats.bytes, blockSize)
  assert.equal(f.stats.rangeRequests, 1)
  assert.equal(f.stats.fullRequests, 0)
  assert.equal(f.stats.downloaded, 1)
})

test('real NSIS downloader falls back to full download when the old installer is absent', windowsOnly, async t => {
  const f = await fixture(t, { noCache: true })
  const [path] = await f.updater.downloadUpdate()
  assert.deepEqual(readFileSync(path), f.payload)
  assert.equal(f.stats.fullRequests, 1)
  assert.equal(f.stats.downloaded, 1)
})

test('a server that ignores byte ranges falls back to a verified complete installer', windowsOnly, async t => {
  const f = await fixture(t, { ignoreRanges: true })
  const [path] = await f.updater.downloadUpdate()
  assert.deepEqual(readFileSync(path), f.payload)
  assert.equal(f.stats.fullRequests, 2)
  assert.equal(f.stats.downloaded, 1)
})

test('corrupt differential and full downloads both fail the real SHA-512 gate', windowsOnly, async t => {
  const f = await fixture(t, { corrupt: true })
  await assert.rejects(f.updater.downloadUpdate(), /sha512 checksum mismatch/iu)
  assert.equal(f.stats.downloaded, 0)
  assert.equal(f.updater.installerPath, null)
})
