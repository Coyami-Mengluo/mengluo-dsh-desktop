import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareSemver,
  DEFAULT_UPDATE_INTERVAL,
  isUpdateCheckDue,
  normalizeUpdateInterval,
  parseDshPackument,
  parseSemver,
  resolveUpdateChannel,
  selectDshUpdate,
  shouldNotifyUpdate,
  UPDATE_INTERVAL_MS,
} from '../src/update-policy.mjs'

const INTEGRITY = `sha512-${'A'.repeat(86)}==`

function release(version) {
  return {
    name: '@deepseek-ai/dsh',
    version,
    dist: {
      tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
      integrity: INTEGRITY,
    },
  }
}

function packument({ latest = '1.2.3', next = '1.3.0-rc.2' } = {}) {
  const tags = { latest }
  const versions = { [latest]: release(latest) }
  if (next !== undefined) {
    tags.next = next
    versions[next] = release(next)
  }
  return { name: '@deepseek-ai/dsh', 'dist-tags': tags, versions }
}

describe('SemVer policy', () => {
  it('accepts strict stable, prerelease, and build versions', () => {
    assert.deepEqual(parseSemver('1.2.3-rc.10+win.x64').prerelease, ['rc', '10'])
    assert.deepEqual(parseSemver('1.2.3-rc.10+win.x64').build, ['win', 'x64'])
    assert.equal(parseSemver('0.0.0').raw, '0.0.0')
  })

  it('rejects loose and invalid versions', () => {
    for (const value of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+']) {
      assert.throws(() => { parseSemver(value) }, /invalid semantic version/u)
    }
  })

  it('implements SemVer prerelease precedence without numeric precision loss', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let index = 1; index < ordered.length; index += 1) {
      assert.equal(compareSemver(ordered[index - 1], ordered[index]), -1)
    }
    assert.equal(compareSemver('9007199254740993.0.0', '9007199254740992.0.0'), 1)
    assert.equal(compareSemver('1.0.0+one', '1.0.0+two'), 0)
  })
})

describe('npm packument policy', () => {
  it('parses official latest and next releases', () => {
    const parsed = parseDshPackument(packument())
    assert.equal(parsed.releases.latest?.version, '1.2.3')
    assert.equal(parsed.releases.next?.version, '1.3.0-rc.2')
    assert.equal(parsed.releases.latest?.integrity, INTEGRITY)
  })

  it('rejects the wrong package and missing tagged version manifests', () => {
    assert.throws(
      () => { parseDshPackument({ ...packument(), name: '@evil/dsh' }) },
      /must describe @deepseek-ai\/dsh/u,
    )
    const missing = packument()
    delete missing.versions[missing['dist-tags'].latest]
    assert.throws(() => { parseDshPackument(missing) }, /latest version manifest must be an object/u)
  })

  it('rejects non-registry, non-HTTPS, mismatched, and decorated tarball URLs', () => {
    const invalid = [
      'http://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.2.3.tgz',
      'https://example.com/@deepseek-ai/dsh/-/dsh-1.2.3.tgz',
      'https://user@registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.2.3.tgz',
      'https://registry.npmjs.org/@deepseek-ai/other/-/other-1.2.3.tgz',
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-9.9.9.tgz',
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.2.3.tgz?token=x',
    ]
    for (const tarball of invalid) {
      const candidate = packument({ next: undefined })
      candidate.versions['1.2.3'].dist.tarball = tarball
      assert.throws(() => { parseDshPackument(candidate) }, /official HTTPS registry artifact/u)
    }
  })

  it('requires one SHA-512 integrity value', () => {
    const nonCanonical = `sha512-${'A'.repeat(85)}B==`
    for (const integrity of [undefined, '', 'sha1-deadbeef', 'sha512-not-base64', nonCanonical, `${INTEGRITY} other`]) {
      const candidate = packument({ next: undefined })
      candidate.versions['1.2.3'].dist.integrity = integrity
      assert.throws(() => { parseDshPackument(candidate) }, /SHA-512 SRI/u)
    }
  })

  it('defaults stable runtimes to latest and prerelease runtimes to next', () => {
    assert.equal(resolveUpdateChannel('1.2.3'), 'latest')
    assert.equal(resolveUpdateChannel('1.3.0-rc.1'), 'next')
    assert.equal(resolveUpdateChannel('1.3.0-rc.1', 'latest'), 'latest')
    assert.throws(() => { resolveUpdateChannel('1.2.3', 'beta') }, /unsupported Harness update channel/u)
  })

  it('selects only a release newer than the installed version', () => {
    const source = packument()
    assert.equal(selectDshUpdate(source, '1.2.2')?.version, '1.2.3')
    assert.equal(selectDshUpdate(source, '1.3.0-rc.1')?.version, '1.3.0-rc.2')
    assert.equal(selectDshUpdate(source, '1.2.3'), undefined)
    assert.equal(selectDshUpdate(source, '2.0.0'), undefined)
  })
})

describe('automatic check policy', () => {
  it('publishes exact six-hour, daily, and weekly intervals', () => {
    assert.deepEqual(UPDATE_INTERVAL_MS, {
      '6h': 21_600_000,
      '24h': 86_400_000,
      '7d': 604_800_000,
    })
  })

  it('normalizes unsupported persisted preferences to daily', () => {
    assert.equal(DEFAULT_UPDATE_INTERVAL, '24h')
    assert.equal(normalizeUpdateInterval('6h'), '6h')
    assert.equal(normalizeUpdateInterval('7d'), '7d')
    assert.equal(normalizeUpdateInterval('hourly'), '24h')
    assert.equal(normalizeUpdateInterval(null), '24h')
  })

  it('checks at the interval boundary and immediately after invalid state or clock rollback', () => {
    const now = 1_000_000_000
    assert.equal(isUpdateCheckDue(now - UPDATE_INTERVAL_MS['6h'] + 1, '6h', now), false)
    assert.equal(isUpdateCheckDue(now - UPDATE_INTERVAL_MS['6h'], '6h', now), true)
    assert.equal(isUpdateCheckDue(undefined, '24h', now), true)
    assert.equal(isUpdateCheckDue(Number.NaN, '24h', now), true)
    assert.equal(isUpdateCheckDue(now + 1, '24h', now), true)
  })

  it('deduplicates only the same exact valid version', () => {
    assert.equal(shouldNotifyUpdate('1.2.3', '1.2.3'), false)
    assert.equal(shouldNotifyUpdate('1.2.3', '1.2.2'), true)
    assert.equal(shouldNotifyUpdate('1.2.3+two', '1.2.3+one'), true)
    assert.equal(shouldNotifyUpdate('1.2.3', 'corrupt state'), true)
  })
})
