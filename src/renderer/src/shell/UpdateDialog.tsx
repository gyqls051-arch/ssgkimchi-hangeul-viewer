import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UpdateErrorCode, UpdateSnapshot } from '../../../preload/api'

const TITLE_ID = 'update-dialog-title'
const DESCRIPTION_ID = 'update-dialog-description'

const ERROR_MESSAGES: Record<UpdateErrorCode, string> = {
  network: '업데이트 서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.',
  signature: '업데이트 서명을 확인할 수 없어 다운로드를 차단했습니다.',
  metadata: '업데이트 무결성 정보를 확인할 수 없어 다운로드를 차단했습니다.',
  policy: '안정 버전 업데이트 정책에 맞지 않아 적용을 차단했습니다.',
  configuration: '업데이트 보안 설정을 확인할 수 없어 요청을 차단했습니다.',
  install: '이전 업데이트 설치를 시작하지 못했거나 완료하지 못했습니다.',
  internal: '업데이트 처리 중 오류가 발생했습니다.'
}

interface Props {
  open: boolean
  snapshot: UpdateSnapshot
  onClose: () => void
}

function statusText(snapshot: UpdateSnapshot, now: number): string {
  switch (snapshot.phase) {
    case 'unsupported':
      return '이 실행 환경에서는 업데이트 기능을 사용할 수 없습니다.'
    case 'idle':
      return '요청할 때만 안정 버전 업데이트를 확인합니다.'
    case 'checking':
      return '안정 버전 업데이트를 확인하고 있습니다…'
    case 'no-update':
      return `현재 ${snapshot.currentVersion} 버전이 최신입니다.`
    case 'available':
      return `${snapshot.availableVersion ?? '새'} 버전을 다운로드할 수 있습니다.`
    case 'downloading':
      return snapshot.cancelRequested
        ? '다운로드를 취소하고 있습니다…'
        : `업데이트를 다운로드하고 있습니다. ${Math.round(snapshot.progressPercent ?? 0)}%`
    case 'downloaded':
      return `${snapshot.availableVersion ?? '새'} 버전 다운로드가 완료되었습니다. 설치는 재시작 후 진행됩니다.`
    case 'installing':
      return '앱을 종료하고 업데이트 설치를 시작합니다…'
    case 'error': {
      const message = ERROR_MESSAGES[snapshot.errorCode ?? 'internal']
      if (!snapshot.retryAt || snapshot.retryAt <= now) return message
      const seconds = Math.max(1, Math.ceil((snapshot.retryAt - now) / 1000))
      return `${message} 약 ${seconds}초 후 다시 확인할 수 있습니다.`
    }
  }
}

export default function UpdateDialog({ open, snapshot, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const restoreFrameRef = useRef<number | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open || snapshot.phase !== 'error' || !snapshot.retryAt) return
    setNow(Date.now())
    const delay = Math.max(0, snapshot.retryAt - Date.now())
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 25, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [open, snapshot.phase, snapshot.retryAt])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      if (restoreFrameRef.current !== undefined) {
        cancelAnimationFrame(restoreFrameRef.current)
        restoreFrameRef.current = undefined
      }
      if (!wasOpenRef.current) {
        const active = document.activeElement
        previousFocusRef.current = active instanceof HTMLElement ? active : null
      }
      wasOpenRef.current = true
      if (!dialog.open) dialog.showModal()
      const frame = requestAnimationFrame(() => closeButtonRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }

    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    if (dialog.open) dialog.close()
    const previous = previousFocusRef.current
    previousFocusRef.current = null
    restoreFrameRef.current = requestAnimationFrame(() => {
      restoreFrameRef.current = undefined
      if (previous?.isConnected) previous.focus()
      else document.querySelector<HTMLButtonElement>('#open-document-button')?.focus()
    })
  }, [open])

  useEffect(
    () => () => {
      if (restoreFrameRef.current !== undefined) cancelAnimationFrame(restoreFrameRef.current)
    },
    []
  )

  const busy = snapshot.phase === 'installing'
  const retryBlocked = snapshot.phase === 'error' && Boolean(snapshot.retryAt && snapshot.retryAt > now)
  const description = useMemo(() => statusText(snapshot, now), [snapshot, now])

  const run = useCallback((action: () => Promise<UpdateSnapshot | null>) => {
    void action().catch(() => {
      // main이 정제된 error snapshot을 별도 이벤트로 보낸다. raw IPC 오류는 UI에 표시하지 않는다.
    })
  }, [])

  let primaryAction: (() => void) | null = null
  let primaryLabel = ''
  if (snapshot.phase === 'idle' || snapshot.phase === 'no-update' || snapshot.phase === 'error') {
    primaryLabel = '업데이트 확인'
    primaryAction = () => run(window.api.checkForUpdates)
  } else if (snapshot.phase === 'available') {
    primaryLabel = '다운로드'
    primaryAction = () => run(window.api.downloadUpdate)
  } else if (snapshot.phase === 'downloaded') {
    primaryLabel = '재시작 후 설치'
    primaryAction = () => run(window.api.installUpdate)
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal__panel update-dialog__panel">
        <h2 id={TITLE_ID} className="modal__title">
          소프트웨어 업데이트
        </h2>
        <p id={DESCRIPTION_ID} className="modal__description">
          설치된 버전: {snapshot.currentVersion}
        </p>

        <div
          className={snapshot.phase === 'error' ? 'update-dialog__status update-dialog__status--error' : 'update-dialog__status'}
          role={snapshot.phase === 'error' ? 'alert' : 'status'}
          aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {description}
        </div>

        {snapshot.phase === 'downloading' && (
          <div className="update-dialog__progress">
            <label htmlFor="update-download-progress">다운로드 진행률</label>
            <progress
              id="update-download-progress"
              max={100}
              value={snapshot.progressPercent ?? 0}
            />
          </div>
        )}

        <div className="modal__actions">
          <button
            ref={closeButtonRef}
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </button>
          {snapshot.phase === 'downloading' && (
            <button
              type="button"
              className="btn"
              onClick={() => run(window.api.cancelUpdateDownload)}
              disabled={snapshot.cancelRequested}
            >
              {snapshot.cancelRequested ? '취소 중…' : '다운로드 취소'}
            </button>
          )}
          {primaryAction && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={primaryAction}
              disabled={retryBlocked}
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </dialog>
  )
}
