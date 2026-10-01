// An agent's usage in the footer belongs to one conversation: what was read for another (the one before a switch)
// never shows for it, and a failed refresh keeps the same conversation's numbers, marked stale.
import type { SessionUsage } from './types'

/** A session's usage as last read; `stale` when the latest refresh failed (the numbers may be behind). */
export type LiveUsage = SessionUsage & { stale?: boolean }

/** Usage held for a session (`for`: "<project path>#<session id>"; `usage` null: it has none yet). */
export interface HeldUsage {
  for: string
  usage: SessionUsage | null
  stale: boolean
}

/**
 * The usage to show for session `key`: only what was read for that very session (another one's never shows).
 * `pending`: nothing has been read for it yet.
 */
export function usageFor(held: HeldUsage | null, key: string | null): { usage: LiveUsage | null; pending: boolean } {
  if (!key) return { usage: null, pending: false }
  if (!held || held.for !== key) return { usage: null, pending: true }
  return { usage: held.usage && held.stale ? { ...held.usage, stale: true } : held.usage, pending: false }
}

/** After a refresh: the new value, or (it failed) the same session's last value marked stale, never another's. */
export function afterRefresh(held: HeldUsage | null, key: string, result: { usage: SessionUsage | null } | { failed: true }): HeldUsage | null {
  if ('usage' in result) return { for: key, usage: result.usage, stale: false }
  return held && held.for === key ? { ...held, stale: true } : held
}
