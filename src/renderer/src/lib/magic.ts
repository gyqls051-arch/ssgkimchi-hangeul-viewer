/**
 * 매직바이트로 파일 컨테이너 종류를 식별한다.
 * 확장자 위조(예: .pdf 인데 실제로는 zip) 방어 및 포맷 라우팅 보정에 사용.
 */
export interface Magic {
  /** "%PDF" */
  isPdf: boolean
  /** ZIP 컨테이너: OOXML(docx/xlsx/pptx) + HWPX */
  isZip: boolean
  /** OLE2 복합 문서: HWP5 + 구형 doc/xls/ppt */
  isOle: boolean
}

const startsWith = (b: Uint8Array, sig: number[]): boolean => {
  if (b.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (b[i] !== sig[i]) return false
  }
  return true
}

export function sniff(bytes: Uint8Array): Magic {
  return {
    // 25 50 44 46  = "%PDF"
    isPdf: startsWith(bytes, [0x25, 0x50, 0x44, 0x46]),
    // 50 4B (PK) + 로컬/빈/스팬 시그니처
    isZip:
      startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]),
    // D0 CF 11 E0 A1 B1 1A E1 = OLE2 Compound File
    isOle: startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  }
}

/** 파일명에서 소문자 확장자(점 포함)를 얻는다. 없으면 빈 문자열. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}
