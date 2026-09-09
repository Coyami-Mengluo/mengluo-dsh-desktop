import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const ICON_SOURCE = 'assets/icon-source.png'
// This allowlist records the reviewed artwork, not a digital signature. When
// replacing the source, review its pixels/metadata and update this digest too.
export const ICON_SOURCE_SHA256 = 'c9988334438e5d384b395a345e08b050ec3f1d807cb79432b57e9b072f4d1e27'

export function verifyIconSource(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ICON_SOURCE_SHA256, 'Icon source differs from the reviewed artwork')
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20), 'Icon must be square')
  assert.ok(bytes.readUInt32BE(16) >= 512, 'Icon must be high resolution')
  assert.equal(bytes[24], 8, 'Icon must use 8-bit channels')
  assert.equal(bytes[25], 6, 'Icon must have a real RGBA channel')
}
