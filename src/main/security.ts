import { app, session, shell } from 'electron'

/**
 * 앱 전역 보안 baseline.
 * - 엄격 CSP (prod) / HMR 허용 CSP (dev)
 * - 권한 요청 전면 거부
 * - 외부 내비게이션 차단, 새 창은 기본 브라우저로
 * - webview 부착 차단
 *
 * BrowserWindow webPreferences(sandbox/contextIsolation 등)는 index.ts에서 강제한다.
 */
// 'wasm-unsafe-eval' : rhwp/일부 WASM 대비 허용. 그 외 스크립트는 'self'(app://bundle)만.
// app:// 표준 보안 origin 이므로 worker/connect 'self' 가 명확히 매칭된다.
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

// dev: Vite HMR가 inline/eval/websocket을 요구하므로 완화 (개발 전용)
const DEV_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "object-src 'none'"
].join('; ')

export function applySecurity(isDev: boolean): void {
  const ses = session.defaultSession
  const csp = isDev ? DEV_CSP : PROD_CSP

  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  // 카메라/마이크/지오로케이션 등 모든 권한 요청 거부 (뷰어엔 불필요)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  // 모든 webContents에 대한 내비게이션/창 하드닝
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      // dev: Vite 서버, prod: app:// 만 허용. file:// 은 더 이상 쓰지 않으므로 차단.
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('app://')
      if (!allowed) event.preventDefault()
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
