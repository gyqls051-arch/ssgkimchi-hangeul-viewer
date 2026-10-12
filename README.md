# 싹싹김치 한글뷰어

한글(HWP/HWPX)·PDF·Word·Excel·PowerPoint를 한 창에서 보는 **Windows 데스크톱 멀티포맷 문서 뷰어**입니다. 편집보다 보기에 집중합니다.

문서 내용은 앱 안에서 로컬로 렌더링되며 현재 애플리케이션 코드는 문서를 서버에 업로드하지 않습니다. 텔레메트리는 구현되어 있지 않습니다. 업데이트 네트워크 요청은 **사용자가 업데이트 확인을 명시적으로 선택한 경우에만** GitHub Releases의 안정 버전 메타데이터를 확인하고, 다운로드와 설치도 각각 사용자 동작과 확인을 요구합니다. 문서의 절대 HTTPS 링크는 사용자의 확인을 받은 뒤 기본 브라우저에서 열 수 있습니다. 자세한 내용은 [개인정보 및 로컬 데이터 안내](PRIVACY.md)를 확인하세요.

## 설치 (Windows 10/11 x64)

[**GitHub 최신 릴리스에서 설치 파일 다운로드**](https://github.com/gyqls051-arch/ssgkimchi-hangeul-viewer/releases/latest) 후 `ssgkimchi-hangeul-viewer-*-setup.exe`를 실행합니다.

> 상용 릴리스 파이프라인은 Authenticode 서명과 타임스탬프, 승인된 게시자·인증서 subject·thumbprint, 업데이트 메타데이터와 체크섬을 독립 검증한 뒤에만 게시하도록 구성되어 있습니다. 실제 인증서 값과 보호된 GitHub Environment가 설정되지 않으면 릴리스는 실패합니다. 기존 공개 자산이 이 정책 이전에 생성되었을 수 있으므로 서명과 `SHA256SUMS`를 확인할 수 없는 파일은 실행하지 말고, Windows 경고를 우회하지 마세요.

## 지원 포맷

| 포맷 | 확장자 | 렌더 엔진 | 라이선스/검토 상태 |
|------|--------|-----------|--------------------|
| 한글 | `.hwp` `.hwpx` | [rhwp](https://github.com/edwardkim/rhwp) (Rust+WASM) | MIT 메타데이터; 포함된 WASM 크레이트 범위는 법률 검토 필요 |
| PDF | `.pdf` | PDF.js | Apache-2.0; Foxit/Liberation 글꼴 조건 별도 |
| Word | `.docx` | docx-preview | Apache-2.0 |
| Excel | `.xlsx` | SheetJS | Apache-2.0 |
| PowerPoint | `.pptx` | pptx-preview | ISC 패키지 메타데이터; 재배포 조건의 법률 검토·승인 필요 |

구형 `.doc`, `.ppt`, `.xls`는 지원하지 않습니다. 프로그램 생성 방식이 비표준이거나 손상된 문서는 인식하지 못하거나 원본과 다르게 보일 수 있습니다. 정확한 서드파티 조건과 알려진 범위 한계는 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 및 [법률 검토 상태](LEGAL_REVIEW.md)를 확인하세요.

## 주요 기능

- 드래그 앤 드롭, 파일 열기, 더블클릭 파일 연결; 모든 메인 프로세스 열기 경로에서 동일한 파일 검증 적용
- 페이지 연속 스크롤, 가시영역 렌더링, 줌(너비 맞춤/확대/축소/Ctrl+휠)
- PDF 문서 내 텍스트 검색·썸네일, Excel 시트 탭
- 사용자 주도 안정 버전 업데이트: 확인·다운로드·재시작 설치를 각각 명시적으로 실행하며 prerelease·downgrade·서명 불일치를 차단
- 최대 12개의 최근 파일 메타데이터와 창 크기·위치를 로컬에 저장

현재 버전은 가상화된 전체 문서의 정확한 출력을 보장하지 못하므로 인쇄를 지원하지 않습니다.

## 보안 설계

- Electron `sandbox`, `contextIsolation`, `nodeIntegration: false`와 제한적인 Content Security Policy
- 프로덕션 렌더러를 커스텀 `app://` 표준 보안 프로토콜로 제공하여 번들된 워커·CMap·글꼴을 로드
- 렌더러에는 최근 파일의 절대 경로를 노출하지 않고, 메인 프로세스에서 확장자·크기·정규 파일 여부를 검증
- HWP SVG와 XLSX 테이블 등 신뢰할 수 없는 문서 파생 마크업을 DOMPurify로 정화
- 새 창, 임의 탐색, 다운로드와 권한 요청을 차단하고 문서의 절대 HTTPS 링크만 네이티브 확인 후 외부 브라우저로 전달
- 업데이트는 stable GitHub release만 사용자 동작으로 확인하며, 웹 설치 프로그램·prerelease·downgrade·자동 종료 설치를 금지하고 Windows Authenticode의 게시자, exact subject·thumbprint, code-signing EKU와 timestamp를 설치 직전까지 재검증

보안 문제를 포함한 지원 범위와 공개 이슈 작성 시 주의사항은 [SUPPORT.md](SUPPORT.md)를 확인하세요.

## 개발

```bash
npm install            # 의존성 및 Electron 바이너리 설치
npm run dev            # 개발 실행(HMR)
npm run typecheck      # main/renderer 타입 검사
npm run test           # Vitest 단위 테스트
npm run test:e2e       # 빌드 후 Playwright E2E
npm run build          # 프로덕션 번들
npm run build:win      # 서명 필수 NSIS Windows 설치 파일(release/)
npm run compliance     # 고지와 SBOM 재생성
npm run compliance:check # 결정적 생성물·문서 검증
npm run verify:release # 서명 완료 아티팩트 prepare/verify 도구
```

> VS Code 통합 터미널처럼 `ELECTRON_RUN_AS_NODE=1`을 상속하는 환경에서도 개발 명령이 동작하도록 `scripts/electron-vite.mjs` 래퍼가 해당 변수를 제거합니다.

### 컴플라이언스 생성·검증

생성기는 Node 내장 모듈만 사용하며 네트워크 요청 없이 현재 `package-lock.json`과 `node_modules`를 읽습니다.

```bash
node scripts/generate-third-party-notices.mjs --check
node scripts/generate-sbom.mjs --check
node scripts/verify-compliance.mjs
```

`--check`는 새로 계산한 내용을 체크인된 파일과 바이트 단위로 비교합니다. [SBOM](sbom.cdx.json)은 보수적인 프로덕션 lockfile 폐쇄와 배포되는 Electron을 포함하지만, 실제 설치 파일의 바이트 단위 목록은 아닙니다. Chromium 내부와 `@rhwp/core` WASM 크레이트 범위 한계는 생성물에 명시되어 있습니다.

## 아키텍처

```text
src/
  main/      윈도우·메뉴·보안·IPC·파일 IO·app:// 프로토콜·로컬 상태
  preload/   contextBridge 허용 API
  renderer/  React UI
    viewers/ 포맷 레지스트리와 포맷별 뷰어
    lib/     포맷 감지·가시영역 도우미·로거
    shell/   툴바·드롭 영역·오류 경계
```

새 포맷은 뷰어 구현과 `viewers/registry.ts` 등록을 함께 추가합니다.

## 라이선스와 배포 검토

저장소 코드는 [싹싹김치 프리웨어 라이선스](LICENSE) 아래 제공됩니다: `Copyright (c) 2026 싹싹김치`. 무료 사용과 원본 그대로의 전달은 허용되나 유료 재판매·변조 배포·제작자 사칭은 금지됩니다. 서드파티 구성요소에는 각자의 조건이 적용됩니다.

- [서드파티 고지](THIRD_PARTY_NOTICES.txt)
- [CycloneDX 1.6 SBOM](sbom.cdx.json)
- [개인정보 및 로컬 데이터 안내](PRIVACY.md)
- [지원 안내](SUPPORT.md)
- [배포 전 법률·권리 검토 상태](LEGAL_REVIEW.md)
- [비운영 EULA 템플릿](EULA.template.md)

`LEGAL_REVIEW.md`에 남은 항목은 기술 생성물만으로 승인되지 않습니다. 실제 권리자 확인과 법률 승인은 저장소 밖에서 별도로 완료해야 합니다.
