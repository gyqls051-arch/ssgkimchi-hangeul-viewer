import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import type { ViewerProps } from '../types'
import { createLogger } from '../../lib/logger'
import './xlsx.css'

const log = createLogger('xlsx')

// 한 시트에서 렌더할 최대 셀 수 (초대형 시트로 인한 프리즈 방지)
const MAX_CELLS = 200_000

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPE[c])
}

/**
 * 시트를 엑셀형 그리드(열문자 A·B·C, 행번호 1·2·3, 격자, sticky 헤더)로 렌더한다.
 * dense 모드(!data) 와 일반 모드 셀 접근을 모두 지원. 너무 크면 앞부분만 렌더(잘림 반환).
 * 셀 텍스트는 .w(서식 적용값)만 사용하고 HTML 이스케이프 → 주입 안전(별도 sanitize 불필요).
 */
function renderSheet(host: HTMLDivElement, sheet: XLSX.WorkSheet): boolean {
  const ref = sheet['!ref']
  if (!ref) {
    host.replaceChildren()
    return false
  }
  const range = XLSX.utils.decode_range(ref)
  const cols = range.e.c - range.s.c + 1
  const rows = range.e.r - range.s.r + 1

  let endR = range.e.r
  let truncated = false
  if (rows * cols > MAX_CELLS) {
    truncated = true
    const maxRows = Math.max(1, Math.floor(MAX_CELLS / Math.max(1, cols)))
    endR = Math.min(range.e.r, range.s.r + maxRows - 1)
  }

  // dense 모드면 !data 로, 아니면 주소로 셀 접근
  const data = (sheet as unknown as { '!data'?: XLSX.CellObject[][] })['!data']
  const getCell = (r: number, c: number): XLSX.CellObject | undefined =>
    data ? data[r]?.[c] : sheet[XLSX.utils.encode_cell({ r, c })]

  // 엑셀 원본의 열 너비 / 행 높이 적용 (없으면 기본값) — 칸이 일정하지 않게(원본처럼)
  const colInfo = sheet['!cols'] as Array<{ wpx?: number; wch?: number; hidden?: boolean }> | undefined
  const rowInfo = sheet['!rows'] as Array<{ hpx?: number; hpt?: number; hidden?: boolean }> | undefined
  const DEFAULT_COL = 80
  const DEFAULT_ROW = 22
  const MIN_COL = 32
  const MAX_COL = 220 // 원본이 과하게 넓게 잡은 열을 적당히 제한
  const clampCol = (w: number): number => Math.max(MIN_COL, Math.min(MAX_COL, Math.round(w)))
  const colWidth = (c: number): number => {
    const ci = colInfo?.[c]
    if (ci?.hidden) return 0
    if (ci?.wpx) return clampCol(ci.wpx)
    if (ci?.wch) return clampCol(ci.wch * 7)
    return DEFAULT_COL
  }
  const rowHeight = (r: number): number => {
    const ri = rowInfo?.[r]
    if (ri?.hidden) return 0
    if (ri?.hpx) return Math.max(18, Math.min(120, Math.round(ri.hpx)))
    if (ri?.hpt) return Math.max(18, Math.min(120, Math.round((ri.hpt * 96) / 72)))
    return DEFAULT_ROW
  }

  const parts: string[] = ['<table class="xlsx-grid"><colgroup><col style="width:46px" />']
  for (let c = range.s.c; c <= range.e.c; c++) {
    parts.push(`<col style="width:${colWidth(c)}px" />`)
  }
  parts.push('</colgroup><thead><tr><th class="xlsx-corner"></th>')
  for (let c = range.s.c; c <= range.e.c; c++) {
    parts.push(`<th class="xlsx-colhead">${XLSX.utils.encode_col(c)}</th>`)
  }
  parts.push('</tr></thead><tbody>')
  for (let r = range.s.r; r <= endR; r++) {
    parts.push(`<tr style="height:${rowHeight(r)}px"><th class="xlsx-rowhead">${r + 1}</th>`)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(r, c)
      const text = cell ? (cell.w ?? (cell.v != null ? String(cell.v) : '')) : ''
      const numeric = cell?.t === 'n'
      parts.push(`<td${numeric ? ' class="xlsx-num"' : ''}>${escapeHtml(text)}</td>`)
    }
    parts.push('</tr>')
  }
  parts.push('</tbody></table>')
  host.innerHTML = parts.join('')
  return truncated
}

export default function XlsxViewer({ doc }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [sheetError, setSheetError] = useState(false)

  const wb = useMemo<XLSX.WorkBook | null>(() => {
    try {
      // 공격면 축소: rich-text raw HTML(cellHTML)·수식 보존 비활성, dense 로 메모리 절감
      return XLSX.read(new Uint8Array(doc.bytes), {
        type: 'array',
        cellHTML: false,
        cellFormula: false,
        dense: true
      })
    } catch (err) {
      log.error('XLSX 파싱 실패', err)
      return null
    }
  }, [doc])

  const sheetNames = wb?.SheetNames ?? []

  useEffect(() => {
    if (wb) log.info(`XLSX 준비: ${wb.SheetNames.length}시트`)
  }, [wb])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !wb) return
    const name = sheetNames[active]
    const sheet = name ? wb.Sheets[name] : undefined
    if (!sheet) {
      host.replaceChildren()
      setTruncated(false)
      setSheetError(false)
      return
    }
    // 한 시트 렌더 실패가 뷰어 전체(탭 포함)를 무너뜨리지 않게 격리한다
    try {
      setTruncated(renderSheet(host, sheet))
      setSheetError(false)
      host.scrollTo({ top: 0, left: 0 })
    } catch (err) {
      log.error('시트 렌더 실패', err)
      host.replaceChildren()
      setTruncated(false)
      setSheetError(true)
    }
  }, [wb, active, sheetNames])

  if (!wb) {
    return (
      <div className="xlsx-status xlsx-status--error">
        <div className="xlsx-status__icon" aria-hidden>
          ⚠️
        </div>
        <div>Excel 문서를 열 수 없습니다.</div>
      </div>
    )
  }

  return (
    <div className="xlsx">
      {sheetError && (
        <div className="xlsx-banner">이 시트를 표시할 수 없습니다. 다른 시트를 선택해 보세요.</div>
      )}
      {truncated && (
        <div className="xlsx-banner">큰 시트입니다 — 앞부분만 표시합니다 (성능 보호).</div>
      )}
      <div className="xlsx-host" ref={hostRef} />
      <div className="xlsx-tabs">
        {sheetNames.map((n, i) => (
          <button
            key={`${n}-${i}`}
            className={`xlsx-tab${i === active ? ' xlsx-tab--active' : ''}`}
            onClick={() => setActive(i)}
            title={n}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}
