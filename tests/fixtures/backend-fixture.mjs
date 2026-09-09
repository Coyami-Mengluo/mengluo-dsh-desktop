const mode = process.argv[2] ?? 'ready'

if (mode === 'ready') {
  process.on('SIGTERM', () => { process.exit(0) })
  if (typeof process.send === 'function') process.send({ type: 'fixture:ready', signalListeners: process.listenerCount('SIGTERM') })
} else if (mode === 'delayed') {
  if (typeof process.send === 'function') process.send({ type: 'fixture:ready', signalListeners: process.listenerCount('SIGTERM') })
  setTimeout(() => {
    process.on('SIGTERM', () => { process.exit(0) })
  }, 10_000)
} else if (mode === 'throw') {
  throw new Error('fixture top-level import failure')
}

setInterval(() => {}, 1_000)
