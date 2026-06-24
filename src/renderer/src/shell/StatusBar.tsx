import { FAMILY_NAME, FAMILY_TAGLINE, FAMILY_URL } from '../lib/family'
import bannerUrl from '../assets/banner-statusbar.png'

/**
 * 하단 상시 배너 바 — 문서 영역을 가리지 않고 항상 보인다.
 * 클릭 시 싹싹김치 패밀리(다른 앱) 페이지를 기본 브라우저로 연다.
 * 배너 교체: src/renderer/src/assets/banner-statusbar.png 를 같은 크기(480x48)로 덮어쓰면 됨.
 */
export default function StatusBar() {
  return (
    <footer className="statusbar">
      <button
        className="statusbar__banner"
        onClick={() => window.api.openExternal(FAMILY_URL)}
        title={`${FAMILY_NAME} — ${FAMILY_TAGLINE}`}
      >
        <img className="statusbar__img" src={bannerUrl} alt={FAMILY_NAME} />
      </button>
    </footer>
  )
}
