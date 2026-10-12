# 배포 전 법률·권리 검토 상태

## 상태: 승인되지 않음

이 문서는 기술적 검토 체크리스트이며 법률 자문이나 배포 승인이 아닙니다. 저장소의 생성기, SBOM, 고지 파일 또는 라이선스 문구가 성공적으로 검증되어도 **권리자 확인과 법률 승인은 저장소 밖의 권한 있는 주체가 별도로 수행해야 합니다**. 현재 문서만으로 싹싹김치라는 표시의 법적 주체, 저작권 귀속 또는 배포 권한이 확정되었다고 볼 수 없습니다.

## 배포 차단 항목

- [ ] **권리자와 저작권:** `LICENSE`는 저장소에 이미 표시된 싹싹김치 프리웨어 의도와 `Copyright (c) 2026 싹싹김치`를 구현합니다. 실제 코드·문서·아이콘에 대한 권리 보유 여부와 “싹싹김치”가 승인된 저작권 표시인지 외부에서 확인해야 합니다.
- [ ] **pptx-preview:** `pptx-preview@1.0.7`의 lock 및 설치 패키지 메타데이터는 ISC이지만 설치 패키지에 LICENSE/COPYING/NOTICE 파일이 없습니다. 원 저작권 표시와 정확한 ISC 허락 문구의 출처를 확보하고 재배포 조건을 법률 검토·승인해야 합니다. 메타데이터만으로 출시를 승인하지 않습니다.
- [ ] **@rhwp/core WASM:** `rhwp_bg.wasm`에는 Rust 크레이트가 정적으로 포함되지만 npm lock은 그 크레이트와 정확한 버전을 열거하지 않습니다. 설치된 README의 크레이트 계열 표는 참고 정보일 뿐입니다. `@rhwp/core@0.7.19`와 일치하는 전체 크레이트 목록, 버전, 라이선스·고지 및 소스 제공 의무를 확보해야 합니다.
- [ ] **PDF.js 글꼴과 CMap:** Foxit 표준 글꼴 고지, Liberation Font Software 계약/GPL 예외, Adobe CMap 조건의 전문은 `THIRD_PARTY_NOTICES.txt`에 포함됩니다. 특히 Liberation 배포·소스 접근 의무가 실제 설치 형태에 어떻게 적용되는지 법률 검토해야 합니다.
- [ ] **Electron과 Chromium:** Electron npm 구성요소와 `LICENSES.chromium.html`의 해시·참조는 생성물에 포함되지만 Chromium 내부 구성요소는 SBOM의 개별 npm 항목으로 펼쳐지지 않습니다. 실제 배포물 옆에 Electron/Chromium 원문 고지가 유지되는지 아티팩트별로 확인해야 합니다.
- [ ] **고지 파일의 실제 제공:** 패키징 설정은 `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `sbom.cdx.json`, 개인정보·지원 문서와 릴리스 정책을 설치 디렉터리의 `resources`에 포함하고 기존 packaged 검증이 존재·비어 있지 않음·symlink 부재를 확인합니다. 다만 이용자가 이를 실제로 찾고 열 수 있는 제공 방식과 지역별 표시 의무가 충분한지는 법률·제품 검토가 필요합니다.
- [ ] **상표·브랜드·아이콘:** 제품명, 아이콘, “한글/HWP/HWPX” 등 표시에 필요한 권한과 비제휴 고지를 확인해야 합니다.
- [ ] **개인정보와 지원:** `PRIVACY.md`와 `SUPPORT.md`는 현재 코드에서 확인한 동작과 GitHub Issues 제안 채널만 설명합니다. 실제 배포 주체, 적용 지역, 공식 연락 채널 및 법정 고지 의무는 확정되지 않았습니다.
- [ ] **코드 서명과 배포 출처:** 기술 파이프라인은 unsigned fallback을 금지하고 installer와 앱 실행 파일의 Authenticode subject·thumbprint·timestamp를 독립 검증한 뒤 draft 자산의 바이트와 checksum을 재검증하도록 구성되었습니다. 실제 인증서, 게시자 법적 주체, GitHub 보호 environment/reviewer 설정은 저장소 밖에서 제공·승인해야 하며 `release-policy.json`의 placeholder가 남아 있으면 릴리스가 실패합니다.
- [ ] **EULA:** `EULA.template.md`는 명시적으로 비운영 템플릿입니다. 실제 EULA가 필요한지, 프로젝트 및 서드파티 권리를 침해하지 않는지 외부 승인을 받기 전에는 사용하지 않습니다.

## 생성물 범위

`THIRD_PARTY_NOTICES.txt`와 `sbom.cdx.json`은 네트워크 없이 현재 `package-lock.json`과 로컬 `node_modules`에서 결정적으로 생성됩니다. 범위는 다음과 같습니다.

- 루트 프로덕션 의존성에서 required, optional, 설치된 peer 해석을 따라간 보수적 lockfile 폐쇄
- devDependency로 분류되지만 실제 제품 런타임으로 배포되는 Electron의 명시적 포함
- PDF.js Foxit/Liberation 글꼴 및 CMap, `@rhwp/core` WASM, Electron Chromium 고지 참조
- npm tarball의 integrity를 변환한 구성요소 해시와 의존성 그래프

이는 바이트 단위 설치 파일 분석이 아닙니다. 플랫폼별 optional 항목을 과다 포함할 수 있고, 번들러가 코드로 합친 구성요소와 Chromium 내부 항목을 완전히 분해하지 않습니다. SBOM 또는 고지의 존재는 라이선스 적합성, 권리 귀속 또는 출시 승인을 증명하지 않습니다.

## 기술 검증 명령

```bash
node scripts/generate-third-party-notices.mjs --check
node scripts/generate-sbom.mjs --check
node scripts/verify-compliance.mjs
```

모든 명령이 성공한 뒤에도 위 체크박스의 권리자·법률 승인은 외부 기록으로 남겨야 합니다.
