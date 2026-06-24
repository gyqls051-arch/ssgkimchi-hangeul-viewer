import { useEffect, useState } from 'react'
import { FAMILY_NAME, FAMILY_TAGLINE, FAMILY_URL } from '../lib/family'
import bannerUrl from '../assets/banner-exit.png'

/**
 * 종료 확인 모달 (배너 포함).
 * 메인이 창 닫기를 가로채 'show-exit-dialog' 를 보내면 열리고,
 * "종료" 선택 시 window.api.confirmExit() 로 실제 종료를 진행한다.
 * (설치본에서만 활성 — 개발/E2E 에선 메인이 신호를 보내지 않는다)
 */
export default function ExitDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => window.api.onShowExitDialog(() => setOpen(true)), [])

  // ESC = 취소
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        {/* 배너 — 교체: src/renderer/src/assets/banner-exit.png 를 같은 크기(720x240)로 덮어쓰면 됨 */}
        <button
          className="modal__banner"
          onClick={() => window.api.openExternal(FAMILY_URL)}
          title={`${FAMILY_NAME} — ${FAMILY_TAGLINE}`}
        >
          <img className="modal__banner-img" src={bannerUrl} alt={FAMILY_NAME} />
        </button>

        <h2 className="modal__title">싹싹김치 한글뷰어를 종료할까요?</h2>

        <div className="modal__actions">
          <button className="btn" onClick={() => setOpen(false)}>
            취소
          </button>
          <button className="btn btn--primary" onClick={() => window.api.confirmExit()}>
            종료
          </button>
        </div>
      </div>
    </div>
  )
}
