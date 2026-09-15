import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'
import { parseSemver } from './update-policy.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const HASH = /^[a-f0-9]{64}$/u
const MAX_BYTES = 2 * 1024 ** 3
const MAX_ENTRIES = 100_000
const MAX_JSON = 48 * 1024 ** 2
const VERSION = 1
const STATUSES = new Set(['pending', 'success', 'failed', 'succeeded', 'failure', 'restored'])

function problem(code, recoveryRequired = false) {
  const error = new Error({
    SNAPSHOT_PATH: '插件快照路径不安全。', SNAPSHOT_LIMIT: '插件快照超过容量或文件数量限制。',
    SNAPSHOT_INVALID: '插件快照不存在、已损坏或无法验证。', SNAPSHOT_CHANGED: '插件文件或来源记录已被其他操作修改，请刷新后重试。',
    SNAPSHOT_RECOVERY: '上次插件恢复尚未完成，请先处理保留的恢复事务。',
    SNAPSHOT_FAILED: '插件快照操作未完成，原始数据已保留。', SNAPSHOT_BUSY: '插件快照操作正在进行。',
  }[code] ?? '插件快照操作未完成。')
  error.code = code
  error.recoveryRequired = recoveryRequired
  return error
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function absolute(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw problem('SNAPSHOT_PATH')
  const resolved = path.resolve(input)
  if (resolved === path.parse(resolved).root) throw problem('SNAPSHOT_PATH')
  return resolved
}
function validId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw problem('SNAPSHOT_INVALID'); return id }
function relativeName(name, allowEmpty = false) {
  if (allowEmpty && name === '') return true
  return typeof name === 'string' && name.length < 4096 && !/[\\:\x00-\x1f]/u.test(name)
    && !name.startsWith('/') && name.split('/').length <= 128
    && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part))
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const absentTree = () => ({ present: false, entries: [] })
const absentFile = () => ({ present: false })
const fingerprint = state => digest(state)
const statIdentity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`

async function maybeStat(filename) {
  try { return await fs.lstat(filename) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

// Check each existing ancestor without resolving through a junction. Every write
// repeats this check: accepting an absolute path alone does not make it safe.
async function plainAncestors(filename, includeLeaf = true) {
  const resolved = absolute(filename)
  const parsed = path.parse(resolved)
  let current = parsed.root
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  if (!includeLeaf) components.pop()
  for (const component of components) {
    current = path.join(current, component)
    const stat = await maybeStat(current)
    if (!stat) continue
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw problem('SNAPSHOT_PATH')
    const canonical = await fs.realpath(current)
    if (path.relative(current, canonical) !== '') {
      // Windows short names (for example RUNNER~1) name the same directory.
      // Prove that identity instead of accepting any realpath redirection.
      if (process.platform !== 'win32') throw problem('SNAPSHOT_PATH')
      const [aliasStat, canonicalStat] = await Promise.all([
        fs.lstat(current, { bigint: true }), fs.lstat(canonical, { bigint: true }),
      ])
      if (aliasStat.isSymbolicLink() || canonicalStat.isSymbolicLink() || !aliasStat.isDirectory() || !canonicalStat.isDirectory()
        || aliasStat.ino === 0n || aliasStat.ino !== canonicalStat.ino || aliasStat.dev !== canonicalStat.dev) throw problem('SNAPSHOT_PATH')
    }
    current = canonical
  }
  return current
}

async function internalDirectoryTarget(root, target, aliases) {
  for (const alias of aliases) {
    let relative
    if (within(alias, target)) relative = path.relative(alias, target)
    else if (process.platform === 'win32') {
      const parsed = path.parse(target)
      if (path.relative(parsed.root, path.parse(alias).root) !== '') continue
      const components = target.slice(parsed.root.length).split(path.sep).filter(Boolean)
      const depth = alias.slice(path.parse(alias).root.length).split(path.sep).filter(Boolean).length
      if (components.length < depth) continue
      const prefix = path.join(parsed.root, ...components.slice(0, depth))
      // Only map the known root prefix. Relocated recovery links can still
      // mention the old root, so inspect descendants in the retained copy.
      if (path.relative(alias, await plainAncestors(prefix)) !== '') continue
      relative = components.slice(depth).join(path.sep)
    }
    if (relative === undefined) continue
    const local = await plainAncestors(path.join(root, relative))
    if (!within(root, local)) throw problem('SNAPSHOT_PATH')
    return local
  }
  throw problem('SNAPSHOT_PATH')
}

async function regularFile(filename, budget, onChunk) {
  await plainAncestors(filename, false)
  const before = await fs.lstat(filename)
  if (before.isSymbolicLink() || !before.isFile()) throw problem('SNAPSHOT_PATH')
  if (before.size > MAX_BYTES || budget.bytes + before.size > MAX_BYTES) throw problem('SNAPSHOT_LIMIT')
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (statIdentity(await handle.stat()) !== statIdentity(before)) throw problem('SNAPSHOT_CHANGED')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (budget.bytes + size > MAX_BYTES) throw problem('SNAPSHOT_LIMIT')
      hash.update(buffer.subarray(0, bytesRead))
      if (onChunk) await onChunk(buffer.subarray(0, bytesRead))
    }
    if (size !== before.size || statIdentity(await handle.stat()) !== statIdentity(before)
      || statIdentity(await fs.lstat(filename)) !== statIdentity(before)) throw problem('SNAPSHOT_CHANGED')
    budget.bytes += size
    budget.files += 1
    if (budget.files > MAX_ENTRIES) throw problem('SNAPSHOT_LIMIT')
    return { size, sha256: hash.digest('hex'), mode: before.mode & 0o777 }
  } finally { await handle.close() }
}

function validateTree(tree) {
  if (!tree || typeof tree.present !== 'boolean' || !Array.isArray(tree.entries) || tree.entries.length > MAX_ENTRIES
    || !tree.present && tree.entries.length) throw problem('SNAPSHOT_INVALID')
  const known = new Map([['', { type: 'dir' }]])
  const folded = new Set()
  let bytes = 0
  for (const entry of tree.entries) {
    if (!relativeName(entry.path) || folded.has(entry.path.toLowerCase()) || !['dir', 'file', 'link'].includes(entry.type)) throw problem('SNAPSHOT_INVALID')
    folded.add(entry.path.toLowerCase())
    known.set(entry.path, entry)
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH.test(entry.sha256) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw problem('SNAPSHOT_INVALID')
      bytes += entry.size
    }
    if (entry.type === 'dir' && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw problem('SNAPSHOT_INVALID')
    if (entry.type === 'link' && !relativeName(entry.target, true)) throw problem('SNAPSHOT_INVALID')
  }
  if (bytes > MAX_BYTES) throw problem('SNAPSHOT_LIMIT')
  for (const entry of tree.entries) {
    const parent = path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path)
    if (known.get(parent)?.type !== 'dir') throw problem('SNAPSHOT_INVALID')
    if (entry.type === 'link') {
      if (known.get(entry.target)?.type !== 'dir') throw problem('SNAPSHOT_PATH')
      // A PNPM dependency graph can have legitimate cycles between physical
      // package directories. We never traverse links; reject only links back
      // into their own ancestor chain, plus all indirect link targets above.
      if (entry.target === '' || entry.path.startsWith(`${entry.target}/`)) throw problem('SNAPSHOT_PATH')
    }
  }
}

function validateFile(file) {
  if (!file || typeof file.present !== 'boolean') throw problem('SNAPSHOT_INVALID')
  if (file.present && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES || !HASH.test(file.sha256)
    || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) throw problem('SNAPSHOT_INVALID')
}
function validateState(state) {
  if (!state) throw problem('SNAPSHOT_INVALID')
  validateTree(state.profile); validateFile(state.record)
  if (state.profile.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0) + (state.record.size ?? 0) > MAX_BYTES) throw problem('SNAPSHOT_LIMIT')
}

async function scanTree(root, budget, progress, { aliases = [root], missingLink } = {}) {
  await plainAncestors(root, false)
  const rootStat = await maybeStat(root)
  if (!rootStat) return absentTree()
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw problem('SNAPSHOT_PATH')
  await plainAncestors(root)
  const entries = []
  async function walk(directory, prefix) {
    await plainAncestors(directory)
    const children = await fs.readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const child of children) {
      if (++budget.entries > MAX_ENTRIES) throw problem('SNAPSHOT_LIMIT')
      const name = prefix ? `${prefix}/${child.name}` : child.name
      if (!relativeName(name)) throw problem('SNAPSHOT_PATH')
      const filename = path.join(directory, child.name)
      const stat = await fs.lstat(filename)
      if (stat.isSymbolicLink()) {
        const target = path.resolve(directory, await fs.readlink(filename))
        const localTarget = await internalDirectoryTarget(root, target, aliases)
        const targetStat = await fs.lstat(localTarget)
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw problem('SNAPSHOT_PATH')
        entries.push({ path: name, type: 'link', target: path.relative(root, localTarget).split(path.sep).join('/') })
      } else if (stat.isDirectory()) {
        entries.push({ path: name, type: 'dir', mode: stat.mode & 0o777 })
        await walk(filename, name)
      } else if (stat.isFile()) {
        entries.push({ path: name, type: 'file', ...await regularFile(filename, budget) })
        progress?.(budget)
      } else throw problem('SNAPSHOT_PATH')
    }
  }
  await walk(root, '')
  if (missingLink && !entries.some(entry => entry.path === missingLink.path)) {
    await plainAncestors(path.join(root, ...missingLink.path.split('/')), false)
    await plainAncestors(path.join(root, ...missingLink.target.split('/')))
    entries.push(missingLink)
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const tree = { present: true, entries }
  validateTree(tree)
  return tree
}

async function scanState(profilePath, recordPath, progress) {
  const budget = { bytes: 0, files: 0, entries: 0 }
  const profile = await scanTree(profilePath, budget, progress)
  await plainAncestors(recordPath, false)
  const record = await maybeStat(recordPath) ? { present: true, ...await regularFile(recordPath, budget) } : absentFile()
  progress?.(budget)
  return { profile, record }
}

async function copyFile(source, target, expected) {
  await plainAncestors(target, false)
  const output = await fs.open(target, 'wx', 0o600)
  try {
    const actual = await regularFile(source, { bytes: 0, files: 0 }, async chunk => {
      let offset = 0
      while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten
    })
    if (digest(actual) !== digest({ size: expected.size, sha256: expected.sha256, mode: expected.mode })) throw problem('SNAPSHOT_CHANGED')
    await output.sync()
  } finally { await output.close() }
  await fs.chmod(target, expected.mode)
}

async function materialize(sourceProfile, sourceRecord, targetProfile, targetRecord, state, progress) {
  let files = 0, bytes = 0
  if (state.profile.present) {
    await plainAncestors(targetProfile, false)
    await fs.mkdir(targetProfile, { mode: 0o700 })
    const directories = state.profile.entries.filter(entry => entry.type === 'dir').sort((a, b) => a.path.split('/').length - b.path.split('/').length)
    for (const entry of directories) await fs.mkdir(path.join(targetProfile, ...entry.path.split('/')), { mode: 0o700 })
    for (const entry of state.profile.entries) {
      if (entry.type !== 'file') continue
      await copyFile(path.join(sourceProfile, ...entry.path.split('/')), path.join(targetProfile, ...entry.path.split('/')), entry)
      bytes += entry.size; files += 1; progress?.({ files, bytes })
    }
    for (const entry of state.profile.entries) {
      if (entry.type !== 'link') continue
      const filename = path.join(targetProfile, ...entry.path.split('/'))
      const target = path.join(targetProfile, ...entry.target.split('/'))
      // Junctions need an absolute OS target on Windows. The manifest retains
      // only a relative, validated target, so moving a stage requires relinking.
      await fs.symlink(process.platform === 'win32' ? target : path.relative(path.dirname(filename), target), filename, process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (process.platform !== 'win32') for (const entry of directories.reverse()) await fs.chmod(path.join(targetProfile, ...entry.path.split('/')), entry.mode)
  }
  if (state.record.present) {
    await copyFile(sourceRecord, targetRecord, state.record)
    progress?.({ files: files + 1, bytes: bytes + state.record.size })
  }
}

async function readJson(filename) {
  await plainAncestors(filename, false)
  const stat = await fs.lstat(filename)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON) throw problem('SNAPSHOT_INVALID')
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (statIdentity(await handle.stat()) !== statIdentity(stat)) throw problem('SNAPSHOT_CHANGED')
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}
async function atomicJson(filename, data) {
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized) > MAX_JSON) throw problem('SNAPSHOT_LIMIT')
  await plainAncestors(filename, false)
  const previous = await maybeStat(filename)
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw problem('SNAPSHOT_PATH')
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(serialized); await handle.sync() } finally { await handle.close() }
  await plainAncestors(filename, false)
  await fs.rename(temporary, filename)
}

/** Full local data backup before a downgrade. Caller must hold the backend/plugin pause.
 * Reuses the byte-verified copier, but never participates in plugin snapshot retention/restore.
 * Missing files, external links, mutation, disk/size limits fail closed. No source is modified.
 */
export async function createHarnessDataBackup({ userData, dshHome, fromVersion, toVersion, onProgress }) {
  parseSemver(fromVersion); parseSemver(toVersion)
  const source = await plainAncestors(absolute(dshHome))
  const client = await plainAncestors(absolute(userData))
  if (path.relative(source, homedir()) === '' || within(source, client) || within(client, source)) throw problem('SNAPSHOT_PATH')
  const store = path.join(client, 'harness-data-backups')
  const record = path.join(client, 'plugin-sources.json')
  const progress = phase => {
    let last = 0
    return ({ files = 0, bytes = 0 } = {}) => {
      if (Date.now() - last < 200) return
      last = Date.now()
      try { onProgress?.({ phase, files, bytes }) } catch { /* Presentation is optional. */ }
    }
  }
  await plainAncestors(store)
  await fs.mkdir(store, { recursive: true, mode: 0o700 })
  await plainAncestors(store)
  const target = path.join(store, randomUUID())
  await fs.mkdir(target, { mode: 0o700 })
  // An incomplete directory is retained for diagnosis; only manifest.json marks a verified backup.
  await atomicJson(path.join(target, 'request.json'), { fromVersion, toVersion, createdAt: new Date().toISOString() })
  const original = await scanState(source, record, progress('scan'))
  await materialize(source, record, path.join(target, 'dsh-home'), path.join(target, 'plugin-sources.json'), original, progress('copy'))
  const copied = await scanState(path.join(target, 'dsh-home'), path.join(target, 'plugin-sources.json'), progress('verify'))
  const unchanged = await scanState(source, record, progress('verify'))
  if (fingerprint(original) !== fingerprint(copied) || fingerprint(original) !== fingerprint(unchanged)) throw problem('SNAPSHOT_CHANGED')
  await atomicJson(path.join(target, 'manifest.json'), {
    schema: 1, kind: 'harness-downgrade-data', fromVersion, toVersion,
    createdAt: new Date().toISOString(), source, state: original, fingerprint: fingerprint(original),
  })
  return target
}

/** Private, bounded byte snapshots. Never invokes npm, a CLI, or the network. */
export class PluginSnapshots {
  constructor({ userData, dshHome, now = Date.now, onProgress, fault } = {}) {
    this.configuredUserData = absolute(userData)
    this.configuredDshHome = absolute(dshHome)
    this.bindPaths(this.configuredUserData, this.configuredDshHome)
    this.now = now
    this.onProgress = onProgress
    this.fault = fault
    this.busy = false
  }

  bindPaths(userData, dshHome) {
    this.userData = userData
    this.dshHome = dshHome
    this.profileParent = path.join(this.dshHome, 'profiles')
    this.profilePath = path.join(this.profileParent, 'web')
    this.recordPath = path.join(this.userData, 'plugin-sources.json')
    this.storePath = path.join(this.userData, 'plugin-snapshots')
    this.journalPath = path.join(this.storePath, 'restore-journal.json')
    this.linkJournalPath = path.join(this.storePath, 'restore-link-repair.json')
    if (within(this.profilePath, this.userData) || within(this.storePath, this.dshHome) || within(this.profilePath, this.storePath)) throw problem('SNAPSHOT_PATH')
  }

  async roots(create = false) {
    const userData = await plainAncestors(this.configuredUserData)
    const dshHome = await plainAncestors(this.configuredDshHome)
    if (this.pathsBound && (path.relative(userData, this.userData) !== '' || path.relative(dshHome, this.dshHome) !== '')) throw problem('SNAPSHOT_PATH')
    this.bindPaths(userData, dshHome)
    this.pathsBound = true
    await plainAncestors(this.profileParent)
    await plainAncestors(this.storePath)
    if (create) {
      await fs.mkdir(this.userData, { recursive: true, mode: 0o700 })
      await fs.mkdir(this.storePath, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      await plainAncestors(this.storePath)
    }
  }

  progress(phase) {
    let calls = 0, last = 0
    return ({ files = 0, bytes = 0 } = {}) => {
      const current = Date.now()
      if (calls && current - last < 250) return
      calls += 1; last = current
      const label = { scan: '读取插件快照', copy: '保存插件快照', verify: '校验插件快照', restore: '恢复插件快照' }[phase]
      try { this.onProgress?.({ phase, label, detail: `${files} 个文件 · ${Math.ceil(bytes / 1024)} KB`, files, bytes }) } catch { /* UI callbacks cannot compromise backup. */ }
    }
  }

  async exclusive(work) {
    if (this.busy) throw problem('SNAPSHOT_BUSY')
    this.busy = true
    try { return await work() } catch (error) {
      if (error.code?.startsWith('SNAPSHOT_')) throw error
      throw problem('SNAPSHOT_FAILED', Boolean(error.recoveryRequired))
    } finally { this.busy = false }
  }

  async journal() {
    await this.roots()
    if (!await maybeStat(this.journalPath)) return undefined
    const journal = await readJson(this.journalPath)
    validId(journal.id); validId(journal.snapshotId)
    if (journal.version !== VERSION || !['staging', 'swapping', 'completed', 'reverted'].includes(journal.phase)) throw problem('SNAPSHOT_RECOVERY', true)
    validateState(journal.current); validateState(journal.desired)
    if (await maybeStat(this.linkJournalPath)) {
      const links = await readJson(this.linkJournalPath)
      if (links.version !== VERSION || !UUID.test(links.id)) throw problem('SNAPSHOT_RECOVERY', true)
      if (links.id === journal.id) journal.linkRepair = links.repair
    }
    if (journal.linkRepair && (!['backup', 'desired', 'original', 'failed'].includes(journal.linkRepair.kind)
      || !relativeName(journal.linkRepair.path))) throw problem('SNAPSHOT_RECOVERY', true)
    return journal
  }

  async getRecoveryState() {
    try {
      const journal = await this.journal()
      return journal && !['completed', 'reverted'].includes(journal.phase)
        ? { recoveryRequired: true, reason: problem('SNAPSHOT_RECOVERY').message }
        : { recoveryRequired: false }
    } catch { return { recoveryRequired: true, reason: problem('SNAPSHOT_RECOVERY').message } }
  }

  async assertReady() {
    await this.roots(true)
    if ((await this.getRecoveryState()).recoveryRequired) throw problem('SNAPSHOT_RECOVERY', true)
  }

  snapshotPath(id) { return path.join(this.storePath, validId(id)) }
  metadata(manifest) {
    return Object.fromEntries(['id', 'createdAt', 'action', 'pluginName', 'status', 'bytes', 'files', 'runtimeVersion'].map(key => [key, manifest[key]]))
  }

  async manifest(id) {
    await this.roots()
    const directory = this.snapshotPath(id)
    await plainAncestors(directory)
    const manifest = await readJson(path.join(directory, 'manifest.json'))
    if (manifest.id !== id || manifest.version !== VERSION || !STATUSES.has(manifest.status)
      || !['install', 'update', 'remove', 'restore'].includes(manifest.action)
      || typeof manifest.pluginName !== 'string' || manifest.pluginName.length > 240 || /[\x00-\x1f\\]/u.test(manifest.pluginName)
      || typeof manifest.runtimeVersion !== 'string' || !/^[0-9A-Za-z.+_-]{1,100}$/u.test(manifest.runtimeVersion)
      || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
      || manifest.after !== null && !HASH.test(manifest.after)) throw problem('SNAPSHOT_INVALID')
    validateState(manifest.before)
    const bytes = manifest.before.profile.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0) + (manifest.before.record.size ?? 0)
    const files = manifest.before.profile.entries.filter(entry => entry.type === 'file').length + Number(manifest.before.record.present)
    if (manifest.bytes !== bytes || manifest.files !== files) throw problem('SNAPSHOT_INVALID')
    return manifest
  }

  async list() {
    try {
      await this.roots()
      if (!await maybeStat(this.storePath)) return []
      const entries = await fs.readdir(this.storePath, { withFileTypes: true })
      const recovery = await this.getRecoveryState()
      const results = []
      for (const entry of entries) {
        if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
        try { results.push({ ...this.metadata(await this.manifest(entry.name)), ...(recovery.recoveryRequired ? recovery : {}) }) } catch { /* Never expose unknown or corrupt private files. */ }
      }
      return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 5)
    } catch { return [] }
  }

  async create({ runtimeVersion, action, pluginName }) {
    return this.exclusive(async () => {
      await this.assertReady()
      if (!['install', 'update', 'remove', 'restore'].includes(action) || typeof pluginName !== 'string' || !pluginName || pluginName.length > 240
        || /[\x00-\x1f\\]/u.test(pluginName) || typeof runtimeVersion !== 'string' || !/^[0-9A-Za-z.+_-]{1,100}$/u.test(runtimeVersion)) throw problem('SNAPSHOT_INVALID')
      const before = await scanState(this.profilePath, this.recordPath, this.progress('scan'))
      const id = randomUUID(), directory = this.snapshotPath(id)
      await fs.mkdir(directory, { mode: 0o700 })
      const targetProfile = path.join(directory, 'web'), targetRecord = path.join(directory, 'plugin-sources.json')
      await materialize(this.profilePath, this.recordPath, targetProfile, targetRecord, before, this.progress('copy'))
      await this.fault?.('afterSnapshotCopy')
      if (fingerprint(before) !== fingerprint(await scanState(this.profilePath, this.recordPath, this.progress('verify')))
        || fingerprint(before) !== fingerprint(await scanState(targetProfile, targetRecord))) throw problem('SNAPSHOT_CHANGED')
      const manifest = { version: VERSION, id, createdAt: new Date(this.now()).toISOString(), action, pluginName, runtimeVersion,
        status: 'pending', before, after: null,
        bytes: before.profile.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0) + (before.record.size ?? 0),
        files: before.profile.entries.filter(entry => entry.type === 'file').length + Number(before.record.present) }
      await atomicJson(path.join(directory, 'manifest.json'), manifest)
      return this.metadata(manifest)
    })
  }

  async markAfter(id, { status }) {
    return this.exclusive(async () => {
      await this.assertReady()
      if (!STATUSES.has(status) || status === 'pending') throw problem('SNAPSHOT_INVALID')
      const manifest = await this.manifest(id)
      manifest.after = fingerprint(await scanState(this.profilePath, this.recordPath, this.progress('scan')))
      manifest.status = status
      await atomicJson(path.join(this.snapshotPath(id), 'manifest.json'), manifest)
      await this.prune()
      return this.metadata(manifest)
    })
  }

  async verify(manifest) {
    const directory = this.snapshotPath(manifest.id)
    const state = await scanState(path.join(directory, 'web'), path.join(directory, 'plugin-sources.json'), this.progress('verify'))
    if (fingerprint(state) !== fingerprint(manifest.before)) throw problem('SNAPSHOT_INVALID')
  }

  async inspect(id) {
    try {
      const manifest = await this.manifest(id)
      const metadata = this.metadata(manifest)
      const recovery = await this.getRecoveryState()
      if (recovery.recoveryRequired) return { ...metadata, canRestore: false, ...recovery }
      if (!manifest.after) return { ...metadata, canRestore: false, reason: '插件操作尚未记录结束状态。' }
      try {
        await this.verify(manifest)
        if (fingerprint(await scanState(this.profilePath, this.recordPath)) !== manifest.after) throw problem('SNAPSHOT_CHANGED')
        return { ...metadata, canRestore: true }
      } catch (error) { return { ...metadata, canRestore: false, reason: error.code === 'SNAPSHOT_CHANGED' ? problem('SNAPSHOT_CHANGED').message : problem('SNAPSHOT_INVALID').message } }
    } catch { return { canRestore: false, reason: problem('SNAPSHOT_INVALID').message } }
  }

  transactionPaths(id) {
    validId(id)
    return {
      stageProfile: path.join(this.profileParent, `.plugin-stage-${id}-web`),
      backupProfile: path.join(this.profileParent, `.plugin-recovery-${id}-web`),
      failedProfile: path.join(this.profileParent, `.plugin-reverted-${id}-web`),
      stageRecord: path.join(this.userData, `.plugin-stage-${id}-sources.json`),
      backupRecord: path.join(this.userData, `.plugin-recovery-${id}-sources.json`),
      failedRecord: path.join(this.userData, `.plugin-reverted-${id}-sources.json`),
    }
  }

  async move(source, destination) {
    await plainAncestors(source, false); await plainAncestors(destination, false)
    if (await maybeStat(destination)) throw problem('SNAPSHOT_RECOVERY', true)
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw problem('SNAPSHOT_PATH')
    await fs.rename(source, destination)
  }

  async relink(root, tree, aliases, journal, kind) {
    if (process.platform !== 'win32' || !tree.present) return
    // Absolute junction targets retain their previous root after directory
    // rename. Replace only manifest-declared links, never traverse them.
    await plainAncestors(root)
    const links = tree.entries.filter(item => item.type === 'link')
      .sort((a, b) => Number(b.path === journal.linkRepair?.path) - Number(a.path === journal.linkRepair?.path))
    // Prove every link before changing any; a journaled unlink can be repaired
    // after a crash, but an unrelated missing/replaced link is a conflict.
    for (const entry of links) {
      const filename = path.join(root, ...entry.path.split('/'))
      await plainAncestors(filename, false)
      const stat = await maybeStat(filename)
      if (!stat && journal.linkRepair?.kind === kind && journal.linkRepair.path === entry.path) continue
      if (!stat?.isSymbolicLink()) throw problem('SNAPSHOT_RECOVERY', true)
      const raw = path.resolve(path.dirname(filename), await fs.readlink(filename))
      if (path.relative(path.join(root, ...entry.target.split('/')), await internalDirectoryTarget(root, raw, aliases)) !== '') throw problem('SNAPSHOT_RECOVERY', true)
    }
    for (const entry of links) {
      const filename = path.join(root, ...entry.path.split('/'))
      journal.linkRepair = { kind, path: entry.path }
      await atomicJson(this.linkJournalPath, { version: VERSION, id: journal.id, repair: journal.linkRepair })
      if (await maybeStat(filename)) await fs.unlink(filename)
      await this.fault?.('afterLinkUnlink')
      await fs.symlink(path.join(root, ...entry.target.split('/')), filename, 'junction')
      journal.linkRepair = null
      await atomicJson(this.linkJournalPath, { version: VERSION, id: journal.id, repair: null })
    }
  }

  async restore(id) {
    return this.exclusive(async () => {
      await this.assertReady()
      const manifest = await this.manifest(id)
      if (!manifest.after) throw problem('SNAPSHOT_INVALID')
      await this.verify(manifest)
      const current = await scanState(this.profilePath, this.recordPath, this.progress('scan'))
      if (fingerprint(current) !== manifest.after) throw problem('SNAPSHOT_CHANGED')
      const journal = { version: VERSION, id: randomUUID(), snapshotId: id, phase: 'staging', current, desired: manifest.before, previousStatus: manifest.status }
      const p = this.transactionPaths(journal.id)
      await fs.mkdir(this.profileParent, { recursive: true, mode: 0o700 })
      await plainAncestors(this.profileParent)
      for (const filename of Object.values(p)) if (await maybeStat(filename)) throw problem('SNAPSHOT_PATH')
      await atomicJson(this.journalPath, journal)
      try {
        const directory = this.snapshotPath(id)
        await materialize(path.join(directory, 'web'), path.join(directory, 'plugin-sources.json'), p.stageProfile, p.stageRecord, manifest.before, this.progress('restore'))
        if (fingerprint(await scanState(p.stageProfile, p.stageRecord)) !== fingerprint(manifest.before)) throw problem('SNAPSHOT_INVALID')
        await this.fault?.('beforeProfileSwap')
        if (fingerprint(await scanState(this.profilePath, this.recordPath)) !== fingerprint(current)) throw problem('SNAPSHOT_CHANGED')
        journal.phase = 'swapping'; await atomicJson(this.journalPath, journal)
        if (current.profile.present) { await this.move(this.profilePath, p.backupProfile); await this.relink(p.backupProfile, current.profile, [this.profilePath, p.backupProfile], journal, 'backup') }
        await this.fault?.('afterProfileBackup')
        if (digest(await scanTree(p.backupProfile, { bytes: 0, files: 0, entries: 0 })) !== digest(current.profile)) throw problem('SNAPSHOT_CHANGED')
        if (manifest.before.profile.present) { await this.move(p.stageProfile, this.profilePath); await this.relink(this.profilePath, manifest.before.profile, [this.profilePath, p.stageProfile], journal, 'desired') }
        await this.fault?.('afterProfileSwap')
        const recordBeforeSwap = await maybeStat(this.recordPath)
          ? { present: true, ...await regularFile(this.recordPath, { bytes: 0, files: 0 }) } : absentFile()
        if (digest(recordBeforeSwap) !== digest(current.record)) throw problem('SNAPSHOT_CHANGED')
        if (current.record.present) await this.move(this.recordPath, p.backupRecord)
        await this.fault?.('afterRecordBackup')
        if (manifest.before.record.present) await this.move(p.stageRecord, this.recordPath)
        await this.fault?.('afterRecordSwap')
        if (fingerprint(await scanState(this.profilePath, this.recordPath)) !== fingerprint(manifest.before)) throw problem('SNAPSHOT_CHANGED')
        manifest.after = fingerprint(manifest.before); manifest.status = 'restored'
        await atomicJson(path.join(this.snapshotPath(id), 'manifest.json'), manifest)
        await this.fault?.('beforeCommit')
        journal.phase = 'completed'; await atomicJson(this.journalPath, journal)
        return { ...this.metadata(manifest), restored: true }
      } catch (error) {
        if (error.simulateCrash) throw problem('SNAPSHOT_RECOVERY', true)
        try { await this.recoverTransaction() } catch { throw problem('SNAPSHOT_RECOVERY', true) }
        throw problem(error.code === 'SNAPSHOT_CHANGED' ? 'SNAPSHOT_CHANGED' : 'SNAPSHOT_FAILED')
      }
    })
  }

  async recover() {
    return this.exclusive(async () => {
      try { return await this.recoverTransaction() } catch { throw problem('SNAPSHOT_RECOVERY', true) }
    })
  }

  async recoverTransaction() {
    const journal = await this.journal()
    if (!journal || ['completed', 'reverted'].includes(journal.phase)) return { recovered: true, recoveryRequired: false }
    const p = this.transactionPaths(journal.id)
    if (journal.phase === 'staging') {
      // Staging has not renamed either live component. External edits are
      // therefore preserved as-is, and the private stage is retained.
      if (await maybeStat(p.backupProfile) || await maybeStat(p.backupRecord)) throw problem('SNAPSHOT_RECOVERY', true)
      journal.phase = 'reverted'; await atomicJson(this.journalPath, journal)
      return { recovered: true, recoveryRequired: false }
    }
    // Recovery is conservative: prove both components before changing either.
    // A user edit to any live/retained file blocks repair and keeps all copies.
    const component = async (kind, live, backup, failed) => {
      const aliases = [this.profilePath, p.stageProfile, p.backupProfile, p.failedProfile]
      const missingLink = kind === 'profile' && journal.linkRepair
        ? (['desired', 'failed'].includes(journal.linkRepair.kind) ? journal.desired : journal.current).profile.entries.find(entry => entry.type === 'link' && entry.path === journal.linkRepair.path)
        : undefined
      const read = async filename => kind === 'profile'
        ? scanTree(filename, { bytes: 0, files: 0, entries: 0 }, undefined, { aliases,
          missingLink: filename === p.backupProfile && journal.linkRepair?.kind === 'backup'
            || filename === p.failedProfile && journal.linkRepair?.kind === 'failed'
            || filename === this.profilePath && ['desired', 'original'].includes(journal.linkRepair?.kind) ? missingLink : undefined })
        : (await maybeStat(filename) ? { present: true, ...await regularFile(filename, { bytes: 0, files: 0 }) } : absentFile())
      const original = journal.current[kind], desired = journal.desired[kind]
      const saved = await read(backup), actual = await read(live)
      const same = (a, b) => digest(a) === digest(b)
      if (saved.present) {
        const preserved = await read(failed)
        if (!same(saved, original) || actual.present && !same(actual, desired)
          || preserved.present && (actual.present || !same(preserved, desired))) throw problem('SNAPSHOT_RECOVERY', true)
        return async () => {
          if (!same(await read(live), actual) || !same(await read(backup), original)) throw problem('SNAPSHOT_RECOVERY', true)
          if (kind === 'profile') {
            await this.relink(backup, original, aliases, journal, 'backup')
            if (actual.present) await this.relink(live, desired, aliases, journal, 'desired')
          }
          if (actual.present) await this.move(live, failed)
          if (kind === 'profile' && (actual.present || preserved.present)) await this.relink(failed, desired, aliases, journal, 'failed')
          await this.fault?.(kind === 'profile' ? 'afterRecoveryProfilePreserve' : 'afterRecoveryRecordPreserve')
          await this.move(backup, live)
          await this.fault?.(kind === 'profile' ? 'afterRecoveryProfileReturn' : 'afterRecoveryRecordReturn')
          if (kind === 'profile') await this.relink(live, original, aliases, journal, 'original')
        }
      }
      if (same(actual, original)) return async () => {
        if (kind === 'profile' && journal.linkRepair?.kind === 'failed') {
          if (!same(await read(failed), desired)) throw problem('SNAPSHOT_RECOVERY', true)
          await this.relink(failed, desired, aliases, journal, 'failed')
        }
        if (kind === 'profile' && original.present) await this.relink(live, original, aliases, journal, 'original')
      }
      if (!original.present && same(actual, desired) && !await maybeStat(failed)) return async () => {
        if (!same(await read(live), actual)) throw problem('SNAPSHOT_RECOVERY', true)
        if (actual.present) await this.move(live, failed)
        if (kind === 'profile' && actual.present) await this.relink(failed, desired, aliases, journal, 'failed')
      }
      throw problem('SNAPSHOT_RECOVERY', true)
    }
    const profile = await component('profile', this.profilePath, p.backupProfile, p.failedProfile)
    const record = await component('record', this.recordPath, p.backupRecord, p.failedRecord)
    await profile(); await record()
    if (fingerprint(await scanState(this.profilePath, this.recordPath)) !== fingerprint(journal.current)) throw problem('SNAPSHOT_RECOVERY', true)
    const manifest = await this.manifest(journal.snapshotId)
    manifest.after = fingerprint(journal.current)
    manifest.status = STATUSES.has(journal.previousStatus) ? journal.previousStatus : 'failed'
    await atomicJson(path.join(this.snapshotPath(journal.snapshotId), 'manifest.json'), manifest)
    journal.phase = 'reverted'; await atomicJson(this.journalPath, journal)
    return { recovered: true, recoveryRequired: false }
  }

  async remove(id) {
    return this.exclusive(async () => { await this.assertReady(); return { removed: await this.removeOwned(id) } })
  }

  async removeOwned(id) {
    const manifest = await this.manifest(id)
    if (manifest.status === 'pending') throw problem('SNAPSHOT_INVALID')
    const journal = await this.journal()
    if (journal?.snapshotId === id && !['completed', 'reverted'].includes(journal.phase)) return false
    await this.verify(manifest)
    const directory = this.snapshotPath(id)
    // Verify the entire directory before recursive removal; unknown extras or
    // links are retained for inspection, and fs.rm is never given a junction.
    const children = await fs.readdir(directory)
    if (children.some(name => !['manifest.json', 'web', 'plugin-sources.json'].includes(name))) return false
    await plainAncestors(directory)
    await fs.rm(directory, { recursive: true })
    return true
  }

  async prune() {
    const entries = await fs.readdir(this.storePath, { withFileTypes: true })
    const completed = []
    for (const entry of entries) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
      try { const manifest = await this.manifest(entry.name); if (manifest.status !== 'pending') completed.push(manifest) } catch { /* Unknown snapshots are never removed. */ }
    }
    completed.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    for (const manifest of completed.slice(5)) { try { await this.removeOwned(manifest.id) } catch { /* Keep unverifiable snapshots. */ } }
  }
}
