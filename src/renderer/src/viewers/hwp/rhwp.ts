import init, { HwpDocument } from '@rhwp/core'
// Vite 가 WASM 바이너리를 자산으로 emit → dev/prod 모두 올바른 URL
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url'

declare global {
  // rhwp 가 문단 레이아웃 시 호출하는 텍스트 폭 측정 콜백 (필수)
  // eslint-disable-next-line no-var
  var measureTextWidth: ((font: string, text: string) => number) | undefined
}

let readyPromise: Promise<void> | null = null

/** Canvas 기반 텍스트 폭 측정기를 전역에 등록 (rhwp 레이아웃에 필요) */
function registerMeasureText(): void {
  if (globalThis.measureTextWidth) return
  let ctx: CanvasRenderingContext2D | null = null
  let lastFont = ''
  globalThis.measureTextWidth = (font: string, text: string): number => {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return 0
    if (font !== lastFont) {
      ctx.font = font
      lastFont = font
    }
    return ctx.measureText(text).width
  }
}

/** rhwp WASM 을 1회만 초기화 (이후 HwpDocument 생성 가능) */
export function ensureRhwp(): Promise<void> {
  if (!readyPromise) {
    registerMeasureText()
    readyPromise = init({ module_or_path: wasmUrl })
      .then(() => undefined)
      .catch((err) => {
        // 실패한 promise 를 캐시하면 이후 모든 열기가 영구 실패하므로 리셋해 재시도 가능케 한다
        readyPromise = null
        throw err
      })
  }
  return readyPromise
}

/**
 * WASM 인스턴스를 폐기해 다음 ensureRhwp 가 새로 초기화하게 한다.
 * 손상된 문서가 Rust 패닉/abort 로 인스턴스를 오염시키면 이후 모든 HWP 열기가 실패하므로,
 * 파싱 실패 시 이걸 호출해 깨끗한 인스턴스로 복구한다.
 */
export function resetRhwp(): void {
  readyPromise = null
}

export { HwpDocument }
