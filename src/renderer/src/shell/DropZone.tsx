import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { extOf } from '../lib/magic'
import { createLogger } from '../lib/logger'
import { REGISTRY } from '../viewers/registry'
import { MAX_DOC_BYTES } from '../../../preload/api'
import type { DocInput } from '../viewers/types'

const log = createLogger('dropzone')

interface Props {
  onFile: (doc: DocInput) => void
  children: ReactNode
}

interface Notice {
  kind: 'info' | 'error'
  text: string
}

const SUPPORTED_EXTS = new Set(REGISTRY.flatMap((v) => v.extensions))
const FORMAT_BADGES = REGISTRY.flatMap((v) => v.extensions).map((e) =>
  e.replace('.', '').toUpperCase()
)
const MAX_MB = Math.floor(MAX_DOC_BYTES / 1024 / 1024)

/** 드래그 데이터에 "파일"이 들어있는지 (텍스트/이미지 내부 드래그는 false) */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * 창 전체 파일 드래그&드롭 (window + 캡처 단계).
 * - dragstart 차단: 문서 내용(텍스트/이미지)을 드래그로 "이동"하려는 동작을 막아
 *   텍스트 선택을 방해하지 않고 파일드롭 오버레이가 잘못 뜨지 않게 한다(핵심).
 * - 오버레이 표시는 depth 카운팅 대신 ①dragleave(relatedTarget=null=창 밖) 즉시 숨김
 *   + ②dragover 침묵 감지 타이머(스펙상 커서가 창 안에 있는 동안 ~350ms 간격 재발화)의
 *   2중 구조 — enter/leave 짝이 어긋나도 오버레이가 눌어붙지 않는다.
 * - 드롭 파일은 preload(webUtils.getPathForFile)를 통해 메인 프로세스의 단일 열기
 *   경로로 위임 → 다이얼로그·파일연결과 동일하게 검증되고 최근 목록에도 남는다.
 *   경로가 없는 File(압축파일/메일 첨부에서 드래그)과 미지원 확장자(안내 카드 표시용)만
 *   렌더러에서 직접 읽되 크기 상한을 동일하게 적용한다.
 * - 관리자 권한 실행 시 Windows(UIPI)가 일반 탐색기→앱 드래그를 차단(앱 외적 제약).
 */
export default function DropZone({ onFile, children }: Props) {
  // 0 = 드래그 없음, n = 드래그 중인 파일 개수 (오버레이 힌트에 사용)
  const [dragCount, setDragCount] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const idleTimer = useRef<number | undefined>(undefined)
  const noticeTimer = useRef<number | undefined>(undefined)

  const showNotice = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }, [])

  useEffect(() => {
    const hide = (): void => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      setDragCount(0)
    }

    // 내부 콘텐츠 드래그 금지 (텍스트 선택 보호 + 오버레이 오작동 방지)
    const onDragStart = (e: DragEvent): void => e.preventDefault()

    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragCount(Math.max(1, e.dataTransfer?.items.length ?? 1))
      // dragover 가 멎으면(창 밖 이탈·ESC 취소 등 leave 유실 케이스) 자동 숨김
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => setDragCount(0), 900)
    }

    const onDragLeave = (e: DragEvent): void => {
      // relatedTarget 이 null 이면 창 밖으로 나간 것 — 즉시 숨김 (요소 간 이동은 무시)
      if (e.relatedTarget === null) hide()
    }

    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      hide()

      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const file = files[0]
      if (files.length > 1) {
        showNotice('info', `파일 ${files.length}개 중 첫 번째(${file.name})만 엽니다.`)
      }

      // 1) 지원 포맷 + 실경로 → 메인 프로세스 단일 열기 경로 (검증 + 최근 목록)
      if (SUPPORTED_EXTS.has(extOf(file.name)) && window.api.openDroppedFile(file)) return

      // 2) 폴백: 경로 없는 File 또는 미지원 확장자(→ 안내 카드) — 크기 상한은 동일 적용
      if (file.size > MAX_DOC_BYTES) {
        showNotice('error', `파일이 너무 큽니다 (최대 ${MAX_MB}MB).`)
        return
      }
      file
        .arrayBuffer()
        .then((bytes) => onFile({ name: file.name, ext: extOf(file.name), bytes }))
        .catch((err) => {
          log.error('드롭 파일 읽기 실패:', err)
          showNotice('error', '파일을 읽지 못했습니다. 다시 시도해 주세요.')
        })
    }

    const opts: AddEventListenerOptions = { capture: true }
    window.addEventListener('dragstart', onDragStart, opts)
    window.addEventListener('dragover', onDragOver, opts)
    window.addEventListener('dragleave', onDragLeave, opts)
    window.addEventListener('drop', onDrop, opts)
    return () => {
      window.removeEventListener('dragstart', onDragStart, opts)
      window.removeEventListener('dragover', onDragOver, opts)
      window.removeEventListener('dragleave', onDragLeave, opts)
      window.removeEventListener('drop', onDrop, opts)
      if (idleTimer.current) clearTimeout(idleTimer.current)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [onFile, showNotice])

  return (
    <div className="dropzone">
      {children}
      {dragCount > 0 && (
        <div className="dropzone__overlay">
          <div className="dropzone__card">
            <div className="dropzone__card-icon" aria-hidden>
              📥
            </div>
            <div className="dropzone__hint">여기에 놓아서 열기</div>
            {dragCount > 1 && (
              <div className="dropzone__sub">파일 {dragCount}개 중 첫 번째만 열립니다</div>
            )}
            <div className="dropzone__formats">
              {FORMAT_BADGES.map((f) => (
                <span key={f} className="badge">
                  {f}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {notice && (
        <div className={`dropzone__diag dropzone__diag--${notice.kind}`}>{notice.text}</div>
      )}
    </div>
  )
}
