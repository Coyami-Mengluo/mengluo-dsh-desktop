const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEARCH_LIMIT = 8
const METADATA_LIMIT = 50
const SEARCH_GAP = 1_000
const MAX_DATE = 8_640_000_000_000_000

const REASONS = Object.freeze({
  searchLocal: '客户端搜索保护：每分钟最多 8 次请求，间隔至少 1 秒。',
  metadataLocal: '客户端插件检查保护：每小时最多 50 次 GitHub 元数据请求，不影响目录搜索。',
  searchServer: 'GitHub 搜索额度已用完，等待服务端额度重置。',
  metadataServer: 'GitHub 插件信息额度已用完，不影响目录搜索。',
  github: 'GitHub 临时限流：搜索和插件信息请求均需等待。',
  npm: 'npm 临时限流：插件信息检查需等待，不影响目录搜索。',
})
const SAFE_REASONS = new Set(Object.values(REASONS))
export const safeRateLimitReason = value => SAFE_REASONS.has(value) ? value : ''

export class PluginRateLimitError extends Error {
  constructor(retryAt, reason, now = Date.now()) {
    super(SAFE_REASONS.has(reason) ? reason : '插件请求已限流，请稍后再试。')
    this.name = 'PluginRateLimitError'
    this.code = 'PLUGIN_RATE_LIMIT'
    this.retryAt = Number.isFinite(retryAt) && retryAt > now ? retryAt : now + MINUTE
  }
}

/** Per-catalog rolling budgets. Only dispatch() spends them; no queue or retry timers. */
export class PluginRateLimiter {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.searchDispatches = []
    this.metadataDispatches = []
    this.cooldowns = new Map()
    this.observedResponses = new WeakMap()
  }

  dispatch(url) {
    const now = this.now()
    const kind = requestKind(url)
    const blocked = this.blocked(kind, now)
    if (blocked.until > now) throw new PluginRateLimitError(blocked.until, blocked.reason, now)
    // An attempted dispatch consumes capacity even if fetch fails or is later cancelled.
    if (kind === 'search') this.searchDispatches.push(now)
    if (kind === 'metadata') this.metadataDispatches.push(now)
  }

  /** Record rate headers even on a successful final-quota response. */
  observe(url, response, evidence = {}) {
    const now = this.now()
    const kind = requestKind(url)
    const headers = response.headers
    const retry = retryAfter(headers?.get?.('retry-after'), now)
    const reset = resetAt(headers?.get?.('x-ratelimit-reset'), now)
    const remaining = headers?.get?.('x-ratelimit-remaining')?.trim()
    const exhausted = remaining === '0'
    const limited = response.status === 429 || (response.status === 403
      && (exhausted || retry > now || evidence.rateLimited === true))

    if (kind === 'npm') {
      if (!limited || response.status !== 429) return undefined
      this.cooldownResponse(response, 'npm', retry, now)
    } else if (limited) {
      // Reset describes the primary bucket, not a secondary Retry-After. GitHub
      // sends reset headers even with quota remaining: do not turn 60s into 1h.
      if (exhausted) this.cooldownResponse(response, `${kind}Server`, Math.max(retry, reset), now)
      if (evidence.secondary === true || !exhausted) this.cooldownResponse(response, 'github', retry, now)
    } else if (response.status === 200 && exhausted) {
      this.cooldownResponse(response, `${kind}Server`, Math.max(retry, reset), now)
      return undefined
    } else {
      return undefined
    }

    const blocked = this.blocked(kind, now)
    return new PluginRateLimitError(blocked.until, blocked.reason, now)
  }

  getState() {
    const now = this.now()
    const search = this.blocked('search', now)
    // Checking updates can use either host, so expose a conservative combined UI deadline.
    const metadata = latest(this.blocked('metadata', now), this.blocked('npm', now))
    return {
      searchUntil: search.until, metadataUntil: metadata.until,
      searchReason: search.reason, metadataReason: metadata.reason,
    }
  }

  blocked(kind, now) {
    if (kind === 'npm') return this.serverBlock('npm', now)
    const dispatches = kind === 'search' ? this.searchDispatches : this.metadataDispatches
    const window = kind === 'search' ? MINUTE : HOUR
    const limit = kind === 'search' ? SEARCH_LIMIT : METADATA_LIMIT
    while (dispatches.length && dispatches[0] <= now - window) dispatches.shift()
    let localUntil = dispatches.length >= limit ? dispatches[0] + window : 0
    if (kind === 'search' && dispatches.length) localUntil = Math.max(localUntil, dispatches.at(-1) + SEARCH_GAP)
    const local = localUntil > now ? { until: localUntil, reason: REASONS[`${kind}Local`] } : empty()
    return latest(local, this.serverBlock(`${kind}Server`, now), this.serverBlock('github', now))
  }

  serverBlock(scope, now) {
    const until = this.cooldowns.get(scope)?.until ?? 0
    return until > now ? { until, reason: REASONS[scope] } : empty()
  }

  cooldown(scope, headerUntil, now) {
    const previous = this.cooldowns.get(scope)
    const attempts = Math.min((previous?.attempts ?? 0) + 1, 7)
    const fallback = now + Math.min(HOUR, MINUTE * 2 ** (attempts - 1))
    const until = Math.max(previous?.until ?? 0, headerUntil > now ? headerUntil : fallback)
    this.cooldowns.set(scope, { until, attempts })
  }

  cooldownResponse(response, scope, headerUntil, now) {
    // Headers can stop dispatch immediately; bounded body inspection may later widen the scope.
    // Count each response only once per scope, so that second observation cannot double backoff.
    const scopes = this.observedResponses.get(response) ?? new Set()
    if (scopes.has(scope)) return
    scopes.add(scope)
    this.observedResponses.set(response, scopes)
    this.cooldown(scope, headerUntil, now)
  }

  dispose() {
    this.searchDispatches.length = 0
    this.metadataDispatches.length = 0
    this.cooldowns.clear()
    this.observedResponses = new WeakMap()
  }
}

function requestKind(url) {
  const parsed = url instanceof URL ? url : new URL(url)
  if (parsed.origin === 'https://registry.npmjs.org') return 'npm'
  return parsed.pathname.startsWith('/search/') ? 'search' : 'metadata'
}

function empty() { return { until: 0, reason: '' } }
function latest(...blocks) { return blocks.reduce((result, block) => block.until > result.until ? block : result, empty()) }

function retryAfter(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0
  const raw = value.trim()
  const until = /^\d+(?:\.\d+)?$/u.test(raw) ? now + Number(raw) * 1_000
    : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /u.test(raw) ? Date.parse(raw) : NaN
  return validDeadline(until, now)
}

function resetAt(value, now) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return 0
  return validDeadline(Number(value.trim()) * 1_000, now)
}

function validDeadline(until, now) {
  return Number.isFinite(until) && until > now && until <= MAX_DATE ? Math.ceil(until) : 0
}
