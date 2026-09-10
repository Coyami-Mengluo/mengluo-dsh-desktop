import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_REGISTRY_ORIGIN } from './update-policy.mjs'

/** Fixed transport choices, never arbitrary URLs or global npm configuration. */
export const DOWNLOAD_SOURCES = Object.freeze([
  Object.freeze({
    id: 'official',
    label: '官方 npm',
    registry: `${NPM_REGISTRY_ORIGIN}/`,
    description: '使用官方 npm 下载 Harness 及依赖。',
  }),
  Object.freeze({
    id: 'npmmirror',
    label: '国内镜像（npmmirror）',
    registry: 'https://registry.npmmirror.com/',
    description: '第三方下载镜像；版本、依赖和校验值仍取自官方 npm，缺少文件时回退官方源。',
  }),
])

export function resolveDownloadSource(id = 'official') {
  const source = DOWNLOAD_SOURCES.find(candidate => candidate.id === id)
  if (source === undefined) throw new Error('unsupported Harness download source')
  return source
}

export function readDownloadPreferences(userData) {
  try {
    const path = join(userData, 'download-settings.json')
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4_096) return preference('official')
    return validatePreferences(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return preference('official')
  }
}

export function writeDownloadPreferences(userData, value) {
  const result = validatePreferences(value)
  mkdirSync(userData, { recursive: true })
  const path = join(userData, 'download-settings.json')
  try {
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('download settings path is not a regular file')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temporary = join(userData, `.download-settings-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return result
}

function validatePreferences(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'source')
    || typeof value.source !== 'string') throw new Error('invalid Harness download settings')
  return preference(resolveDownloadSource(value.source).id)
}

function preference(source) {
  return Object.freeze({ source })
}
