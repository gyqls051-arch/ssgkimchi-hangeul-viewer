import { useCallback, useEffect, useRef, useState } from 'react'

export interface InView {
  /** 한 번이라도 뷰포트(+여백)에 근접했는지 (lazy 렌더 트리거) */
  inView: boolean
  /** 관찰 대상 엘리먼트에 부착할 콜백 ref */
  setRef: (el: HTMLElement | null) => void
}

/**
 * 엘리먼트가 뷰포트(+rootMargin)에 들어오는지 관찰하는 공용 훅.
 * onVisible 로 가시 비율을 보고해 "현재 페이지" 추적 등에 사용한다.
 * (PDF·HWP 등 페이지형 뷰어가 공유)
 */
export function useInView(
  onVisible?: (ratio: number) => void,
  rootMargin = '300px 0px'
): InView {
  const [inView, setInView] = useState(false)
  const ioRef = useRef<IntersectionObserver | null>(null)
  const onVisibleRef = useRef(onVisible)

  useEffect(() => {
    onVisibleRef.current = onVisible
  }, [onVisible])

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      ioRef.current?.disconnect()
      if (!el) {
        ioRef.current = null
        return
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) setInView(true)
            onVisibleRef.current?.(e.isIntersecting ? e.intersectionRatio : 0)
          }
        },
        { rootMargin, threshold: [0, 0.25, 0.5, 0.75, 1] }
      )
      io.observe(el)
      ioRef.current = io
    },
    [rootMargin]
  )

  useEffect(() => () => ioRef.current?.disconnect(), [])

  return { inView, setRef }
}
