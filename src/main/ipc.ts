import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, extname } from 'node:path'
import { readDoc } from './fileService'
import { addRecent, clearRecent, getRecent, isKnownRecent, removeRecent } from './store'

const FILTERS: Electron.FileFilter[] = [
  { name: '모든 지원 문서', extensions: ['pdf', 'hwp', 'hwpx', 'docx', 'xlsx', 'pptx'] },
  { name: '한글 문서 (hwp, hwpx)', extensions: ['hwp', 'hwpx'] },
  { name: 'PDF (pdf)', extensions: ['pdf'] },
  { name: 'Word (docx)', extensions: ['docx'] },
  { name: 'Excel (xlsx)', extensions: ['xlsx'] },
  { name: 'PowerPoint (pptx)', extensions: ['pptx'] }
]

/**
 * 모든 열기 경로(다이얼로그·메뉴·파일연결·최근목록)는 결국 이 함수로 모여
 * 렌더러에는 단일 'open-file' 이벤트로만 전달된다.
 */
function emitOpenFile(win: BrowserWindow, path: string): void {
  readDoc(path)
    .then((file) => {
      if (win.isDestroyed()) return
      win.webContents.send('open-file', file)
      void addRecent({
        path,
        name: basename(path),
        ext: extname(path).toLowerCase(),
        openedAt: Date.now()
      })
    })
    .catch((err: unknown) => {
      // 최근목록의 죽은 경로(이동/삭제)는 제거
      void removeRecent(path)
      dialog.showErrorBox('열기 실패', err instanceof Error ? err.message : String(err))
    })
}

/** 파일 연결(더블클릭)·명령행 인자로 들어온 경로 열기 */
export function openPath(win: BrowserWindow, path: string): void {
  emitOpenFile(win, path)
}

/** 열기 다이얼로그 → 선택 시 'open-file' 전송 */
export async function openViaDialog(win: BrowserWindow): Promise<void> {
  const res = await dialog.showOpenDialog(win, {
    title: '문서 열기',
    properties: ['openFile'],
    filters: FILTERS
  })
  if (res.canceled || res.filePaths.length === 0) return
  emitOpenFile(win, res.filePaths[0])
}

/** 렌더러가 호출할 수 있는 IPC 등록 (열기 경로 인자는 최근목록 검증을 거친다) */
export function registerIpc(): void {
  ipcMain.handle('dialog:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) await openViaDialog(win)
  })

  ipcMain.handle('recent:list', () => getRecent())

  ipcMain.handle('recent:open', async (event, path: unknown) => {
    if (typeof path !== 'string') return
    // 렌더러가 임의 경로를 열지 못하도록 최근목록에 있는 경로만 허용
    if (!(await isKnownRecent(path))) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) emitOpenFile(win, path)
  })

  ipcMain.handle('recent:clear', () => clearRecent())

  // 문서 내 외부 링크 열기 — http/https 만 허용
  ipcMain.on('open-external', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
  })
}
