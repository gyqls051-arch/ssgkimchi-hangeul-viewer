#!/usr/bin/env node
/** 브랜드 아이콘 생성: SVG(폰트 불필요 기하학) → 다중 해상도 resources/icon.ico + icon.png */
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f8cf7"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="56" fill="url(#bg)"/>
  <path d="M76 52 h74 l30 30 v118 a8 8 0 0 1 -8 8 H76 a8 8 0 0 1 -8 -8 V60 a8 8 0 0 1 8 -8 z" fill="#ffffff"/>
  <path d="M150 52 l30 30 h-22 a8 8 0 0 1 -8 -8 z" fill="#cbd9f5"/>
  <rect x="90" y="104" width="76" height="10" rx="5" fill="#9db8ea"/>
  <rect x="90" y="126" width="76" height="10" rx="5" fill="#c3d3f2"/>
  <rect x="90" y="148" width="56" height="10" rx="5" fill="#c3d3f2"/>
  <rect x="90" y="172" width="24" height="24" rx="6" fill="#2563eb"/>
</svg>`

const sizes = [256, 128, 64, 48, 32, 16]
const pngs = sizes.map((s) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: s } }).render().asPng()
)

const dir = join(process.cwd(), 'resources')
await mkdir(dir, { recursive: true })
const ico = await pngToIco(pngs)
await writeFile(join(dir, 'icon.ico'), ico)
await writeFile(join(dir, 'icon.png'), pngs[0])
console.log('[icon] wrote resources/icon.ico + icon.png')
