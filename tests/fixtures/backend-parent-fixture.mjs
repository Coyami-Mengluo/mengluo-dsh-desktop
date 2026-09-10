import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [, , runner, fixture] = process.argv
const backend = spawn(process.execPath, ['--import', pathToFileURL(runner).href, fixture, 'delayed'], {
  env: { ...process.env, MENG_LUO_HARNESS_PARENT_PID: String(process.pid) },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
})

backend.on('message', (message) => {
  if (message?.type !== 'fixture:ready') return
  if (typeof process.send === 'function') process.send({ type: 'backend:ready', pid: backend.pid })
  process.exit(0)
})
