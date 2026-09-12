import { app, session } from 'electron'
import { isTrustedRendererUrl } from './rendererTrust'

/**
 * 앱 전역 보안 baseline.
 * BrowserWindow webPreferences(sandbox/contextIsolation 등)는 index.ts에서 강제한다.
 */
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

// dev: Vite HMR에 필요한 항목만 완화하고 문서/프레임 경계는 production과 동일하게 닫는다.
const DEV_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

function withoutSecurityHeaders(
  headers: Record<string, string[] | undefined>
): Record<string, string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase()
      return lower !== 'content-security-policy' && lower !== 'x-content-type-options'
    })
  )
}

export function applySecurity(isDev: boolean): void {
  const ses = session.defaultSession
  const csp = isDev ? DEV_CSP : PROD_CSP

  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...withoutSecurityHeaders(details.responseHeaders ?? {}),
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())

  app.on('web-contents-created', (_event, contents) => {
    // 외부 링크는 renderer → guarded IPC → native confirm 경로만 허용한다.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))

    contents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url)) event.preventDefault()
    })

    contents.on('will-redirect', (event, url) => {
      if (!isTrustedRendererUrl(url)) event.preventDefault()
    })

    // Electron의 runtime 이벤트가 현재 bundled 타입 정의에는 빠져 있어 최소 구조만 국소 선언한다.
    const frameNavigationContents = contents as typeof contents & {
      on(
        event: 'will-frame-navigate',
        listener: (
          event: { preventDefault(): void },
          details: { isMainFrame: boolean; url: string }
        ) => void
      ): typeof contents
    }
    frameNavigationContents.on(
      'will-frame-navigate',
      (
        event: { preventDefault(): void },
        details: { isMainFrame: boolean; url: string }
      ) => {
        if (!details.isMainFrame || !isTrustedRendererUrl(details.url)) event.preventDefault()
      }
    )

    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
