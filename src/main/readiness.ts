import type { DeliveryNeed } from '../shared/deliveries'
import { tasksWillWake } from '../shared/providers'
import { agentRuntime } from '../shared/runtime'
import type { LiveSessionState } from '../shared/types'

/**
 * Whether an agent can take a line of Hive's now, as far as what it is doing goes (#649): the one place every way into an
 * agent asks it (deliveries, watches, the typed line's writer). It reads the turn ledger's facts (#648): the CLI running
 * (or, `stalled`, stopped by a refused sign-in), no turn running and none of unknown state (unknown is never idle), no
 * compaction, nobody asked, and no background tasks that will start it again. A watch is Hive's policy on top: `idle`
 * takes a watching agent (a message or a wake; its watch carries on), `free` doesn't (it takes no new work). Who holds
 * the composer is the writer's to check (it holds it itself while it types). A state from before the facts reads its
 * status word, as before.
 */
export function readyFor(st: LiveSessionState | null | undefined, need: DeliveryNeed = 'idle'): boolean {
  if (!st) return false
  if (!st.runtime) return byStatus(st, need)
  const rt = agentRuntime(st)
  if (!(rt.lifecycle === 'running' || (need === 'stalled' && rt.lifecycle === 'signin'))) return false
  if (rt.turn === 'running' || rt.turn === 'unknown' || rt.maintenance || rt.attention || tasksWillWake(st)) return false
  return need === 'idle' || !st.watch
}

/** The status word's reading (states without the ledger's facts). */
function byStatus(st: LiveSessionState, need: DeliveryNeed): boolean {
  if (st.status === 'ready' || st.status === 'finished') return true
  if (st.status === 'watching') return need === 'idle'
  return need === 'stalled' && st.status === 'signin'
}
