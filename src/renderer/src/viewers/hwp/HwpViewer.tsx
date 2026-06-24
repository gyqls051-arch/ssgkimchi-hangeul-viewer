import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewerProps } from '../types'
import { useHwpDocument } from './useHwpDocument'
import HwpPage from './HwpPage'
import './hwp.css'

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface Size {
  w: number
  h: number
}

export default function HwpViewer({ doc: input }: ViewerProps) {
  const { doc, pageCount, sourceFormat, loading, error } = useHwpDocument(input.bytes)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [currentPage, setCurrentPage] = useState(0) // 0-based
  const [base, setBase] = useState<Size | null>(null)
  const [pageInput, setPageInput] = useState<string | null>(null)

  // 페이지 엘리먼트 등록 (이동 스크롤용)
  const pageEls = useRef<Map<number, HTMLDivElement>>(new Map())
  const registerEl = useCallback((i: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(i, el)
    else pageEls.current.delete(i)
  }, [])

  const jumpToPage = useCallback((i: number) => {
    pageEls.current.get(i)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const onMeasured = useCallback((size: Size) => {
    setBase((prev) => prev ?? size)
  }, [])

  // fit-width: 컨테이너 너비에 맞춰 scale 자동 조정
  const computeFitScale = useCallback((): number => {
    const el = scrollRef.current
    if (!base || !el) return 1
    return clamp((el.clientWidth - 48) / base.w, MIN_SCALE, MAX_SCALE)
  }, [base])

  useEffect(() => {
    if (!fitWidth) return
    const el = scrollRef.current
    if (!el) return
    const apply = (): void => setScale(computeFitScale())
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitWidth, computeFitScale])

  // 현재 페이지 추적 (가장 많이 보이는 페이지)
  const ratios = useRef<Map<number, number>>(new Map())
  const rafRef = useRef<number | undefined>(undefined)
  const handleVisible = useCallback((pageIndex: number, ratio: number) => {
    ratios.current.set(pageIndex, ratio)
    if (rafRef.current !== undefined) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      let best = 0
      let bestRatio = -1
      for (const [p, r] of ratios.current) {
        if (r > bestRatio) {
          bestRatio = r
          best = p
        }
      }
      setCurrentPage((prev) => (prev === best ? prev : best))
    })
  }, [])

  // Ctrl+휠 줌
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setFitWidth(false)
      setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_SCALE, MAX_SCALE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setFitWidth(false)
    setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE))
  }, [])

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i), [pageCount])

  if (loading) {
    return <div className="hwp-status">한글 문서 불러오는 중…</div>
  }
  if (error || !doc) {
    return (
      <div className="hwp-status hwp-status--error">
        <div className="hwp-status__icon" aria-hidden>
          ⚠️
        </div>
        <div>{error ?? '한글 문서를 열 수 없습니다.'}</div>
      </div>
    )
  }

  return (
    <div className="hwp">
      <div className="hwp-toolbar">
        <span className="badge">{(sourceFormat || 'hwp').toUpperCase()}</span>

        <div className="hwp-toolbar__group">
          <button
            className="iconbtn"
            title="이전 페이지"
            onClick={() => jumpToPage(Math.max(0, currentPage - 1))}
          >
            ‹
          </button>
          <input
            className="hwp-pageinput"
            type="number"
            min={1}
            max={pageCount}
            value={pageInput ?? String(currentPage + 1)}
            onFocus={() => setPageInput(String(currentPage + 1))}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => {
              if (pageInput !== null) jumpToPage(clamp(Number(pageInput) || 1, 1, pageCount) - 1)
              setPageInput(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') {
                setPageInput(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          <span className="hwp-toolbar__total">/ {pageCount}</span>
          <button
            className="iconbtn"
            title="다음 페이지"
            onClick={() => jumpToPage(Math.min(pageCount - 1, currentPage + 1))}
          >
            ›
          </button>
        </div>

        <div className="hwp-toolbar__group">
          <button className="iconbtn" title="축소" onClick={() => zoomBy(1 / 1.2)}>
            −
          </button>
          <span className="hwp-zoom">{Math.round(scale * 100)}%</span>
          <button className="iconbtn" title="확대" onClick={() => zoomBy(1.2)}>
            ＋
          </button>
          <button
            className={`textbtn${fitWidth ? ' textbtn--active' : ''}`}
            title="너비 맞춤"
            onClick={() => setFitWidth(true)}
          >
            너비맞춤
          </button>
        </div>
      </div>

      <div className="hwp-scroll" ref={scrollRef}>
        <div className="hwp-pages">
          {pages.map((i) => (
            <HwpPage
              key={i}
              doc={doc}
              pageIndex={i}
              scale={scale}
              base={base}
              onVisible={handleVisible}
              registerEl={registerEl}
              onMeasured={onMeasured}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
