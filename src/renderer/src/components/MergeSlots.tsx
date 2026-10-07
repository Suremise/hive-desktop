import { useEffect } from 'react'
import { holderText, slotLine } from '@shared/mergeSlot'
import type { MergeSlotInfo } from '@shared/types'
import { attempt } from '../actions'
import { call } from '../api'
import { confirm, set, useStore } from '../store'
import { useNow } from '../usage'
import { Icon, Tooltip } from './ui'

/**
 * The merge slots (#350): who is merging into a project's branch and who waits, in the Progress panel (every project),
 * the project's Overview and the Merge dialog, with Release for a holder that is stuck.
 */

const NO_SLOTS: MergeSlotInfo[] = []

/** This window's slots, loaded when its workspace changes (events keep them current). */
export function useMergeSlots(): MergeSlotInfo[] {
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws) return
    let current = true
    void call('mergeSlots:list').then((slots) => current && set({ mergeSlots: slots }))
    return () => {
      current = false
    }
  }, [ws])
  return useStore((s) => s.mergeSlots ?? NO_SLOTS)
}

/** One project's slots. */
export function projectSlots(slots: MergeSlotInfo[], projectPath: string): MergeSlotInfo[] {
  return slots.filter((s) => s.project.toLowerCase() === projectPath.toLowerCase())
}

async function release(s: MergeSlotInfo, projectName: string): Promise<void> {
  const h = s.holder
  if (!h) return
  const ok = await confirm({
    title: 'Release the merge slot?',
    message: `${h.kind === 'agent' ? h.name : 'Your merge'} holds the merge slot for ${projectName} · ${s.branch}. Release it only if it is stuck: ${h.kind === 'agent' ? `${h.name} may be in the middle of merging, and is told the slot was released when it next asks.` : 'the merge may still be running.'}`,
    detail: s.waiting.length ? `${s.waiting[0].name} is next in line and gets it.` : undefined,
    confirmLabel: 'Release',
    danger: true
  })
  // Releases the hold this question named: if it has changed hands meanwhile, Hive refuses and says so.
  if (ok) await attempt("Couldn't release the merge slot", () => call('mergeSlots:release', s.project, s.branch, h.id))
}

/** The slots as rows: the branch, who holds it (and until when), who waits; Release for a holder. */
export function MergeSlotList({ slots, projectName, showProject }: { slots: MergeSlotInfo[]; projectName: (path: string) => string; showProject: boolean }) {
  const now = useNow(30000)
  if (!slots.length) return null
  return (
    <div className="merge-slots">
      {slots.map((s) => {
        const h = s.holder
        const late = !!h && h.until < now
        return (
          <div key={`${s.project}#${s.branch}`} className={`merge-slot${late ? ' late' : ''}`} data-slot={`${projectName(s.project)}#${s.branch}`}>
            <Icon name="git-merge" />
            <div className="merge-slot-text">
              <div className="merge-slot-line">
                {showProject && <span className="merge-slot-project">{projectName(s.project)} · </span>}
                <span className="merge-slot-branch">{s.branch}</span>: {slotLine(s, now)}
              </div>
              {s.waiting.length > 0 && <div className="merge-slot-waiting faint">Waiting: {s.waiting.map((w) => w.name).join(', ')}</div>}
            </div>
            {h && (
              <Tooltip content={`Release the merge slot ${h.kind === 'agent' ? `${h.name} holds` : 'your merge holds'}, if it is stuck`}>
                <button type="button" className="btn small subtle" onClick={() => void release(s, projectName(s.project))}>
                  Release
                </button>
              </Tooltip>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The Merge dialog's note while the slot it merges into is taken: the merge waits until it is free. */
export function MergeSlotNote({ slot }: { slot: MergeSlotInfo | null }) {
  if (!slot || (!slot.holder && !slot.waiting.length)) return null
  const who = slot.holder ? holderText(slot.holder) : `${slot.waiting[0].name} is waiting to merge`
  return (
    <div className="banner warn merge-slot-note">
      <Icon name="git-merge" />
      <span>
        {who[0].toUpperCase() + who.slice(1)} into {slot.branch} (the merge slot). Merge waits until it is free{slot.waiting.length ? `; ${slot.waiting.length} waiting` : ''}.
      </span>
    </div>
  )
}
