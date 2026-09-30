import type { HiveBridge } from '../shared/api'

declare global {
  interface Window {
    hive: HiveBridge
  }
}

// Makes this file a module, so `declare global` applies.
// eslint-disable-next-line unicorn/require-module-specifiers
export {}
