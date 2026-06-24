import { useEffect, useState } from 'react'
import { ensureRhwp, HwpDocument, resetRhwp } from './rhwp'
import { createLogger } from '../../lib/logger'

const log = createLogger('hwp')

export interface HwpDocState {
  doc: HwpDocument | null
  pageCount: number
  sourceFormat: string
  loading: boolean
  error: string | null
}

/** ArrayBuffer 로부터 rhwp HwpDocument 를 로드하는 훅 (WASM 초기화 → 파싱, 정리 안전) */
export function useHwpDocument(bytes: ArrayBuffer): HwpDocState {
  const [state, setState] = useState<HwpDocState>({
    doc: null,
    pageCount: 0,
    sourceFormat: '',
    loading: true,
    error: null
  })

  useEffect(() => {
    let cancelled = false
    let created: HwpDocument | null = null
    setState({ doc: null, pageCount: 0, sourceFormat: '', loading: true, error: null })

    ensureRhwp().then(
      () => {
        if (cancelled) return
        try {
          const doc = new HwpDocument(new Uint8Array(bytes))
          created = doc
          const pageCount = doc.pageCount()
          let sourceFormat = ''
          try {
            sourceFormat = doc.getSourceFormat()
          } catch {
            /* 선택적 정보 */
          }
          log.info(`HWP 준비: ${pageCount}페이지 (${sourceFormat || 'hwp'})`)
          setState({ doc, pageCount, sourceFormat, loading: false, error: null })
        } catch (err) {
          log.error('HWP 파싱 실패', err)
          // 손상 문서가 WASM 인스턴스를 오염시켰을 수 있으므로 폐기 → 다음 열기는 새 인스턴스로
          resetRhwp()
          setState({
            doc: null,
            pageCount: 0,
            sourceFormat: '',
            loading: false,
            error: `한글 문서를 열 수 없습니다: ${(err as Error)?.message ?? String(err)}`
          })
        }
      },
      (err: unknown) => {
        if (cancelled) return
        log.error('rhwp 초기화 실패', err)
        setState({
          doc: null,
          pageCount: 0,
          sourceFormat: '',
          loading: false,
          error: '한글 렌더링 엔진(rhwp) 초기화에 실패했습니다.'
        })
      }
    )

    return () => {
      cancelled = true
      try {
        created?.free()
      } catch {
        /* 이미 해제됨 */
      }
    }
  }, [bytes])

  return state
}
