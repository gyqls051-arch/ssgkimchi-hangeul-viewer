import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ViewerApi, OpenedFile, RecentItem } from './api'

const api: ViewerApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:open'),

  onOpenFile: (cb: (file: OpenedFile) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, file: OpenedFile): void => cb(file)
    ipcRenderer.on('open-file', listener)
    return () => ipcRenderer.removeListener('open-file', listener)
  },

  onPrint: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:print', listener)
    return () => ipcRenderer.removeListener('menu:print', listener)
  },

  notifyReady: (): void => ipcRenderer.send('renderer-ready'),

  openDroppedFile: (file: File): boolean => {
    // webUtils 는 OS 가 실제로 드래그해 넣은 File 에만 경로를 준다.
    // 렌더러가 new File() 로 합성한 객체는 '' → 임의 경로 읽기 통로가 되지 않는다.
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      /* 경로 없는 File — 폴백(렌더러 직접 읽기)으로 처리 */
    }
    if (!path) return false
    ipcRenderer.send('drop:open', path)
    return true
  },

  openExternal: (url: string): void => ipcRenderer.send('open-external', url),

  listRecent: (): Promise<RecentItem[]> => ipcRenderer.invoke('recent:list'),
  openRecent: (path: string): Promise<boolean> => ipcRenderer.invoke('recent:open', path),
  clearRecent: (): Promise<void> => ipcRenderer.invoke('recent:clear'),

  onShowExitDialog: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('show-exit-dialog', listener)
    return () => ipcRenderer.removeListener('show-exit-dialog', listener)
  },
  confirmExit: (): void => ipcRenderer.send('exit:confirm'),

  platform: process.platform
}

// contextIsolation:true 에서는 contextBridge로만 노출 (안전 경계 유지)
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] exposeInMainWorld 실패:', error)
  }
} else {
  // 비정상(격리 꺼짐) 환경 폴백 — 정상 빌드에선 도달하지 않음
  ;(globalThis as unknown as { api: ViewerApi }).api = api
}
