import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createLogger } from '../../lib/logger'

const log = createLogger('pdf')

// 문서별 텍스트 인덱스 캐시 (문서가 GC 되면 함께 해제)
const cache = new WeakMap<PDFDocumentProxy, string[]>()

// 페이지 텍스트 추출 동시 실행 수 (순차 대비 대폭 단축, 워커 과부하 방지)
const CONCURRENCY = 12

async function extractPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<string> {
  try {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    return content.items
      .map((it) => ('str' in it ? (it as { str: string }).str : ''))
      .join(' ')
      .toLowerCase()
  } catch (err) {
    // 한 페이지의 텍스트 추출 실패가 전체 검색을 막지 않게 한다
    log.debug(`${pageNumber}쪽 텍스트 추출 실패`, err)
    return ''
  }
}

/**
 * 페이지별 텍스트를 추출/캐시한 뒤, query 를 포함하는 페이지 번호 목록을 돌려준다.
 * 첫 호출에서만 인덱싱하며, 페이지를 동시(batch)로 처리해 대용량 PDF 지연을 줄인다.
 * (Phase 1: 페이지 단위 검색 — 페이지 내 하이라이트는 후속 단계에서 텍스트 레이어로)
 */
export async function searchPdfText(
  pdf: PDFDocumentProxy,
  numPages: number,
  query: string
): Promise<number[]> {
  const q = query.toLowerCase()

  let texts = cache.get(pdf)
  if (!texts) {
    const acc = new Array<string>(numPages)
    for (let start = 1; start <= numPages; start += CONCURRENCY) {
      const end = Math.min(start + CONCURRENCY, numPages + 1)
      const batch: Promise<string>[] = []
      for (let i = start; i < end; i++) batch.push(extractPageText(pdf, i))
      const results = await Promise.all(batch)
      results.forEach((t, k) => {
        acc[start - 1 + k] = t
      })
    }
    texts = acc
    cache.set(pdf, texts)
  }

  const result: number[] = []
  texts.forEach((t, idx) => {
    if (t.includes(q)) result.push(idx + 1)
  })
  return result
}
