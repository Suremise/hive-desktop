import { useCallback, useRef, useState } from 'react'
import { settle, type Scoped } from '@shared/scoped'
import { errorMessage } from './api'

/**
 * Loads for a view, kept per scope (see Scoped in @shared/scoped). `load(scope, fetch)` starts one for `scope`, which
 * the caller builds from the same values as `fetch`. Loads are numbered: one that finishes after a newer one started,
 * or after the view moved to another scope, is dropped. `data`, `error` and `at` are the current scope's only: data
 * null and no error means loading; data with an error means a failed refresh.
 */
export function useScopedLoad<T>(scope: string) {
  const [state, setState] = useState<Scoped<T>>({ scope, data: null, error: null, at: 0 })
  const current = useRef(scope)
  current.current = scope
  const loads = useRef(0)
  const load = useCallback((asked: string, fetch: () => Promise<T>): void => {
    const n = ++loads.current
    const done = (r: { data: T } | { error: string }): void => {
      if (n !== loads.current || asked !== current.current) return
      setState((prev) => settle(prev, asked, r, Date.now()))
    }
    void fetch().then(
      (data) => done({ data }),
      (e) => done({ error: errorMessage(e) })
    )
  }, [])
  const mine = state.scope === scope
  return { data: mine ? state.data : null, error: mine ? state.error : null, at: mine ? state.at : 0, load }
}
