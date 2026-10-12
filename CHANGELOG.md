# 변경 기록

이 파일은 저장소에서 확인할 수 있는 변경만 기록하며 과거 릴리스 이력을 추정해 만들지 않습니다.

## Unreleased

### Added

- 싹싹김치 프리웨어 저장소 라이선스, 개인정보·지원 안내, 비운영 EULA 템플릿 및 외부 법률 검토 체크리스트
- 저장소 라이선스를 MIT에서 싹싹김치 프리웨어 라이선스로 교체(무료 사용·원본 그대로 전달 허용, 유료 재판매·변조 배포·사칭 금지) — 공홈 이용약관 제4조와 일치
- `package-lock.json`의 보수적 프로덕션 의존성 폐쇄와 배포되는 Electron 런타임을 대상으로 하는 오프라인 서드파티 고지 생성기
- CycloneDX 1.6 형태의 결정적 SBOM 생성기와 package URL, lock 무결성 해시, 의존성 그래프
- 생성물 바이트 비교, 필수 문서 및 README 주장 검증 명령
- 사용자 주도 stable 업데이트 상태 머신과 접근 가능한 업데이트 대화상자
- Authenticode identity·timestamp, updater metadata, blockmap, checksum 및 provenance를 검증하는 분리형 릴리스 파이프라인

### Changed

- 로컬 렌더링 범위, 사용자 요청 시에만 발생하는 업데이트 네트워크 동작, 인쇄 미지원 및 `pptx-preview` ISC 메타데이터를 README와 개인정보 안내에 정확히 기술
- Windows 패키징은 서명 없이는 실패하고 라이선스·고지·SBOM·개인정보·지원 문서를 설치 resources에 포함

## 0.2.0

`package.json`과 현재 릴리스 메타데이터가 식별하는 애플리케이션 버전입니다. 이 저장소에는 해당 버전의 전체 과거 변경 기록이 없으므로 추가 항목을 재구성하지 않았습니다.
