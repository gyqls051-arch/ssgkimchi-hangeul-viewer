import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fixture, launchBlank } from './helpers'

/** 렌더러 컨텍스트에서 합성 DragEvent 를 디스패치하는 스크립트 인자 */
interface DragArgs {
  type: 'dragover' | 'drop'
  names: string[]
  b64: string
}

/** window 에 합성 drag 이벤트 디스패치 (합성 File 은 OS 경로가 없어 폴백 경로를 탄다) */
const dispatchDrag = ({ type, names, b64 }: DragArgs): void => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const dt = new DataTransfer()
  for (const n of names) dt.items.add(new File([bytes], n, { type: 'application/pdf' }))
  window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
}

const samplePdfB64 = (): string => readFileSync(fixture('sample.pdf')).toString('base64')

test('드래그&드롭으로 파일을 열 수 있다 (렌더러 폴백 경로)', async () => {
  const app = await launchBlank()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.empty')

    await win.evaluate(dispatchDrag, { type: 'drop', names: ['dropped.pdf'], b64: samplePdfB64() })

    await win.waitForSelector('.pdf-page__canvas')
    expect(await win.locator('.pdf-page__canvas').count()).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})

test('실경로 드롭(drop:open 채널) — 파일이 열리고 최근 목록에 남는다', async () => {
  const app = await launchBlank()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.empty')

    // preload(webUtils.getPathForFile)가 보내는 것과 동일한 형태로 drop:open 을 흉내낸다.
    // (합성 File 은 OS 경로가 없어 진짜 드래그를 자동화할 수 없기 때문)
    await app.evaluate(({ ipcMain, BrowserWindow }, path) => {
      const w = BrowserWindow.getAllWindows()[0]
      ipcMain.emit('drop:open', { sender: w.webContents }, path)
    }, fixture('sample.pdf'))

    await win.waitForSelector('.pdf-page__canvas')

    // 문서 닫기 → EmptyState 최근 목록에 등재됐는지 (드롭도 최근목록에 남는 게 이 경로의 핵심)
    await win.click('button[title="문서 닫기"]')
    await win.waitForSelector('.recent__item')
    expect(await win.locator('.recent__name').first().textContent()).toContain('sample.pdf')
  } finally {
    await app.close()
  }
})

test('오버레이 — dragover 로 표시, 멀티파일 힌트, drop 시 즉시 숨김 + 안내 토스트', async () => {
  const app = await launchBlank()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.empty')
    const b64 = samplePdfB64()

    await win.evaluate(dispatchDrag, { type: 'dragover', names: ['a.pdf', 'b.pdf'], b64 })
    await win.waitForSelector('.dropzone__card')
    await win.waitForSelector('.dropzone__sub') // "파일 2개 중 첫 번째만" 힌트

    await win.evaluate(dispatchDrag, { type: 'drop', names: ['a.pdf', 'b.pdf'], b64 })
    await win.waitForSelector('.dropzone__card', { state: 'detached' })
    await win.waitForSelector('.dropzone__diag--info') // 첫 파일만 연다는 토스트
    await win.waitForSelector('.pdf-page__canvas')
  } finally {
    await app.close()
  }
})

test('오버레이 — dragover 침묵 시 안전 타이머로 자동 숨김 (눌어붙음 방지)', async () => {
  const app = await launchBlank()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.empty')

    await win.evaluate(dispatchDrag, { type: 'dragover', names: ['x.pdf'], b64: samplePdfB64() })
    await win.waitForSelector('.dropzone__card')
    // dragover 재발화가 끊기면(창 밖 이탈·ESC 취소 등) 900ms 후 자동 숨김
    await win.waitForSelector('.dropzone__card', { state: 'detached', timeout: 3000 })
  } finally {
    await app.close()
  }
})
