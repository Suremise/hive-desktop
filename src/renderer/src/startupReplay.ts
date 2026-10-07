/** Events that change what the window's startup snapshot (ui:get) also sets: the tips and project preferences (#295). */
const REPLAYED: ReadonlySet<string> = new Set(['tips-changed', 'ui-pref-changed'])

/**
 * One startup of a window. Its snapshot is read while it already listens for events, so a change another window makes
 * meanwhile can arrive first and then be undone by the older snapshot. The events above that arrive before the snapshot
 * is applied are handled again after it: each is the saved state as it is now (the tips) or one change (a project
 * preference), so handling it again is safe in any order. After `settle`, nothing is kept.
 *
 * A startup that is `stop`ped (its effect cleaned up: React's StrictMode runs it twice in development) is no longer
 * `active`: it applies nothing it loads, since a newer one has heard what this one no longer listens for (#337).
 */
export function startupReplay<E extends { type: string }>(handle: (e: E) => void): { note: (e: E) => void; settle: () => void; stop: () => void; active: () => boolean } {
  let early: E[] | null = []
  let stopped = false
  return {
    note(e) {
      if (early && !stopped && REPLAYED.has(e.type)) early.push(e)
    },
    settle() {
      const list = early ?? []
      early = null
      if (!stopped) for (const e of list) handle(e)
    },
    stop() {
      stopped = true
      early = null
    },
    active: () => !stopped
  }
}
