import type { DevlogApi } from './index'

declare global {
  interface Window {
    devlog: DevlogApi
  }
}

export {}
