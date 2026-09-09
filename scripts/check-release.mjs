import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listSourceFiles } from './source-files.mjs'
import { SHELL_RELEASE_SOURCE } from '../src/release-config.mjs'
import { ICON_SOURCE, verifyIconSource } from './icon-source.mjs'

const root = resolve(import.meta.dirname, '..')
const files = listSourceFiles(root)
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['API credential', /\bsk-[A-Za-z0-9_-]{24,}\b/u],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ['personal Windows path', /[A-Za-z]:[\\/]+Users[\\/]+(?!tester\b|test\b|Public\b|example\b|user\b)[\w.-]+[\\/]/iu],
  ['private proxy default', /127\.0\.0\.1:7897/u],
]
const violations = []
for (const file of files) {
  const bytes = readFileSync(join(root, file))
  if (file === ICON_SOURCE) { verifyIconSource(bytes); continue }
  if (bytes.includes(0)) { violations.push(`${file}: binary data is not an approved source asset`); continue }
  const lines = bytes.toString('utf8').split(/\r?\n/u)
  lines.forEach((line, index) => {
    for (const [rule, pattern] of rules) if (pattern.test(line)) violations.push(`${file}:${index + 1}: ${rule}`)
  })
}
assert.deepEqual(violations, [], 'Source preflight found possible private data; values are intentionally not printed.')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
assert.equal(manifest.license, 'MIT')
assert.equal(lock.packages[''].version, manifest.version)
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies)
assert.equal(manifest.repository.url, `https://github.com/${SHELL_RELEASE_SOURCE.owner}/${SHELL_RELEASE_SOURCE.repo}.git`)
assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false)
assert.equal(manifest.build.nsis.differentialPackage, true)
for (const required of ['LICENSE', 'licenses/DeepSeek-Harness.LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', ICON_SOURCE, 'assets/ARTWORK.md']) assert.ok(files.includes(required))
for (const file of files.filter(name => name.endsWith('.md'))) {
  const markdown = readFileSync(join(root, file), 'utf8')
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0]
    if (!target || /^(?:https?:|mailto:)/u.test(target)) continue
    const relative = resolve(root, file, '..', target).slice(root.length + 1).replaceAll('\\', '/')
    assert.ok(files.includes(relative), `Broken source link in ${file}: ${target}`)
  }
}
process.stdout.write(`Source preflight passed: ${files.length} allowlisted files; no matched secret/private-path patterns. This is not a complete security audit.\n`)
