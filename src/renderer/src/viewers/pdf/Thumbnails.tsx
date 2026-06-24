import { useCallback, useEffect, useRef } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { useLazyPageCanvas } from './useLazyPageCanvas'

const THUMB_WIDTH = 130

interface ThumbProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onSelect: (page: number) => void
  registerActive: (el: HTMLButtonElement | null) => void
}

function ThumbItem({ pdf, pageNumber, active, onSelect, registerActive }: ThumbProps) {
  const computeViewport = useCallback((page: PDFPageProxy) => {
    const base = page.getViewport({ scale: 1 })
    return page.getViewport({ scale: THUMB_WIDTH / base.width })
  }, [])

  const { setContainer, canvasRef, visible } = useLazyPageCanvas(pdf, pageNumber, computeViewport, {
    rootMargin: '200px 0px'
  })

  const refCb = useCallback(
    (el: HTMLButtonElement | null) => {
      setContainer(el)
      if (active) registerActive(el)
    },
    [setContainer, active, registerActive]
  )

  return (
    <button
      ref={refCb}
      className={`pdf-thumb${active ? ' pdf-thumb--active' : ''}`}
      onClick={() => onSelect(pageNumber)}
      title={`${pageNumber}쪽`}
    >
      {visible ? (
        <canvas ref={canvasRef} className="pdf-thumb__canvas" />
      ) : (
        <div className="pdf-thumb__placeholder" />
      )}
      <span className="pdf-thumb__num">{pageNumber}</span>
    </button>
  )
}

interface Props {
  pdf: PDFDocumentProxy
  numPages: number
  currentPage: number
  onSelect: (page: number) => void
}

export default function Thumbnails({ pdf, numPages, currentPage, onSelect }: Props) {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const registerActive = useCallback((el: HTMLButtonElement | null) => {
    activeRef.current = el
  }, [])

  // 현재 페이지 썸네일을 사이드바 안에서 보이게 스크롤
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  return (
    <div className="pdf-thumbs">
      {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
        <ThumbItem
          key={p}
          pdf={pdf}
          pageNumber={p}
          active={p === currentPage}
          onSelect={onSelect}
          registerActive={registerActive}
        />
      ))}
    </div>
  )
}
