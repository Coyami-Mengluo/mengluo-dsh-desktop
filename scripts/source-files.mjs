import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_FILES = new Set(['.gitignore', '.gitattributes', 'LICENSE', 'package.json', 'package-lock.json', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md'])
const ROOT_DIRS = new Set(['src', 'assets', 'scripts', 'tests', 'licenses', 'docs', '.github'])
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'coverage', '.idea', '.vscode'])
const GENERATED = new Set(['assets/icon.png', 'assets/icon.ico'])

/** Enumerate only reviewed source roots and reject links, unknown roots and private file types. */
export function listSourceFiles(root) {
  const files = []
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name
      const path = join(directory, name)
      const stats = lstatSync(path)
      if (!prefix && IGNORED_DIRS.has(name)) continue
      if (GENERATED.has(relative)) continue
      if (stats.isSymbolicLink()) throw new Error(`Source contains a link: ${relative}`)
      if (!prefix && !(ROOT_FILES.has(name) || ROOT_DIRS.has(name))) throw new Error(`Unreviewed source root: ${relative}`)
      if (stats.isDirectory()) visit(path, relative)
      else if (stats.isFile()) {
        if (/(?:^|\/)\.env(?:\.|$)|\.(?:log|sqlite|db|pem|key|pfx|p12|exe|zip)$/iu.test(relative)) throw new Error(`Private or generated file in source: ${relative}`)
        files.push(relative)
      } else throw new Error(`Non-file entry in source: ${relative}`)
    }
  }
  visit(root)
  return files
}
