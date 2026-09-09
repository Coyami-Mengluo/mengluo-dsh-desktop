import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createBackendEnvironment } from '../src/runtime.mjs'
import { SHELL_RELEASE_SOURCE, PRODUCT_NAME } from '../src/release-config.mjs'
import { validateShellRelease } from '../src/shell-updater.mjs'

// This deliberately installs software and writes HKCU on a disposable runner.
// Never run it as part of npm test or on a contributor's workstation.
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only run in GitHub Actions')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted VM is required')
const from = process.env.DSH_E2E_FROM
const to = process.env.DSH_E2E_TO
for (const version of [from, to]) assert.match(version ?? '', /^\d+\.\d+\.\d+$/u)
assert.notEqual(from, to)
const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(process.env.RUNNER_TEMP, 'mengluo-release-update-'))
const installRoot = join(temporary, PRODUCT_NAME)
const executable = join(installRoot, `${PRODUCT_NAME}.exe`)
const output = join(root, 'build', 'github-update-smoke')
mkdirSync(output, { recursive: true })
const require = createRequire(import.meta.url)
const buildRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const asar = buildRequire('@electron/asar')
const yaml = buildRequire('js-yaml')
const owner = SHELL_RELEASE_SOURCE.owner
const repo = SHELL_RELEASE_SOURCE.repo
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const childEnv = createBackendEnvironment(process.env)
for (const key of Object.keys(childEnv)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY/iu.test(key)) delete childEnv[key]
}
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const reportPath = join(temporary, 'update-report.json')

async function release(version) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/v${version}`, {
    redirect: 'error', signal: AbortSignal.timeout(60_000), headers: {
      'User-Agent': 'MengLuo-Release-Update-Smoke', Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })
  assert.equal(response.status, 200, `Release v${version} unavailable`)
  const result = await response.json()
  assert.equal(result.draft, false)
  assert.equal(result.prerelease, false)
  return result
}

async function asset(release, name) {
  const entry = release.assets.find(item => item.name === name)
  assert.ok(entry, `Missing release asset: ${name}`)
  assert.ok(entry.size > 0 && entry.size < 1024 * 1024 * 1024)
  const url = new URL(entry.browser_download_url)
  assert.equal(url.origin, 'https://github.com')
  assert.ok(url.pathname.toLowerCase().startsWith(`/${owner}/${repo}/releases/download/`.toLowerCase()))
  // No API credential is forwarded to public artifact downloads or redirects.
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, entry.size)
  assert.equal(`sha256:${hash(bytes)}`, entry.digest)
  return bytes
}

function run(command, args, timeout = 120_000, env = childEnv) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout, env })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed: ${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function installedVersion() {
  try {
    const archive = join(installRoot, 'resources', 'app.asar')
    // The installer replaces this path in place; do not reuse the old ASAR header.
    asar.uncache(archive)
    return JSON.parse(asar.extractFile(archive, 'package.json').toString()).version
  }
  catch { return undefined }
}

function runningProcesses(stop = false) {
  assert.ok(executable.startsWith(`${temporary}\\`), 'Only operate on the isolated installed executable')
  const script = "$items=@(Get-CimInstance Win32_Process -Filter \"Name = 'MengLuo DSH Desktop.exe'\" | Where-Object { $_.ExecutablePath -eq $env:DSH_E2E_EXECUTABLE -and $_.CommandLine -notmatch ' --type=' }); "
    + (stop ? 'foreach ($item in $items) { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $item.ProcessId /T /F | Out-Null }' : 'ConvertTo-Json -Compress -InputObject @($items | Select-Object ProcessId,ExecutablePath,CommandLine)')
  const text = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 30_000, { ...childEnv, DSH_E2E_EXECUTABLE: executable })
  return stop ? [] : JSON.parse(text)
}

const preserved = []
const marker = (path, label) => {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = Buffer.from(`isolated update preservation fixture: ${label}\n`)
  writeFileSync(path, bytes, { flag: 'wx' })
  preserved.push({ path, label, sha256: hash(bytes) })
}

try {
  const [oldRelease, newRelease] = await Promise.all([release(from), release(to)])
  const oldInfo = yaml.load((await asset(oldRelease, 'latest.yml')).toString())
  const newInfo = yaml.load((await asset(newRelease, 'latest.yml')).toString())
  assert.equal(validateShellRelease(oldInfo).version, from)
  assert.equal(validateShellRelease(newInfo).version, to)
  const installerBytes = await asset(oldRelease, `MengLuo-DSH-Desktop-${from}-setup.exe`)
  assert.equal(hash(installerBytes, 'sha512', 'base64'), oldInfo.files[0].sha512)
  const installer = join(temporary, `baseline-${from}.exe`)
  writeFileSync(installer, installerBytes)
  console.log(`Installing verified release ${from} on disposable Windows runner`)
  run(installer, ['/S', '/currentuser', `/D=${installRoot}`])
  assert.equal(installedVersion(), from)
  runningProcesses(true)
  const cache = join(process.env.LOCALAPPDATA, 'mengluo-dsh-desktop-updater', 'installer.exe')
  assert.equal(hash(readFileSync(cache)), hash(installerBytes), 'The normal installer must populate its differential cache')
  const profile = join(process.env.APPDATA, PRODUCT_NAME)
  marker(join(profile, 'harness-runtimes', 'preservation-fixture', 'keep.txt'), 'Harness runtime data')
  marker(join(process.env.USERPROFILE, '.dsh', 'profiles', 'web', 'preservation-fixture.txt'), 'Harness plugin profile')
  marker(join(process.env.USERPROFILE, '.dsh', 'preservation-conversation.json'), 'Conversation fixture')
  marker(join(process.env.USERPROFILE, 'Documents', `${PRODUCT_NAME} Workspace`, 'preservation-workspace.txt'), 'Workspace fixture')
  writeFileSync(join(profile, 'client-updates.json'), JSON.stringify({ autoCheck: false, lastCheckedAt: 0, lastNotifiedVersion: '' }))
  writeFileSync(join(temporary, 'expected-update.json'), JSON.stringify({ from, to, info: newInfo, installRoot, profile: realpathSync.native(profile) }))
  console.log(`Launching ${from} packaged main entry and its real menu/updater`)
  const trace = run(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    join(root, 'tests', 'fixtures', 'github-update-smoke.mjs'), temporary,
  ], 8 * 60_000)
  console.log(trace.trim())
  const result = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(result.downloadVerified, true)
  assert.equal(result.shutdownPreparedBeforeInstaller, true)
  assert.equal(result.windowsClosedOnQuit, true)
  assert.equal(result.requestedInstall, true)
  assert.ok(result.transferred > 0 && result.transferred < newInfo.files[0].size, 'This fixture requires a real differential transfer')
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (installedVersion() === to && runningProcesses().length > 0) break
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  assert.equal(installedVersion(), to, 'Installer did not replace the installed application')
  let processes = runningProcesses()
  assert.ok(processes.length > 0, 'Updated application did not restart')
  await new Promise(resolve => setTimeout(resolve, 4_000))
  processes = runningProcesses()
  assert.ok(processes.length > 0, 'Restarted application exited during the stability check')
  assert.ok(processes.some(item => item.CommandLine.includes('--updated')), 'Restart must come from the update installer')
  for (const item of preserved) assert.equal(hash(readFileSync(item.path)), item.sha256, `${item.label} changed`)
  const final = { ...result, installedVersion: to, restarted: true, preservedFixtures: preserved.map(item => item.label), passed: true }
  writeFileSync(join(output, 'result.json'), JSON.stringify(final, null, 2) + '\n')
  console.log(JSON.stringify(final, null, 2))
} finally {
  if (existsSync(reportPath)) copyFileSync(reportPath, join(output, 'updater-trace.json'))
  const screenshot = join(temporary, 'update-downloaded.png')
  if (existsSync(screenshot)) copyFileSync(screenshot, join(output, 'update-downloaded.png'))
  // The runner is disposable; only stop this test's exact application process.
  if (existsSync(executable)) runningProcesses(true)
}
