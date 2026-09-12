import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ViewerApi, OpenedFile, RecentItem, UpdateSnapshot } from './api'

const api: ViewerApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:open'),

  onOpenIntent: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('open-file-start', listener)
    return () => ipcRenderer.removeListener('open-file-start', listener)
  },

  onOpenFile: (cb: (file: OpenedFile) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, file: OpenedFile): void => cb(file)
    ipcRenderer.on('open-file', listener)
    return () => ipcRenderer.removeListener('open-file', listener)
  },

  cancelPendingOpen: (): void => ipcRenderer.send('open:cancel'),

  onPrint: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:print', listener)
    return () => ipcRenderer.removeListener('menu:print', listener)
  },

  notifyReady: (): void => ipcRenderer.send('renderer-ready'),

  openDroppedFile: (file: File): boolean => {
    // webUtils 는 OS 가 실제로 드래그해 넣은 File 에만 경로를 준다.
    // renderer가 합성한 File은 빈 경로이므로 임의 경로 입력 통로가 되지 않는다.
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      /* 경로 없는 File — renderer 직접 읽기 fallback으로 처리 */
    }
    if (!path) return false
    ipcRenderer.send('drop:open', path)
    return true
  },

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('open-external', url),

  listRecent: (): Promise<RecentItem[]> => ipcRenderer.invoke('recent:list'),
  openRecent: (id: string): Promise<boolean> => ipcRenderer.invoke('recent:open', id),
  clearRecent: (): Promise<void> => ipcRenderer.invoke('recent:clear'),

  onShowExitDialog: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('show-exit-dialog', listener)
    return () => ipcRenderer.removeListener('show-exit-dialog', listener)
  },
  cancelExit: (): void => ipcRenderer.send('exit:cancel'),
  confirmExit: (): void => ipcRenderer.send('exit:confirm'),

  getUpdateState: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('update:download'),
  cancelUpdateDownload: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('update:cancel'),
  installUpdate: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: UpdateSnapshot): void => cb(snapshot)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
  onShowUpdateDialog: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('show-update-dialog', listener)
    return () => ipcRenderer.removeListener('show-update-dialog', listener)
  },

  platform: process.platform
}

// 비격리 renderer에는 어떠한 privileged API도 노출하지 않는다.
if (!process.contextIsolated) {
  throw new Error('contextIsolation이 비활성화되어 preload API 노출을 거부합니다.')
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('[preload] exposeInMainWorld 실패:', error)
}
