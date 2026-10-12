import type { DeliveryNeed } from '../shared/deliveries'
import type { LiveSessionState } from '../shared/types'

/**
 * Whether an agent can take a line of Hive's now, as far as what it is doing goes (#649): the one place every way into an
 * agent asks it (deliveries, watches, the typed line's writer). Today it reads the session's status; the turn ledger's
 * fields (#648: the active turn, the composer, attention) replace it here once they are on main, and nothing else
 * changes. `need`: idle (ready, finished or watching), free (ready or finished), stalled (free, or stopped by a refused
 * sign-in).
 */
export function readyFor(st: LiveSessionState | null | undefined, need: DeliveryNeed = 'idle'): boolean {
  if (!st) return false
  if (st.status === 'ready' || st.status === 'finished') return true
  if (st.status === 'watching') return need === 'idle'
  return need === 'stalled' && st.status === 'signin'
}
