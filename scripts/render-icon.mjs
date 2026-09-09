import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ICON_SOURCE, verifyIconSource } from './icon-source.mjs'

const root = join(import.meta.dirname, '..')
const assets = join(root, 'assets')
if (process.argv.includes('--placeholder')) {
  const svg = readFileSync(join(assets, 'icon.svg'), 'utf8')
  writeFileSync(join(assets, 'icon.png'), new Resvg(svg).render().asPng())
  process.stdout.write('Rendered the optional MIT placeholder SVG to assets/icon.png.\n')
} else {
  const png = readFileSync(join(root, ICON_SOURCE))
  verifyIconSource(png)
  writeFileSync(join(assets, 'icon.png'), png)
  process.stdout.write('Prepared the reviewed transparent artwork as assets/icon.png.\n')
}
