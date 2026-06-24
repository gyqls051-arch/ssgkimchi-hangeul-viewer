import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createLogger } from './lib/logger'
import './styles/global.css'

// React ErrorBoundary 가 못 잡는 비동기 throw/거부를 최후방에서 로깅 (조용한 블랭크 방지)
const rootLog = createLogger('uncaught')
window.addEventListener('unhandledrejection', (e) => {
  rootLog.error('unhandledrejection:', e.reason)
})
window.addEventListener('error', (e) => {
  rootLog.error('error:', e.message, e.error)
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 엘리먼트를 찾을 수 없습니다.')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
