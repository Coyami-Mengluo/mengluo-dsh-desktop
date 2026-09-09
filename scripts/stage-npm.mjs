import { EXPECTED_NPM_VERSION, stageNpmTooling } from './staging-npm.mjs'
import { ensureBuildTools } from './prepare-tools.mjs'

const staged = stageNpmTooling({ programFiles: await ensureBuildTools() })
process.stdout.write(`staged npm ${EXPECTED_NPM_VERSION}: ${staged.root}\n`)
process.stdout.write(`staged npm tree SHA-256: ${staged.tree.sha256}\n`)
