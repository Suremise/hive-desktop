import { join } from 'path'
import type { TaskCard } from '../shared/types'
import { sessions } from './sessions'
import { workspaceFor, type WorkspaceService } from './workspace'

/**
 * Who is on a card now (#351), so Archive All leaves it on the board unless the user includes it: its agent in Doing
 * with a running session, its reviewer, or a running agent (or the Assistant) of the card's workspace watching it. The
 * same rule as the board's dialog, checked again by main as each card is archived. Null when nobody is on it.
 */
export function cardBusy(ws: WorkspaceService, c: TaskCard): string | null {
  if (c.column === 'doing' && c.agent && c.project && ws.path) {
    const st = sessions.liveFor(join(ws.path, c.project), c.agent)
    if (st) return `${st.agentName ?? c.agentName ?? 'its agent'} is working on it`
  }
  if (c.review) return `${c.review.agentName} is reviewing it`
  for (const st of sessions.liveStates()) {
    if (workspaceFor(st.projectPath) !== ws || !sessions.watchFor(st.projectPath, st.agentId)?.cards.includes(c.number)) continue
    return `${ws.isAssistantHome(st.projectPath) ? 'The Assistant' : (st.agentName ?? 'An agent')} is watching it`
  }
  return null
}
