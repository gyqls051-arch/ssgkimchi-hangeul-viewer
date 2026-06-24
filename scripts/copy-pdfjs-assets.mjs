#!/usr/bin/env node
/**
 * pdfjs-dist 의 cmaps / standard_fonts 를 렌더러 public 으로 복사한다.
 * - cmaps: CID-keyed(특히 한중일) 폰트의 문자 매핑. 한글 PDF 정확 렌더에 필요.
 * - standard_fonts: 비임베드 표준폰트 대체.
 * predev/prebuild 에서 실행되어 ./pdfjs/ 경로로 제공된다.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const dest = join(process.cwd(), 'src', 'renderer', 'public', 'pdfjs')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(join(pdfjsRoot, 'cmaps'), join(dest, 'cmaps'), { recursive: true })
await cp(join(pdfjsRoot, 'standard_fonts'), join(dest, 'standard_fonts'), { recursive: true })

console.log('[pdfjs] cmaps + standard_fonts →', dest)
