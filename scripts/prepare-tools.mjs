import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import { resolveTrustedNodeExecutable, verifyNodeExecutable, verifyNodeLicense } from './staging-node.mjs'
import { resolveTrustedNpmRoot, verifyNpmTree } from './staging-npm.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const ARCHIVE = 'node-v24.19.0-win-x64.zip'
const ARCHIVE_SHA256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
const ARCHIVE_URL = `https://nodejs.org/dist/v24.19.0/${ARCHIVE}`

function verifyTools(root) {
  const nodePath = resolveTrustedNodeExecutable(root)
  verifyNodeExecutable(nodePath)
  verifyNpmTree(resolveTrustedNpmRoot(root), { nodePath })
  // The official ZIP includes the redistributable license; an incomplete local
  // installation must not make a clean build depend on an unrelated GitHub fetch.
  verifyNodeLicense(join(root, 'nodejs', 'LICENSE'))
  return root
}

/** Obtain the pinned, signature-checked Windows toolchain without relying on the developer's PATH. */
export async function ensureBuildTools() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaging requires Windows x64.')
  const toolRoot = join(APP_ROOT, 'build', 'tools')
  for (const candidate of [toolRoot, process.env.ProgramFiles]) {
    if (!candidate || !existsSync(join(candidate, 'nodejs', 'node.exe'))) continue
    try { return verifyTools(candidate) } catch {
      // A different developer toolchain is not a build input; fetch the pinned distribution instead.
    }
  }
  mkdirSync(join(APP_ROOT, 'build'), { recursive: true })
  const temporary = mkdtempSync(join(APP_ROOT, 'build', 'tools-download-'))
  try {
    process.stdout.write(`Downloading the pinned build tools from ${ARCHIVE_URL}\n`)
    const response = await fetch(ARCHIVE_URL, { redirect: 'error', signal: AbortSignal.timeout(300_000) })
    if (!response.ok || !response.body) throw new Error(`Node download returned HTTP ${response.status}`)
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > 256 * 1024 * 1024) throw new Error('Node archive exceeded its size limit.')
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks)
    if (createHash('sha256').update(bytes).digest('hex') !== ARCHIVE_SHA256) throw new Error('Node archive checksum mismatch.')
    const archivePath = join(temporary, ARCHIVE)
    writeFileSync(archivePath, bytes)
    const extractionRoot = join(temporary, 'extracted')
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:DSH_BUILD_ARCHIVE -DestinationPath $env:DSH_BUILD_EXTRACT -ErrorAction Stop'], {
      env: { ...process.env, DSH_BUILD_ARCHIVE: archivePath, DSH_BUILD_EXTRACT: extractionRoot },
      windowsHide: true, encoding: 'utf8', timeout: 120_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Node extraction failed: ${result.stderr}`)
    const candidateRoot = join(temporary, 'candidate')
    mkdirSync(candidateRoot)
    cpSync(join(extractionRoot, 'node-v24.19.0-win-x64'), join(candidateRoot, 'nodejs'), { recursive: true })
    // The official Windows ZIP stores LICENSE as CRLF, while the pinned upstream
    // license fingerprint is LF. Canonicalize only the newly extracted build copy.
    const licensePath = join(candidateRoot, 'nodejs', 'LICENSE')
    writeFileSync(licensePath, readFileSync(licensePath, 'utf8').replaceAll('\r\n', '\n'))
    verifyTools(candidateRoot)
    if (toolRoot !== resolve(APP_ROOT, 'build', 'tools')) throw new Error('Invalid build tools destination.')
    removeTreeWithoutFollowingLinks(toolRoot)
    renameSync(candidateRoot, toolRoot)
    return verifyTools(toolRoot)
  } finally {
    removeTreeWithoutFollowingLinks(temporary)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureBuildTools()
  process.stdout.write('Pinned build tools verified.\n')
}
