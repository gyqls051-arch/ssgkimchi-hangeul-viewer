import { useCallback, useEffect, useRef, useState } from 'react'

const TITLE_ID = 'exit-dialog-title'
const DESCRIPTION_ID = 'exit-dialog-description'

interface Props {
  onBeforeOpen?: () => void
}

/** 설치본 창 닫기 확인. 광고 없이 취소를 기본 포커스로 두는 native modal dialog다. */
export default function ExitDialog({ onBeforeOpen }: Props) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const restoreFrameRef = useRef<number | undefined>(undefined)
  const wasOpenRef = useRef(false)

  useEffect(
    () =>
      window.api.onShowExitDialog(() => {
        onBeforeOpen?.()
        if (restoreFrameRef.current !== undefined) {
          cancelAnimationFrame(restoreFrameRef.current)
          restoreFrameRef.current = undefined
        }
        const active = document.activeElement
        previousFocusRef.current = active instanceof HTMLElement ? active : null
        setOpen(true)
      }),
    [onBeforeOpen]
  )

  const cancelExit = useCallback(() => {
    window.api.cancelExit()
    setOpen(false)
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      wasOpenRef.current = true
      if (!dialog.open) dialog.showModal()
      const frame = requestAnimationFrame(() => cancelButtonRef.current?.focus())
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

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      onCancel={(event) => {
        event.preventDefault()
        cancelExit()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) cancelExit()
      }}
    >
      <div className="modal__panel">
        <h2 id={TITLE_ID} className="modal__title">
          싹싹김치 한글뷰어를 종료할까요?
        </h2>
        <p id={DESCRIPTION_ID} className="modal__description">
          열어 둔 문서는 변경하지 않으며 뷰어만 종료합니다.
        </p>
        <div className="modal__actions">
          <button ref={cancelButtonRef} type="button" className="btn" onClick={cancelExit}>
            취소
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.api.confirmExit()}
          >
            종료
          </button>
        </div>
      </div>
    </dialog>
  )
}
