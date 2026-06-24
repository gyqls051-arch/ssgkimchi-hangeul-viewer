import { useCallback } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { useLazyPageCanvas } from './useLazyPageCanvas'

interface Props {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  /** 렌더 전 자리표시자 높이(px) — 레이아웃 점프 방지 */
  estHeight: number
  /** 가시성 변화 보고 (현재 페이지 추적용) */
  onVisible?: (pageNumber: number, ratio: number) => void
  /** 페이지 래퍼 엘리먼트 등록 (페이지 이동 스크롤용) */
  registerEl?: (pageNumber: number, el: HTMLDivElement | null) => void
}

/** 본문 PDF 페이지 — 가시 영역에서만 현재 배율로 렌더 (공용 훅 사용) */
export default function PdfPage({ pdf, pageNumber, scale, estHeight, onVisible, registerEl }: Props) {
  const computeViewport = useCallback(
    (page: PDFPageProxy) => page.getViewport({ scale }),
    [scale]
  )
  const handleVisible = useCallback(
    (ratio: number) => onVisible?.(pageNumber, ratio),
    [onVisible, pageNumber]
  )

  const { setContainer, canvasRef, textLayerRef, linkLayerRef, visible, size } = useLazyPageCanvas(
    pdf,
    pageNumber,
    computeViewport,
    { onVisible: handleVisible, textLayer: true, linkLayer: true }
  )

  const refCb = useCallback(
    (el: HTMLDivElement | null) => {
      setContainer(el)
      registerEl?.(pageNumber, el)
    },
    [setContainer, registerEl, pageNumber]
  )

  return (
    <div
      className="pdf-page"
      ref={refCb}
      style={{ height: size ? size.h : estHeight, width: size?.w }}
      data-page={pageNumber}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="pdf-page__canvas" />
          <div ref={textLayerRef} className="textLayer" />
          <div ref={linkLayerRef} className="pdf-linkLayer" />
        </>
      ) : (
        <div className="pdf-page__placeholder">{pageNumber}</div>
      )}
    </div>
  )
}
