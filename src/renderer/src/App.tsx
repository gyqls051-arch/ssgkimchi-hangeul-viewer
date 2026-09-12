import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Toolbar from './shell/Toolbar'
import DropZone from './shell/DropZone'
import EmptyState from './shell/EmptyState'
import ErrorBoundary from './shell/ErrorBoundary'
import ExitDialog from './shell/ExitDialog'
import UpdateDialog from './shell/UpdateDialog'
import { resolveViewer } from './viewers/registry'
import type { DocInput, ViewerEntry } from './viewers/types'
import type { UpdateSnapshot } from '../../preload/api'
import { createLogger } from './lib/logger'

const log = createLogger('app')
const PRINT_DISABLED_MESSAGE =
  '현재 버전은 전체 문서 출력의 정확성을 보장할 수 없어 인쇄 기능을 비활성화했습니다.'

type OpenIntent = 'main' | 'local'

export default function App() {
  const [doc, setDoc] = useState<DocInput | null>(null)
  const [entry, setEntry] = useState<ViewerEntry | null>(null)
  const [printNotice, setPrintNotice] = useState<{ id: number; text: string } | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const activeOpenIntentRef = useRef<OpenIntent>('main')
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

  const beginLocalOpen = useCallback(() => {
    activeOpenIntentRef.current = 'local'
    // pathless File 읽기가 새 사용자 의도이므로, 이전 main descriptor read를 즉시 무효화한다.
    window.api.cancelPendingOpen()
  }, [])

  const openLocalDoc = useCallback(
    (d: DocInput) => {
      if (activeOpenIntentRef.current !== 'local') return
      openDoc(d)
    },
    [openDoc]
  )

  // 다이얼로그·메뉴·파일연결로 열린 파일은 모두 이 단일 채널로 들어온다.
  useEffect(() => {
    const offIntent = window.api.onOpenIntent(() => {
      activeOpenIntentRef.current = 'main'
    })
    const offFile = window.api.onOpenFile((file) => {
      // 더 최신 pathless drop이 시작된 뒤 늦게 도착한 main 결과는 표시하지 않는다.
      if (activeOpenIntentRef.current !== 'main') return
      openDoc({ name: file.name, ext: file.ext, bytes: file.bytes })
    })
    // 리스너 부착 완료를 알려 메인이 큐된 파일(파일연결 cold-start 등)을 전송하게 한다.
    window.api.notifyReady()
    return () => {
      offIntent()
      offFile()
    }
  }, [openDoc])

  // push listener를 먼저 붙인 뒤 snapshot을 조회하고 revision으로 경합을 제거한다.
  useEffect(() => {
    let active = true
    const applySnapshot = (next: UpdateSnapshot): void => {
      if (!active) return
      setUpdateSnapshot((previous) =>
        !previous || next.revision >= previous.revision ? next : previous
      )
    }
    const offState = window.api.onUpdateState(applySnapshot)
    const offShow = window.api.onShowUpdateDialog(() => setUpdateDialogOpen(true))
    void window.api
      .getUpdateState()
      .then((snapshot) => {
        if (snapshot) applySnapshot(snapshot)
      })
      .catch((error: unknown) => log.warn('업데이트 상태 조회 실패', error))
    return () => {
      active = false
      offState()
      offShow()
    }
  }, [])

  // 현재 viewer들은 페이지/표 범위를 가상화하므로 window.print()는 조용히 일부만 출력한다.
  // 완전한 print-mode가 구현되기 전까지 메뉴는 명시적 안내만 하고 fail closed한다.
  useEffect(
    () =>
      window.api.onPrint(() => {
        setPrintNotice((previous) => ({
          id: (previous?.id ?? 0) + 1,
          text: PRINT_DISABLED_MESSAGE
        }))
      }),
    []
  )

  useEffect(() => {
    if (!printNotice) return
    const timer = window.setTimeout(() => setPrintNotice(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [printNotice])

  // 문서 안의 모든 anchor 기본 동작을 먼저 차단하고, 절대 HTTPS URL만 확인 후 외부 브라우저로 연다.
  useEffect(() => {
    const onAnchorActivation = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const anchor = target?.closest('a')
      if (!anchor) return

      event.preventDefault()
      event.stopPropagation()

      const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || ''
      try {
        const parsed = new URL(href)
        if (parsed.protocol !== 'https:') return
        void window.api.openExternal(parsed.href).catch((error: unknown) => {
          log.warn('외부 링크 요청 실패', error)
        })
      } catch {
        // 상대/손상 URL과 javascript:, file:, data: 등은 기본 탐색 없이 폐기한다.
      }
    }
    document.addEventListener('click', onAnchorActivation, true)
    document.addEventListener('auxclick', onAnchorActivation, true)
    return () => {
      document.removeEventListener('click', onAnchorActivation, true)
      document.removeEventListener('auxclick', onAnchorActivation, true)
    }
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
    // 닫기 버튼이 unmount된 뒤 남아 있는 열기 버튼으로 키보드 포커스를 옮긴다.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#open-document-button')?.focus())
  }, [])

  const openUpdateDialog = useCallback(() => setUpdateDialogOpen(true), [])
  const closeUpdateDialog = useCallback(() => setUpdateDialogOpen(false), [])

  // 선택된 포맷의 뷰어를 코드 스플리팅으로 lazy 로드.
  const Viewer = useMemo(() => (entry ? lazy(entry.load) : null), [entry])

  return (
    <div className="app">
      <Toolbar
        fileName={doc?.name}
        format={entry?.label}
        onOpen={handleOpenClick}
        onUpdate={
          updateSnapshot && updateSnapshot.phase !== 'unsupported' ? openUpdateDialog : undefined
        }
        onClose={doc ? handleClose : undefined}
      />
      <DropZone onFile={openLocalDoc} onLocalOpenIntent={beginLocalOpen}>
        <main className="stage">
          {!doc && <EmptyState onOpen={handleOpenClick} />}
          {doc && Viewer && (
            <ErrorBoundary key={openId}>
              <Suspense
                fallback={
                  <div className="loading" role="status" aria-live="polite">
                    불러오는 중…
                  </div>
                }
              >
                <Viewer doc={doc} />
              </Suspense>
            </ErrorBoundary>
          )}
        </main>
      </DropZone>
      {printNotice && (
        <div
          key={printNotice.id}
          className="dropzone__diag dropzone__diag--info"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {printNotice.text}
        </div>
      )}
      {updateSnapshot && updateSnapshot.phase !== 'unsupported' && (
        <UpdateDialog
          open={updateDialogOpen}
          snapshot={updateSnapshot}
          onClose={closeUpdateDialog}
        />
      )}
      <ExitDialog onBeforeOpen={closeUpdateDialog} />
    </div>
  )
}
