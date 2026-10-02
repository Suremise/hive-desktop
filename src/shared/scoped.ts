/**
 * What a view loaded, kept with the scope it was loaded for: a project, a workspace, a search. A view shows results and
 * errors only for its current scope, so after a switch it never shows (or edits) another scope's results as its own:
 * a new scope starts as loading. A refresh of the same scope that fails keeps the last results (stale, with when they
 * are from) beside the error. The renderer's useScopedLoad keeps one of these per view.
 */
export interface Scoped<T> {
  scope: string
  data: T | null
  error: string | null
  /** When `data` was loaded (0: never). */
  at: number
}

/** The state after a load for `scope` finished with `r`. */
export function settle<T>(prev: Scoped<T>, scope: string, r: { data: T } | { error: string }, now: number): Scoped<T> {
  if ('data' in r) return { scope, data: r.data, error: null, at: now }
  // The same scope keeps what it had; another scope has nothing of its own yet.
  return prev.scope === scope ? { ...prev, error: r.error } : { scope, data: null, error: r.error, at: 0 }
}
