import { useEffect, useRef, useState } from 'react'
import { init } from 'pptx-preview'
import type { ViewerProps } from '../types'
import { createLogger } from '../../lib/logger'
import './pptx.css'

const log = createLogger('pptx')

type Status = 'loading' | 'ready' | 'error'
type Previewer = ReturnType<typeof init>

export default function PptxViewer({ doc }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let previewer: Previewer | null = null

    setStatus('loading')
    setErrMsg('')
    host.replaceChildren()

    // 슬라이드 폭을 호스트 너비에 맞춤(16:9). 호스트는 항상 표시되어 clientWidth 가 유효.
    const width = Math.max(480, host.clientWidth - 40)
    const height = Math.round((width * 9) / 16)

    try {
      previewer = init(host, { width, height, mode: 'list' })
      // ArrayBuffer 가 소비될 수 있으므로 복사본 전달
      previewer
        .preview(doc.bytes.slice(0))
        .then(() => {
          if (cancelled) return
          const count = previewer?.slideCount ?? 0
          if (count === 0) {
            // 일부 비표준 생성기(예: 프로그램 생성) 파일은 인식되지 않을 수 있음
            log.warn('PPTX 슬라이드를 인식하지 못했습니다')
            setErrMsg('이 PowerPoint 파일의 슬라이드를 인식할 수 없습니다.')
            setStatus('error')
            return
          }
          log.info(`PPTX 준비: ${count}슬라이드`)
          setStatus('ready')
        })
        .catch((err: unknown) => {
          if (cancelled) return
          log.error('PPTX 렌더 실패', err)
          setErrMsg(
            `PowerPoint 문서를 표시할 수 없습니다: ${(err as Error)?.message ?? String(err)}`
          )
          setStatus('error')
        })
    } catch (err) {
      log.error('PPTX 초기화 실패', err)
      setErrMsg('PowerPoint 렌더러 초기화에 실패했습니다.')
      setStatus('error')
    }

    return () => {
      cancelled = true
      try {
        previewer?.destroy()
      } catch {
        /* 이미 해제됨 */
      }
    }
  }, [doc])

  return (
    <div className="pptx">
      <div className="pptx-host" ref={hostRef} />
      {status === 'loading' && <div className="pptx-overlay">PowerPoint 불러오는 중…</div>}
      {status === 'error' && (
        <div className="pptx-overlay pptx-overlay--error">
          <div className="pptx-overlay__icon" aria-hidden>
            ⚠️
          </div>
          <div>{errMsg}</div>
        </div>
      )}
    </div>
  )
}
