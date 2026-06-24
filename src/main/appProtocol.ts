import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative } from 'node:path'
import { PROD_CSP } from './security'

/**
 * 프로덕션에서 렌더러를 file:// 대신 커스텀 `app://` 표준 보안 프로토콜로 서빙한다.
 *
 * 이유: file:// 은 불투명(opaque) origin 이라
 *  - PDF.js 가 워커를 blob 모듈워커로 감싸 dev/prod 동작이 갈리고
 *  - cMap/표준폰트 fetch 가 CSP 'self' 와 모호하게 상호작용한다.
 * app:// 은 실제 origin('app://bundle')을 부여해 _isSameOrigin=true → blob 래퍼 회피,
 * connect-src/worker-src 'self' 매칭이 명확해진다.
 */

const SCHEME = 'app'
const HOST = 'bundle'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream'
}

/** 렌더러를 가리키는 진입 URL */
export const APP_INDEX_URL = `${SCHEME}://${HOST}/index.html`

/** app:// 을 표준·보안 스킴으로 등록 (app ready 이전에 호출해야 함) */
export function registerAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true
      }
    }
  ])
}

/** out/renderer 의 정적 파일을 app:// 로 서빙 (app ready 이후 호출) */
export function registerAppProtocolHandler(): void {
  const root = join(__dirname, '..', 'renderer')

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    // 널바이트 차단 (readFile 에 넘기지 않도록)
    if (pathname.includes('\0')) return new Response('forbidden', { status: 403 })

    const filePath = normalize(join(root, pathname))
    // 경로 traversal 방어: root 밖이면 거부 (relative 가 .. 로 시작하거나 절대경로면 탈출)
    const rel = relative(root, filePath)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      return new Response('forbidden', { status: 403 })
    }

    try {
      const data = await readFile(filePath)
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      // 커스텀 프로토콜 응답은 webRequest.onHeadersReceived 를 거치지 않으므로
      // CSP 를 여기서 직접 부여한다(문서 응답에 적용되면 하위 리소스가 상속).
      return new Response(data, {
        headers: {
          'Content-Type': type,
          'Content-Security-Policy': PROD_CSP,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      // SPA 폴백 없이 단순 404 (렌더러는 단일 index)
      return new Response('not found', { status: 404 })
    }
  })
}
