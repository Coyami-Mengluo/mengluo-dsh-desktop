/** One supervised launch, settled only after the official renderer is ready. */
export function createBackendReadiness({ timeoutMs, onTimeout }) {
  const deferred = Promise.withResolvers()
  let settled = false
  const finish = (error) => {
    if (settled) return false
    settled = true
    clearTimeout(timer)
    if (error) deferred.reject(error)
    else deferred.resolve()
    return true
  }
  const timer = setTimeout(() => {
    if (finish(new Error('Harness renderer readiness timed out'))) onTimeout?.()
  }, timeoutMs)
  // Ordinary startup is event-driven; only an explicit restart awaits this promise.
  void deferred.promise.catch(() => {})
  return { promise: deferred.promise, ready: () => finish(),
    fail: (error = new Error('Harness launch interrupted')) => finish(error) }
}
