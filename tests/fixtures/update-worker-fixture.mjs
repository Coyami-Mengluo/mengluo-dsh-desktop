process.on('message', message => {
  if (message?.type === 'install') {
    process.send?.({ type: 'log', text: 'fixture prepared\n' })
    process.send?.({ type: 'progress', stage: 'installing', files: { completedFiles: 12 } })
    const timer = setTimeout(() => {
      process.send?.({ type: 'complete' })
      process.disconnect?.()
    }, 40)
    timer.unref()
  }
  if (message?.type === 'cancel') {
    process.send?.({ type: 'failed', error: 'fixture cancelled' })
    process.exitCode = 2
    process.disconnect?.()
  }
})
