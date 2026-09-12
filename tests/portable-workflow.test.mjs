import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('portable CI prepares generated artwork and only runs source checks on Linux/macOS', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/portable-tests.yml'), 'utf8')
  const commands = [...workflow.matchAll(/^      - run: (.+)$/gmu)].map(match => match[1].trim())
  assert.deepEqual(commands, ['npm ci --ignore-scripts', 'npm run prepare:icon', 'npm test', 'npm run check:release'])
  assert.match(workflow, /os: \[ubuntu-24\.04, macos-15\]/u)
  assert.match(workflow, /contents: read/u)
  assert.doesNotMatch(workflow, /contents: write|dist:win|upload-artifact|gh release|workflow_dispatch/u)
})
