/**
 * 메인 ↔ 렌더러 사이 계약(IPC) 타입.
 * preload(구현)와 renderer(window.api 타입), main(fileService 반환)이 공유한다.
 * 여기엔 electron import가 없어야 한다 — 렌더러 타입체크에 안전하게 포함되도록.
 */

/** 메인 프로세스가 디스크에서 읽어 렌더러로 넘기는 문서 한 건 */
export interface OpenedFile {
  /** 파일 이름 (경로 제외) */
  name: string
  /** 소문자 확장자, 점 포함 (예: ".hwp") */
  ext: string
  /** 원본 바이트 */
  bytes: ArrayBuffer
}

/** 최근 연 파일 항목 (경로는 메인 프로세스에서만 다룬다) */
export interface RecentItem {
  path: string
  name: string
  ext: string
  openedAt: number
}

/** contextBridge로 렌더러에 노출되는 화이트리스트 API (1메서드 = 1동작) */
export interface ViewerApi {
  /** 열기 다이얼로그를 띄운다. 선택/읽기 결과는 onOpenFile 콜백으로 전달된다. */
  openFileDialog(): Promise<void>
  /**
   * 파일이 열릴 때(다이얼로그·메뉴·파일연결 모두) 호출되는 콜백 등록.
   * @returns 해제 함수
   */
  onOpenFile(cb: (file: OpenedFile) => void): () => void
  /** "인쇄" 메뉴/단축키가 눌렸을 때 호출되는 콜백 등록. @returns 해제 함수 */
  onPrint(cb: () => void): () => void
  /** open-file 리스너 부착 완료를 메인에 알린다 (큐된 파일 전송 트리거) */
  notifyReady(): void
  /** 문서 내 외부 링크(http/https)를 기본 브라우저로 연다 */
  openExternal(url: string): void
  /** 최근 연 파일 목록 */
  listRecent(): Promise<RecentItem[]>
  /** 최근 목록의 파일을 연다 (목록에 있는 경로만 허용). */
  openRecent(path: string): Promise<void>
  /** 최근 목록 비우기 */
  clearRecent(): Promise<void>
  /** 호스트 플랫폼 (예: "win32") */
  readonly platform: string
}
