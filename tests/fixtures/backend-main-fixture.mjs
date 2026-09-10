let calls = 0
export async function runCli() {
  if (++calls !== 1) throw new Error('CLI dispatched twice')
  process.on('SIGTERM', () => { process.exit(0) })
  process.send?.({ type: 'fixture:ready', main: import.meta.main, calls, argv: process.argv.slice(1) })
  setInterval(() => {}, 1_000)
}
// Match the newer official command entry instead of simulating unconditional import execution.
if (import.meta.main) await runCli()
