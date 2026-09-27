// Windows can terminate the child before Electron receives session-end. Neither
// DBG_TERMINATE_PROCESS nor STATUS_CONTROL_C_EXIT proves that a runtime is bad.
const WINDOWS_INTERRUPTED = new Set([0x40010004, 0xc000013a])
const INTERRUPTED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])

/** Only a failed initial boot may quarantine a version; a stopped process may not. */
export function backendFailureAction({
  quitting = false, sessionEnding = false, paused = false, ready = false,
  platform = process.platform, code, signal, rendererReason,
} = {}) {
  if (quitting || sessionEnding || paused) return 'ignore'
  if (INTERRUPTED_SIGNALS.has(signal) || rendererReason === 'killed'
    || platform === 'win32' && Number.isInteger(code) && WINDOWS_INTERRUPTED.has(code >>> 0)) return 'interrupted'
  return ready ? 'stopped' : 'startup-failure'
}
