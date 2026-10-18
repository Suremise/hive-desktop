/**
 * Whether an agent may hand over to a new conversation of its own now (#1057, shared/handOver.ts): what the long
 * conversation's notice offers, what its Hand Over to… finds when clicked, and what the hand-over checks before it asks
 * for a handover and again before it ends the conversation. Here, since it needs the lanes (lanes.ts reads the board).
 */
import { basename } from 'path'
import { handOverNow } from '../shared/handOver'
import { laneOf } from './lanes'
import { sessions } from './sessions'
import { workspaceOf } from './workspace'

/** Whether the agent is the builder or reviewer of a running lane of its project (the Assistant, or none open: no). */
async function onLane(projectPath: string, agentId: string): Promise<boolean> {
  try {
    const ws = workspaceOf(projectPath)
    if (ws.isAssistantHome(projectPath)) return false
    return !!(await laneOf(ws, basename(projectPath), agentId))
  } catch {
    return false
  }
}

/**
 * Whether it may hand over now. `turnOver`: as if its turn were over (the hand-over about to end its conversation, which
 * checks its turn itself): only the merge slot and the lane count then.
 */
export async function mayHandOverNow(projectPath: string, agentId: string, turnOver = false): Promise<boolean> {
  const st = sessions.liveFor(projectPath, agentId)
  return handOverNow(turnOver && st ? { ...st, status: 'finished', backgroundTasks: 0 } : st, await onLane(projectPath, agentId))
}

let started = false

/** Gives the session manager the check. Once, at startup. */
export function startHandOverCheck(): void {
  if (started) return
  started = true
  sessions.handOverAllowed = mayHandOverNow
}
