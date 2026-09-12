import * as XLSX from 'xlsx'

const ROW_WINDOW = 100
const COLUMN_WINDOW = 32
const MAX_CELL_CHARS = 4_096

interface ParseMessage {
  type: 'parse'
  generation: number
  bytes: ArrayBuffer
}

interface SheetMessage {
  type: 'sheet'
  generation: number
  requestId: number
  sheetIndex: number
  rowStart: number
  columnStart: number
}

type RequestMessage = ParseMessage | SheetMessage

interface CellView {
  text: string
  numeric: boolean
  truncated: boolean
}

interface RowView {
  number: number
  cells: CellView[]
}

let workbook: XLSX.WorkBook | null = null
let activeGeneration = 0

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function postError(generation: number, requestId: number | undefined, error: unknown): void {
  self.postMessage({
    type: 'error',
    generation,
    ...(requestId === undefined ? {} : { requestId }),
    message: messageOf(error)
  })
}

function formattedCell(cell: XLSX.CellObject | undefined): CellView {
  if (!cell) return { text: '', numeric: false, truncated: false }
  const original = cell.w ?? (cell.v == null ? '' : String(cell.v))
  const truncated = original.length > MAX_CELL_CHARS
  return {
    text: truncated ? `${original.slice(0, MAX_CELL_CHARS)}…` : original,
    numeric: cell.t === 'n',
    truncated
  }
}

self.onmessage = (event: MessageEvent<RequestMessage>): void => {
  const message = event.data
  if (message.type === 'parse') {
    activeGeneration = message.generation
    workbook = null
    try {
      workbook = XLSX.read(new Uint8Array(message.bytes), {
        type: 'array',
        cellHTML: false,
        cellFormula: false,
        cellStyles: false,
        cellNF: false,
        dense: true
      })
      self.postMessage({
        type: 'ready',
        generation: message.generation,
        sheetNames: workbook.SheetNames.slice(0, 1_024)
      })
    } catch (error: unknown) {
      postError(message.generation, undefined, error)
    }
    return
  }

  if (message.generation !== activeGeneration || !workbook) return
  try {
    const name = workbook.SheetNames[message.sheetIndex]
    const sheet = name ? workbook.Sheets[name] : undefined
    if (!name || !sheet) throw new Error('시트를 찾을 수 없습니다.')

    const reference = sheet['!ref']
    if (!reference) {
      self.postMessage({
        type: 'sheet',
        generation: message.generation,
        requestId: message.requestId,
        name,
        totalRows: 0,
        totalColumns: 0,
        firstRow: 0,
        firstColumn: 0,
        rowStart: 0,
        columnStart: 0,
        columns: [],
        rows: [],
        truncatedCells: 0
      })
      return
    }

    const range = XLSX.utils.decode_range(reference)
    const totalRows = Math.max(0, range.e.r - range.s.r + 1)
    const totalColumns = Math.max(0, range.e.c - range.s.c + 1)
    if (!Number.isSafeInteger(totalRows) || !Number.isSafeInteger(totalColumns)) {
      throw new Error('시트 범위가 올바르지 않습니다.')
    }

    const rowStart = Math.min(
      Math.max(range.s.r, Math.trunc(message.rowStart)),
      Math.max(range.s.r, range.e.r - ROW_WINDOW + 1)
    )
    const columnStart = Math.min(
      Math.max(range.s.c, Math.trunc(message.columnStart)),
      Math.max(range.s.c, range.e.c - COLUMN_WINDOW + 1)
    )
    const rowEnd = Math.min(range.e.r, rowStart + ROW_WINDOW - 1)
    const columnEnd = Math.min(range.e.c, columnStart + COLUMN_WINDOW - 1)
    const dense = (sheet as unknown as { '!data'?: XLSX.CellObject[][] })['!data']
    const getCell = (row: number, column: number): XLSX.CellObject | undefined =>
      dense?.[row]?.[column] ?? sheet[XLSX.utils.encode_cell({ r: row, c: column })]

    let truncatedCells = 0
    const rows: RowView[] = []
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const cells: CellView[] = []
      for (let column = columnStart; column <= columnEnd; column += 1) {
        const cell = formattedCell(getCell(row, column))
        if (cell.truncated) truncatedCells += 1
        cells.push(cell)
      }
      rows.push({ number: row + 1, cells })
    }

    self.postMessage({
      type: 'sheet',
      generation: message.generation,
      requestId: message.requestId,
      name,
      totalRows,
      totalColumns,
      firstRow: range.s.r,
      firstColumn: range.s.c,
      rowStart,
      columnStart,
      columns: Array.from(
        { length: Math.max(0, columnEnd - columnStart + 1) },
        (_, index) => XLSX.utils.encode_col(columnStart + index)
      ),
      rows,
      truncatedCells
    })
  } catch (error: unknown) {
    postError(message.generation, message.requestId, error)
  }
}

export {}
