import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, Worker } from 'node:worker_threads'

const mode = !isMainThread ? 'worker' : process.argv[2] === 'fork' ? 'fork' : 'root'
const started = Date.now()
const initial = {
  mode,
  marker: process.env.MENG_LUO_HARNESS_PARENT_PID,
  messageListeners: process.listenerCount('message'),
  disconnectListeners: process.listenerCount('disconnect'),
  inheritedPreload: process.execArgv.includes('--import'),
}

if (mode !== 'root') {
  let signalCount = 0
  let privateMessages = 0
  process.on('SIGTERM', () => { signalCount += 1 })
  process.on('message', message => { if (message?.type === 'dsh:shutdown') privateMessages += 1 })
  setTimeout(() => {
    const result = { ...initial, elapsedMs: Date.now() - started, signalCount, privateMessages }
    if (mode === 'worker') parentPort.postMessage(result)
    else process.send(result, () => process.exit(0))
  }, 2_250)
} else {
  const worker = new Worker(new URL(import.meta.url))
  const child = fork(fileURLToPath(import.meta.url), ['fork'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
  const deadline = setTimeout(() => { void worker.terminate(); child.kill(); process.exit(71) }, 6_000)
  const workerResult = new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => { reject(new Error(`worker exited before its 2.2-second result: ${code}`)) })
  })
  const forkResult = new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('close', code => { reject(new Error(`fork exited before its 2.2-second result: ${code}`)) })
  })
  child.send({ type: 'dsh:shutdown' })
  try {
    const descendants = await Promise.all([workerResult, forkResult])
    clearTimeout(deadline)
    process.on('SIGTERM', () => { process.exit(0) })
    process.send({ type: 'fixture:descendants', root: initial, descendants })
  } catch (error) {
    clearTimeout(deadline)
    void worker.terminate()
    child.kill()
    process.stderr.write(`${String(error)}\n`)
    process.exit(72)
  }
}
