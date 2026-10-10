import { useEffect, useMemo } from 'react'
import { panelOrder } from '@shared/laneBar'
import type { LaneCard, LaneInfo } from '@shared/types'
import { call } from './api'
import { set, useStore } from './store'

/**
 * Where the Progress panel's lanes come from (#484): the one place that knows the lane data's shape (#483's
 * `LaneInfo`, from `lanes:list` and the `lanes-changed` event). Everything else reads `Lane` through `useLanes()`.
 */

/** A lane as the panel shows it: a builder and its reviewer working through cards in order. */
export interface Lane {
  id: string
  /** Its project's folder (path). */
  project: string
  builder: { agentId: string; name: string }
  reviewer: { agentId: string; name: string } | null
  /** What the lane is about, in a few words, when it has a name. */
  name: string | null
  /** Its cards' numbers, in the order they are worked. The panel reads each card from the board itself, as it is now. */
  cards: number[]
  /** paused: it waits for the user (a blocked card, nothing else worked); ended: merged; abandoned: an agent was removed, or it was given up. */
  state: LaneInfo['state']
  /** Ended or abandoned: its cards as it left them (#512), never the board's now. */
  frozen: LaneCard[] | null
  startedAt: string
  endedAt: string | null
}

const NO_LANES: Lane[] = []
const NO_INFO: LaneInfo[] = []

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? ''

/**
 * This window's lanes, loaded when its workspace changes (events keep them current), in the workspace's projects, in the
 * panel's order (running first, panelOrder).
 */
export function useLanes(): Lane[] {
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws) return
    let current = true
    void call('lanes:list').then((lanes) => current && set({ lanes }))
    return () => {
      current = false
    }
  }, [ws])
  const raw = useStore((s) => s.lanes ?? NO_INFO)
  const projects = useStore((s) => s.workspace?.projects)
  return useMemo(() => {
    if (!raw.length || !projects) return NO_LANES
    // A lane names its project by folder name; one whose project isn't in the workspace is left out.
    const pathOf = new Map(projects.map((p) => [folderName(p.path), p.path]))
    const who = (a: { id: string; name: string }): Lane['builder'] => ({ agentId: a.id, name: a.name })
    const lanes = raw.flatMap((d): Lane[] => {
      const project = pathOf.get(d.project.toLowerCase())
      const frozen = d.state === 'ended' || d.state === 'abandoned' ? d.cards : null
      return project ? [{ id: d.id, project, builder: who(d.builder), reviewer: d.reviewer ? who(d.reviewer) : null, name: d.name, cards: d.cards.map((c) => c.number), state: d.state, frozen, startedAt: d.startedAt, endedAt: d.endedAt }] : []
    })
    return lanes.length ? panelOrder(lanes) : NO_LANES
  }, [raw, projects])
}
