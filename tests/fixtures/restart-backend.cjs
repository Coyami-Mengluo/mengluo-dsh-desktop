// Synthetic loopback UI; never loads Harness, a plugin, or user data.
const { createServer } = require('node:http')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const record = type => appendFileSync(join(process.env.DSH_HOME, 'restart-events.jsonl'), JSON.stringify({ type, pid: process.pid }) + '\n')
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><title>DeepSeek Harness fixture</title><body>Isolated restart fixture</body>')
})
process.once('SIGTERM', () => { record('stop'); server.close(() => process.exit(0)) })
server.listen(0, '127.0.0.1', () => {
  record('start')
  process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\n`)
})
