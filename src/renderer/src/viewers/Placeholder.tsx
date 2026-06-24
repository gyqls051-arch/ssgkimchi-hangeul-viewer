import type { ViewerProps } from './types'

const KNOWN: Record<string, string> = {
  '.pdf': 'PDF',
  '.hwp': '한글(HWP)',
  '.hwpx': '한글(HWPX)',
  '.docx': 'Word',
  '.xlsx': 'Excel',
  '.pptx': 'PowerPoint'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 실제 뷰어가 붙기 전까지 사용하는 공용 자리표시자.
 * - 알려진 포맷: "다음 단계에서 제공" 안내
 * - 미지원 포맷: 우아한 거부 메시지
 */
export default function Placeholder({ doc }: ViewerProps) {
  const label = KNOWN[doc.ext]
  const supported = Boolean(label)

  return (
    <div className="placeholder">
      <div className="placeholder__icon" aria-hidden>
        {supported ? '📄' : '🚫'}
      </div>
      <div className="placeholder__name">{doc.name}</div>
      <div className="placeholder__meta">
        <span className="badge">{label ?? (doc.ext || '알 수 없음')}</span>
        <span>{humanSize(doc.bytes.byteLength)}</span>
      </div>
      <p className="placeholder__msg">
        {supported
          ? `${label} 뷰어는 곧 제공됩니다. (개발 진행 중)`
          : '이 형식은 아직 지원하지 않습니다. 한글(HWP/HWPX)·PDF·Word·Excel·PowerPoint 파일을 열어주세요.'}
      </p>
    </div>
  )
}
