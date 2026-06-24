import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const mainEntry = join(root, 'out', 'main', 'index.js')
const fixture = process.argv[2] || 'tests/fixtures/biz_plan.hwp'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.SSGKIMCHI_OPEN_ON_START = join(root, fixture)
const ud = mkdtempSync(join(tmpdir(), 'ssgkimchi-sel-'))
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${ud}`], env })
const win = await app.firstWindow()
try {
  await new Promise((r) => setTimeout(r, 4500))
  const layout = await win.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.hwp-textlayer span'))
    const scroll = document.querySelector('.hwp-scroll')
    if (!spans.length || !scroll) return null
    const f = spans[0].getBoundingClientRect()
    const sr = scroll.getBoundingClientRect()
    return {
      startX: Math.round(f.left + 4),
      startY: Math.round(f.top + f.height / 2),
      dragX: Math.round(f.left + 120),
      bottom: Math.round(sr.bottom - 12),
      spanCount: spans.length
    }
  })
  if (!layout) throw new Error('no overlay spans')
  console.log(`스팬 ${layout.spanCount}개, 세로 드래그 측정(12px 스텝)`)
  await win.mouse.move(layout.startX, layout.startY)
  await win.mouse.down()
  const lens = []
  for (let y = layout.startY; y < layout.bottom; y += 12) {
    await win.mouse.move(layout.dragX, y, { steps: 1 })
    // eslint-disable-next-line no-await-in-loop
    const len = await win.evaluate(() => window.getSelection().toString().length)
    lens.push(len)
  }
  await win.mouse.up()
  const deltas = lens.map((v, i) => (i ? v - lens[i - 1] : v))
  const maxJump = Math.max(...deltas)
  const bigJumps = deltas.filter((d) => d > 40).length
  console.log(`선택길이 추이: ${lens.join(',')}`)
  console.log(`스텝별 증가: ${deltas.join(',')}`)
  console.log(`최대 단일점프=${maxJump}자, 큰점프(>40자) 횟수=${bigJumps}  ${maxJump <= 40 ? 'SMOOTH' : 'JUMPY'}`)
} catch (e) {
  console.log('ERR', String(e).slice(0, 120))
} finally {
  await app.close()
}
