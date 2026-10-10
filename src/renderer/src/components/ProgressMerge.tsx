import { holderText, minutes } from '@shared/mergeSlot'
import type { MergeSlotInfo } from '@shared/types'
import { call } from '../api'
import { findProject, set, useStore } from '../store'
import { cx } from '../util'
import { releaseSlot } from './MergeSlots'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The top of the Progress panel (#484): a card per merge going on (a slot its holder has taken), in its own colour, with who
 * holds it, which branch goes where, the holder's current step (its running progress), how long so far and left, and
 * who waits. It folds up to its first line (remembered per workspace); Release frees a holder that is stuck.
 */

/** Where the merge cards' fold is remembered (`ui.panes`, as the panel's other folds). */
const foldKey = (ws: string): string => `progress-merge-fold:${ws.toLowerCase()}`

/** The fold of one of the panel's sections, remembered per workspace: true when folded. */
export function usePanelFold(key: string | null): [boolean, () => void] {
  const folded = useStore((s) => (key ? s.panes[key] === 1 : false))
  const toggle = (): void => {
    if (!key) return
    set((s) => ({ panes: { ...s.panes, [key]: folded ? 0 : 1 } }))
    void call('ui:setPane', key, folded ? null : 1)
  }
  return [folded, toggle]
}

const capital = (s: string): string => s[0].toUpperCase() + s.slice(1)

export function MergeCards({ slots, projectName, showProject, stepOf, now }: { slots: MergeSlotInfo[]; projectName: (path: string) => string; showProject: boolean; stepOf: (s: MergeSlotInfo) => string | null; now: number }) {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const [folded, toggle] = usePanelFold(ws ? foldKey(ws) : null)
  if (!slots.length) return null
  return (
    <div className="progress-merge" role="region" aria-label="Merging">
      {slots.map((s) => (
        <MergeCard key={`${s.project}#${s.branch}`} slot={s} project={projectName(s.project)} showProject={showProject} step={stepOf(s)} now={now} folded={folded} onFold={toggle} />
      ))}
    </div>
  )
}

function MergeCard({ slot: s, project, showProject, step, now, folded, onFold }: { slot: MergeSlotInfo; project: string; showProject: boolean; step: string | null; now: number; folded: boolean; onFold: () => void }) {
  // Only taken slots get a card (Progress.tsx).
  const h = s.holder!
  // The holder's branch, when it is an agent working in its own worktree: "hive/b1 → main".
  const from = useStore((st) => (h.agentId ? (findProject(st, s.project)?.agents.find((a) => a.id === h.agentId)?.worktree?.branch ?? null) : null))
  const late = h.until < now
  const left = h.until - now
  const time = `${minutes(now - h.since)} so far · ${left > 0 ? `${minutes(left)} left` : 'over its time'}`
  return (
    <div className={cx('progress-merge-card', late && 'late', folded && 'folded')} data-slot={`${project}#${s.branch}`}>
      <div className="progress-merge-top">
        <Icon name="git-merge" />
        <span className="progress-merge-who">{capital(holderText(h))}</span>
        {folded && <span className="progress-merge-short">{minutes(now - h.since)}</span>}
        <div className="grow" />
        {!folded && (
          <Tooltip content={`Release the merge slot ${h.kind === 'agent' ? `${h.name} holds` : 'your merge holds'}, if it is stuck`}>
            <button type="button" className="btn small subtle" onClick={() => void releaseSlot(s, project)}>
              Release
            </button>
          </Tooltip>
        )}
        <IconButton icon={folded ? 'chevron-down' : 'chevron-up'} title={folded ? 'Show the merge in full' : 'Fold the merge to one line'} expanded={!folded} onClick={onFold} />
      </div>
      {!folded && (
        <>
          <div className="progress-merge-branch">
            {showProject && <span className="faint">{project} · </span>}
            {from ? (
              <>
                <code>{from}</code> → <code>{s.branch}</code>
              </>
            ) : (
              <>
                into <code>{s.branch}</code>
              </>
            )}
          </div>
          {step && (
            <Tooltip block content={step}>
              <div className="progress-merge-step">{step}</div>
            </Tooltip>
          )}
          <div className={cx('progress-merge-time faint', late && 'late')}>{time}</div>
          {s.waiting.length > 0 && <div className="progress-merge-waiting faint">Waiting: {s.waiting.map((w) => w.name).join(', ')}</div>}
        </>
      )}
    </div>
  )
}
