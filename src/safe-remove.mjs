import { chmodSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Remove a tree without ever traversing a symlink or Windows junction. */
export function removeTreeWithoutFollowingLinks(target) {
  let stats
  try {
    stats = lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  if (stats.isSymbolicLink()) {
    unlinkSync(target)
    return
  }
  if (!stats.isDirectory()) {
    chmodSync(target, 0o666)
    unlinkSync(target)
    return
  }
  for (const entry of readdirSync(target)) removeTreeWithoutFollowingLinks(join(target, entry))
  chmodSync(target, 0o777)
  rmdirSync(target)
}
