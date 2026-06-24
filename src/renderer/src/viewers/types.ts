import type { ComponentType } from 'react'
import type { Magic } from '../lib/magic'

export type FormatId = 'pdf' | 'hwp' | 'docx' | 'xlsx' | 'pptx' | 'unsupported'

/** 열린 문서 (렌더러 내부 표현) */
export interface DocInput {
  name: string
  ext: string
  bytes: ArrayBuffer
}

/** 각 포맷 뷰어 컴포넌트가 받는 공통 props */
export interface ViewerProps {
  doc: DocInput
}

/** lazy import 결과 형태 */
export interface ViewerModule {
  default: ComponentType<ViewerProps>
}

/**
 * 포맷 레지스트리 엔트리.
 * 새 포맷 추가 = 이 배열에 항목 1개 추가 + 뷰어 컴포넌트 1개 작성.
 */
export interface ViewerEntry {
  id: FormatId
  label: string
  /** 소문자 확장자(점 포함) */
  extensions: string[]
  /** 매직바이트로 이 포맷이 맞는지 추가 확인 (확장자 모호/위조 대비) */
  matchMagic?: (magic: Magic) => boolean
  /** 뷰어 컴포넌트 lazy 로더 (코드 스플리팅) */
  load: () => Promise<ViewerModule>
}
