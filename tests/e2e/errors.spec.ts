import { test, expect } from '@playwright/test'
import { fixture, launchWith } from './helpers'

// 유효 매직 + 손상 본문 → 해당 뷰어로 라우팅되지만 graceful 오류 UI 가 떠야 한다(크래시 X)
const cases: Array<[string, string]> = [
  ['corrupt/corrupt.pdf', '.pdf-status--error'],
  ['corrupt/corrupt.hwp', '.hwp-status--error'],
  ['corrupt/corrupt.docx', '.docx-status--error'],
  ['corrupt/corrupt.xlsx', '.xlsx-status--error'],
  ['corrupt/corrupt.pptx', '.pptx-overlay--error']
]

test.describe('손상 파일 → graceful 오류 (크래시·블랭크 없음)', () => {
  for (const [file, selector] of cases) {
    test(`${file} → ${selector}`, async () => {
      const app = await launchWith(fixture(file))
      try {
        const win = await app.firstWindow()
        await win.waitForSelector(selector)
        // 창이 살아있는지(크래시 아님) 확인
        expect(await win.title()).toContain('싹싹김치')
      } finally {
        await app.close()
      }
    })
  }
})
