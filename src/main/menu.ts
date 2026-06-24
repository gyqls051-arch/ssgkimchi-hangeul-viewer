import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { openViaDialog } from './ipc'

/** 네이티브 애플리케이션 메뉴 구성 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isDev = !app.isPackaged

  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        {
          label: '열기…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const win = getWindow()
            if (win) void openViaDialog(win)
          }
        },
        {
          label: '인쇄…',
          accelerator: 'CmdOrCtrl+P',
          click: () => getWindow()?.webContents.send('menu:print')
        },
        { type: 'separator' },
        { role: 'quit', label: '종료' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' }
      ]
    },
    ...(isDev
      ? [
          {
            label: '개발',
            submenu: [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const }
            ]
          }
        ]
      : [])
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
