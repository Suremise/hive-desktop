import type { LaneState, TaskWatchInfo } from './types'

/**
 * A project's agents as a table (#529: the project tile's tooltip, the sidebar's agent count and the project header's
 * status): what goes in each row comes from the renderer; the order and the "Waiting for" cell are here.
 */

/** What the table needs of a lane: its state and its pair, by agent id. */
export interface TableLane {
  state: LaneState
  builder: { agentId: string }
  reviewer: { agentId: string } | null
}

/**
 * The agents in the table's order: each running lane's builder then its reviewer (in the lanes' order, as the Progress
 * panel shows them; paused lanes count, ended ones don't), then everyone else in the project's order. An agent in two
 * lanes goes with the first.
 */
export function laneOrder<T extends { id: string }>(agents: readonly T[], lanes: readonly TableLane[]): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const out: T[] = []
  const placed = new Set<string>()
  const put = (id: string | undefined): void => {
    const a = id === undefined ? undefined : byId.get(id)
    if (a && !placed.has(a.id)) {
      placed.add(a.id)
      out.push(a)
    }
  }
  for (const l of lanes) {
    if (l.state !== 'active' && l.state !== 'paused') continue
    put(l.builder.agentId)
    put(l.reviewer?.agentId)
  }
  for (const a of agents) put(a.id)
  return out
}

/** A watching agent's "Waiting for" cell: its watch's label without the words ("#506, #509 → Review", "B6 to finish"). */
export function waitingFor(watch: Pick<TaskWatchInfo, 'label'> | undefined): string {
  return watch ? watch.label.replace(/^Waiting for\s+/i, '') : ''
}
