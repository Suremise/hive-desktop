import type { HiveBridge } from '../shared/api'

declare global {
  interface Window {
    hive: HiveBridge
  }
}

export {}
