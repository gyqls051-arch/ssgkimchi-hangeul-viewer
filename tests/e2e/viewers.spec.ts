import { test, expect } from '@playwright/test'
import { fixture, launchWith } from './helpers'

test.describe('포맷별 렌더링 (prod app:// 경로)', () => {
  test('PDF → 페이지 캔버스가 렌더된다', async () => {
    const app = await launchWith(fixture('sample.pdf'))
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.pdf-page__canvas')
      expect(await win.locator('.pdf-page__canvas').count()).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('HWP → SVG 페이지가 내용과 함께 렌더된다', async () => {
    const app = await launchWith(fixture('biz_plan.hwp'))
    try {
      const win = await app.firstWindow()
      // svg 가 mount 만 된 게 아니라 실제 자식 노드를 가졌는지까지 확인
      await win.waitForFunction(() => {
        const s = document.querySelector('.hwp-page svg')
        return !!s && s.childNodes.length > 0
      })
    } finally {
      await app.close()
    }
  })

  test('HWPX → SVG 페이지가 내용과 함께 렌더된다', async () => {
    const app = await launchWith(fixture('sample.hwpx'))
    try {
      const win = await app.firstWindow()
      await win.waitForFunction(() => {
        const s = document.querySelector('.hwp-page svg')
        return !!s && s.childNodes.length > 0
      })
    } finally {
      await app.close()
    }
  })

  test('DOCX → 문서 래퍼에 내용이 렌더된다', async () => {
    const app = await launchWith(fixture('sample.docx'))
    try {
      const win = await app.firstWindow()
      await win.waitForFunction(() => {
        const w = document.querySelector('.docx-host .docx-wrapper')
        return !!w && w.children.length > 0
      })
    } finally {
      await app.close()
    }
  })

  test('XLSX → 시트 테이블이 렌더된다', async () => {
    const app = await launchWith(fixture('sample.xlsx'))
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.xlsx-host table')
      expect(await win.locator('.xlsx-host table tr').count()).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('PPTX → 슬라이드가 렌더된다', async () => {
    const app = await launchWith(fixture('sample.pptx'))
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.pptx-host')
      await win.waitForFunction(
        () => document.querySelectorAll('.pptx-host > *').length > 0
      )
    } finally {
      await app.close()
    }
  })
})
