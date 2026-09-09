import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const assets = join(import.meta.dirname, '..', 'assets')
const svg = readFileSync(join(assets, 'icon.svg'), 'utf8')
writeFileSync(join(assets, 'icon.png'), new Resvg(svg).render().asPng())
process.stdout.write('Rendered the original placeholder SVG to assets/icon.png.\n')
