import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Resolve packaged dependencies through app.asar, not the standalone-Node unpacked source directory. */
export function createNativeShellUpdater(applicationPath) {
  const require = createRequire(join(applicationPath, 'package.json'))
  const { NsisUpdater } = require('electron-updater')
  const { CancellationToken } = require('builder-util-runtime')
  return { updater: new NsisUpdater(), createCancellationToken: () => new CancellationToken() }
}
