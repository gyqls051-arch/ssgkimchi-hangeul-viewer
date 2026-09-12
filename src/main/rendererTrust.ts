import { isIP } from 'node:net'
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain
} from 'electron'

export const TRUSTED_APP_RENDERER_URL = 'app://bundle/index.html'
const MAX_EXTERNAL_URL_LENGTH = 2_048

type TrustedIpcEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender'> & {
  senderFrame?: WebFrameMain | null
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function configuredDevRendererUrl(): URL | null {
  const value = process.env['ELECTRON_RENDERER_URL']
  return value ? parseUrl(value) : null
}

/** app:// 진입 문서 또는 실제 Vite 진입 URL과 URL 객체 기준으로 정확히 일치하는지 검사한다. */
export function isTrustedRendererUrl(value: string): boolean {
  const candidate = parseUrl(value)
  if (!candidate) return false

  const appUrl = new URL(TRUSTED_APP_RENDERER_URL)
  if (candidate.href === appUrl.href) return true

  const devUrl = configuredDevRendererUrl()
  return devUrl !== null && candidate.href === devUrl.href
}

function liveTopFrame(contents: WebContents, eventFrame?: WebFrameMain | null): WebFrameMain | null {
  if (contents.isDestroyed()) return null

  let mainFrame: WebFrameMain
  try {
    mainFrame = contents.mainFrame
  } catch {
    return null
  }

  // 실제 IPC에는 senderFrame이 있다. 직접 main-side emit을 쓰는 기존 smoke/E2E는
  // sender만 전달하므로 그 경우에도 현재 mainFrame 자체를 검증해 동일한 경계를 유지한다.
  const frame = eventFrame ?? mainFrame
  if (frame !== mainFrame || frame.detached || frame.parent !== null || frame.top !== frame) return null
  return frame
}

/** IPC가 현재 singleton 창의 살아있는 trusted top frame에서 왔는지 검사한다. */
export function isTrustedIpcEvent(
  event: TrustedIpcEvent,
  getMainWindow: () => BrowserWindow | null
): boolean {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
  if (event.sender !== win.webContents) return false

  const frame = liveTopFrame(event.sender, event.senderFrame)
  if (!frame) return false
  return isTrustedRendererUrl(frame.url) && isTrustedRendererUrl(event.sender.getURL())
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function ipv6Words(hostname: string): number[] | null {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const halves = value.split('::')
  if (halves.length > 2) return null

  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const words: number[] = []
    for (const part of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      words.push(Number.parseInt(part, 16))
    }
    return words
  }

  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null

  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

function isPrivateIpv6(hostname: string): boolean {
  const words = ipv6Words(hostname)
  if (!words || words.length !== 8) return true

  const allZero = words.every((word) => word === 0)
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00
  const linkLocal = (words[0] & 0xffc0) === 0xfe80
  const siteLocal = (words[0] & 0xffc0) === 0xfec0
  const multicast = (words[0] & 0xff00) === 0xff00
  if (allZero || loopback || uniqueLocal || linkLocal || siteLocal || multicast) return true

  const mappedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  if (mappedIpv4) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`
    return isPrivateIpv4(ipv4)
  }
  return false
}

/** 외부 브라우저에 넘길 수 있는 canonical public HTTPS URL만 반환한다. */
export function parseExternalHttpsUrl(value: unknown): URL | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    containsControlCharacter(value)
  ) {
    return null
  }

  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  if (url.href.length > MAX_EXTERNAL_URL_LENGTH) return null

  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null

  const literal = hostname.replace(/^\[|\]$/g, '')
  const version = isIP(literal)
  if ((version === 4 && isPrivateIpv4(literal)) || (version === 6 && isPrivateIpv6(literal))) {
    return null
  }
  return url
}
