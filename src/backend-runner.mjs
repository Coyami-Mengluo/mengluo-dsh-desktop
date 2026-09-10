import { isMainThread } from 'node:worker_threads'

if (process.versions.electron !== undefined) {
  throw new Error('desktop backend runner requires standalone Node; Electron is unsupported')
}

const SHUTDOWN_MESSAGE = 'dsh:shutdown'
const SHUTDOWN_SIGNAL_WAIT_MS = 1_000
const SHUTDOWN_SIGNAL_POLL_MS = 25

// Node --import executes this lifecycle preload before the actual official CLI.
// Do not import the CLI here: doing so makes import.meta.main false in newer
// official releases and silently prevents their command dispatch from running.
if (import.meta.main) {
  process.stderr.write('desktop backend runner must be loaded using Node --import\n')
  process.exit(64)
}

// --import is inherited by default in plugin Worker/fork calls. Supervise only
// the exact standalone main process started by the shell, then consume its
// parent marker so descendants keep their own ordinary lifecycle and IPC.
if (isMainThread && process.env.MENG_LUO_HARNESS_PARENT_PID === String(process.ppid)) {
  delete process.env.MENG_LUO_HARNESS_PARENT_PID
  superviseBackend()
}

function superviseBackend() {
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
}

// Node now starts the official entry directly, with its original argv and
// import.meta.main semantics. Uncaught startup errors retain Node's normal exit.
