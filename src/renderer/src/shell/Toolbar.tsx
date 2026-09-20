interface Props {
  fileName?: string
  format?: string
  onOpen: () => void
  /** 업데이트가 지원되는 설치본에서만 제공 */
  onUpdate?: () => void
  /** 문서가 열려 있을 때만 제공 — 문서를 닫고 홈으로 */
  onClose?: () => void
}

/** 상단 툴바 (앱 타이틀 · 현재 파일/포맷 · 업데이트 · 닫기 · 열기) */
export default function Toolbar({ fileName, format, onOpen, onUpdate, onClose }: Props) {
  return (
    <header className="toolbar" aria-label="애플리케이션 도구 모음">
      <div className="toolbar__brand">
        <span className="toolbar__logo" aria-hidden>
          📚
        </span>
        <span className="toolbar__title">싹싹김치 한글뷰어</span>
      </div>

      <div className="toolbar__center" aria-live="polite" aria-atomic="true">
        {fileName && (
          <div className="toolbar__file" title={fileName} aria-label={`현재 문서 ${fileName}`}>
            {format && <span className="badge">{format}</span>}
            <span className="toolbar__filename">{fileName}</span>
          </div>
        )}
      </div>

      <div className="toolbar__actions" role="group" aria-label="문서 및 앱 작업">
        <button
          type="button"
          className="btn"
          title="자매 제품 — 프리미어 컷편집 가속기"
          onClick={() => {
            void window.api.openExternal(
              'https://www.offcut.dev/?utm_source=ssakssak_hangeul&utm_medium=app_brand',
            )
          }}
        >
          오프컷
        </button>
        {onUpdate && (
          <button type="button" className="btn" onClick={onUpdate} title="소프트웨어 업데이트">
            업데이트
          </button>
        )}
        {onClose && (
          <button type="button" className="btn" onClick={onClose} title="문서 닫기">
            닫기
          </button>
        )}
        <button
          id="open-document-button"
          type="button"
          className="btn btn--primary"
          onClick={onOpen}
        >
          열기
        </button>
      </div>
    </header>
  )
}
