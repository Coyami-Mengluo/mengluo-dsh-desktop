import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

it('prepares the real launcher toolchain before either source main smoke on a clean CI checkout', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/windows.yml'), 'utf8')
  const commands = [...workflow.matchAll(/^      - run: (.+)$/gmu)].map(match => match[1].trim())
  const prepareNode = commands.indexOf('npm run stage:node')
  const prepareNpm = commands.indexOf('npm run stage:npm')
  const normalSmoke = commands.indexOf('npm run smoke:main')
  const recoverySmoke = commands.indexOf('node scripts/smoke-main.mjs --snapshot-recovery')
  assert.ok(prepareNode >= 0 && prepareNpm > prepareNode)
  assert.ok(normalSmoke > prepareNpm && recoverySmoke > prepareNpm)
  assert.ok(commands.includes('npm test') && commands.includes('npm run check:release'))
  assert.ok(!commands.some(command => /publish|dist:win|upload/iu.test(command)), 'Automatic source checks must not publish or package releases')
})
