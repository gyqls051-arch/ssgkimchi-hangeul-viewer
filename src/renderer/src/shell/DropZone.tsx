import { useEffect, useRef, useState, type ReactNode } from 'react'
import { extOf } from '../lib/magic'
import { createLogger } from '../lib/logger'
import type { DocInput } from '../viewers/types'

const log = createLogger('dropzone')

interface Props {
  onFile: (doc: DocInput) => void
  children: ReactNode
}

/** 드래그 데이터에 "파일"이 들어있는지 (텍스트/이미지 내부 드래그는 false) */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * 창 전체 파일 드래그&드롭 (window + 캡처 단계).
 * - dragstart 차단: 문서 내용(텍스트/이미지)을 드래그로 "이동"하려는 동작을 막아
 *   텍스트 선택을 방해하지 않고 파일드롭 오버레이가 잘못 뜨지 않게 한다(핵심).
 * - 오버레이/드롭 처리는 "진짜 파일 드래그(types에 Files)"일 때만.
 * - 관리자 권한 실행 시 Windows(UIPI)가 일반 탐색기→앱 드래그를 차단(앱 외적 제약).
 */
export default function DropZone({ onFile, children }: Props) {
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const depth = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    // 내부 콘텐츠 드래그 금지 (텍스트 선택 보호 + 오버레이 오작동 방지)
    const onDragStart = (e: DragEvent): void => e.preventDefault()

    const onDragOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setOver(true)
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      file
        .arrayBuffer()
        .then((bytes) => onFile({ name: file.name, ext: extOf(file.name), bytes }))
        .catch((err) => {
          log.error('드롭 파일 읽기 실패:', err)
          setError('파일을 읽지 못했습니다. 다시 시도해 주세요.')
          if (timer.current) clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setError(null), 4000)
        })
    }

    const opts: AddEventListenerOptions = { capture: true }
    window.addEventListener('dragstart', onDragStart, opts)
    window.addEventListener('dragover', onDragOver, opts)
    window.addEventListener('dragenter', onDragEnter, opts)
    window.addEventListener('dragleave', onDragLeave, opts)
    window.addEventListener('drop', onDrop, opts)
    return () => {
      window.removeEventListener('dragstart', onDragStart, opts)
      window.removeEventListener('dragover', onDragOver, opts)
      window.removeEventListener('dragenter', onDragEnter, opts)
      window.removeEventListener('dragleave', onDragLeave, opts)
      window.removeEventListener('drop', onDrop, opts)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [onFile])

  return (
    <div className="dropzone">
      {children}
      {over && (
        <div className="dropzone__overlay">
          <div className="dropzone__hint">여기에 놓아서 열기</div>
        </div>
      )}
      {error && <div className="dropzone__diag">{error}</div>}
    </div>
  )
}
