import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const mainEntry = join(root, 'out', 'main', 'index.js')

test('드래그&드롭으로 파일을 열 수 있다 (window 레벨 핸들러)', async () => {
  // 자동열기 없이 빈 화면(EmptyState)으로 띄운다
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SSGKIMCHI_OPEN_ON_START
  const userData = mkdtempSync(join(tmpdir(), 'ssgkimchi-drop-'))
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userData}`], env })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.empty') // 빈 화면 확인

    const b64 = readFileSync(join(root, 'tests', 'fixtures', 'sample.pdf')).toString('base64')
    // window 에 합성 drop 이벤트를 디스패치 (OS 파일 드롭과 동일 경로)
    await win.evaluate((data: string) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      const file = new File([bytes], 'dropped.pdf', { type: 'application/pdf' })
      const dt = new DataTransfer()
      dt.items.add(file)
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      )
    }, b64)

    await win.waitForSelector('.pdf-page__canvas')
    expect(await win.locator('.pdf-page__canvas').count()).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
