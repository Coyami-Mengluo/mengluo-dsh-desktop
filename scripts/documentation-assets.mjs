import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Exact fixture captures reviewed for visible content and PNG metadata.
// These digests record that review; they are not signatures or a privacy scan.
// Replacing a screenshot requires a new visual/metadata review and digest.
export const DOCUMENTATION_ASSETS = Object.freeze({
  'docs/screenshots/harness.png': Object.freeze({
    sha256: 'ad7a3d569dbb5601bdd71ae5c93f50c84457f0ddfb5d26743ee2857b841ace05', width: 1334, height: 1030,
  }),
  'docs/screenshots/plugins.png': Object.freeze({
    sha256: '047ba315033dc5890e9a2258241e00d86ac8b6d883d1cf6becb2fcd5c4d7813a', width: 1334, height: 1030,
  }),
  'docs/screenshots/snapshots.png': Object.freeze({
    sha256: '9c8a2bb97970a63ceef43b90f98c5901fcb9fb53510bb4bb31c949e3a0b3b0d0', width: 1334, height: 1030,
  }),
})

export function verifyDocumentationAsset(file, bytes) {
  assert.ok(Object.hasOwn(DOCUMENTATION_ASSETS, file), 'Unreviewed documentation asset')
  const reviewed = DOCUMENTATION_ASSETS[file]
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reviewed.sha256, `${file} differs from the reviewed screenshot`)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
  assert.equal(bytes.readUInt32BE(16), reviewed.width)
  assert.equal(bytes.readUInt32BE(20), reviewed.height)
  let offset = 8
  let ended = false
  let imageData = false
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Truncated documentation PNG')
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    assert.ok(['IHDR', 'IDAT', 'IEND'].includes(type), 'Documentation PNG must not contain metadata chunks')
    assert.ok(offset + length + 12 <= bytes.length, 'Truncated documentation PNG chunk')
    if (type === 'IDAT') imageData = true
    offset += length + 12
    if (type === 'IEND') {
      assert.equal(length, 0)
      assert.equal(offset, bytes.length, 'Documentation PNG must not contain trailing data')
      ended = true
    }
  }
  assert.ok(imageData && ended, 'Incomplete documentation PNG')
}
