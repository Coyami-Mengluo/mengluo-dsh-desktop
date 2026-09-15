import { compareSemver, parseSemver } from './update-policy.mjs'
import { PluginRateLimiter } from './plugin-rate-limit.mjs'

export { PluginRateLimitError } from './plugin-rate-limit.mjs'

const API = 'https://api.github.com'
const REGISTRY = 'https://registry.npmjs.org'
const SEARCH_SCOPE = 'topic:dsh-plugin archived:false fork:false'
const SEARCH_PAGE_SIZE = 100
const SEARCH_MAX_PAGES = 10
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_ERROR_BYTES = 16 * 1024
const CACHE_ENTRIES = 256
const CACHE_BYTES = 8 * 1024 * 1024
const METADATA_CACHE_TTL = 15 * 60_000
const IMMUTABLE_CACHE_TTL = 24 * 60 * 60_000
const SHA = /^[a-f0-9]{40}$/iu
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export const PLUGIN_CATALOG_SOURCE = Object.freeze({
  name: 'GitHub dsh-plugin topic',
  url: 'https://github.com/topics/dsh-plugin',
  notice: '社区发现目录；收录不代表安全或兼容认证。安装前请查看源码与权限。',
})

/** Accept literal search words, never caller-supplied GitHub qualifiers or operators. */
export function normalizePluginSearchQuery(value = '') {
  if (typeof value !== 'string' || value.length > 100) throw new Error('搜索词最多 100 个字符。')
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || !/^[\p{L}\p{M}\p{N}\s._/-]*$/u.test(value)) {
    throw new Error('请使用文字、数字、空格或 . _ / -，不要输入搜索限定符。')
  }
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.split(' ').some(word => /^(?:AND|OR|NOT)$/iu.test(word))) {
    throw new Error('请输入普通关键词，不支持 AND、OR、NOT 搜索运算符。')
  }
  if (searchExpression(query).length > 256) throw new Error('关键词过多，请缩短搜索词后重试。')
  return query
}

/** Read-only, credential-free metadata client. Inject Electron net.fetch to use the system proxy. */
export class PluginCatalog {
  constructor({ fetch, now = Date.now, timeoutMs = 15_000, cacheTtlMs = 5 * 60_000,
    metadataCacheTtlMs = METADATA_CACHE_TTL } = {}) {
    if (typeof fetch !== 'function') throw new TypeError('plugin catalog requires a fetch function')
    this.fetch = fetch
    this.now = now
    this.timeoutMs = Math.max(1, Math.min(60_000, Number(timeoutMs) || 15_000))
    this.cacheTtlMs = Math.max(0, Math.min(60 * 60_000, Number(cacheTtlMs) || 0))
    this.metadataCacheTtlMs = Math.max(0, Math.min(60 * 60_000, Number(metadataCacheTtlMs) || 0))
    this.cache = new Map()
    this.cacheBytes = 0
    this.inflight = new Map()
    this.rateLimiter = new PluginRateLimiter({ now })
    this.requests = new Set()
    this.disposed = false
  }

  async list(options = {}) {
    const query = normalizePluginSearchQuery(options.query)
    const page = options.page === undefined ? 1 : options.page
    if (!Number.isSafeInteger(page) || page < 1 || page > SEARCH_MAX_PAGES) throw new Error('插件目录页码必须为 1 至 10 的整数。')
    const url = new URL(`${API}/search/repositories`)
    url.search = new URLSearchParams({
      q: searchExpression(query), sort: 'updated', order: 'desc', per_page: String(SEARCH_PAGE_SIZE), page: String(page),
    }).toString()
    const value = await this.json(url.href, options)
    if (!record(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total_count) || value.total_count < 0) {
      throw new Error('插件目录数据格式已变化，请稍后重试。')
    }
    const seen = new Set()
    const items = []
    for (const item of value.items.slice(0, SEARCH_PAGE_SIZE)) {
      if (!Array.isArray(item?.topics) || !item.topics.includes('dsh-plugin')) continue
      const parsed = parseRepository(item)
      if (!parsed || seen.has(parsed.id.toLowerCase())) continue
      seen.add(parsed.id.toLowerCase())
      items.push(parsed)
    }
    const hasMore = page < SEARCH_MAX_PAGES && value.total_count > page * SEARCH_PAGE_SIZE
    const incomplete = value.incomplete_results === true
    return {
      items, source: PLUGIN_CATALOG_SOURCE.name, sourceUrl: PLUGIN_CATALOG_SOURCE.url,
      total: value.total_count, query, page, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}),
      limitReached: page === SEARCH_MAX_PAGES && value.total_count > SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES,
      incomplete, truncated: incomplete || value.total_count > items.length,
      checkedAt: this.now(),
    }
  }

  /** Resolve a discovered repository to one root bundle at an exact immutable commit. */
  async resolve(id, options = {}) {
    if (typeof id !== 'string' || !id.startsWith('github:')) throw new Error('不支持的插件标识。')
    const repo = requireRepository(id.slice('github:'.length))
    const info = await this.json(`${API}/repos/${repo}`, options)
    const item = parseRepository(info)
    if (!item || item.repo.toLowerCase() !== repo.toLowerCase()) throw new Error('插件仓库不可用或已迁移，请重新检查源码。')
    return this.githubCandidate(item.repo, item.ref, { ...options, item })
  }

  /** No installation happens here. Missing provenance remains unknown, never an inferred upgrade. */
  async checkUpdate(installed, options = {}) {
    this.assertActive(options.signal)
    if (!record(installed)) return unknown('缺少已安装插件信息。')
    if (installed.source === 'npm') return this.npmUpdate(installed, options)
    if (installed.source !== 'github') return unknown('此安装来源暂不支持检查更新。')
    const github = record(installed.github) ? installed.github : {}
    let repo = installed.repo
    if (!repo && typeof github.owner === 'string' && typeof github.repo === 'string') repo = `${github.owner}/${github.repo}`
    const ref = installed.ref ?? github.ref
    const specCommit = typeof installed.spec === 'string' ? installed.spec.match(/#([a-f0-9]{40})$/iu)?.[1] : undefined
    const commit = installed.commit ?? github.commit ?? specCommit
    if (!validRepository(repo) || !validRef(ref) || SHA.test(ref) || typeof commit !== 'string' || !SHA.test(commit)) {
      return unknown('未记录可追踪分支和已安装提交；请查看源码，不会猜测更新。')
    }
    const latestCommit = await this.githubRevision(repo, ref, options)
    if (latestCommit === commit.toLowerCase()) return { status: 'current' }
    const candidate = await this.githubCandidateAt(repo, ref, latestCommit, options)
    if (candidate.name !== installed.name) return unknown('仓库中的插件名称已变化，请人工核对。')
    return { status: 'available', candidate }
  }

  async githubRevision(repo, ref, options = {}) {
    requireRepository(repo)
    if (!validRef(ref)) throw new Error('插件仓库没有可用的公开分支。')
    const revision = await this.json(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, options)
    if (!record(revision) || typeof revision.sha !== 'string' || !SHA.test(revision.sha)) {
      throw new Error('无法确认插件的精确提交。')
    }
    return revision.sha.toLowerCase()
  }

  async githubCandidate(repo, ref, options = {}) {
    const commit = await this.githubRevision(repo, ref, options)
    return this.githubCandidateAt(repo, ref, commit, options)
  }

  async githubCandidateAt(repo, ref, commit, options = {}) {
    requireRepository(repo)
    if (!validRef(ref) || typeof commit !== 'string' || !SHA.test(commit)) throw new Error('插件提交信息无效。')
    const manifestFile = await this.json(`${API}/repos/${repo}/contents/package.json?ref=${commit}`, options)
    const manifest = decodeManifest(manifestFile)
    const patch = bundlePatch(manifest)
    if (!patch) throw new Error('仓库根目录未声明可安装的 Harness 插件包；多包仓库请按作者说明安装。')
    const patchFile = await this.json(`${API}/repos/${repo}/contents/${patch.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`, options)
    if (!record(patchFile) || patchFile.type !== 'file' || patchFile.path !== patch || patchFile.target !== undefined) {
      throw new Error('插件声明的配置文件不存在或不是普通文件。')
    }
    const item = options.item
    return {
      id: `github:${repo}`, name: manifest.name, version: safeVersion(manifest.version) ?? commit.slice(0, 12),
      spec: `github:${repo}#${commit}`, source: 'github', repo, ref, commit,
      author: item?.author ?? repo.split('/')[0], sourceUrl: `https://github.com/${repo}`,
      description: cleanText(manifest.description ?? item?.description, 500),
      compatibility: 'unknown', ...compatibilityDeclaration(manifest),
    }
  }

  async npmUpdate(installed, options = {}) {
    if (!validNpmName(installed.name) || !safeVersion(installed.version)) return unknown('缺少有效的 npm 名称或已安装版本。')
    const manifest = await this.json(`${REGISTRY}/${encodeURIComponent(installed.name)}/latest`, options)
    if (!record(manifest) || manifest.name !== installed.name || !safeVersion(manifest.version)) {
      throw new Error('npm 返回的插件名称或版本不匹配。')
    }
    if (compareSemver(manifest.version, installed.version) <= 0) return { status: 'current' }
    if (!bundlePatch(manifest)) return unknown('新版未声明可安装的 Harness 插件包，请人工核对。')
    const repo = repositoryFromManifest(manifest)
    const candidate = {
      id: `npm:${manifest.name}`, name: manifest.name, version: manifest.version,
      spec: `${manifest.name}@${manifest.version}`, source: 'npm',
      author: cleanText(typeof manifest.author === 'string' ? manifest.author : manifest.author?.name, 120),
      description: cleanText(manifest.description, 500),
      sourceUrl: repo ? `https://github.com/${repo}` : `https://www.npmjs.com/package/${encodeURIComponent(manifest.name)}`,
      ...(repo ? { repo } : {}), compatibility: 'unknown', ...compatibilityDeclaration(manifest),
    }
    return { status: 'available', candidate }
  }

  async json(url, { refresh = false, signal } = {}) {
    this.assertActive(signal)
    const parsed = new URL(url)
    if (![API, REGISTRY].includes(parsed.origin) || parsed.username || parsed.password || parsed.hash) {
      throw new Error('插件元数据地址不受支持。')
    }
    const key = parsed.href
    // Only exact-commit files are immutable. Branches, tags, repository metadata
    // and npm's latest version must still be checked on an explicit refresh.
    const immutable = parsed.origin === API && /^\/repos\/[^/]+\/[^/]+\/contents\/.+/u.test(parsed.pathname)
      && parsed.searchParams.size === 1 && SHA.test(parsed.searchParams.get('ref') ?? '')
    const ttl = immutable ? IMMUTABLE_CACHE_TTL : parsed.pathname.startsWith('/search/')
      ? this.cacheTtlMs : this.metadataCacheTtlMs
    const cached = this.cache.get(key)
    if ((!refresh || immutable) && cached && this.now() >= cached.at && this.now() - cached.at < ttl) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return structuredClone(cached.value)
    }
    let pending = this.inflight.get(key)
    if (!pending) {
      this.rateLimiter.dispatch(parsed)
      pending = { controller: new AbortController(), consumers: new Set(), settled: false }
      this.inflight.set(key, pending)
      pending.promise = this.fetchJson(parsed, pending.controller).finally(() => {
        pending.settled = true
        if (this.inflight.get(key) === pending) this.inflight.delete(key)
      })
    }
    return this.joinRequest(key, pending, signal)
  }

  /** A cancelled search must not cancel another caller sharing the same GET. */
  joinRequest(key, pending, signal) {
    return new Promise((resolve, reject) => {
      const consumer = {}
      let done = false
      pending.consumers.add(consumer)
      const finish = (ok, value) => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', cancel)
        pending.consumers.delete(consumer)
        if (ok) resolve(structuredClone(value))
        else reject(value)
      }
      const cancel = () => {
        finish(false, signal.reason ?? new Error('插件请求已取消。'))
        if (!pending.settled && !pending.consumers.size) {
          if (this.inflight.get(key) === pending) this.inflight.delete(key)
          pending.controller.abort(signal.reason)
        }
      }
      // Attach both handlers even if this consumer was cancelled synchronously.
      pending.promise.then(value => finish(true, value), error => finish(false, error))
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }

  async fetchJson(parsed, controller) {
    const url = parsed.href
    this.requests.add(controller)
    const timer = setTimeout(() => controller.abort(new Error('插件元数据请求超时。')), this.timeoutMs)
    const combined = controller.signal
    try {
      const response = await this.fetch(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { Accept: 'application/json', ...(parsed.origin === API ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
      })
      if (combined.aborted || this.disposed) {
        await response.body?.cancel?.().catch(() => {})
        this.assertActive(combined)
      }
      if (response.redirected || (response.url && new URL(response.url).origin !== parsed.origin)) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error('插件元数据地址发生跳转，已停止请求。')
      }
      if (response.status !== 200) {
        const headerRateError = this.rateLimiter.observe(parsed, response)
        const evidence = (response.status === 403 || response.status === 429) && parsed.origin === API
          ? await readRateEvidence(response, combined) : {}
        this.assertActive(combined)
        const rateError = this.rateLimiter.observe(parsed, response, evidence) ?? headerRateError
        await response.body?.cancel?.().catch(() => {})
        this.assertActive(combined)
        if (rateError) throw rateError
        if (response.status === 403) throw new Error('插件元数据访问被拒绝，请检查仓库是否公开。')
        if (response.status === 404) throw new Error('插件或目标版本尚未公开，请稍后重试或查看源码。')
        throw new Error(`插件元数据请求失败（HTTP ${Number(response.status) || 0}）。`)
      }
      this.rateLimiter.observe(parsed, response)
      const value = await readJson(response, MAX_JSON_BYTES, combined)
      this.assertActive(combined)
      this.remember(url, value)
      return value
    } finally {
      clearTimeout(timer)
      this.requests.delete(controller)
    }
  }

  remember(url, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    const previous = this.cache.get(url)
    if (previous) { this.cache.delete(url); this.cacheBytes -= previous.bytes }
    while (this.cache.size && (this.cache.size >= CACHE_ENTRIES || this.cacheBytes + bytes > CACHE_BYTES)) {
      const oldest = this.cache.keys().next().value
      this.cacheBytes -= this.cache.get(oldest).bytes
      this.cache.delete(oldest)
    }
    if (bytes > CACHE_BYTES) return
    this.cache.set(url, { at: this.now(), bytes, value: structuredClone(value) })
    this.cacheBytes += bytes
  }

  assertActive(signal) {
    if (this.disposed) throw new Error('插件目录已关闭。')
    signal?.throwIfAborted()
  }

  getRateLimitState() {
    return this.rateLimiter.getState()
  }

  dispose() {
    this.disposed = true
    for (const controller of this.requests) controller.abort(new Error('插件目录已关闭。'))
    this.requests.clear()
    this.inflight.clear()
    this.cache.clear()
    this.cacheBytes = 0
    this.rateLimiter.dispose()
  }
}

function searchExpression(query) {
  // Quotes prevent leading '-' and repository punctuation from becoming search syntax.
  return query ? `${SEARCH_SCOPE} ${query.split(' ').map(word => `"${word}"`).join(' ')} in:name,description,readme` : SEARCH_SCOPE
}

function parseRepository(value) {
  if (!record(value) || !validRepository(value.full_name) || !validRef(value.default_branch)
    || value.private === true || value.archived === true || value.disabled === true || value.fork === true) return undefined
  const [author, name] = value.full_name.split('/')
  if (typeof value.owner?.login !== 'string' || value.owner.login.toLowerCase() !== author.toLowerCase()) return undefined
  return {
    id: `github:${value.full_name}`, name, author, repo: value.full_name, ref: value.default_branch,
    description: cleanText(value.description, 500), source: 'github', sourceUrl: `https://github.com/${value.full_name}`,
    category: category(value.topics), compatibility: 'unknown',
  }
}

function category(topics) {
  const known = new Set(Array.isArray(topics) ? topics.filter(value => typeof value === 'string').slice(0, 30) : [])
  if (['theme', 'dsh-theme', 'skin', 'web-ui'].some(topic => known.has(topic))) return '主题与界面'
  if (['browser', 'automation', 'agent', 'workflow'].some(topic => known.has(topic))) return '自动化与工具'
  return '社区插件'
}

function validRepository(value) {
  return typeof value === 'string' && value.length <= 200
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value)
    && !value.endsWith('.git')
}

function requireRepository(value) {
  if (!validRepository(value)) throw new Error('不支持的 GitHub 仓库标识。')
  return value
}

function validRef(value) {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
    && !value.endsWith('.') && value.split('/').every(segment => segment && !segment.startsWith('.') && !segment.endsWith('.lock'))
}

function validNpmName(value) {
  return typeof value === 'string' && value.length <= 214 && NPM_NAME.test(value)
}

function bundlePatch(manifest) {
  if (!record(manifest) || !validNpmName(manifest.name)) return undefined
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length > 300 || !/^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:yml|yaml|json)$/u.test(patch)) return undefined
  const normalized = patch.startsWith('./') ? patch.slice(2) : patch
  if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) return undefined
  return normalized
}

function decodeManifest(file) {
  if (!record(file) || file.type !== 'file' || file.path !== 'package.json' || file.encoding !== 'base64'
    || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_MANIFEST_BYTES
    || typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_MANIFEST_BYTES * 1.5)) {
    throw new Error('插件根目录的 package.json 不可读取。')
  }
  const base64 = file.content.replace(/\s/gu, '')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length !== file.size || bytes.toString('base64') !== base64 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error('插件清单格式不正确。')
  }
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('插件清单不是有效 JSON。') }
}

function compatibilityDeclaration(manifest) {
  const value = manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? manifest.engines?.dsh
  return typeof value === 'string' && value.length <= 160 && !/[\u0000-\u001f]/u.test(value)
    ? { compatibleRange: value } : {}
}

function repositoryFromManifest(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (typeof raw !== 'string') return undefined
  const match = /^(?:git\+)?https:\/\/github\.com\/([^?#]+?)(?:\.git)?\/?$/u.exec(raw)
  return match && validRepository(match[1]) ? match[1] : undefined
}

function safeVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined
  try { return parseSemver(value).raw } catch { return undefined }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, max) : ''
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function unknown(reason) { return { status: 'unknown', reason } }

async function readRateEvidence(response, signal) {
  // Only bounded error metadata is inspected; external text is never displayed or saved.
  try {
    const value = await readJson(response, MAX_ERROR_BYTES, signal)
    const message = typeof value?.message === 'string' ? value.message : ''
    return {
      rateLimited: /\brate[ -]limit exceeded\b|\bexceeded (?:a |the )?(?:secondary )?rate[ -]limit\b|\babuse detection\b/iu.test(message),
      secondary: /\bsecondary rate[ -]limit\b|\babuse detection\b/iu.test(message),
    }
  } catch { return {} }
}

async function readJson(response, limit, signal) {
  const announced = Number(response.headers?.get?.('content-length'))
  if (announced > limit) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('插件元数据过大，已停止读取。')
  }
  if (!response.body?.getReader) throw new Error('插件元数据响应无法安全读取。')
  const reader = response.body.getReader()
  let size = 0
  const chunks = []
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('插件元数据过大，已停止读取。')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof SyntaxError) throw new Error('插件元数据不是有效 JSON。')
    throw error
  } finally { reader.releaseLock() }
}
