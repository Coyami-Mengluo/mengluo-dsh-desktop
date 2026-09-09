import { spawn } from 'node:child_process'

const [, , runner, fixture] = process.argv
const backend = spawn(process.execPath, [runner, fixture, 'delayed'], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
})

backend.on('message', (message) => {
  if (message?.type !== 'fixture:ready') return
  if (typeof process.send === 'function') process.send({ type: 'backend:ready', pid: backend.pid })
  process.exit(0)
})
