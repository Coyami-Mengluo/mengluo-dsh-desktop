/** Pure validation and scheduling policy for Harness runtime updates. */

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'

export const UPDATE_INTERVAL_MS = Object.freeze({
  '6h': 6 * 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
})

export const DEFAULT_UPDATE_INTERVAL = '24h'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u
const SUPPORTED_CHANNELS = new Set(['latest', 'next'])

/**
 * Parse a strict SemVer 2.0 version.
 * @param {unknown} value candidate version.
 * @returns {{raw: string; major: string; minor: string; patch: string; prerelease: string[]; build: string[]}}
 */
export function parseSemver(value) {
  if (typeof value !== 'string') throw new TypeError('version must be a string')
  const match = SEMVER_PATTERN.exec(value)
  if (match === null) throw new Error(`invalid semantic version: ${value}`)
  return {
    raw: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4]?.split('.') ?? [],
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer versions, including prerelease precedence.
 * Build metadata does not affect precedence.
 * @param {string} left first version.
 * @param {string} right second version.
 * @returns {-1 | 0 | 1} precedence ordering.
 */
export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (const field of ['major', 'minor', 'patch']) {
    const order = compareNumericIdentifier(a[field], b[field])
    if (order !== 0) return order
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index]
    const bIdentifier = b.prerelease[index]
    if (aIdentifier === undefined) return -1
    if (bIdentifier === undefined) return 1
    const order = comparePrereleaseIdentifier(aIdentifier, bIdentifier)
    if (order !== 0) return order
  }
  return 0
}

/**
 * Select the registry channel for the current runtime.
 * An explicit channel wins; otherwise prerelease runtimes follow `next` and
 * stable runtimes follow `latest`.
 * @param {string} currentVersion installed Harness version.
 * @param {unknown} requestedChannel explicit channel, when configured.
 * @returns {'latest' | 'next'} selected dist-tag.
 */
export function resolveUpdateChannel(currentVersion, requestedChannel) {
  const current = parseSemver(currentVersion)
  if (requestedChannel !== undefined) {
    if (typeof requestedChannel !== 'string' || !SUPPORTED_CHANNELS.has(requestedChannel)) {
      throw new Error(`unsupported Harness update channel: ${String(requestedChannel)}`)
    }
    return requestedChannel
  }
  return current.prerelease.length > 0 ? 'next' : 'latest'
}

/**
 * Parse the official package releases named by supported npm dist-tags.
 * Untagged historic versions and unrelated packument metadata are ignored.
 * @param {unknown} value npm registry packument.
 * @returns {{name: typeof DSH_PACKAGE_NAME; releases: Readonly<Partial<Record<'latest' | 'next', DshRelease>>>}}
 */
export function parseDshPackument(value) {
  const packument = requireRecord(value, 'packument')
  if (packument.name !== DSH_PACKAGE_NAME) {
    throw new Error(`packument must describe ${DSH_PACKAGE_NAME}`)
  }
  const distTags = requireRecord(packument['dist-tags'], 'packument dist-tags')
  const versions = requireRecord(packument.versions, 'packument versions')
  const releases = {}
  for (const channel of SUPPORTED_CHANNELS) {
    const taggedVersion = distTags[channel]
    if (taggedVersion === undefined) continue
    const parsedVersion = parseSemver(taggedVersion)
    const manifest = requireRecord(versions[taggedVersion], `${channel} version manifest`)
    if (manifest.name !== DSH_PACKAGE_NAME || manifest.version !== taggedVersion) {
      throw new Error(`${channel} version manifest identity does not match ${DSH_PACKAGE_NAME}@${taggedVersion}`)
    }
    const dist = requireRecord(manifest.dist, `${channel} version dist`)
    const tarball = parseRegistryTarball(dist.tarball, parsedVersion.raw)
    const integrity = parseIntegrity(dist.integrity, channel)
    releases[channel] = Object.freeze({
      channel,
      version: parsedVersion.raw,
      tarball,
      integrity,
    })
  }
  if (releases.latest === undefined) throw new Error('packument has no latest dist-tag')
  return Object.freeze({ name: DSH_PACKAGE_NAME, releases: Object.freeze(releases) })
}

/** List installable official releases; historical malformed or deprecated entries are excluded. */
export function listDshReleases(value) {
  const tagged = parseDshPackument(value)
  const releases = new Map(Object.values(tagged.releases).map(release => [release.version, release]))
  for (const [version, manifest] of Object.entries(value.versions)) {
    if (releases.has(version) || manifest?.deprecated) continue
    try {
      const parsed = parseSemver(version)
      if (manifest?.name !== DSH_PACKAGE_NAME || manifest.version !== version) continue
      releases.set(version, Object.freeze({
        channel: parsed.prerelease.length > 0 ? 'next' : 'latest',
        version,
        tarball: parseRegistryTarball(manifest.dist?.tarball, version),
        integrity: parseIntegrity(manifest.dist?.integrity, version),
      }))
    } catch {
      // Historical metadata without a verifiable official artifact is not an installation choice.
    }
  }
  return Object.freeze([...releases.values()]
    .sort((left, right) => compareSemver(right.version, left.version))
    .map(release => Object.freeze({
      ...release,
      recommended: release.version === tagged.releases.latest?.version,
      preview: parseSemver(release.version).prerelease.length > 0,
    })))
}

/**
 * Select a newer official Harness release without permitting a downgrade.
 * @param {unknown} packument npm registry packument.
 * @param {string} currentVersion installed Harness version.
 * @param {unknown} requestedChannel explicit channel, when configured.
 * @returns {DshRelease | undefined} newer tagged release.
 */
export function selectDshUpdate(packument, currentVersion, requestedChannel) {
  parseSemver(currentVersion)
  const channel = resolveUpdateChannel(currentVersion, requestedChannel)
  const parsed = parseDshPackument(packument)
  const release = parsed.releases[channel]
  if (release === undefined) {
    if (requestedChannel !== undefined) throw new Error(`packument has no ${channel} dist-tag`)
    return undefined
  }
  return compareSemver(release.version, currentVersion) > 0 ? release : undefined
}

/**
 * Normalize a persisted automatic-check interval preference.
 * @param {unknown} value persisted preference.
 * @returns {'6h' | '24h' | '7d'} supported interval key.
 */
export function normalizeUpdateInterval(value) {
  return typeof value === 'string' && Object.hasOwn(UPDATE_INTERVAL_MS, value)
    ? value
    : DEFAULT_UPDATE_INTERVAL
}

/**
 * Decide whether an automatic check is due.
 * Missing, invalid, or future timestamps are due immediately.
 * @param {unknown} lastCheckedAt epoch-millisecond timestamp of the last completed check.
 * @param {unknown} intervalPreference persisted interval preference.
 * @param {number} now current epoch-millisecond timestamp.
 * @returns {boolean} whether a check should start.
 */
export function isUpdateCheckDue(lastCheckedAt, intervalPreference, now = Date.now()) {
  if (!Number.isFinite(now) || now < 0) throw new Error('current time must be a non-negative finite number')
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt) || lastCheckedAt < 0) return true
  if (lastCheckedAt > now) return true
  const interval = UPDATE_INTERVAL_MS[normalizeUpdateInterval(intervalPreference)]
  return now - lastCheckedAt >= interval
}

/**
 * Suppress a notification already shown for the same exact Harness version.
 * Invalid persisted state is treated as no previous notification.
 * @param {string} candidateVersion available update version.
 * @param {unknown} lastNotifiedVersion persisted last-notified version.
 * @returns {boolean} whether the update should notify.
 */
export function shouldNotifyUpdate(candidateVersion, lastNotifiedVersion) {
  const candidate = parseSemver(candidateVersion)
  if (typeof lastNotifiedVersion !== 'string') return true
  try {
    return parseSemver(lastNotifiedVersion).raw !== candidate.raw
  } catch {
    return true
  }
}

/** @typedef {{channel: 'latest' | 'next'; version: string; tarball: string; integrity: string}} DshRelease */

/**
 * Require a plain JSON-style record.
 * @param {unknown} value candidate record.
 * @param {string} label failure label.
 * @returns {Record<string, unknown>} parsed record.
 */
function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

/**
 * Validate one official npm registry tarball URL.
 * @param {unknown} value candidate URL.
 * @param {string} version tagged version.
 * @returns {string} canonical URL string.
 */
function parseRegistryTarball(value, version) {
  if (typeof value !== 'string') throw new Error('release tarball must be a string')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`release tarball is not a valid URL: ${value}`)
  }
  const expectedPath = `/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  if (url.origin !== NPM_REGISTRY_ORIGIN
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== expectedPath
    || url.search !== ''
    || url.hash !== '') {
    throw new Error(`release tarball must be the official HTTPS registry artifact for ${DSH_PACKAGE_NAME}@${version}`)
  }
  return url.href
}

/**
 * Validate npm's SHA-512 subresource integrity field.
 * @param {unknown} value candidate integrity.
 * @param {string} channel dist-tag label.
 * @returns {string} validated integrity.
 */
function parseIntegrity(value, channel) {
  if (typeof value !== 'string' || !SHA512_INTEGRITY_PATTERN.test(value)) {
    throw new Error(`${channel} release integrity must be one SHA-512 SRI value`)
  }
  const digest = value.slice('sha512-'.length)
  if (Buffer.from(digest, 'base64').toString('base64') !== digest) {
    throw new Error(`${channel} release integrity must be one SHA-512 SRI value`)
  }
  return value
}

/**
 * Compare non-negative decimal identifiers without number precision loss.
 * @param {string} left first identifier.
 * @param {string} right second identifier.
 * @returns {-1 | 0 | 1} ordering.
 */
function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Compare two SemVer prerelease identifiers.
 * @param {string} left first identifier.
 * @param {string} right second identifier.
 * @returns {-1 | 0 | 1} ordering.
 */
function comparePrereleaseIdentifier(left, right) {
  if (left === right) return 0
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : 1
}
