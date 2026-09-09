import { EXPECTED_NODE_VERSION, stageNodeRuntime } from './staging-node.mjs'
import { ensureBuildTools } from './prepare-tools.mjs'

const staged = await stageNodeRuntime({ programFiles: await ensureBuildTools() })
process.stdout.write(`staged Node ${EXPECTED_NODE_VERSION}: ${staged.targetExecutable}\n`)
process.stdout.write(`staged Node license from: ${staged.licenseSource}\n`)
