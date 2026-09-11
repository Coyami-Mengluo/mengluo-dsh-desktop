import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Exact maintainer-supplied captures reviewed for visible content and PNG metadata.
// These digests record that review; they are not signatures or a privacy scan.
// Replacing a screenshot requires a new visual/metadata review and digest.
export const DOCUMENTATION_ASSETS = Object.freeze({
  'docs/screenshots/desktop.png': Object.freeze({
    sha256: '71f179dd02a95e1119a5692b7f00241d934b5c1ad89492db3d2aa97f5765f22d', width: 1653, height: 1078,
  }),
  'docs/screenshots/harness.png': Object.freeze({
    sha256: '1add2510ab7396f8bdd34fc7ed97eaa41fe3a897e5b0daae150ac4ba59653861', width: 1653, height: 1078,
  }),
  'docs/screenshots/plugins.png': Object.freeze({
    sha256: '6d66514850cadae1d4f811c258b80c936abf04919c84565807ecbd3a4e0928ba', width: 1653, height: 1078,
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
