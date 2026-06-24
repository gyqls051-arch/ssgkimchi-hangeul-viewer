import { useCallback, useEffect, useState } from 'react'

interface Props {
  onOpen: () => void
}

type RecentItem = Awaited<ReturnType<typeof window.api.listRecent>>[number]

const FORMATS = [
  { label: '한글', ext: 'HWP · HWPX' },
  { label: 'PDF', ext: 'PDF' },
  { label: 'Word', ext: 'DOCX' },
  { label: 'Excel', ext: 'XLSX' },
  { label: 'PowerPoint', ext: 'PPTX' }
]

const EXT_LABEL: Record<string, string> = {
  '.pdf': 'PDF',
  '.hwp': '한글',
  '.hwpx': '한글',
  '.docx': 'Word',
  '.xlsx': 'Excel',
  '.pptx': 'PowerPoint'
}

/** 문서가 열리지 않았을 때의 첫 화면 (지원 포맷 안내 + 최근 파일) */
export default function EmptyState({ onOpen }: Props) {
  const [recent, setRecent] = useState<RecentItem[]>([])

  const refresh = useCallback(() => {
    void window.api.listRecent().then(setRecent)
  }, [])

  useEffect(() => refresh(), [refresh])

  const openRecent = useCallback(
    (path: string) => {
      void window.api.openRecent(path)
      // 죽은 경로면 메인이 목록에서 제거하므로 잠시 후 새로고침
      setTimeout(refresh, 400)
    },
    [refresh]
  )

  const clear = useCallback(() => {
    void window.api.clearRecent().then(refresh)
  }, [refresh])

  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden>
        📂
      </div>
      <h1 className="empty__title">문서를 열어보세요</h1>
      <p className="empty__sub">파일을 이 창에 끌어다 놓거나, 아래 버튼으로 선택하세요.</p>

      <button className="btn btn--primary btn--lg" onClick={onOpen}>
        파일 열기
      </button>

      <ul className="empty__formats">
        {FORMATS.map((f) => (
          <li key={f.label} className="empty__format">
            <span className="empty__format-label">{f.label}</span>
            <span className="empty__format-ext">{f.ext}</span>
          </li>
        ))}
      </ul>

      {recent.length > 0 && (
        <div className="recent">
          <div className="recent__head">
            <span className="recent__title">최근 연 파일</span>
            <button className="recent__clear" onClick={clear}>
              지우기
            </button>
          </div>
          <ul className="recent__list">
            {recent.map((r) => (
              <li key={r.path}>
                <button
                  className="recent__item"
                  onClick={() => openRecent(r.path)}
                  title={r.path}
                >
                  <span className="badge">{EXT_LABEL[r.ext] ?? r.ext.replace('.', '').toUpperCase()}</span>
                  <span className="recent__name">{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
