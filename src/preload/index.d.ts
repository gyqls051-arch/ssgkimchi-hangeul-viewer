import type { ViewerApi } from './api'

declare global {
  interface Window {
    api: ViewerApi
  }
}

export {}
