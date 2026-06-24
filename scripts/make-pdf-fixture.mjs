#!/usr/bin/env node
/**
 * 테스트용 유효 PDF(2페이지, Helvetica 내장표준폰트) 생성.
 * xref 바이트 오프셋을 정확히 계산해 pdf.js 가 정상 파싱하도록 한다.
 * 검색 테스트용 단어: 1쪽 "Viewer", 2쪽 "Target".
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const objs = []
objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`
objs[2] = `<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>`
objs[3] =
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ` +
  `/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>`
const s1 = `BT /F1 18 Tf 40 150 Td (Hello SSGKIMCHI Viewer) Tj ET`
objs[4] = `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`
objs[5] =
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ` +
  `/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`
const s2 = `BT /F1 18 Tf 40 150 Td (Page Two Search Target) Tj ET`
objs[6] = `<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`
objs[7] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`

const len = (s) => Buffer.byteLength(s, 'latin1')

let pdf = `%PDF-1.4\n`
const offsets = []
for (let i = 1; i <= 7; i++) {
  offsets[i] = len(pdf)
  pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
}
const xrefStart = len(pdf)
pdf += `xref\n0 8\n0000000000 65535 f \n`
for (let i = 1; i <= 7; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

const out = join(process.cwd(), 'tests', 'fixtures', 'sample.pdf')
await mkdir(join(process.cwd(), 'tests', 'fixtures'), { recursive: true })
await writeFile(out, Buffer.from(pdf, 'latin1'))
console.log('[fixture] wrote', out, `(${len(pdf)} bytes)`)
