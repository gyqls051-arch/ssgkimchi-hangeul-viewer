# 싹싹김치 한글뷰어

한글(HWP/HWPX)·PDF·Word·Excel·PowerPoint를 한 창에서 보는 **윈도우 데스크톱 멀티포맷 문서 뷰어**.
폴라리스 뷰어처럼 "편집 말고 보기에 집중한 경량 앱". 100% 오프라인 렌더링.

## 지원 포맷

| 포맷 | 확장자 | 렌더 엔진 | 라이선스 |
|------|--------|-----------|---------|
| 한글 | `.hwp` `.hwpx` | [rhwp](https://github.com/edwardkim/rhwp) (Rust+WASM) | MIT |
| PDF | `.pdf` | PDF.js | Apache-2.0 |
| Word | `.docx` | docx-preview | Apache-2.0 |
| Excel | `.xlsx` | SheetJS | Apache-2.0 |
| PowerPoint | `.pptx` | pptx-preview | MIT |

> 구형 `.doc/.ppt/.xls`는 미지원(안내 표시). 프로그램 생성 비표준 PPTX 일부는 인식 못 할 수 있음.

## 주요 기능

- 드래그&드롭 · 파일 열기 · **더블클릭 파일 연결**
- 페이지 연속 스크롤 + 가시영역만 렌더(가상화), 줌(너비맞춤/±/Ctrl+휠)
- PDF 문서 내 텍스트 검색 · 썸네일, Excel 시트 탭
- 최근 연 파일, 창 크기/위치 기억, 인쇄(Ctrl+P)

## 보안 설계

- Electron 하드닝: `sandbox` + `contextIsolation` + `nodeIntegration:false` + 엄격 CSP
- 프로덕션은 `file://`(불투명 origin) 대신 커스텀 **`app://` 표준 보안 프로토콜**로 렌더러 서빙
  → PDF.js 워커/cMap이 일관되게 로드됨
- 렌더러는 임의 파일 경로를 메인에 보내지 않음(열기 다이얼로그/최근목록만). `readDoc`는 확장자·크기·정규파일 검증
- 신뢰불가 문서 렌더 시 DOMPurify(HWP SVG·XLSX 테이블) + CSP 이중 방어

## 개발

```bash
npm install            # 의존성 + electron 바이너리
npm run dev            # 개발 실행 (HMR)
npm run typecheck      # 타입 검사 (main + renderer)
npm run test           # 단위 테스트 (vitest)
npm run test:e2e       # E2E (Playwright + Electron, 빌드 후 6개 포맷 렌더 검증)
npm run build          # 프로덕션 번들
npm run build:win      # NSIS 윈도우 설치파일 (release/)
```

> 참고: VS Code 통합 터미널 등 `ELECTRON_RUN_AS_NODE=1`을 상속하는 환경에서도
> `npm run dev`가 동작하도록 래퍼(`scripts/electron-vite.mjs`)가 이를 제거한다.

## 아키텍처

```
src/
  main/      윈도우·메뉴·보안·IPC·파일IO·app:// 프로토콜·영속저장
  preload/   contextBridge 화이트리스트 API (단일 open-file 채널)
  renderer/  React 19 UI
    viewers/ 포맷 레지스트리 + 포맷별 뷰어(lazy 코드스플리팅)
    lib/     포맷감지(매직바이트)·useInView·로거
    shell/   Toolbar·DropZone·EmptyState·ErrorBoundary
```

새 포맷 추가 = `viewers/registry.ts`에 항목 1개 + 뷰어 컴포넌트 1개.

## 라이선스

MIT
