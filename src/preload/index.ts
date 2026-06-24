import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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

  openExternal: (url: string): void => ipcRenderer.send('open-external', url),

  listRecent: (): Promise<RecentItem[]> => ipcRenderer.invoke('recent:list'),
  openRecent: (path: string): Promise<void> => ipcRenderer.invoke('recent:open', path),
  clearRecent: (): Promise<void> => ipcRenderer.invoke('recent:clear'),

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
