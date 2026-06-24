import { useCallback, useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import type { ViewerProps } from '../types'
import { createLogger } from '../../lib/logger'
import './docx.css'

const log = createLogger('docx')

const MIN_SCALE = 0.4
const MAX_SCALE = 3
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

type Status = 'loading' | 'ready' | 'error'

export default function DocxViewer({ doc }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    setStatus('loading')
    setErrMsg('')
    host.replaceChildren()

    // docx-preview 가 OOXML 을 DOM 으로 빌드. 이미지는 base64(data:)로 — CSP img-src data: 허용.
    renderAsync(doc.bytes, host, undefined, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      // 보안: altChunk(임베드 HTML/RTF)는 공격자 제어 raw-HTML 싱크라 비활성 (심층방어)
      renderAltChunks: false
    }).then(
      () => {
        if (cancelled) return
        log.info('DOCX 렌더 완료')
        setStatus('ready')
      },
      (err: unknown) => {
        if (cancelled) return
        log.error('DOCX 렌더 실패', err)
        setErrMsg(`Word 문서를 표시할 수 없습니다: ${(err as Error)?.message ?? String(err)}`)
        setStatus('error')
      }
    )

    return () => {
      cancelled = true
    }
  }, [doc])

  // Ctrl+휠 줌
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_SCALE, MAX_SCALE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE))
  }, [])

  return (
    <div className="docx">
      <div className="docx-toolbar">
        <span className="badge">WORD</span>
        <div className="docx-toolbar__group">
          <button className="iconbtn" title="축소" onClick={() => zoomBy(1 / 1.2)}>
            −
          </button>
          <span className="docx-zoom">{Math.round(scale * 100)}%</span>
          <button className="iconbtn" title="확대" onClick={() => zoomBy(1.2)}>
            ＋
          </button>
          <button className="textbtn" title="실제 크기" onClick={() => setScale(1)}>
            100%
          </button>
        </div>
      </div>

      <div className="docx-scroll" ref={scrollRef}>
        {status === 'loading' && <div className="docx-status">Word 문서 불러오는 중…</div>}
        {status === 'error' && (
          <div className="docx-status docx-status--error">
            <div className="docx-status__icon" aria-hidden>
              ⚠️
            </div>
            <div>{errMsg}</div>
          </div>
        )}
        {/* zoom 은 Chromium 의 CSS zoom 으로 적용(레이아웃·스크롤 정상 반영) */}
        <div
          className="docx-host"
          ref={hostRef}
          style={{ zoom: scale, display: status === 'ready' ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
