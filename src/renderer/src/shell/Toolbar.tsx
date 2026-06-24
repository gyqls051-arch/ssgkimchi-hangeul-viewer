interface Props {
  fileName?: string
  format?: string
  onOpen: () => void
  /** 문서가 열려 있을 때만 제공 — 문서를 닫고 홈으로 */
  onClose?: () => void
}

/** 상단 툴바 (앱 타이틀 · 현재 파일/포맷 · 닫기 · 열기) */
export default function Toolbar({ fileName, format, onOpen, onClose }: Props) {
  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__logo" aria-hidden>
          📚
        </span>
        <span className="toolbar__title">싹싹김치 한글뷰어</span>
      </div>

      <div className="toolbar__center">
        {fileName && (
          <div className="toolbar__file" title={fileName}>
            {format && <span className="badge">{format}</span>}
            <span className="toolbar__filename">{fileName}</span>
          </div>
        )}
      </div>

      <div className="toolbar__actions">
        {onClose && (
          <button className="btn" onClick={onClose} title="문서 닫기">
            닫기
          </button>
        )}
        <button className="btn btn--primary" onClick={onOpen}>
          열기
        </button>
      </div>
    </header>
  )
}
