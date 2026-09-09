import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'

/**
 * Remove a known staging tree without following any nested junction or link.
 * @param {string} target exact file or directory to remove.
 */
export function removeStagingTree(target) {
  removeTreeWithoutFollowingLinks(target)
}

/**
 * Reject links in the packaged runtime so copying it cannot preserve an
 * absolute pnpm junction back into the source checkout.
 * @param {string} target file or directory to inspect.
 */
export function assertMaterializedTree(target) {
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) throw new Error(`desktop runtime contains a filesystem link: ${target}`)
  if (!stats.isDirectory()) return
  for (const entry of readdirSync(target)) assertMaterializedTree(join(target, entry))
}
