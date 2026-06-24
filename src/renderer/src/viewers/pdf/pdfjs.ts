import * as pdfjsLib from 'pdfjs-dist'
// Vite 의 ?url 임포트 → dev/prod 모두에서 올바른 워커 자산 URL
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// workerSrc 로 설정하면 PDF.js 가 문서마다 독립 워커를 생성한다.
// (단일 workerPort 공유 시, 한 문서의 destroy() 가 공유 워커까지 파괴해
//  StrictMode 의 이중 마운트에서 "worker is being destroyed" 오류가 났다.)
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** CJK(한글 등) cMap 과 표준폰트 경로 — predev/prebuild 가 public/pdfjs 로 복사한다. */
export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: './pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './pdfjs/standard_fonts/',
  // CSP 친화: PDF.js 가 eval 을 시도하지 않게 한다
  isEvalSupported: false
} as const

export { pdfjsLib }
