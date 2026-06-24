import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewerProps } from '../types'
import { usePdfDocument } from './usePdfDocument'
import PdfPage from './PdfPage'
import Thumbnails from './Thumbnails'
import { searchPdfText } from './search'
import { createLogger } from '../../lib/logger'
import './pdf.css'

const log = createLogger('pdf')
const MIN_SCALE = 0.25
const MAX_SCALE = 5
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export default function PdfViewer({ doc }: ViewerProps) {
  const { pdf, numPages, loading, error } = usePdfDocument(doc.bytes)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [baseViewport, setBaseViewport] = useState<{ w: number; h: number } | null>(null)
  const [showThumbs, setShowThumbs] = useState(false)
  // 편집 중인 페이지 입력값 (null = 비편집, currentPage 를 표시). 스크롤 추적이 입력을 덮어쓰는 것 방지.
  const [pageInput, setPageInput] = useState<string | null>(null)

  // 검색 상태
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<number[]>([])
  const [matchIdx, setMatchIdx] = useState(0)
  const [searching, setSearching] = useState(false)
  // 빠른 재검색 시 늦게 도착한 이전 결과를 무시하기 위한 시퀀스 토큰
  const searchSeq = useRef(0)

  // 페이지 엘리먼트 등록 (이동 스크롤용)
  const pageEls = useRef<Map<number, HTMLDivElement>>(new Map())
  const registerEl = useCallback((p: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(p, el)
    else pageEls.current.delete(p)
  }, [])

  const jumpToPage = useCallback((p: number) => {
    pageEls.current.get(p)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // 1페이지 기준 크기 (fit-width 계산 + 자리표시자 높이)
  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    pdf
      .getPage(1)
      .then((page) => {
        if (cancelled) return
        const v = page.getViewport({ scale: 1 })
        setBaseViewport({ w: v.width, h: v.height })
      })
      .catch((err) => {
        // 1페이지 메타 실패는 치명적이지 않음(자리표시자 크기로 폴백). 미처리 거부만 막는다.
        if (!cancelled) log.debug('1페이지 크기 측정 실패', err)
      })
    return () => {
      cancelled = true
    }
  }, [pdf])

  // fit-width: 컨테이너 너비에 맞춰 scale 자동 조정 (미세 떨림 방지 위해 소수 3자리 반올림)
  const computeFitScale = useCallback((): number => {
    const el = scrollRef.current
    if (!baseViewport || !el) return 1
    const avail = el.clientWidth - 48 // 좌우 여백
    const s = clamp(avail / baseViewport.w, MIN_SCALE, MAX_SCALE)
    return Math.round(s * 1000) / 1000
  }, [baseViewport])

  useEffect(() => {
    if (!fitWidth) return
    const el = scrollRef.current
    if (!el) return
    // 의미 있는 변화일 때만 setScale → 텍스트레이어 불필요한 재렌더(선택 깜빡임) 방지
    const apply = (): void => setScale((prev) => {
      const next = computeFitScale()
      return Math.abs(next - prev) < 0.002 ? prev : next
    })
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitWidth, computeFitScale])

  // 현재 페이지 추적 (가장 많이 보이는 페이지)
  const ratios = useRef<Map<number, number>>(new Map())
  const rafRef = useRef<number | undefined>(undefined)
  const handleVisible = useCallback((pageNumber: number, ratio: number) => {
    ratios.current.set(pageNumber, ratio)
    if (rafRef.current !== undefined) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      let best = 1
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

  const runSearch = useCallback(
    async (q: string) => {
      setQuery(q)
      const trimmed = q.trim()
      const seq = ++searchSeq.current
      if (!pdf || !trimmed) {
        setMatches([])
        setMatchIdx(0)
        return
      }
      setSearching(true)
      try {
        const pages = await searchPdfText(pdf, numPages, trimmed)
        if (seq !== searchSeq.current) return // 더 최근 검색에 의해 무효화됨
        setMatches(pages)
        setMatchIdx(0)
        if (pages.length > 0) jumpToPage(pages[0])
      } catch (err) {
        if (seq !== searchSeq.current) return
        log.error('검색 실패', err)
        setMatches([])
        setMatchIdx(0)
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    },
    [pdf, numPages, jumpToPage]
  )

  const gotoMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) return
      const next = (matchIdx + delta + matches.length) % matches.length
      setMatchIdx(next)
      jumpToPage(matches[next])
    },
    [matches, matchIdx, jumpToPage]
  )

  const pages = useMemo(
    () => Array.from({ length: numPages }, (_, i) => i + 1),
    [numPages]
  )
  const estHeight = baseViewport ? baseViewport.h * scale : 800

  if (loading) {
    return <div className="pdf-status">PDF 불러오는 중…</div>
  }
  if (error || !pdf) {
    return (
      <div className="pdf-status pdf-status--error">
        <div className="pdf-status__icon" aria-hidden>
          ⚠️
        </div>
        <div>{error ?? 'PDF를 열 수 없습니다.'}</div>
      </div>
    )
  }

  return (
    <div className="pdf">
      <div className="pdf-toolbar">
        <button
          className={`iconbtn${showThumbs ? ' iconbtn--active' : ''}`}
          title="썸네일"
          onClick={() => setShowThumbs((v) => !v)}
        >
          ▦
        </button>

        <div className="pdf-toolbar__group">
          <button className="iconbtn" title="이전 페이지" onClick={() => jumpToPage(Math.max(1, currentPage - 1))}>
            ‹
          </button>
          <input
            className="pdf-pageinput"
            type="number"
            min={1}
            max={numPages}
            // 편집 중엔 입력값을 그대로 두고(스크롤 추적이 덮어쓰지 않게),
            // 비편집 시엔 현재 페이지를 표시한다.
            value={pageInput ?? String(currentPage)}
            onFocus={() => setPageInput(String(currentPage))}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => {
              if (pageInput !== null) jumpToPage(clamp(Number(pageInput) || 1, 1, numPages))
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
          <span className="pdf-toolbar__total">/ {numPages}</span>
          <button
            className="iconbtn"
            title="다음 페이지"
            onClick={() => jumpToPage(Math.min(numPages, currentPage + 1))}
          >
            ›
          </button>
        </div>

        <div className="pdf-toolbar__group">
          <button className="iconbtn" title="축소" onClick={() => zoomBy(1 / 1.2)}>
            −
          </button>
          <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
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

        <form
          className="pdf-search"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
        >
          <input
            className="pdf-search__input"
            type="search"
            placeholder="문서 내 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {matches.length > 0 && (
            <span className="pdf-search__count">
              {matchIdx + 1}/{matches.length}쪽
            </span>
          )}
          {query.trim() && matches.length === 0 && !searching && (
            <span className="pdf-search__count">없음</span>
          )}
          <button type="button" className="iconbtn" title="이전 결과" onClick={() => gotoMatch(-1)}>
            ↑
          </button>
          <button type="button" className="iconbtn" title="다음 결과" onClick={() => gotoMatch(1)}>
            ↓
          </button>
        </form>
      </div>

      <div className="pdf-body">
        {showThumbs && (
          <Thumbnails
            pdf={pdf}
            numPages={numPages}
            currentPage={currentPage}
            onSelect={jumpToPage}
          />
        )}
        <div className="pdf-scroll" ref={scrollRef}>
          <div className="pdf-pages">
            {pages.map((p) => (
              <PdfPage
                key={p}
                pdf={pdf}
                pageNumber={p}
                scale={scale}
                estHeight={estHeight}
                onVisible={handleVisible}
                registerEl={registerEl}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
