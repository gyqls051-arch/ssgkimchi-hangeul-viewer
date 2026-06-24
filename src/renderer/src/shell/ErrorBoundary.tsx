import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createLogger } from '../lib/logger'

const log = createLogger('viewer')

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * 뷰어 렌더 중 발생한 예외를 잡아 앱 전체가 죽지 않게 한다.
 * (손상된 문서·파서 버그 등) — 디버깅 게이트 요건.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('뷰어 렌더 실패:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="viewer-error">
          <div className="viewer-error__icon" aria-hidden>
            ⚠️
          </div>
          <div className="viewer-error__title">문서를 표시할 수 없습니다</div>
          <div className="viewer-error__detail">{this.state.error.message}</div>
        </div>
      )
    }
    return this.props.children
  }
}
