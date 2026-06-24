#!/usr/bin/env node
/** 2시트 XLSX 생성 — SheetJS 뷰어 스모크용. 검색어: SHEETMARK */
import * as XLSX from 'xlsx'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const wb = XLSX.utils.book_new()

const ws1 = XLSX.utils.aoa_to_sheet([
  ['항목', '수량', '단가', '금액'],
  ['사과', 3, 1000, 3000],
  ['배', 2, 1500, 3000],
  ['합계', null, null, 6000]
])
XLSX.utils.book_append_sheet(wb, ws1, '매출')

const ws2 = XLSX.utils.aoa_to_sheet([
  ['Search', 'Target', 'Marker'],
  ['a', 'b', 'SHEETMARK'],
  [1, 2, 3]
])
XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2')

const dir = join(process.cwd(), 'tests', 'fixtures')
await mkdir(dir, { recursive: true })
const out = join(dir, 'sample.xlsx')
// ESM/Node 에서는 SheetJS 의 writeFile(fs 자동감지)이 동작하지 않으므로 buffer 로 받아 저장
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
await writeFile(out, buf)
console.log('[fixture] wrote', out, `(${buf.length} bytes)`)
