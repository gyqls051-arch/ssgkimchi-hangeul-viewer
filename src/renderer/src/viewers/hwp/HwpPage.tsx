import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { HwpDocument } from './rhwp'
import { useInView } from '../../lib/useInView'
import { createLogger } from '../../lib/logger'

const log = createLogger('hwp')

// 한 페이지 SVG 문자열 상한 (이 이상이면 sanitize/파싱이 UI를 멈추므로 표시 생략)
const MAX_SVG_CHARS = 24_000_000

interface Size {
  w: number
  h: number
}

/**
 * 신뢰할 수 없는 문서에서 나온 SVG 를 DOMPurify(SVG 프로파일)로 정화한다.
 * - 스크립트/이벤트핸들러/javascript:/SMIL 애니메이션 href/네임스페이스 트릭 등을 견고하게 제거
 * - foreignObject(임베드 HTML 표면)는 추가로 금지
 * - 프로덕션 CSP(script-src 'self', img/font/connect 'self')가 2차 방어선
 */
const PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject']
}

function sanitizeSvgString(svg: string): string {
  return DOMPurify.sanitize(svg, PURIFY_CONFIG)
}

/** SVG 의 자연 크기(px)를 viewBox 우선으로 추출 */
function naturalSize(svg: SVGSVGElement): Size | null {
  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] }
    }
  }
  const w = parseFloat(svg.getAttribute('width') ?? '')
  const h = parseFloat(svg.getAttribute('height') ?? '')
  if (w > 0 && h > 0) return { w, h }
  return null
}

function applyScale(svg: SVGSVGElement, nat: Size, scale: number): void {
  svg.style.width = `${Math.round(nat.w * scale)}px`
  svg.style.height = `${Math.round(nat.h * scale)}px`
}

interface Props {
  doc: HwpDocument
  /** 0-based 페이지 인덱스 */
  pageIndex: number
  scale: number
  /** 자리표시자 자연 크기(첫 페이지 기준) */
  base: Size | null
  onVisible?: (pageIndex: number, ratio: number) => void
  registerEl?: (pageIndex: number, el: HTMLDivElement | null) => void
  /** 첫 렌더된 페이지의 자연 크기 보고 (fit-width/자리표시자용) */
  onMeasured?: (size: Size) => void
}

/** 한글 한 페이지 — 가시 영역에서 SVG 1회 렌더, 줌은 CSS 스케일(재렌더 없음) */
export default function HwpPage({
  doc,
  pageIndex,
  scale,
  base,
  onVisible,
  registerEl,
  onMeasured
}: Props) {
  // SVG 주입 전용 컨테이너 (React 는 이 div 의 자식을 건드리지 않음)
  const svgHostRef = useRef<HTMLDivElement | null>(null)
  const svgElRef = useRef<SVGSVGElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const natRef = useRef<Size | null>(null)
  const scaleRef = useRef(scale)
  const onMeasuredRef = useRef(onMeasured)
  const [rendered, setRendered] = useState(false)

  const { inView, setRef } = useInView((ratio) => onVisible?.(pageIndex, ratio))

  // SVG 글자(<text>, 글자당 1요소)를 시각 순서(줄 → 표 칸)로 묶어
  // 투명 HTML 텍스트 레이어를 만든다. 표 문서에서 native SVG 선택이 문서 전체를
  // 잡아버리는 문제를 해결(선택/복사가 보이는 순서대로 동작).
  const buildOverlay = useCallback(() => {
    const svg = svgElRef.current
    const overlay = overlayRef.current
    if (!svg || !overlay) return
    const base = overlay.getBoundingClientRect()
    if (base.width === 0) return

    // 1) 글자 측정 (읽기 일괄 — 레이아웃 1회)
    const chars: { txt: string; left: number; top: number; right: number; h: number }[] = []
    svg.querySelectorAll('text').forEach((t) => {
      const s = t.textContent
      if (!s || !s.trim()) return
      const r = t.getBoundingClientRect()
      if (r.height <= 0 || r.width <= 0) return
      chars.push({
        txt: s,
        left: r.left - base.left,
        top: r.top - base.top,
        right: r.right - base.left,
        h: r.height
      })
    })
    overlay.replaceChildren()
    if (!chars.length) return

    // 읽는 순서: 같은 줄이면 x, 아니면 y
    chars.sort((a, b) =>
      Math.abs(a.top - b.top) <= Math.min(a.h, b.h) * 0.5 ? a.left - b.left : a.top - b.top
    )

    // 2) 줄(밴드) 묶기 — 전역 median 글자높이를 임계로 써서 안정적으로 그룹
    type Char = (typeof chars)[number]
    const median = (a: number[]): number => (a.length ? a[a.length >> 1] : 16)
    const globalH = median(chars.map((c) => c.h).sort((a, b) => a - b))
    const lines: { top: number; chars: Char[] }[] = []
    for (const c of chars) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(c.top - last.top) <= globalH * 0.6) {
        last.chars.push(c)
        last.top = Math.min(last.top, c.top)
      } else {
        lines.push({ top: c.top, chars: [c] })
      }
    }

    // 3) 각 줄을 큰 x-간격(표 칸 경계)으로 세그먼트 분리 (높이는 뒤에서 열별로 채움).
    //    글자높이는 줄별 median → 괄호 등 이상치 무시, 하이라이트 균일.
    type SegData = {
      left: number
      top: number
      right: number
      fontH: number
      text: string
      height: number
      lineH: number
    }
    const segData: SegData[] = []
    for (const ln of lines) {
      ln.chars.sort((a, b) => a.left - b.left)
      const fontH = median(ln.chars.map((c) => c.h).sort((a, b) => a - b))
      let cur: SegData | null = null
      let prev = -1e9
      const flush = (): void => {
        if (cur) segData.push(cur)
        cur = null
      }
      for (const c of ln.chars) {
        if (cur && c.left - prev > fontH * 1.5) flush() // 표 칸 경계
        if (!cur) {
          cur = { left: c.left, top: ln.top, right: c.right, fontH, text: c.txt, height: fontH, lineH: fontH }
        } else {
          if (c.left - prev > fontH * 0.25) cur.text += ' ' // 단어 간격
          cur.text += c.txt
          cur.right = c.right
        }
        prev = c.right
      }
      flush()
    }

    // 3.5) 표 감지 → 열 키 함수. left 분포에 큰 x-간격(폭의 12%↑)이 있으면 2열+ 표로 봄.
    //      일반 문서는 들여쓰기 간격<12%라 1열(colOf=0)로 묶여 읽는 순서 유지.
    let colOf = (_x: number): number => 0
    if (segData.length > 4) {
      const sortedLefts = segData.map((s) => s.left).sort((a, b) => a - b)
      const colGap = base.width * 0.12
      const bounds: number[] = []
      for (let k = 1; k < sortedLefts.length; k++) {
        if (sortedLefts[k] - sortedLefts[k - 1] > colGap) {
          bounds.push((sortedLefts[k] + sortedLefts[k - 1]) / 2)
        }
      }
      if (bounds.length >= 1) colOf = (x) => bounds.reduce((n, b) => (x >= b ? n + 1 : n), 0)
    }

    // 3.6) 열 우선 정렬(한 열 세로선택 격리) + 같은 열의 "다음 세그먼트까지" 높이 채움
    //      → 열마다 독립적으로 빈틈 없이 타일링되어 세로 드래그가 매끄럽다.
    segData.sort((a, b) => colOf(a.left) - colOf(b.left) || a.top - b.top || a.left - b.left)
    // 같은 열 다음 세그먼트까지 높이를 채운다(히트영역=부드러운 드래그). 하이라이트도 높이
    // 전체(=일반 텍스트처럼 빈 줄도 연속으로 칠해 틈/줄무늬 없이 매끄럽게).
    // 단, 매우 큰 빈틈(장면 전환 등 글자높이 8배↑)만 캡해 거대 빈 블록을 막는다.
    const hugeGap = globalH * 8
    for (let i = 0; i < segData.length; i++) {
      const s = segData[i]
      const nx = segData[i + 1]
      const sameCol = nx && colOf(nx.left) === colOf(s.left) && nx.top > s.top + 1
      s.height = sameCol ? Math.max(nx.top - s.top, s.fontH) : s.fontH
      s.lineH = Math.min(s.height, hugeGap)
    }

    // 4) 스팬 생성(쓰기) → 너비 측정(읽기 일괄) → scaleX 정렬(쓰기 일괄)
    // 높이=틈채운 값(히트영역), 폰트/line-height=글자높이(하이라이트는 글자줄만)
    const made = segData.map((s) => {
      const span = document.createElement('span')
      span.textContent = s.text
      span.style.left = `${s.left}px`
      span.style.top = `${s.top}px`
      span.style.height = `${s.height}px`
      span.style.fontSize = `${s.fontH * 0.82}px`
      span.style.lineHeight = `${s.lineH}px`
      overlay.appendChild(span)
      return { span, targetW: s.right - s.left }
    })
    const natW = made.map((m) => m.span.getBoundingClientRect().width)
    made.forEach((m, i) => {
      if (natW[i] > 1 && m.targetW > 1) m.span.style.transform = `scaleX(${m.targetW / natW[i]})`
    })

    // 마지막 줄 아래/여백으로 드래그해도 선택이 붕괴되지 않게 (endOfContent + selecting 토글)
    const eoc = document.createElement('div')
    eoc.className = 'endOfContent'
    overlay.appendChild(eoc)
  }, [])

  useEffect(() => {
    onMeasuredRef.current = onMeasured
  }, [onMeasured])

  // 외곽 래퍼 ref: 옵저버 + 페이지 등록 (메모이즈해 매 렌더 재부착 방지)
  const wrapRef = useCallback(
    (el: HTMLDivElement | null) => {
      setRef(el)
      registerEl?.(pageIndex, el)
    },
    [setRef, registerEl, pageIndex]
  )

  // 가시 시 SVG 1회 렌더 + sanitize + 주입
  useEffect(() => {
    if (!inView || svgElRef.current) return
    const host = svgHostRef.current
    if (!host) return

    let svgStr: string
    try {
      svgStr = doc.renderPageSvg(pageIndex)
    } catch (err) {
      log.error(`${pageIndex + 1}쪽 렌더 실패`, err)
      return
    }

    // 비정상적으로 거대한 SVG는 sanitize+파싱이 메인스레드를 멈추므로 자리표시로 대체
    if (svgStr.length > MAX_SVG_CHARS) {
      log.warn(`${pageIndex + 1}쪽 SVG 과대(${svgStr.length}) — 표시 생략`)
      host.replaceChildren()
      setRendered(true)
      return
    }

    // 신뢰불가 SVG 정화 후 주입 (DOMPurify SVG 프로파일)
    host.innerHTML = sanitizeSvgString(svgStr)
    const svg = host.querySelector('svg')
    if (!svg) {
      log.error(`${pageIndex + 1}쪽 SVG 파싱/정화 오류`)
      host.replaceChildren()
      return
    }
    svg.style.display = 'block'

    const nat = naturalSize(svg)
    if (nat) {
      natRef.current = nat
      onMeasuredRef.current?.(nat)
      applyScale(svg, nat, scaleRef.current)
    }

    svgElRef.current = svg
    setRendered(true)
  }, [inView, doc, pageIndex])

  // 렌더 직후 텍스트 레이어 구성 (폰트 로드 반영 위해 rAF)
  useEffect(() => {
    if (!rendered) return
    const id = requestAnimationFrame(() => buildOverlay())
    return () => cancelAnimationFrame(id)
  }, [rendered, buildOverlay])

  // 줌: 이미 렌더된 SVG 의 CSS 크기만 갱신 (재렌더 없음) + 텍스트 레이어 재정렬
  useEffect(() => {
    scaleRef.current = scale
    if (svgElRef.current && natRef.current) {
      applyScale(svgElRef.current, natRef.current, scale)
      buildOverlay() // 동기: getBoundingClientRect 가 레이아웃을 강제하므로 새 배율로 정확
    }
  }, [scale, buildOverlay])

  const nat = natRef.current ?? base
  const width = nat ? Math.round(nat.w * scale) : undefined
  const height = nat ? Math.round(nat.h * scale) : 1000

  return (
    <div className="hwp-page" ref={wrapRef} style={{ width, height }} data-page={pageIndex + 1}>
      <div className="hwp-page__svg" ref={svgHostRef} />
      <div className="hwp-textlayer" ref={overlayRef} />
      {!rendered && <div className="hwp-page__placeholder">{pageIndex + 1}</div>}
    </div>
  )
}
