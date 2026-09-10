import { installOfficialRuntime } from './runtime-installer.mjs'
import { smokeOfficialRuntime } from './runtime-smoke.mjs'

const controller = new AbortController()
let started = false

process.once('disconnect', () => { controller.abort() })
process.on('message', message => {
  if (message !== null && typeof message === 'object' && message.type === 'cancel') {
    controller.abort()
    return
  }
  if (started || message === null || typeof message !== 'object' || message.type !== 'install') return
  started = true
  void install(message)
})

async function install(message) {
  try {
    await installOfficialRuntime({
      userData: message.userData,
      release: message.release,
      npm: message.npm,
      preferredNodeLicense: {
        nodeVersion: message.currentNodeVersion,
        nodeLicensePath: message.currentNodeLicensePath,
      },
      proxy: message.proxy,
      officialProxy: message.officialProxy,
      downloadSource: message.downloadSource,
      onDownloadStatus: status => { send({ type: 'download-source', status }) },
      fetch: (url, init) => fetch(url, init),
      signal: controller.signal,
      log: text => { send({ type: 'log', text }) },
      progress: (stage, files) => { send({ type: 'progress', stage, files }) },
      smoke: candidate => smokeOfficialRuntime({
        executable: candidate.nodePath,
        version: candidate.version,
        root: candidate.root,
        runnerPath: message.runnerPath,
        cliPath: candidate.cliPath,
        fetchPage: (url, init) => fetch(url, init),
        log: text => { send({ type: 'log', text }) },
        signal: controller.signal,
      }),
    })
    if (controller.signal.aborted) throw new Error('Harness update preparation was cancelled')
    send({ type: 'complete' })
    disconnectAndExit(0)
  } catch (error) {
    send({
      type: 'failed',
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
    disconnectAndExit(controller.signal.aborted ? 2 : 1)
  }
}

function send(message) {
  if (!process.connected) return
  try {
    process.send(message, () => {})
  } catch {
    // Parent loss is handled by the disconnect listener and process exit.
  }
}

function disconnectAndExit(code) {
  process.exitCode = code
  try {
    if (process.connected) process.disconnect()
  } catch {
    // No IPC handle remains to close.
  }
}
