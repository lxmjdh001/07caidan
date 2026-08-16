/// <reference types="vite/client" />
import type { OmniApi } from '@shared/ipc'

declare global {
  interface Window {
    omni: OmniApi
  }
}

export {}
