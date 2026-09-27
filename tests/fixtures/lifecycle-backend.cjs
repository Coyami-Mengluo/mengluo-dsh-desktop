// Synthetic backend only: never loads official Harness or user plugins.
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const http = require('node:http')
const home = process.env.DSH_HOME
const mode = readFileSync(join(home, 'lifecycle-mode.txt'), 'utf8')
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
const record = event => appendFileSync(join(home, 'lifecycle-events.jsonl'), `${JSON.stringify({ ...event, pid: process.pid, version })}\n`)
record({ type: 'start' })
if (version === '0.1.7-rc.2' && mode.startsWith('early-')) {
  setTimeout(() => process.exit(mode === 'early-crash' ? 1 : 1073807364), 40)
} else {
  const server = http.createServer((request, response) => {
    if (request.url === '/__fixture_stop' && request.method === 'POST') {
      response.end('stopping synthetic backend')
      setTimeout(() => process.exit(mode === 'ready-crash' ? 1 : 1073807364), 30)
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Lifecycle fixture</title><body style="background:#fff">Isolated backend</body>')
  })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`
    record({ type: 'listening', url })
    process.stdout.write(`dsh web: ${url}\n`)
  })
  process.once('SIGTERM', () => {
    record({ type: 'stop' })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 100).unref()
  })
}
