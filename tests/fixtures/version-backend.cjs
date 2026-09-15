// Synthetic test runtime only: loopback server and isolated lifecycle records, no model/plugins.
const { createServer } = require('node:http')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { version } = require('../package.json')
const record = type => appendFileSync(join(process.env.DSH_HOME, 'version-events.jsonl'), JSON.stringify({ type, version, pid: process.pid }) + '\n')
if (version === '0.9.0') { record('failed'); process.exit(1) }
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><title>DeepSeek Harness</title><body>Isolated version fixture</body>')
})
process.once('SIGTERM', () => { record('stop'); server.close(() => process.exit(0)) })
server.listen(0, '127.0.0.1', () => {
  record('start')
  process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\n`)
})
