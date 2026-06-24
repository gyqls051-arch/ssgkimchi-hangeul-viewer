#!/usr/bin/env node
/**
 * 싹싹김치 패밀리 홍보 배너 *목업* PNG 생성 (placeholder).
 * 실제 디자인이 나오면 같은 크기로 아래 두 파일을 덮어쓰면 된다.
 *
 *   src/renderer/src/assets/banner-statusbar.png  →  480 x 48  (표시 240 x 24, @2x)
 *   src/renderer/src/assets/banner-exit.png       →  720 x 240 (표시 360 x 120, @2x)
 *
 * 한글 렌더를 위해 Malgun Gothic 을 명시적으로 로드한다.
 */
import { Resvg } from '@resvg/resvg-js'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const fontFiles = ['C:\\Windows\\Fonts\\malgun.ttf', 'C:\\Windows\\Fonts\\malgunbd.ttf'].filter(
  existsSync
)
const font = { fontFiles, loadSystemFonts: true, defaultFontFamily: 'Malgun Gothic' }

// ── 하단 상태바 배너 (480 x 48, 투명 배경) ─────────────────────────
const statusbarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="48" viewBox="0 0 480 48">
  <circle cx="24" cy="24" r="15" fill="#2f9e57"/>
  <path d="M24 13 C13 18 13 31 24 35 C35 31 35 18 24 13 Z" fill="#c7f2d6"/>
  <path d="M24 16 L24 32" stroke="#2f9e57" stroke-width="2" stroke-linecap="round"/>
  <text x="50" y="31" font-family="Malgun Gothic" font-size="20" font-weight="700" fill="#e6e7ea">싹싹김치 패밀리</text>
  <text x="332" y="31" font-family="Malgun Gothic" font-size="16" font-weight="700" fill="#5b9bff">다른 앱 보기 →</text>
</svg>`

// ── 종료 모달 배너 (720 x 240) ───────────────────────────────────
const exitSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240" viewBox="0 0 720 240">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8513a"/>
      <stop offset="1" stop-color="#f0922f"/>
    </linearGradient>
  </defs>
  <rect width="720" height="240" rx="18" fill="url(#g)"/>
  <circle cx="598" cy="120" r="80" fill="#ffffff" fill-opacity="0.12"/>
  <circle cx="598" cy="120" r="48" fill="#ffffff"/>
  <path d="M598 86 C576 96 576 142 598 154 C620 142 620 96 598 86 Z" fill="#2f9e57"/>
  <path d="M598 96 L598 148" stroke="#1f7a42" stroke-width="3" stroke-linecap="round"/>
  <text x="56" y="96" font-family="Malgun Gothic" font-size="44" font-weight="800" fill="#ffffff">싹싹김치 패밀리</text>
  <text x="58" y="138" font-family="Malgun Gothic" font-size="22" font-weight="500" fill="#ffe9d8">다운로더 · 플레이어 · 캡처 한 곳에서</text>
  <rect x="58" y="166" width="196" height="46" rx="23" fill="#ffffff"/>
  <text x="156" y="196" text-anchor="middle" font-family="Malgun Gothic" font-size="20" font-weight="700" fill="#e8513a">다른 앱 보기 →</text>
</svg>`

const dir = join(process.cwd(), 'src', 'renderer', 'src', 'assets')
await mkdir(dir, { recursive: true })

for (const [name, svg] of [
  ['banner-statusbar', statusbarSvg],
  ['banner-exit', exitSvg]
]) {
  const png = new Resvg(svg, { font }).render().asPng()
  await writeFile(join(dir, `${name}.png`), png)
  console.log(`[banner] wrote src/renderer/src/assets/${name}.png (${png.length} bytes)`)
}

if (fontFiles.length === 0) {
  console.warn('[banner] ⚠ Malgun Gothic 미발견 — 한글이 깨질 수 있음(시스템 폰트 폴백)')
}
