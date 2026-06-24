#!/usr/bin/env node
/**
 * 패키징된(win-unpacked) 실제 앱을 띄워 asar→app:// 자산 서빙이 동작하는지 검증한다.
 * 파일은 argv(파일연결 경로)로 전달한다(패키지 모드는 SSGKIMCHI_OPEN_ON_START 미사용).
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'

const root = process.cwd()
const exe = join(root, 'release', 'win-unpacked', '싹싹김치 한글뷰어.exe')

const cases = [
  ['sample.pdf', '.pdf-page__canvas'],
  ['biz_plan.hwp', '.hwp-page svg'],
  ['sample.xlsx', '.xlsx-host table'],
  ['sample.pptx', '.pptx-host > *']
]

let failed = 0
for (const [file, selector] of cases) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.SSGKIMCHI_SKIP_EXIT_CONFIRM = '1' // 종료 확인 팝업 끔 (app.close 가 즉시 닫히도록)
  const app = await electron.launch({
    executablePath: exe,
    args: [join(root, 'tests', 'fixtures', file)],
    env
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector(selector, { timeout: 45000 })
    console.log(`OK   ${file} → ${selector}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${file} → ${selector}: ${err?.message ?? err}`)
  } finally {
    await app.close()
  }
}

console.log(failed === 0 ? 'PACKAGED VERIFY: ALL OK' : `PACKAGED VERIFY: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
