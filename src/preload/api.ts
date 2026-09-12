/**
 * 메인 ↔ 렌더러 사이 계약(IPC) 타입.
 * preload(구현)와 renderer(window.api 타입), main(fileService 반환)이 공유한다.
 * 여기엔 electron import가 없어야 한다 — 렌더러 타입체크에 안전하게 포함되도록.
 */

/** 문서 크기 상한 (메인 descriptor read + 렌더러 드롭 폴백이 공유) */
export const MAX_DOC_BYTES = 128 * 1024 * 1024

/** 메인 프로세스가 디스크에서 읽어 렌더러로 넘기는 문서 한 건 */
export interface OpenedFile {
  /** 파일 이름 (경로 제외) */
  name: string
  /** 소문자 확장자, 점 포함 (예: ".hwp") */
  ext: string
  /** 원본 바이트 */
  bytes: ArrayBuffer
}

/** 최근 연 파일 항목. 실제 경로 대신 무작위 opaque id만 renderer에 노출한다. */
export interface RecentItem {
  id: string
  name: string
  ext: string
  openedAt: number
}

export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'no-update'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type UpdateSupportReason = 'development' | 'platform' | 'configuration'
export type UpdateErrorCode =
  | 'network'
  | 'signature'
  | 'metadata'
  | 'policy'
  | 'configuration'
  | 'install'
  | 'internal'

/** renderer-safe 업데이트 상태. URL·다운로드 경로·원본 오류·release note는 포함하지 않는다. */
export interface UpdateSnapshot {
  revision: number
  phase: UpdatePhase
  currentVersion: string
  supportReason?: UpdateSupportReason
  availableVersion?: string
  progressPercent?: number
  cancelRequested?: boolean
  errorCode?: UpdateErrorCode
  retryAt?: number
}

/** contextBridge로 렌더러에 노출되는 화이트리스트 API (1메서드 = 1동작) */
export interface ViewerApi {
  /** 열기 다이얼로그를 띄운다. 선택/읽기 결과는 onOpenFile 콜백으로 전달된다. */
  openFileDialog(): Promise<void>
  /** main 기반 열기 요청이 시작될 때 호출된다. @returns 해제 함수 */
  onOpenIntent(cb: () => void): () => void
  /**
   * 파일이 열릴 때(다이얼로그·메뉴·파일연결 모두) 호출되는 콜백 등록.
   * @returns 해제 함수
   */
  onOpenFile(cb: (file: OpenedFile) => void): () => void
  /** renderer의 더 최신 pathless drop이 시작됐을 때 진행 중인 main read를 취소한다. */
  cancelPendingOpen(): void
  /** "인쇄" 메뉴/단축키가 눌렸을 때 호출되는 콜백 등록. @returns 해제 함수 */
  onPrint(cb: () => void): () => void
  /** open-file 리스너 부착 완료를 메인에 알린다 (큐된 파일 전송 트리거) */
  notifyReady(): void
  /**
   * 드롭된 File의 OS 경로를 얻어 메인 프로세스 열기 경로(검증+최근목록)로 위임한다.
   * 진짜 드래그된 파일만 경로가 나온다(렌더러가 합성한 File은 불가 → 임의 경로 주입 차단).
   * @returns 경로를 얻어 위임했으면 true, 경로 없는 File(압축/첨부 드래그 등)이면 false
   */
  openDroppedFile(file: File): boolean
  /** 검증·사용자 확인 후 HTTPS 링크를 기본 브라우저로 연다. */
  openExternal(url: string): Promise<boolean>
  /** 최근 연 파일 목록 (절대경로 미포함) */
  listRecent(): Promise<RecentItem[]>
  /** opaque id가 가리키는 최근 파일을 연다. stale id는 실패한다. */
  openRecent(id: string): Promise<boolean>
  /** 최근 목록 비우기 */
  clearRecent(): Promise<void>
  /** 종료 확인 팝업 표시 요청. @returns 해제 함수 */
  onShowExitDialog(cb: () => void): () => void
  /** 종료 확인 모달을 취소해 다음 닫기 요청을 다시 받을 수 있게 한다. */
  cancelExit(): void
  /** 종료 확인 모달에서 "종료" 선택 → 실제 종료 진행 */
  confirmExit(): void

  /** 현재 수동 업데이트 상태를 조회한다. 신뢰 검증 실패 시 null. */
  getUpdateState(): Promise<UpdateSnapshot | null>
  /** 사용자가 명시적으로 stable 업데이트 확인을 요청한다. */
  checkForUpdates(): Promise<UpdateSnapshot | null>
  /** 확인된 업데이트 다운로드를 명시적으로 시작한다. */
  downloadUpdate(): Promise<UpdateSnapshot | null>
  /** 진행 중인 업데이트 다운로드를 취소한다. */
  cancelUpdateDownload(): Promise<UpdateSnapshot | null>
  /** 다운로드된 업데이트의 native 확인·설치를 요청한다. */
  installUpdate(): Promise<UpdateSnapshot | null>
  /** 업데이트 상태 변경 구독. @returns 해제 함수 */
  onUpdateState(cb: (snapshot: UpdateSnapshot) => void): () => void
  /** 네이티브 메뉴가 업데이트 화면 표시를 요청할 때 구독. @returns 해제 함수 */
  onShowUpdateDialog(cb: () => void): () => void

  /** 호스트 플랫폼 (예: "win32") */
  readonly platform: string
}
