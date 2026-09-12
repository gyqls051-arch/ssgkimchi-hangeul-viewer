import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { ViewerProps } from '../types'
import { createLogger } from '../../lib/logger'
import './xlsx.css'

const log = createLogger('xlsx')
const ROW_WINDOW = 100
const COLUMN_WINDOW = 32
const PARSE_TIMEOUT_MS = 15_000
const SHEET_TIMEOUT_MS = 10_000

interface CellView {
  text: string
  numeric: boolean
  truncated: boolean
}

interface RowView {
  number: number
  cells: CellView[]
}

interface SheetView {
  name: string
  totalRows: number
  totalColumns: number
  firstRow: number
  firstColumn: number
  rowStart: number
  columnStart: number
  columns: string[]
  rows: RowView[]
  truncatedCells: number
}

type WorkerResponse =
  | { type: 'ready'; generation: number; sheetNames: string[] }
  | ({ type: 'sheet'; generation: number; requestId: number } & SheetView)
  | { type: 'error'; generation: number; requestId?: number; message: string }

export default function XlsxViewer({ doc }: ViewerProps) {
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef(0)
  const timeoutRef = useRef<number | undefined>(undefined)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [sheet, setSheet] = useState<SheetView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const clearWorkerTimeout = useCallback(() => {
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = undefined
  }, [])

  const requestSheet = useCallback(
    (sheetIndex: number, rowStart: number, columnStart: number): void => {
      const worker = workerRef.current
      if (!worker) {
        setError('Excel 문서 처리 프로세스를 사용할 수 없습니다.')
        setLoading(false)
        return
      }
      const generation = generationRef.current
      const requestId = ++requestRef.current
      clearWorkerTimeout()
      setLoading(true)
      setError(null)
      worker.postMessage({
        type: 'sheet',
        generation,
        requestId,
        sheetIndex,
        rowStart,
        columnStart
      })
      timeoutRef.current = window.setTimeout(() => {
        if (generation !== generationRef.current || requestId !== requestRef.current) return
        worker.terminate()
        if (workerRef.current === worker) workerRef.current = null
        setError('Excel 시트 표시 시간이 안전 한도를 초과해 작업 프로세스를 종료했습니다.')
        setLoading(false)
      }, SHEET_TIMEOUT_MS)
    },
    [clearWorkerTimeout]
  )

  useEffect(() => {
    const generation = ++generationRef.current
    requestRef.current = 0
    setSheetNames([])
    setSheet(null)
    setActive(0)
    setError(null)
    setLoading(true)

    const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), {
      type: 'module',
      name: 'xlsx-parser'
    })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
      const message = event.data
      if (message.generation !== generation || generation !== generationRef.current) return
      if (message.type === 'ready') {
        clearWorkerTimeout()
        setSheetNames(message.sheetNames)
        if (message.sheetNames.length === 0) {
          setError('표시할 시트가 없습니다.')
          setLoading(false)
        } else {
          requestSheet(0, 0, 0)
        }
        return
      }
      if (message.type === 'error') {
        if (message.requestId !== undefined && message.requestId !== requestRef.current) return
        clearWorkerTimeout()
        log.error('XLSX worker 실패', message.message)
        setError(message.message || 'Excel 문서를 처리할 수 없습니다.')
        setLoading(false)
        return
      }
      if (message.requestId !== requestRef.current) return
      clearWorkerTimeout()
      setSheet(message)
      setLoading(false)
    }

    worker.onerror = (event): void => {
      if (generation !== generationRef.current) return
      clearWorkerTimeout()
      log.error('XLSX worker 오류', event.message)
      setError('Excel 문서 처리 프로세스가 중단되었습니다.')
      setLoading(false)
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }

    const transferable = doc.bytes.slice(0)
    worker.postMessage({ type: 'parse', generation, bytes: transferable }, [transferable])
    timeoutRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current) return
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      setError('Excel 문서 분석 시간이 안전 한도를 초과했습니다.')
      setLoading(false)
    }, PARSE_TIMEOUT_MS)

    return () => {
      clearWorkerTimeout()
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [clearWorkerTimeout, doc, requestSheet])

  const selectSheet = useCallback(
    (index: number) => {
      if (index < 0 || index >= sheetNames.length || index === active) return
      setActive(index)
      setSheet(null)
      requestSheet(index, 0, 0)
    },
    [active, requestSheet, sheetNames.length]
  )

  const onTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (sheetNames.length === 0) return
      let next = index
      if (event.key === 'ArrowRight') next = (index + 1) % sheetNames.length
      else if (event.key === 'ArrowLeft') next = (index - 1 + sheetNames.length) % sheetNames.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = sheetNames.length - 1
      else return

      event.preventDefault()
      if (next !== index) selectSheet(next)
      window.requestAnimationFrame(() => tabRefs.current[next]?.focus())
    },
    [selectSheet, sheetNames.length]
  )

  const moveRows = useCallback(
    (delta: number) => {
      if (!sheet) return
      requestSheet(active, sheet.rowStart + delta, sheet.columnStart)
    },
    [active, requestSheet, sheet]
  )

  const moveColumns = useCallback(
    (delta: number) => {
      if (!sheet) return
      requestSheet(active, sheet.rowStart, sheet.columnStart + delta)
    },
    [active, requestSheet, sheet]
  )

  return (
    <div className="xlsx">
      {error && sheet && (
        <div
          className="xlsx-status xlsx-status--error xlsx-status--inline"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <span aria-hidden>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {sheet && (
        <div className="xlsx-windowbar">
          <div
            className="xlsx-windowbar__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>
              행 {sheet.rows.length ? sheet.rows[0].number : 0}–
              {sheet.rows.at(-1)?.number ?? 0} / {sheet.totalRows.toLocaleString()}, 열{' '}
              {sheet.columns[0] ?? '-'}–{sheet.columns.at(-1) ?? '-'} /{' '}
              {sheet.totalColumns.toLocaleString()}
              {loading ? ' (불러오는 중)' : ''}
            </span>
            {sheet.truncatedCells > 0 && (
              <span>긴 셀 {sheet.truncatedCells}개는 4,096자로 제한했습니다.</span>
            )}
          </div>
          <div className="xlsx-windowbar__actions" role="group" aria-label="표시 범위 이동">
            <button
              type="button"
              className="textbtn"
              disabled={sheet.rowStart <= sheet.firstRow || loading}
              onClick={() => moveRows(-ROW_WINDOW)}
            >
              이전 행
            </button>
            <button
              type="button"
              className="textbtn"
              disabled={
                sheet.rowStart + sheet.rows.length >= sheet.firstRow + sheet.totalRows || loading
              }
              onClick={() => moveRows(ROW_WINDOW)}
            >
              다음 행
            </button>
            <button
              type="button"
              className="textbtn"
              disabled={sheet.columnStart <= sheet.firstColumn || loading}
              onClick={() => moveColumns(-COLUMN_WINDOW)}
            >
              이전 열
            </button>
            <button
              type="button"
              className="textbtn"
              disabled={
                sheet.columnStart + sheet.columns.length >=
                  sheet.firstColumn + sheet.totalColumns || loading
              }
              onClick={() => moveColumns(COLUMN_WINDOW)}
            >
              다음 열
            </button>
          </div>
        </div>
      )}

      <div
        id="xlsx-sheet-panel"
        className={`xlsx-host${sheet ? '' : ' xlsx-host--empty'}`}
        role="tabpanel"
        aria-labelledby={sheetNames.length > 0 ? `xlsx-sheet-tab-${active}` : undefined}
        aria-label={sheetNames.length === 0 ? 'Excel 문서' : undefined}
        aria-busy={loading}
        tabIndex={0}
      >
        {error && !sheet && (
          <div
            className="xlsx-status xlsx-status--error"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <div className="xlsx-status__icon" aria-hidden>
              ⚠️
            </div>
            <div>{error}</div>
          </div>
        )}
        {loading && !sheet && !error && (
          <div className="xlsx-status" role="status" aria-live="polite" aria-atomic="true">
            Excel 문서를 안전한 작업 프로세스에서 분석하는 중…
          </div>
        )}
        {sheet && (
          <table className="xlsx-grid">
            <thead>
              <tr>
                <th className="xlsx-corner" aria-label="행 번호" />
                {sheet.columns.map((column) => (
                  <th key={column} className="xlsx-colhead" scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.number}>
                  <th className="xlsx-rowhead" scope="row">
                    {row.number}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td
                      key={`${row.number}-${sheet.columns[index]}`}
                      className={cell.numeric ? 'xlsx-num' : undefined}
                      title={cell.truncated ? '긴 셀 내용이 안전 한도로 잘렸습니다.' : undefined}
                    >
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="xlsx-tabs" role="tablist" aria-label="Excel 시트">
        {sheetNames.map((name, index) => (
          <button
            key={`${name}-${index}`}
            id={`xlsx-sheet-tab-${index}`}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
            type="button"
            role="tab"
            aria-controls="xlsx-sheet-panel"
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            className={`xlsx-tab${index === active ? ' xlsx-tab--active' : ''}`}
            onClick={() => selectSheet(index)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            title={name}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}
