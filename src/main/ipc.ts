import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, extname } from 'node:path'
import { readDoc } from './fileService'
import {
  addRecent,
  clearRecent,
  listRecentItems,
  removeRecentPath,
  resolveRecentId
} from './store'
import { isTrustedIpcEvent, parseExternalHttpsUrl } from './rendererTrust'
import type { OpenedFile } from '../preload/api'

const FILTERS: Electron.FileFilter[] = [
  { name: '지원 문서', extensions: ['hwp', 'hwpx', 'pdf', 'docx', 'xlsx', 'pptx'] },
  { name: '한글 문서', extensions: ['hwp', 'hwpx'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Microsoft Office', extensions: ['docx', 'xlsx', 'pptx'] }
]

interface ActiveOpen {
  generation: number
  controller: AbortController
}

type OpenSource = 'system' | 'dialog' | 'drop' | 'recent'

let openGeneration = 0
let activeOpen: ActiveOpen | null = null
let dialogOpen = false
let lastExternalOpenAt = 0

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportAsyncFailure(scope: string, error: unknown): void {
  console.error(`[ipc] ${scope}:`, error)
}

/** navigation/crash/shutdown 또는 더 최신 renderer fallback 시 진행 중인 read를 무효화한다. */
export function cancelActiveOpen(): void {
  openGeneration += 1
  activeOpen?.controller.abort()
  activeOpen = null
}

/**
 * 모든 main 기반 열기 경로의 latest-request-wins 조정자.
 * descriptor read가 끝난 뒤에도 generation/window 상태를 재검사하며 canonicalPath는 IPC로 보내지 않는다.
 */
async function emitOpenFile(
  win: BrowserWindow,
  path: string,
  source: OpenSource
): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false

  const generation = ++openGeneration
  activeOpen?.controller.abort()
  const controller = new AbortController()
  activeOpen = { generation, controller }

  // renderer가 진행 중인 pathless File read를 즉시 stale 처리할 수 있게 결과보다 먼저 알린다.
  win.webContents.send('open-file-start')

  try {
    const document = await readDoc(path, controller.signal)
    if (
      controller.signal.aborted ||
      generation !== openGeneration ||
      win.isDestroyed() ||
      win.webContents.isDestroyed()
    ) {
      return false
    }

    // main-only canonicalPath를 구조분해로 명시적으로 제거한다.
    const payload: OpenedFile = {
      name: document.name,
      ext: document.ext,
      bytes: document.bytes
    }
    win.webContents.send('open-file', payload)

    void addRecent({
      path: document.canonicalPath,
      name: document.name,
      ext: document.ext,
      openedAt: Date.now()
    }).catch((error: unknown) => reportAsyncFailure('최근 파일 저장 실패', error))
    return true
  } catch (error: unknown) {
    if (isAbort(error) || controller.signal.aborted || generation !== openGeneration) return false

    if (source === 'recent') {
      void removeRecentPath(path).catch((removeError: unknown) =>
        reportAsyncFailure('죽은 최근 파일 제거 실패', removeError)
      )
    }
    if (!win.isDestroyed() && !win.webContents.isDestroyed() && generation === openGeneration) {
      // 검증에 실패한 원본 바이트는 parser에 넘기지 않는다. 대신 동일 포맷의 빈 payload로
      // 기존 viewer 오류 UI를 안전하게 표시해 native modal로 앱 종료가 막히지 않게 한다.
      const extension = extname(path).toLowerCase()
      const safeFailureBytes = ['.hwpx', '.docx', '.xlsx', '.pptx'].includes(extension)
        ? Uint8Array.of(0x50, 0x4b, 0x03, 0x04).buffer
        : new ArrayBuffer(0)
      win.webContents.send('open-file', {
        name: basename(path),
        ext: extension,
        bytes: safeFailureBytes
      } satisfies OpenedFile)
      console.warn(`[ipc] 문서 검증 거부(${source}): ${errorMessage(error)}`)
    }
    return false
  } finally {
    if (activeOpen?.generation === generation) activeOpen = null
  }
}

/** 파일 연결(더블클릭)·명령행 인자로 들어온 경로 열기 */
export function openPath(win: BrowserWindow, path: string): Promise<boolean> {
  return emitOpenFile(win, path, 'system')
}

/** 열기 다이얼로그 → 선택 시 단일 조정자를 통해 전송 */
export async function openViaDialog(win: BrowserWindow): Promise<void> {
  if (dialogOpen || win.isDestroyed()) return
  dialogOpen = true
  try {
    const result = await dialog.showOpenDialog(win, {
      title: '문서 열기',
      properties: ['openFile'],
      filters: FILTERS
    })
    if (result.canceled || result.filePaths.length === 0 || win.isDestroyed()) return
    await emitOpenFile(win, result.filePaths[0], 'dialog')
  } finally {
    dialogOpen = false
  }
}

/** 렌더러가 호출할 수 있는 IPC 등록 */
export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  const trusted = (event: Parameters<typeof isTrustedIpcEvent>[0]): boolean =>
    isTrustedIpcEvent(event, getMainWindow)

  ipcMain.handle('dialog:open', async (event): Promise<void> => {
    if (!trusted(event)) return
    const win = getMainWindow()
    if (win) await openViaDialog(win)
  })

  ipcMain.handle('recent:list', async (event) => {
    if (!trusted(event)) return []
    return listRecentItems()
  })

  ipcMain.handle('recent:open', async (event, id: unknown): Promise<boolean> => {
    if (!trusted(event) || typeof id !== 'string') return false
    const path = await resolveRecentId(id)
    const win = getMainWindow()
    return path && win ? emitOpenFile(win, path, 'recent') : false
  })

  ipcMain.handle('recent:clear', async (event): Promise<void> => {
    if (!trusted(event)) return
    await clearRecent()
  })

  // pathless renderer File read가 더 최신 의도이면 기존 descriptor read를 중단한다.
  ipcMain.on('open:cancel', (event) => {
    if (!trusted(event)) return
    cancelActiveOpen()
  })

  // preload의 webUtils.getPathForFile이 실제 OS drag File에서 얻은 경로만 허용한다.
  ipcMain.on('drop:open', (event, path: unknown) => {
    if (!trusted(event) || typeof path !== 'string' || path.length === 0 || path.length > 32_768) {
      return
    }
    const win = getMainWindow()
    if (win) {
      void emitOpenFile(win, path, 'drop').catch((error: unknown) =>
        reportAsyncFailure('드롭 파일 열기 실패', error)
      )
    }
  })

  ipcMain.handle('open-external', async (event, value: unknown): Promise<boolean> => {
    if (!trusted(event)) return false
    const url = parseExternalHttpsUrl(value)
    if (!url) return false

    const now = Date.now()
    if (now - lastExternalOpenAt < 2_000) return false

    const win = getMainWindow()
    if (!win) return false
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '외부 링크 열기',
      message: `${url.hostname} 사이트를 기본 브라우저에서 여시겠습니까?`,
      detail: url.href,
      buttons: ['열기', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (result.response !== 0 || !trusted(event) || win.isDestroyed()) return false

    lastExternalOpenAt = Date.now()
    try {
      await shell.openExternal(url.href, { activate: true })
      return true
    } catch (error: unknown) {
      reportAsyncFailure('외부 링크 열기 실패', error)
      return false
    }
  })
}
