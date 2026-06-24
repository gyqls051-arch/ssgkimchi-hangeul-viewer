import { useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { createLogger } from '../../lib/logger'
import { useInView } from '../../lib/useInView'

const log = createLogger('pdf')
type RenderTask = ReturnType<PDFPageProxy['render']>

/** 캔버스 한 변의 최대 백킹스토어 픽셀 (고배율·고DPR 메모리 폭증/캔버스 한계 방지) */
const MAX_CANVAS_DIM = 4096

function isCancel(err: unknown): boolean {
  return (err as { name?: string })?.name === 'RenderingCancelledException'
}

/** width*dpr / height*dpr 가 MAX_CANVAS_DIM 을 넘지 않도록 dpr 을 제한 */
function clampDpr(cssWidth: number, cssHeight: number): number {
  const dpr = window.devicePixelRatio || 1
  const longest = Math.max(cssWidth, cssHeight)
  if (longest * dpr <= MAX_CANVAS_DIM) return dpr
  return Math.max(1, MAX_CANVAS_DIM / longest)
}

export interface LazyCanvas {
  /** 페이지 래퍼에 부착할 콜백 ref (가시성 관찰 대상) */
  setContainer: (el: HTMLElement | null) => void
  /** 캔버스 ref */
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** 텍스트 선택용 레이어 컨테이너 ref (textLayer 옵션 시) */
  textLayerRef: React.RefObject<HTMLDivElement | null>
  /** 외부 링크(<a>) 레이어 컨테이너 ref (linkLayer 옵션 시) */
  linkLayerRef: React.RefObject<HTMLDivElement | null>
  /** 화면에 근접해 렌더가 시작되었는지 */
  visible: boolean
  /** 렌더 완료된 논리 크기(px) */
  size: { w: number; h: number } | null
}

export interface LazyCanvasOptions {
  rootMargin?: string
  /** 가시성 비율 보고 (현재 페이지 추적용). 안 보이면 0. */
  onVisible?: (ratio: number) => void
  /** 캔버스 위에 선택 가능한 텍스트 레이어도 렌더 (본문 페이지용, 썸네일은 false) */
  textLayer?: boolean
  /** 외부 URL 링크 주석을 클릭 가능한 <a> 로 렌더 */
  linkLayer?: boolean
}

/**
 * IntersectionObserver 로 화면에 근접할 때만 PDF 페이지를 캔버스에 렌더하는 공용 훅.
 * - DPR 적용 + 상한 클램프 (고배율 메모리 보호)
 * - 렌더 태스크 취소/정리, 취소가 아닌 오류만 로깅
 * - PdfPage(본문)·Thumbnails(썸네일)가 viewport 계산만 달리해 공유
 *
 * @param computeViewport 페이지에서 PageViewport 를 계산 (호출부에서 useCallback 으로 메모이즈할 것)
 */
export function useLazyPageCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  computeViewport: (page: PDFPageProxy) => PageViewport,
  options?: LazyCanvasOptions
): LazyCanvas {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const linkLayerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const { inView, setRef } = useInView(options?.onVisible, options?.rootMargin)
  const wantTextLayer = options?.textLayer ?? false
  const wantLinkLayer = options?.linkLayer ?? false

  // 가시 상태에서 렌더 (computeViewport 변경 = 줌 변경 시 재렌더)
  useEffect(() => {
    if (!inView) return
    let cancelled = false
    let task: RenderTask | null = null
    let textLayer: TextLayer | null = null

    pdf
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return
        const viewport = computeViewport(page)
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const dpr = clampDpr(viewport.width, viewport.height)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        setSize({ w: viewport.width, h: viewport.height })

        task = page.render({ canvasContext: ctx, viewport, canvas })
        task.promise.catch((err: unknown) => {
          if (!isCancel(err)) log.debug(`${pageNumber}쪽 렌더 실패`, err)
        })

        // 선택 가능한 텍스트 레이어 (캔버스 위 투명 텍스트)
        const tl = textLayerRef.current
        if (wantTextLayer && tl) {
          tl.replaceChildren()
          // v6 텍스트레이어는 --total-scale-factor 를 사용한다 (구버전 --scale-factor 아님)
          tl.style.setProperty('--total-scale-factor', String(viewport.scale))
          tl.style.setProperty('--scale-factor', String(viewport.scale))
          tl.style.width = `${Math.floor(viewport.width)}px`
          tl.style.height = `${Math.floor(viewport.height)}px`
          textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: tl,
            viewport
          })
          textLayer
            .render()
            .then(() => {
              // selecting 토글이 작동하도록 endOfContent 요소를 직접 추가
              // (선택이 마지막 줄 너머로 번지지 않게)
              if (cancelled || !tl.isConnected || tl.querySelector('.endOfContent')) return
              const eoc = document.createElement('div')
              eoc.className = 'endOfContent'
              tl.appendChild(eoc)
            })
            .catch(() => {
              /* 취소/실패는 무시 (선택 못 할 뿐) */
            })
        }

        // 외부 URL 링크 주석 → 클릭 가능한 <a> 오버레이
        const ll = linkLayerRef.current
        if (wantLinkLayer && ll) {
          ll.replaceChildren()
          page
            .getAnnotations()
            .then((annotations) => {
              if (cancelled) return
              for (const a of annotations as Array<{
                subtype?: string
                url?: string
                rect?: number[]
              }>) {
                if (a.subtype !== 'Link' || !a.url || !a.rect) continue
                // href 주입 전 스킴 화이트리스트 검사: http(s)만 허용
                // (javascript:, file:, data: 등 위험 스킴은 <a> 자체를 만들지 않음)
                let safeHref: string | null = null
                try {
                  const parsed = new URL(a.url)
                  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    safeHref = parsed.href
                  }
                } catch {
                  safeHref = null
                }
                if (!safeHref) continue
                const r = viewport.convertToViewportRectangle(a.rect)
                const x = Math.min(r[0], r[2])
                const y = Math.min(r[1], r[3])
                const link = document.createElement('a')
                link.href = safeHref
                link.className = 'pdf-link'
                link.rel = 'noreferrer'
                link.style.left = `${x}px`
                link.style.top = `${y}px`
                link.style.width = `${Math.abs(r[2] - r[0])}px`
                link.style.height = `${Math.abs(r[3] - r[1])}px`
                ll.appendChild(link)
              }
            })
            .catch(() => {})
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) log.debug(`${pageNumber}쪽 getPage 실패`, err)
      })

    return () => {
      cancelled = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [inView, pdf, pageNumber, computeViewport, wantTextLayer, wantLinkLayer])

  return { setContainer: setRef, canvasRef, textLayerRef, linkLayerRef, visible: inView, size }
}
