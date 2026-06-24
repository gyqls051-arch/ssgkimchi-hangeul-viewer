import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const mainEntry = join(root, 'out', 'main', 'index.js')

async function check(file, fn, label) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.SSGKIMCHI_OPEN_ON_START = join(root, 'tests', 'fixtures', file)
  const ud = mkdtempSync(join(tmpdir(), 'ssgkimchi-ts-'))
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${ud}`], env })
  const win = await app.firstWindow()
  try {
    // 렌더 대기
    await new Promise((r) => setTimeout(r, 4000))
    const n = await win.evaluate(fn)
    console.log(`${label}: ${n}`)
  } catch (e) {
    console.log(`${label}: ERR ${String(e).slice(0, 70)}`)
  } finally {
    await app.close()
  }
}

await check(
  'sample.pdf',
  () => {
    const span = document.querySelector('.textLayer span')
    const fs = span ? getComputedStyle(span).fontSize : 'none'
    const eoc = document.querySelectorAll('.textLayer .endOfContent').length
    return `spans=${document.querySelectorAll('.textLayer span').length} fontSize=${fs} endOfContent=${eoc}`
  },
  'PDF 텍스트레이어(fontSize>0px=정렬정상)'
)
await check(
  'biz_plan.hwp',
  () => document.querySelectorAll('.hwp-page svg text, .hwp-page svg tspan').length,
  'HWP svg <text>/<tspan> 개수(>0=선택가능)'
)
await check(
  'sample.xlsx',
  () =>
    `colhead=${document.querySelectorAll('.xlsx-colhead').length} rowhead=${document.querySelectorAll('.xlsx-rowhead').length}`,
  '엑셀 그리드(열문자/행번호 개수)'
)
