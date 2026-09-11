import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { DOCUMENTATION_ASSETS, verifyDocumentationAsset } from '../scripts/documentation-assets.mjs'
import { listSourceFiles } from '../scripts/source-files.mjs'

const root = resolve(import.meta.dirname, '..')

describe('reviewed documentation source', () => {
  it('includes release history and all reviewed screenshots in source exports and both READMEs', () => {
    assert.equal(Object.keys(DOCUMENTATION_ASSETS).length, 3)
    const files = listSourceFiles(root)
    assert.ok(files.includes('CHANGELOG.md'))
    assert.ok(files.includes('docs/screenshots/README.md'))
    for (const readme of ['README.md', 'README.zh.md']) {
      const markdown = readFileSync(resolve(root, readme), 'utf8')
      assert.ok(markdown.includes('(CHANGELOG.md)'))
      const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map(match => match[1])
      assert.deepEqual(images, ['docs/screenshots/desktop.png', 'docs/screenshots/harness.png', 'docs/screenshots/plugins.png'])
      for (const file of Object.keys(DOCUMENTATION_ASSETS)) {
        assert.ok(files.includes(file))
        assert.ok(markdown.includes(`](${file})`), `${readme} must link the reviewed screenshot ${file}`)
      }
    }
    assert.ok(!files.some(file => /^(?:build|dist|node_modules)\//u.test(file)))
    assert.ok(!files.includes('docs/screenshots/snapshots.png'))
  })

  it('accepts the exact reviewed images and rejects changed images or unreviewed paths', () => {
    for (const file of Object.keys(DOCUMENTATION_ASSETS)) {
      const source = readFileSync(resolve(root, file))
      verifyDocumentationAsset(file, source)
      const changed = Buffer.from(source)
      changed[changed.length - 1] ^= 1
      assert.throws(() => verifyDocumentationAsset(file, changed), /differs from the reviewed screenshot/u)
      assert.throws(() => verifyDocumentationAsset(`build/${file}`, source), /Unreviewed documentation asset/u)
    }
  })
})
