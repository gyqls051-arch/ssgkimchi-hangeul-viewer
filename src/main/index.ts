import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { applySecurity } from './security'
import { buildMenu } from './menu'
import { openPath, registerIpc } from './ipc'
import { ALLOWED_EXT } from './fileService'
import { getWindowState, saveWindowStateSync, type WindowState } from './store'
import {
  APP_INDEX_URL,
  registerAppProtocolHandler,
  registerAppProtocolScheme
} from './appProtocol'

const isDev = !app.isPackaged

// 종료 확인 팝업(배너): 설치본에서 기본 활성. 개발/E2E 에선 끔(닫기 테스트 방해 방지).
//   - 개발 미리보기로 켜기:        SSGKIMCHI_EXIT_CONFIRM=1
//   - 패키지 스모크 스크립트에서 끄기: SSGKIMCHI_SKIP_EXIT_CONFIRM=1
const exitConfirmEnabled =
  (app.isPackaged || !!process.env['SSGKIMCHI_EXIT_CONFIRM']) &&
  !process.env['SSGKIMCHI_SKIP_EXIT_CONFIRM']

// app:// 스킴은 app 'ready' 이전에 등록해야 한다 (모듈 로드 시점)
registerAppProtocolScheme()

// 전역 예외/거부를 잡아 로그만 남기고 앱이 조용히 죽지 않게 한다 (디버깅 게이트)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})

let mainWindow: BrowserWindow | null = null
let rendererReady = false
let exitConfirmed = false
const pendingFiles: string[] = []

/** argv에서 문서 경로들을 추출 (지원 확장자 + 실제 존재하는 파일만, 다중 선택 지원) */
function filesFromArgv(argv: string[]): string[] {
  const out: string[] = []
  // [0]은 실행파일(dev에선 electron). 나머지에서 플래그/`.` 제외, 지원 확장자 + 실제 파일만.
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-') || arg === '.') continue
    const lower = arg.toLowerCase()
    let matched = false
    for (const ext of ALLOWED_EXT) {
      if (lower.endsWith(ext)) {
        matched = true
        break
      }
    }
    if (matched && existsSync(arg)) out.push(arg)
  }
  return out
}

/** 렌더러 준비 전/창 없을 때 들어온 파일은 큐에 모았다가 준비되면 처리 */
function queueOrOpen(path: string): void {
  if (mainWindow && rendererReady) openPath(mainWindow, path)
  else pendingFiles.push(path)
}

function flushPending(): void {
  if (!mainWindow || !rendererReady) return
  const win = mainWindow
  while (pendingFiles.length > 0) {
    const p = pendingFiles.shift()
    if (p) openPath(win, p)
  }
}

/** 저장된 위치가 현재 디스플레이 작업영역과 충분히 겹치는지 (오프스크린 복원 방지) */
function isVisibleOnScreen(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    return overlapX > 80 && overlapY > 40
  })
}

function createWindow(state: WindowState): void {
  const width = Math.max(760, state.width || 1200)
  const height = Math.max(480, state.height || 820)
  const useXY =
    state.x !== undefined &&
    state.y !== undefined &&
    isVisibleOnScreen(state.x, state.y, width, height)

  mainWindow = new BrowserWindow({
    width,
    height,
    ...(useXY ? { x: state.x, y: state.y } : {}),
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#1e1f22',
    title: '싹싹김치 한글뷰어',
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  if (state.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 창 크기/위치/최대화 상태를 닫기 직전에 동기 저장 (종료 레이스로 미저장 방지)
  mainWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isMinimized()) {
      const bounds = mainWindow.getNormalBounds()
      if (bounds.width >= 200 && bounds.height >= 200) {
        saveWindowStateSync({
          width: bounds.width,
          height: bounds.height,
          x: bounds.x,
          y: bounds.y,
          maximized: mainWindow.isMaximized()
        })
      }
    }
    // 종료 확인 팝업(배너) — 처음 닫기 시도를 가로채 렌더러 모달을 띄운다.
    // "종료" 선택 시 exit:confirm → exitConfirmed=true → destroy 로 실제 종료.
    if (exitConfirmEnabled && !exitConfirmed && mainWindow && !mainWindow.webContents.isDestroyed()) {
      e.preventDefault()
      mainWindow.webContents.send('show-exit-dialog')
    }
  })

  // 모든 로드 시작 시 준비상태 리셋 — 렌더러가 리스너 부착 후 'renderer-ready'로 다시 알린다
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (isDev) console.log('[main] 렌더러 로드 완료')
    // 폴백: 렌더러가 ready 신호를 못 보내도 일정 시간 후 강제 처리
    setTimeout(() => {
      if (mainWindow && !rendererReady) {
        rendererReady = true
        flushPending()
      }
    }, 2500)
  })

  // dev: 렌더러 콘솔을 터미널로 포워딩 (디버깅 + 스모크 테스트 신호)
  if (isDev) {
    mainWindow.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.message)
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  // 외부 링크/새 창 차단은 security.ts 의 app-wide web-contents-created 핸들러가 담당한다.

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    // 프로덕션: file:// 대신 app:// 표준 보안 origin 으로 로드
    void mainWindow.loadURL(APP_INDEX_URL)
  }
}

// 단일 인스턴스 — 파일 연결로 재실행 시 기존 창으로 전달
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    for (const f of filesFromArgv(argv)) queueOrOpen(f)
  })

  // macOS: 파일 연결로 열기
  app.on('open-file', (event, path) => {
    event.preventDefault()
    queueOrOpen(path)
  })

  // macOS dock 재활성화 — 동기 등록(async whenReady 안에 두면 초기 이벤트를 놓칠 수 있음)
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(await getWindowState())
  })

  // 렌더러가 open-file 리스너를 부착한 뒤 보내는 준비 신호 — 이때 큐를 비운다
  ipcMain.on('renderer-ready', (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) {
      rendererReady = true
      flushPending()
    }
  })

  // 종료 확인 모달에서 "종료" 선택 → 가로채기 해제하고 실제 종료
  ipcMain.on('exit:confirm', () => {
    exitConfirmed = true
    mainWindow?.destroy()
  })

  app.whenReady().then(async () => {
    app.setName('싹싹김치 한글뷰어')
    registerAppProtocolHandler()
    applySecurity(isDev)
    registerIpc()
    createWindow(await getWindowState())
    buildMenu(() => mainWindow)

    for (const f of filesFromArgv(process.argv)) pendingFiles.push(f)

    // 테스트/스모크 전용 자동 열기 (dev 에서 환경변수로만 활성화 — 프로덕션 비활성)
    const autoOpen = isDev ? process.env['SSGKIMCHI_OPEN_ON_START'] : undefined
    if (autoOpen) pendingFiles.push(autoOpen)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
