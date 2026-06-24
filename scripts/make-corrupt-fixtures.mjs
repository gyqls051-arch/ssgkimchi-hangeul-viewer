#!/usr/bin/env node
/**
 * 에러테스트용 손상 픽스처: "유효한 매직바이트 + 손상된 본문".
 * → 포맷 라우팅은 해당 뷰어로 가지만 파싱이 실패해 graceful 오류 UI 가 떠야 한다.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 결정적 의사난수(테스트 재현성). Math.random 불필요.
function garbage(n, seed = 1) {
  const b = Buffer.alloc(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    b[i] = x & 0xff
  }
  return b
}

const dir = join(process.cwd(), 'tests', 'fixtures', 'corrupt')
await mkdir(dir, { recursive: true })

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), garbage(4000, 3)]) // PDF 매직 + 쓰레기
const ole = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  garbage(6000, 5)
]) // OLE 매직 + 쓰레기 (hwp)
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), garbage(4000, 7)]) // ZIP 매직 + 쓰레기

await writeFile(join(dir, 'corrupt.pdf'), pdf)
await writeFile(join(dir, 'corrupt.hwp'), ole)
await writeFile(join(dir, 'corrupt.docx'), zip)
await writeFile(join(dir, 'corrupt.xlsx'), zip)
await writeFile(join(dir, 'corrupt.pptx'), zip)

console.log('[corrupt] wrote 5 corrupt fixtures →', dir)
