import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  EXPECTED_NODE_SHA256,
  EXPECTED_NODE_VERSION,
  resolveTrustedNodeExecutable,
  stageNodeRuntime,
  verifyNodeExecutable,
  verifyOfficialNodeSignature,
} from '../scripts/staging-node.mjs'

const VALID_SIGNATURE = Object.freeze({
  status: 'Valid',
  subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
  issuer: 'CN=Test CA',
  thumbprint: 'A'.repeat(40),
  companyName: 'Node.js',
  productName: 'Node.js',
  productVersion: '24.19.0',
  fileVersion: '24.19.0',
  originalFilename: 'node.exe',
})

describe('standalone Node staging', () => {
  it('pins the exact Node executable proven by the official npx run', () => {
    assert.equal(EXPECTED_NODE_VERSION, 'v24.19.0')
    assert.equal(EXPECTED_NODE_SHA256, '3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237')
  })

  it('rejects a different executable version even when its fingerprint matches', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-node-version-'))
    const executable = join(temporary, 'node.exe')
    const bytes = Buffer.from('fixture-node')
    writeFileSync(executable, bytes)
    try {
      assert.throws(() => {
        verifyNodeExecutable(executable, {
          expectedBytes: bytes.length,
          expectedSha256: digest(bytes),
          spawnSync: () => ({ status: 0, stdout: 'v24.18.0\n' }),
          inspectSignature: () => VALID_SIGNATURE,
        })
      }, /version mismatch: expected v24\.19\.0, received v24\.18\.0/u)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('requires a valid OpenJS Authenticode signer and matching PE metadata', () => {
    assert.doesNotThrow(() => { verifyOfficialNodeSignature(VALID_SIGNATURE, 'v24.19.0') })
    assert.throws(() => {
      verifyOfficialNodeSignature({ ...VALID_SIGNATURE, status: 'HashMismatch' }, 'v24.19.0')
    }, /signature is not valid/u)
    assert.throws(() => {
      verifyOfficialNodeSignature({ ...VALID_SIGNATURE, subject: 'CN=Unknown Publisher' }, 'v24.19.0')
    }, /signer is not OpenJS Foundation/u)
  })

  it('replaces only the exact staging directory and includes a verified license', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mengluo-node-stage-'))
    const programFiles = join(temporary, 'Program Files')
    const nodeDirectory = join(programFiles, 'nodejs')
    const appRoot = join(temporary, 'desktop')
    const targetRoot = join(appRoot, 'build', 'runtime', 'node-runtime')
    const sentinel = join(appRoot, 'build', 'keep.txt')
    const sourceBytes = Buffer.from('fixture-node')
    const licenseBytes = Buffer.from('fixture-license')
    mkdirSync(nodeDirectory, { recursive: true })
    mkdirSync(targetRoot, { recursive: true })
    writeFileSync(join(nodeDirectory, 'node.exe'), sourceBytes)
    writeFileSync(join(targetRoot, 'stale.txt'), 'remove')
    writeFileSync(sentinel, 'keep')

    try {
      assert.equal(resolveTrustedNodeExecutable(programFiles), join(nodeDirectory, 'node.exe'))
      const staged = await stageNodeRuntime({
        appRoot,
        programFiles,
        expectedBytes: sourceBytes.length,
        expectedSha256: digest(sourceBytes),
        expectedLicenseBytes: licenseBytes.length,
        expectedLicenseSha256: digest(licenseBytes),
        spawnSync: () => ({ status: 0, stdout: 'v24.19.0\n' }),
        inspectSignature: () => VALID_SIGNATURE,
        fetch: async () => new Response(licenseBytes),
      })
      assert.equal(staged.targetRoot, targetRoot)
      assert.equal(staged.licenseSource, 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE')
      assert.deepEqual(readFileSync(join(targetRoot, 'node.exe')), sourceBytes)
      assert.deepEqual(readFileSync(join(targetRoot, 'LICENSE')), licenseBytes)
      assert.equal(existsSync(join(targetRoot, 'stale.txt')), false)
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep')

      const restaged = await stageNodeRuntime({
        appRoot,
        programFiles,
        expectedBytes: sourceBytes.length,
        expectedSha256: digest(sourceBytes),
        expectedLicenseBytes: licenseBytes.length,
        expectedLicenseSha256: digest(licenseBytes),
        spawnSync: () => ({ status: 0, stdout: 'v24.19.0\n' }),
        inspectSignature: () => VALID_SIGNATURE,
        fetch: async () => { throw new Error('idempotent staging must reuse its verified license') },
      })
      assert.equal(restaged.licenseSource, join(targetRoot, 'LICENSE'))
      assert.deepEqual(readFileSync(join(targetRoot, 'LICENSE')), licenseBytes)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}
