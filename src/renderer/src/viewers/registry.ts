import { extOf, sniff } from '../lib/magic'
import type { FormatId, ViewerEntry } from './types'

/**
 * 포맷 레지스트리.
 * Phase 0에서는 모든 포맷이 Placeholder로 연결되어 있다.
 * 각 Phase에서 해당 포맷의 `load`만 실제 뷰어 모듈로 교체하면 된다.
 */
const placeholder = () => import('./Placeholder')

export const REGISTRY: ViewerEntry[] = [
  {
    id: 'pdf',
    label: 'PDF',
    extensions: ['.pdf'],
    matchMagic: (m) => m.isPdf,
    load: () => import('./pdf/PdfViewer')
  },
  {
    id: 'hwp',
    label: '한글',
    extensions: ['.hwp', '.hwpx'],
    // hwp(OLE)·hwpx(ZIP) 둘 다 가능 — 확장자로 1차 판별
    load: () => import('./hwp/HwpViewer')
  },
  {
    id: 'docx',
    label: 'Word',
    extensions: ['.docx'],
    load: () => import('./docx/DocxViewer')
  },
  {
    id: 'xlsx',
    label: 'Excel',
    extensions: ['.xlsx'],
    load: () => import('./xlsx/XlsxViewer')
  },
  {
    id: 'pptx',
    label: 'PowerPoint',
    extensions: ['.pptx'],
    load: () => import('./pptx/PptxViewer')
  }
]

export const UNSUPPORTED: ViewerEntry = {
  id: 'unsupported',
  label: '지원하지 않는 형식',
  extensions: [],
  load: placeholder
}

const byExt = (ext: string): ViewerEntry | undefined =>
  REGISTRY.find((v) => v.extensions.includes(ext))

const byId = (id: FormatId): ViewerEntry | undefined => REGISTRY.find((v) => v.id === id)

/**
 * 파일명 + 바이트로 적절한 뷰어 엔트리를 고른다.
 * 1) PDF는 매직바이트가 가장 확실 → 우선 적용
 * 2) 확장자 매칭
 * 3) 확장자 미상 + OLE → 한글(HWP5)일 가능성, 단 doc/xls/ppt일 수도 있어 보수적으로 미지원
 * 4) 그 외 미지원
 */
// 확장자가 요구하는 컨테이너 매직 (불일치 = 확장자 위조/손상 → 미지원으로)
const REQUIRED_MAGIC: Record<string, (m: ReturnType<typeof sniff>) => boolean> = {
  '.docx': (m) => m.isZip,
  '.xlsx': (m) => m.isZip,
  '.pptx': (m) => m.isZip,
  '.hwpx': (m) => m.isZip,
  '.hwp': (m) => m.isOle
}

export function resolveViewer(name: string, bytes: Uint8Array): ViewerEntry {
  const ext = extOf(name)
  const magic = sniff(bytes)

  if (magic.isPdf) return byId('pdf') ?? UNSUPPORTED

  const matched = byExt(ext)
  if (matched) {
    // 확장자↔컨테이너 매직 교차검증: 모순되면(PNG를 .docx로 위장 등) 파서로 보내지 않고 미지원
    const requires = REQUIRED_MAGIC[ext]
    if (requires && !requires(magic)) return UNSUPPORTED
    return matched
  }

  // 확장자를 모를 때의 보정
  if (magic.isOle) return UNSUPPORTED // HWP5/구형오피스 구분 불가 → 보수적 처리
  return UNSUPPORTED
}
