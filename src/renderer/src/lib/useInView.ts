import { useCallback, useEffect, useRef, useState } from 'react'

export interface InView {
  inView: boolean
  setRef: (el: HTMLElement | null) => void
}

const EVICTION_DELAY_MS = 900

/**
 * 페이지가 viewport 근처에 있을 때만 true를 유지한다.
 * 이탈 직후의 경계 깜빡임은 짧은 hysteresis로 막되, 시간이 지나면 false로 되돌려
 * PDF canvas/HWP SVG가 실제로 unmount·해제될 수 있게 한다.
 */
export function useInView(
  onVisible?: (ratio: number) => void,
  rootMargin = '300px 0px'
): InView {
  const [inView, setInView] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const evictionTimerRef = useRef<number | undefined>(undefined)
  const onVisibleRef = useRef(onVisible)

  useEffect(() => {
    onVisibleRef.current = onVisible
  }, [onVisible])

  const clearEviction = useCallback(() => {
    if (evictionTimerRef.current !== undefined) window.clearTimeout(evictionTimerRef.current)
    evictionTimerRef.current = undefined
  }, [])

  const setRef = useCallback(
    (element: HTMLElement | null) => {
      observerRef.current?.disconnect()
      clearEviction()
      if (!element) {
        observerRef.current = null
        setInView(false)
        return
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const ratio = entry.isIntersecting ? entry.intersectionRatio : 0
            onVisibleRef.current?.(ratio)
            if (entry.isIntersecting) {
              clearEviction()
              setInView(true)
            } else if (evictionTimerRef.current === undefined) {
              evictionTimerRef.current = window.setTimeout(() => {
                evictionTimerRef.current = undefined
                setInView(false)
              }, EVICTION_DELAY_MS)
            }
          }
        },
        { rootMargin, threshold: [0, 0.25, 0.5, 0.75, 1] }
      )
      observer.observe(element)
      observerRef.current = observer
    },
    [clearEviction, rootMargin]
  )

  useEffect(
    () => () => {
      observerRef.current?.disconnect()
      clearEviction()
    },
    [clearEviction]
  )

  return { inView, setRef }
}
