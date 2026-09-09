import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listSourceFiles } from './source-files.mjs'
import { removeTreeWithoutFollowingLinks } from '../src/safe-remove.mjs'
import './check-release.mjs'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
assert.match(version, /^\d+\.\d+\.\d+$/u)
mkdirSync(join(root, 'dist'), { recursive: true })
mkdirSync(join(root, 'build'), { recursive: true })
const temporary = mkdtempSync(join(root, 'build', 'source-export-'))
const output = join(root, 'dist', `MengLuo-DSH-Desktop-${version}-source.zip`)
try {
  const files = listSourceFiles(root)
  const manifestPath = join(temporary, 'files.json')
  writeFileSync(manifestPath, JSON.stringify(files))
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$files=Get-Content -Raw -LiteralPath $env:DSH_SOURCE_LIST | ConvertFrom-Json',
    '$stream=[System.IO.File]::Open($env:DSH_SOURCE_ZIP,[System.IO.FileMode]::CreateNew)',
    '$zip=New-Object System.IO.Compression.ZipArchive($stream,[System.IO.Compression.ZipArchiveMode]::Create)',
    'try { foreach ($file in $files) { $inputPath=Join-Path $env:DSH_SOURCE_ROOT $file; [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$inputPath,("mengluo-dsh-desktop/"+$file),[System.IO.Compression.CompressionLevel]::Optimal) } } finally { $zip.Dispose(); $stream.Dispose() }',
    '$check=[System.IO.Compression.ZipFile]::OpenRead($env:DSH_SOURCE_ZIP)',
    'try { if ($check.Entries.Count -ne $files.Count) { throw "Source archive entry count mismatch" } } finally { $check.Dispose() }',
  ].join('; ')], {
    env: { ...process.env, DSH_SOURCE_ROOT: root, DSH_SOURCE_LIST: manifestPath, DSH_SOURCE_ZIP: output },
    windowsHide: true, encoding: 'utf8', timeout: 60_000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  const hash = createHash('sha256').update(readFileSync(output)).digest('hex')
  writeFileSync(`${output}.sha256`, `${hash}  MengLuo-DSH-Desktop-${version}-source.zip\n`)
  process.stdout.write(`Exported ${files.length} source files; no dependencies, build output, Git history or user data: ${output}\n`)
} finally { removeTreeWithoutFollowingLinks(temporary) }
