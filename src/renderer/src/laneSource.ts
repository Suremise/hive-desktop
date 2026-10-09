import { useMemo, useSyncExternalStore } from 'react'
import { useStore } from './store'

/**
 * Where the Progress panel's lanes come from (#484): the one place that knows the lane data's shape (#483's `LaneInfo`).
 * Everything else reads `Lane` through `useLanes()`.
 *
 * Until #483 lands, this is a stub: no lanes (so the section stays hidden), unless a test sets some with
 * `window.__hiveTestLanes([...])`, in #483's shape. Wiring it: `LaneData` becomes `LaneInfo` from shared/types, and the
 * stub becomes `call('lanes:list')` and the `lanes-changed` event.
 */

/** #483's lane, as posted on #484: the fields the panel reads. */
interface LaneData {
  id: string
  /** The project's folder name. */
  project: string
  name: string | null
  builder: { id: string; name: string }
  reviewer: { id: string; name: string } | null
  /** In the lane's order. The panel reads each card from the board itself, as it is now. */
  cards: { number: number }[]
  state: Lane['state']
}

/** A lane as the panel shows it: a builder and its reviewer working through cards in order. */
export interface Lane {
  id: string
  /** Its project's folder (path). */
  project: string
  builder: { agentId: string; name: string }
  reviewer: { agentId: string; name: string } | null
  /** What the lane is about, in a few words, when it has a name. */
  name: string | null
  /** Its cards' numbers, in the order they are worked. */
  cards: number[]
  /** paused: a card is blocked on the user; ended: merged; abandoned: an agent was removed, or it was given up. */
  state: 'active' | 'paused' | 'ended' | 'abandoned'
}

const NO_DATA: LaneData[] = []
const NO_LANES: Lane[] = []
let data: LaneData[] = NO_DATA
const listeners = new Set<() => void>()
const subscribe = (f: () => void): (() => void) => {
  listeners.add(f)
  return () => listeners.delete(f)
}

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? ''

/** This window's lanes, in the workspace's projects (a lane whose project isn't there is left out). */
export function useLanes(): Lane[] {
  const raw = useSyncExternalStore(subscribe, () => data)
  const projects = useStore((s) => s.workspace?.projects)
  return useMemo(() => {
    if (!raw.length || !projects) return NO_LANES
    const pathOf = new Map(projects.map((p) => [folderName(p.path), p.path]))
    const lanes = raw.flatMap((d): Lane[] => {
      const project = pathOf.get(d.project.toLowerCase())
      if (!project) return []
      const who = (a: { id: string; name: string }): Lane['builder'] => ({ agentId: a.id, name: a.name })
      return [{ id: d.id, project, builder: who(d.builder), reviewer: d.reviewer ? who(d.reviewer) : null, name: d.name, cards: d.cards.map((c) => c.number), state: d.state }]
    })
    return lanes.length ? lanes : NO_LANES
  }, [raw, projects])
}

;(window as unknown as { __hiveTestLanes?: (l: LaneData[]) => void }).__hiveTestLanes = (l) => {
  data = l.length ? l : NO_DATA
  for (const f of listeners) f()
}
