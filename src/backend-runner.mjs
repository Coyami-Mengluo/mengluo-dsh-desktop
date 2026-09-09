import { pathToFileURL } from 'node:url'

if (process.versions.electron !== undefined) {
  throw new Error('desktop backend runner requires standalone Node; Electron is unsupported')
}

const SHUTDOWN_MESSAGE = 'dsh:shutdown'
const SHUTDOWN_SIGNAL_WAIT_MS = 1_000
const SHUTDOWN_SIGNAL_POLL_MS = 25

const [, , cliPath, ...cliArguments] = process.argv
if (cliPath === undefined || cliPath.length === 0) {
  process.stderr.write('desktop backend runner: missing Harness CLI path\n')
  process.exit(64)
}

let shutdownRequested = false
let shutdownDelivered = false
let shutdownDeadline = 0
let shutdownTimer
const parentWatch = setInterval(() => {
  if (!process.connected) requestShutdown()
}, SHUTDOWN_SIGNAL_POLL_MS)
parentWatch.unref()

/** Ask an unmodified official CLI to use its ordinary SIGTERM shutdown path. */
function requestShutdown() {
  if (shutdownRequested) return
  shutdownRequested = true
  shutdownDeadline = Date.now() + SHUTDOWN_SIGNAL_WAIT_MS
  deliverShutdownWhenReady()
}

/** Wait briefly for profile boot to register its SIGTERM handler. */
function deliverShutdownWhenReady() {
  if (shutdownDelivered) return
  if (process.listenerCount('SIGTERM') > 0) {
    shutdownDelivered = true
    clearInterval(parentWatch)
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
    process.emit('SIGTERM')
    return
  }
  if (Date.now() >= shutdownDeadline) {
    clearInterval(parentWatch)
    process.exit(0)
  }
  shutdownTimer = setTimeout(deliverShutdownWhenReady, SHUTDOWN_SIGNAL_POLL_MS)
  shutdownTimer.unref()
}

process.on('message', (message) => {
  if (message !== null && typeof message === 'object' && message.type === SHUTDOWN_MESSAGE) {
    requestShutdown()
  }
})
process.once('disconnect', requestShutdown)
if (!process.connected) requestShutdown()

// Commander must see the official CLI as argv[1], exactly as it would under npx.
process.argv = [process.execPath, cliPath, ...cliArguments]

try {
  await import(pathToFileURL(cliPath).href)
} catch (error) {
  clearInterval(parentWatch)
  if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
  try {
    if (process.connected) process.disconnect()
  } catch {
    // The process is exiting immediately below.
  }
  const detail = `desktop backend runner: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  process.stderr.write(detail, () => { process.exit(1) })
  const forcedExit = setTimeout(() => { process.exit(1) }, 250)
  forcedExit.unref()
}
