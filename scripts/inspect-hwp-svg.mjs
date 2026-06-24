import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const mainEntry = join(root, 'out', 'main', 'index.js')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.SSGKIMCHI_OPEN_ON_START = process.argv[2]
  ? join(root, process.argv[2])
  : join(root, 'tests', 'fixtures', 'biz_plan.hwp')
const ud = mkdtempSync(join(tmpdir(), 'ssgkimchi-hwp-'))
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${ud}`], env })
const win = await app.firstWindow()
try {
  await new Promise((r) => setTimeout(r, 4000))
  const info = await win.evaluate(() => {
    const overlaySpans = Array.from(document.querySelectorAll('.hwp-textlayer span'))
    const overlay = {
      count: overlaySpans.length,
      first: overlaySpans.slice(0, 8).map((s) => (s.textContent || '').slice(0, 24))
    }
    const svg = document.querySelector('.hwp-page svg')
    if (!svg) return { overlay, error: 'no svg' }
    const texts = Array.from(svg.querySelectorAll('text'))
    // 각 text 의 화면상 y (getBoundingClientRect) 와 DOM 순서 비교
    const rows = texts.slice(0, 40).map((t, i) => {
      const r = t.getBoundingClientRect()
      return { i, y: Math.round(r.top), x: Math.round(r.left), txt: (t.textContent || '').slice(0, 12) }
    })
    // DOM 순서대로 y 가 단조 증가(읽는 순서)인지 위반 횟수
    let inversions = 0
    for (let k = 1; k < rows.length; k++) if (rows[k].y < rows[k - 1].y - 3) inversions++
    // 부모 구조 샘플
    const sampleParent = texts[0]?.parentElement
    const parentChain = []
    let p = sampleParent
    for (let d = 0; d < 4 && p; d++) {
      parentChain.push(`${p.tagName}${p.getAttribute('transform') ? '[transform]' : ''}`)
      p = p.parentElement
    }
    return { overlay, count: texts.length, inversions, parentChain }
  })
  console.log(JSON.stringify(info, null, 1))
} catch (e) {
  console.log('ERR', String(e).slice(0, 100))
} finally {
  await app.close()
}
