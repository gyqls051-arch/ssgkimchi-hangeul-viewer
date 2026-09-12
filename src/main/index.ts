import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { applySecurity } from './security'
import { buildMenu } from './menu'
import { cancelActiveOpen, openPath, registerIpc } from './ipc'
import { ALLOWED_EXT } from './fileService'
import { getWindowState, saveWindowStateSync, type WindowState } from './store'
import {
  APP_INDEX_URL,
  registerAppProtocolHandler,
  registerAppProtocolScheme
} from './appProtocol'
import { isTrustedIpcEvent } from './rendererTrust'
import { UpdateManager, registerUpdateIpc } from './updateManager'

const isDev = !app.isPackaged
const READY_TIMEOUT_MS = 10_000
const RECOVERY_WINDOW_MS = 60_000
const MAX_AUTOMATIC_RECOVERIES = 2

// 종료 확인 팝업은 설치본에서만 기본 활성. 개발/E2E에서는 명시적으로 켤 수 있다.
const exitConfirmEnabled =
  (app.isPackaged || !!process.env['SSGKIMCHI_EXIT_CONFIRM']) &&
  !process.env['SSGKIMCHI_SKIP_EXIT_CONFIRM']

// app:// 스킴은 app ready 이전에 등록해야 한다.
registerAppProtocolScheme()

let mainWindow: BrowserWindow | null = null
let updateManager: UpdateManager | null = null
let rendererReady = false
let exitConfirmed = false
let exitPromptPending = false
let shuttingDown = false
let loadEpoch = 0
let readyTimer: ReturnType<typeof setTimeout> | null = null
let recoveryInProgress = false
let rendererUnresponsive = false
let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null
let recoveryAttempts: number[] = []
const pendingFiles: string[] = []

function clearReadyTimer(): void {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
}

function clearUnresponsiveTimer(): void {
  if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
  unresponsiveTimer = null
}

function reportAsyncFailure(scope: string, error: unknown): void {
  console.error(`[main] ${scope}:`, error)
}

// 예상하지 못한 main 예외 뒤 손상된 상태로 계속 서비스하지 않는다.
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error)
  cancelActiveOpen()
  if (isDev) return
  shuttingDown = true
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})

/** argv에서 지원 확장자의 실제 경로만 추출한다. 최종 정규파일 검증은 readDoc이 수행한다. */
function filesFromArgv(argv: string[]): string[] {
  const out: string[] = []
  for (const argument of argv.slice(1)) {
    if (argument.startsWith('-') || argument === '.') continue
    const lower = argument.toLowerCase()
    if ([...ALLOWED_EXT].some((extension) => lower.endsWith(extension)) && existsSync(argument)) {
      out.push(argument)
    }
  }
  return out
}

function rememberLatestPending(path: string): void {
  pendingFiles.length = 0
  pendingFiles.push(path)
}

/** 단일 문서 UI이므로 여러 요청이 겹치면 최신 요청만 남긴다. */
function queueOrOpen(path: string): void {
  const win = mainWindow
  if (win && rendererReady && !win.isDestroyed()) {
    void openPath(win, path).catch((error: unknown) => reportAsyncFailure('파일 열기 실패', error))
  } else {
    rememberLatestPending(path)
  }
}

function flushPending(): void {
  const win = mainWindow
  if (!win || !rendererReady || win.isDestroyed()) return
  const path = pendingFiles.pop()
  pendingFiles.length = 0
  if (!path) return
  void openPath(win, path).catch((error: unknown) => reportAsyncFailure('대기 파일 열기 실패', error))
}

function rendererEntryUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return isDev && devUrl ? devUrl : APP_INDEX_URL
}

function isVisibleOnScreen(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const workArea = display.workArea
    const overlapX = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x)
    const overlapY = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y)
    return overlapX > 80 && overlapY > 40
  })
}

async function recoverRenderer(win: BrowserWindow, reason: string): Promise<void> {
  if (recoveryInProgress || shuttingDown || win.isDestroyed() || win !== mainWindow) return
  recoveryInProgress = true
  rendererReady = false
  exitPromptPending = false
  cancelActiveOpen()
  clearReadyTimer()

  const now = Date.now()
  recoveryAttempts = recoveryAttempts.filter((time) => now - time < RECOVERY_WINDOW_MS)
  try {
    if (recoveryAttempts.length >= MAX_AUTOMATIC_RECOVERIES) {
      const result = await dialog.showMessageBox(win, {
        type: 'error',
        title: '화면 복구 실패',
        message: '문서 화면이 반복해서 중단되었습니다.',
        detail: `${reason}\n같은 문제가 계속되면 앱을 종료하고 해당 문서를 다시 열지 마세요.`,
        buttons: ['종료', '한 번 더 다시 로드'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (result.response === 0 || win.isDestroyed()) {
        exitConfirmed = true
        win.destroy()
        return
      }
      recoveryAttempts = []
    }

    recoveryAttempts.push(Date.now())
    await win.loadURL(rendererEntryUrl())
  } catch (error: unknown) {
    reportAsyncFailure('renderer 재로딩 실패', error)
  } finally {
    recoveryInProgress = false
  }
}

function armReadyTimeout(win: BrowserWindow, epoch: number): void {
  clearReadyTimer()
  readyTimer = setTimeout(() => {
    if (
      !rendererReady &&
      !shuttingDown &&
      !win.isDestroyed() &&
      win === mainWindow &&
      epoch === loadEpoch
    ) {
      void recoverRenderer(win, 'renderer가 준비 신호를 보내지 않았습니다.')
    }
  }, READY_TIMEOUT_MS)
}

function saveBounds(win: BrowserWindow): void {
  if (win.isMinimized()) return
  const bounds = win.getNormalBounds()
  if (bounds.width < 200 || bounds.height < 200) return
  saveWindowStateSync({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: win.isMaximized()
  })
}

function createWindow(state: WindowState): void {
  const width = Math.max(760, state.width || 1200)
  const height = Math.max(480, state.height || 820)
  const useXY =
    state.x !== undefined &&
    state.y !== undefined &&
    isVisibleOnScreen(state.x, state.y, width, height)

  const win = new BrowserWindow({
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
  mainWindow = win
  rendererReady = false
  exitConfirmed = false
  exitPromptPending = false
  recoveryAttempts = []

  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  win.on('close', (event) => {
    saveBounds(win)
    if (
      exitConfirmEnabled &&
      !shuttingDown &&
      !exitConfirmed &&
      rendererReady &&
      !win.webContents.isDestroyed()
    ) {
      event.preventDefault()
      if (!exitPromptPending) {
        exitPromptPending = true
        win.webContents.send('show-exit-dialog')
      }
    }
  })

  win.webContents.on('did-start-loading', () => {
    loadEpoch += 1
    rendererReady = false
    rendererUnresponsive = false
    exitPromptPending = false
    cancelActiveOpen()
    clearReadyTimer()
    clearUnresponsiveTimer()
  })

  win.webContents.on('did-finish-load', () => {
    if (isDev) console.log('[main] 렌더러 로드 완료')
    armReadyTimeout(win, loadEpoch)
  })

  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || shuttingDown) return
      void recoverRenderer(win, `화면 로드 실패(${errorCode}): ${errorDescription}`)
    }
  )

  win.webContents.on('render-process-gone', (_event, details) => {
    if (shuttingDown) return
    void recoverRenderer(win, `renderer 종료: ${details.reason} (exit ${details.exitCode})`)
  })

  win.on('unresponsive', () => {
    rendererUnresponsive = true
    clearUnresponsiveTimer()
    unresponsiveTimer = setTimeout(() => {
      if (!rendererUnresponsive || shuttingDown || win.isDestroyed()) return
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          title: '응답 없음',
          message: '문서 화면이 응답하지 않습니다.',
          detail: '큰 문서를 처리 중일 수 있습니다. 계속 기다리거나 안전하게 화면을 다시 로드할 수 있습니다.',
          buttons: ['계속 기다리기', '화면 다시 로드'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        .then((result) => {
          if (result.response === 1) return recoverRenderer(win, 'renderer 무응답')
          return undefined
        })
        .catch((error: unknown) => reportAsyncFailure('무응답 대화상자 실패', error))
    }, 3_000)
  })

  win.on('responsive', () => {
    rendererUnresponsive = false
    clearUnresponsiveTimer()
  })

  if (isDev) {
    win.webContents.on('console-message', (event) => {
      console.log('[renderer]', event.message)
    })
  }

  win.on('closed', () => {
    clearReadyTimer()
    clearUnresponsiveTimer()
    cancelActiveOpen()
    if (mainWindow === win) mainWindow = null
    rendererReady = false
    exitPromptPending = false
  })

  void win.loadURL(rendererEntryUrl()).catch((error: unknown) =>
    reportAsyncFailure('초기 renderer 로드 실패', error)
  )
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const win = mainWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const files = filesFromArgv(argv)
    if (files.length > 0) queueOrOpen(files[files.length - 1])
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    queueOrOpen(path)
  })

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(await getWindowState())
  })

  ipcMain.on('renderer-ready', (event) => {
    if (!isTrustedIpcEvent(event, () => mainWindow)) return
    rendererReady = true
    clearReadyTimer()
    flushPending()
    updateManager?.broadcastCurrent()
  })

  ipcMain.on('exit:cancel', (event) => {
    if (!exitPromptPending || !isTrustedIpcEvent(event, () => mainWindow)) return
    exitPromptPending = false
  })

  ipcMain.on('exit:confirm', (event) => {
    if (!exitPromptPending || !isTrustedIpcEvent(event, () => mainWindow)) return
    exitPromptPending = false
    exitConfirmed = true
    mainWindow?.destroy()
  })

  app.on('before-quit', () => {
    shuttingDown = true
    updateManager?.dispose()
    cancelActiveOpen()
    clearReadyTimer()
    clearUnresponsiveTimer()
  })

  void app
    .whenReady()
    .then(async () => {
      app.setName('싹싹김치 한글뷰어')
      registerAppProtocolHandler()
      applySecurity(isDev)

      const manager = new UpdateManager({
        publish: (snapshot) => {
          const win = mainWindow
          if (
            !rendererReady ||
            !win ||
            win.isDestroyed() ||
            win.webContents.isDestroyed()
          ) {
            return
          }
          win.webContents.send('update:state', snapshot)
        },
        prepareInstall: () => {
          shuttingDown = true
          exitConfirmed = true
          exitPromptPending = false
          cancelActiveOpen()
          clearReadyTimer()
          clearUnresponsiveTimer()
        },
        cancelInstallPreparation: () => {
          shuttingDown = false
          exitConfirmed = false
        }
      })
      updateManager = manager
      await manager.initialize()
      registerIpc(() => mainWindow)
      registerUpdateIpc(manager, () => mainWindow)

      const initialFiles = filesFromArgv(process.argv)
      if (initialFiles.length > 0) rememberLatestPending(initialFiles[initialFiles.length - 1])
      const autoOpen = isDev ? process.env['SSGKIMCHI_OPEN_ON_START'] : undefined
      if (autoOpen) rememberLatestPending(autoOpen)

      createWindow(await getWindowState())
      buildMenu(() => mainWindow, manager)
    })
    .catch((error: unknown) => {
      reportAsyncFailure('앱 초기화 실패', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
