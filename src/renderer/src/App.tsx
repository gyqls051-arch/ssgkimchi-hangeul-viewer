import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Toolbar from './shell/Toolbar'
import DropZone from './shell/DropZone'
import EmptyState from './shell/EmptyState'
import ErrorBoundary from './shell/ErrorBoundary'
import { resolveViewer } from './viewers/registry'
import type { DocInput, ViewerEntry } from './viewers/types'
import { createLogger } from './lib/logger'

const log = createLogger('app')

export default function App() {
  const [doc, setDoc] = useState<DocInput | null>(null)
  const [entry, setEntry] = useState<ViewerEntry | null>(null)
  // 열기마다 증가하는 고유 키 — 같은 파일명이라도 뷰어를 새로 마운트해
  // 직전 문서의 리소스 해제(free)와 stale 렌더를 확실히 분리한다.
  const [openId, setOpenId] = useState(0)

  const openDoc = useCallback((d: DocInput) => {
    const resolved = resolveViewer(d.name, new Uint8Array(d.bytes))
    log.info(`열기: ${d.name} → ${resolved.id}`)
    setDoc(d)
    setEntry(resolved)
    setOpenId((n) => n + 1)
  }, [])

  // 다이얼로그·메뉴·파일연결로 열린 파일은 모두 이 단일 채널로 들어온다.
  useEffect(() => {
    const off = window.api.onOpenFile((file) => {
      openDoc({ name: file.name, ext: file.ext, bytes: file.bytes })
    })
    // 리스너 부착 완료를 알려 메인이 큐된 파일(파일연결 cold-start 등)을 전송하게 한다
    window.api.notifyReady()
    return off
  }, [openDoc])

  // 인쇄(메뉴/Ctrl+P) — 인쇄 전용 CSS가 툴바를 숨기고 문서 영역만 인쇄한다.
  // 한계: PDF/HWP는 가상화로 화면에 렌더된 페이지만 인쇄됨(전체 인쇄는 Phase 7+ 과제).
  useEffect(() => window.api.onPrint(() => window.print()), [])

  // 문서 내 외부 링크(http/https) 클릭 → 기본 브라우저로 열기
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a')
      if (!anchor) return
      // HTML <a href> + SVG <a xlink:href>(한글 링크) 모두 처리
      const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || ''
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault()
        window.api.openExternal(href)
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  // 텍스트 선택 중 .selecting 토글 (PDF·한글 텍스트레이어 공통)
  // → endOfContent 가 확장돼 빈 여백으로 드래그해도 선택이 윗줄로 튀지 않음
  useEffect(() => {
    const sel = '.textLayer, .hwp-textlayer'
    const onDown = (e: PointerEvent): void => {
      const tl = (e.target as HTMLElement | null)?.closest?.(sel)
      if (tl) tl.classList.add('selecting')
    }
    const onUp = (): void => {
      document
        .querySelectorAll('.textLayer.selecting, .hwp-textlayer.selecting')
        .forEach((el) => el.classList.remove('selecting'))
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerup', onUp)
    }
  }, [])

  const handleOpenClick = useCallback(() => {
    void window.api.openFileDialog()
  }, [])

  const handleClose = useCallback(() => {
    setDoc(null)
    setEntry(null)
  }, [])

  // 선택된 포맷의 뷰어를 코드 스플리팅으로 lazy 로드.
  const Viewer = useMemo(() => (entry ? lazy(entry.load) : null), [entry])

  return (
    <div className="app">
      <Toolbar
        fileName={doc?.name}
        format={entry?.label}
        onOpen={handleOpenClick}
        onClose={doc ? handleClose : undefined}
      />
      <DropZone onFile={openDoc}>
        <main className="stage">
          {!doc && <EmptyState onOpen={handleOpenClick} />}
          {doc && Viewer && (
            <ErrorBoundary key={openId}>
              <Suspense fallback={<div className="loading">불러오는 중…</div>}>
                <Viewer doc={doc} />
              </Suspense>
            </ErrorBoundary>
          )}
        </main>
      </DropZone>
    </div>
  )
}
