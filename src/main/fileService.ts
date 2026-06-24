import { lstat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { OpenedFile } from '../preload/api'

/** 뷰어가 다루는 확장자 화이트리스트 */
export const ALLOWED_EXT = new Set([
  '.pdf',
  '.hwp',
  '.hwpx',
  '.docx',
  '.xlsx',
  '.pptx'
])

/** 메모리 보호용 상한 (300MB). 초과 시 거부. */
export const MAX_BYTES = 300 * 1024 * 1024

/**
 * 경로를 검증하고 문서 바이트를 읽어 OpenedFile로 반환한다.
 * 경로는 항상 메인 프로세스가 직접 만든 값(다이얼로그/파일연결)이며,
 * 렌더러가 임의 경로를 보내는 통로는 두지 않는다(경로 traversal 차단).
 */
export async function readDoc(path: string): Promise<OpenedFile> {
  const ext = extname(path).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`지원하지 않는 형식입니다: ${ext || '(확장자 없음)'}`)
  }

  // 심링크/디렉터리/디바이스 거부 (lstat 은 심링크를 따라가지 않음).
  // 새 IPC 경로(recent:open)가 경로를 받게 되었으므로 방어적으로 정규 파일만 허용.
  const info = await lstat(path)
  if (!info.isFile()) {
    throw new Error('정규 파일이 아닙니다.')
  }

  const buf = await readFile(path)
  if (buf.byteLength === 0) {
    throw new Error('빈 파일입니다.')
  }
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`파일이 너무 큽니다 (최대 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB).`)
  }

  // Node Buffer는 공유 풀 위의 뷰일 수 있으므로 독립 ArrayBuffer로 복사
  // (정확한 구간만 + SharedArrayBuffer 타입 혼입 방지)
  const bytes = new ArrayBuffer(buf.byteLength)
  new Uint8Array(bytes).set(buf)
  return { name: basename(path), ext, bytes }
}
