#!/usr/bin/env node
/**
 * 패키지 앱(win-unpacked)에 다양한 실제/복잡 문서를 넣어 견고성을 본다.
 * 각 파일 결과: RENDERED(실제 내용) / ERROR(graceful 오류 UI) / STUCK(둘 다 없음 = 블랭크·멈춤 = 불합격)
 * argv(파일연결) 경로로 연다(패키지 모드는 SSGKIMCHI_OPEN_ON_START 미사용).
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const exe = join(root, 'release', 'win-unpacked', '싹싹김치 한글뷰어.exe')
const dir = process.argv[2] ? join(root, process.argv[2]) : join(root, 'tests', 'fixtures', 'stress')
const TIMEOUT = 45000

function selectorsFor(ext) {
  switch (ext) {
    case '.pdf':
      return ['.pdf-page__canvas', '.pdf-status--error']
    case '.hwp':
    case '.hwpx':
      return ['.hwp-page svg', '.hwp-status--error']
    case '.docx':
      return ['.docx-host .docx-wrapper', '.docx-status--error']
    case '.xlsx':
      return ['.xlsx-host table', '.xlsx-status--error']
    case '.pptx':
      return ['.pptx-host > *', '.pptx-overlay--error']
    default:
      return [null, null]
  }
}

const files = readdirSync(dir).filter((f) => /\.(pdf|hwp|hwpx|docx|xlsx|pptx)$/i.test(f))
let rendered = 0
let errored = 0
let stuck = 0

for (const file of files) {
  const ext = `.${file.split('.').pop().toLowerCase()}`
  const [content, error] = selectorsFor(ext)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.SSGKIMCHI_SKIP_EXIT_CONFIRM = '1' // 종료 확인 팝업 끔 (app.close 가 즉시 닫히도록)
  const userData = mkdtempSync(join(tmpdir(), 'ssgkimchi-stress-'))
  const app = await electron.launch({
    executablePath: exe,
    args: [join(dir, file), `--user-data-dir=${userData}`],
    env
  })
  let outcome = 'STUCK'
  try {
    const win = await app.firstWindow()
    const r = await Promise.race([
      win
        .waitForSelector(content, { timeout: TIMEOUT })
        .then(() => 'RENDERED')
        .catch(() => null),
      win
        .waitForSelector(error, { timeout: TIMEOUT })
        .then(() => 'ERROR')
        .catch(() => null)
    ])
    if (r) outcome = r
  } catch {
    /* STUCK */
  } finally {
    await app.close()
  }

  if (outcome === 'RENDERED') rendered++
  else if (outcome === 'ERROR') errored++
  else stuck++
  console.log(`${outcome.padEnd(9)} ${file}`)
}

console.log(`\n총 ${files.length}개  RENDERED=${rendered}  ERROR=${errored}  STUCK=${stuck}`)
console.log(stuck === 0 ? 'STRESS OK (멈춤·블랭크 없음)' : `STRESS FAIL: ${stuck}개 STUCK`)
process.exit(stuck === 0 ? 0 : 1)
