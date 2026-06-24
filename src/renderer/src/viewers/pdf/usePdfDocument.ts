import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfjsLib, PDFJS_ASSET_OPTIONS } from './pdfjs'
import { createLogger } from '../../lib/logger'

const log = createLogger('pdf')

export interface PdfDocState {
  pdf: PDFDocumentProxy | null
  numPages: number
  loading: boolean
  error: string | null
}

/** ArrayBuffer 로부터 PDFDocumentProxy 를 로드하는 훅 (정리·취소 안전) */
export function usePdfDocument(bytes: ArrayBuffer): PdfDocState {
  const [state, setState] = useState<PdfDocState>({
    pdf: null,
    numPages: 0,
    loading: true,
    error: null
  })

  useEffect(() => {
    let cancelled = false
    setState({ pdf: null, numPages: 0, loading: true, error: null })

    // slice/getDocument 가 동기 throw(detached buffer, 할당 실패 등) 할 수 있어 감싼다
    let task: ReturnType<typeof pdfjsLib.getDocument>
    try {
      const data = bytes.slice(0)
      task = pdfjsLib.getDocument({ data, ...PDFJS_ASSET_OPTIONS })
    } catch (err) {
      log.error('PDF 로드 실패(동기)', err)
      setState({
        pdf: null,
        numPages: 0,
        loading: false,
        error: `PDF를 열 수 없습니다: ${(err as Error)?.message ?? String(err)}`
      })
      return
    }

    task.promise.then(
      (pdf) => {
        // 취소된 경우엔 아래 cleanup 의 task.destroy() 가 문서까지 정리한다
        if (cancelled) return
        log.info(`PDF 준비: ${pdf.numPages}페이지`)
        setState({ pdf, numPages: pdf.numPages, loading: false, error: null })
      },
      (err: unknown) => {
        if (cancelled) return
        const name = (err as { name?: string })?.name
        const message =
          name === 'PasswordException'
            ? '암호로 보호된 PDF입니다. (암호 입력은 아직 지원하지 않습니다)'
            : `PDF를 열 수 없습니다: ${(err as Error)?.message ?? String(err)}`
        log.error('PDF 로드 실패', err)
        setState({ pdf: null, numPages: 0, loading: false, error: message })
      }
    )

    return () => {
      cancelled = true
      // 진행 중 태스크 정리. 미해결 태스크 destroy 는 거부될 수 있으므로 삼킨다.
      task.destroy().catch(() => {})
    }
  }, [bytes])

  return state
}
