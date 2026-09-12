import { DSH_PACKAGE_NAME, parseSemver } from './update-policy.mjs'
import { resolveDownloadSource } from './download-source.mjs'

const MAX_BYTES = 1024 * 1024
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u

/** Read metadata only. Mirror replies never authorize installation or change a version. */
export async function probeRegistryVersion({ fetch, source, version, signal }) {
  if (version === undefined) return { status: 'not-selected' }
  if (typeof version !== 'string' || version.length > 80) return { status: 'unknown' }
  try { parseSemver(version) } catch { return { status: 'unknown' } }
  const selected = resolveDownloadSource(source)
  const official = resolveDownloadSource('official')
  const read = async registry => {
    let response
    try {
      const url = new URL(`@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`, registry).href
      response = await fetch(url, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' } })
      if (response.status === 404) return { status: 'missing' }
      if (response.status !== 200) return { status: 'unknown' }
      const manifest = await readBoundedJson(response)
      if (manifest?.name !== DSH_PACKAGE_NAME || manifest.version !== version || !INTEGRITY.test(manifest.dist?.integrity ?? '')) return { status: 'unknown' }
      return { status: 'available', integrity: manifest.dist.integrity }
    } catch { return { status: 'unknown' } }
    finally { try { await response?.body?.cancel() } catch { /* Already consumed or aborted. */ } }
  }
  const [trusted, mirror] = await Promise.all([read(official.registry), selected.id === 'official' ? undefined : read(selected.registry)])
  if (trusted.status !== 'available') return { status: 'unknown', version }
  if (!mirror) return { status: 'official', version }
  return { version, status: mirror.status === 'missing' ? 'missing'
    : mirror.status !== 'available' ? 'unknown' : mirror.integrity === trusted.integrity ? 'synced' : 'mismatch' }
}

async function readBoundedJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('metadata too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('metadata stream unavailable')
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new Error('metadata too large')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
}

export function describeRegistryVersion(result) {
  const version = result.version
  if (!version) return '尚未选择有效目标版本，仅检测连通性。'
  if (result.status === 'synced') return `目标 ${version}：镜像已提供同版本元数据，完整性摘要与官方一致。`
  if (result.status === 'official') return `目标 ${version}：官方版本元数据可用。`
  if (result.status === 'missing') return `目标 ${version}：镜像尚未提供此版本元数据，可稍后重试或使用官方源。`
  if (result.status === 'mismatch') return `目标 ${version}：镜像与官方完整性摘要不一致，建议使用官方源。`
  return `目标 ${version}：暂未确认同步状态，请稍后重试；不能据此判断版本不存在。`
}
