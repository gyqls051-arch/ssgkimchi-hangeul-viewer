import { protocol } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative } from 'node:path'
import { TRUSTED_APP_RENDERER_URL } from './rendererTrust'
import { PROD_CSP } from './security'

/**
 * 프로덕션에서 렌더러를 file:// 대신 커스텀 `app://` 표준 보안 프로토콜로 서빙한다.
 * URL·경로·실경로·MIME를 모두 allowlist로 검증한 정적 파일만 반환한다.
 */

const SCHEME = 'app'
const HOST = 'bundle'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
  '.map': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream'
}

/** 렌더러를 가리키는 진입 URL */
export const APP_INDEX_URL = TRUSTED_APP_RENDERER_URL

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function rawPathname(rawUrl: string): string | null {
  const scheme = rawUrl.indexOf('://')
  if (scheme < 0) return null
  const pathStart = rawUrl.indexOf('/', scheme + 3)
  if (pathStart < 0) return '/'
  const query = rawUrl.indexOf('?', pathStart)
  const hash = rawUrl.indexOf('#', pathStart)
  const candidates = [query, hash].filter((index) => index >= 0)
  const end = candidates.length > 0 ? Math.min(...candidates) : rawUrl.length
  return rawUrl.slice(pathStart, end)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function response(
  method: string,
  status: number,
  body: ConstructorParameters<typeof Response>[0],
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: {
      'Content-Security-Policy': PROD_CSP,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  })
}

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
  const realRootPromise = realpath(root)

  protocol.handle(SCHEME, async (request) => {
    const method = request.method.toUpperCase()
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        return response(method, 405, 'method not allowed', { Allow: 'GET, HEAD' })
      }

      const url = new URL(request.url)
      if (
        url.protocol !== `${SCHEME}:` ||
        url.hostname !== HOST ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== ''
      ) {
        return response(method, 403, 'forbidden')
      }

      const rawPath = rawPathname(request.url)
      if (!rawPath || /%2f|%5c/i.test(rawPath) || rawPath.includes('\\')) {
        return response(method, 403, 'forbidden')
      }

      let pathname = decodeURIComponent(rawPath)
      if (pathname === '/' || pathname === '') pathname = '/index.html'
      if (
        !pathname.startsWith('/') ||
        pathname.includes('\0') ||
        pathname.includes('\\') ||
        containsControlCharacter(pathname) ||
        pathname.split('/').some((segment) => segment === '.' || segment === '..')
      ) {
        return response(method, 403, 'forbidden')
      }

      const filePath = normalize(join(root, pathname))
      if (!isContained(root, filePath)) return response(method, 403, 'forbidden')

      const realRoot = await realRootPromise
      const realFile = await realpath(filePath)
      if (!isContained(realRoot, realFile)) return response(method, 403, 'forbidden')

      const type = MIME[extname(realFile).toLowerCase()]
      if (!type) return response(method, 415, 'unsupported media type')

      const info = await stat(realFile)
      if (!info.isFile()) return response(method, 404, 'not found')

      const headers = {
        'Content-Type': type,
        'Content-Length': String(info.size)
      }
      if (method === 'HEAD') return response(method, 200, null, headers)

      const data = await readFile(realFile)
      return response(method, 200, data, headers)
    } catch {
      return response(method, 404, 'not found')
    }
  })
}
