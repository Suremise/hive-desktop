import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { branchSummary, inboxStateText, type InboxItem } from '@shared/inbox'
import type { SessionStatus } from '@shared/types'
import { openInboxChanges, openInboxItem, openInboxMerge, useInbox } from '../inbox'
import { set, useStore } from '../store'
import { useNow } from '../usage'
import { cx, timeAgo } from '../util'
import { AssistantMark } from './AssistantMark'
import { Icon, Tooltip } from './ui'

/** The status dot an inbox item shows: its agent's for what it needs. */
const dotOf = (i: InboxItem): SessionStatus => (i.kind === 'review' || i.kind === 'finished' ? 'finished' : i.kind === 'failed' ? 'error' : 'waiting')

/** The status bar's "n need you": hidden when nothing needs you and nothing is left to review. */
export function InboxStatusItem() {
  const { needYou, toReview } = useInbox()
  const open = useStore((s) => s.inboxOpen)
  if (!needYou.length && !toReview.length && !open) return null
  const toggle = (): void => set((s) => ({ inboxOpen: !s.inboxOpen }))
  return (
    <Tooltip content={needYou.length ? 'Agents waiting for you or finished since you last looked' : 'Worktree agents with work to review'}>
      <div className={cx('status-item', 'inbox-item', needYou.length > 0 && 'caution')} data-inbox-toggle onClick={toggle} role="button" aria-expanded={open}>
        {needYou.length ? (
          <>
            <Icon name="bell-dot" /> {needYou.length} need{needYou.length === 1 ? 's' : ''} you
          </>
        ) : (
          <>
            <Icon name="git-merge" /> {toReview.length} to review
          </>
        )}
      </div>
    </Tooltip>
  )
}

/** The inbox popover above the status bar: oldest first; a click goes to the agent. */
export function InboxPopover() {
  const open = useStore((s) => s.inboxOpen)
  const { needYou, toReview } = useInbox()
  const ref = useRef<HTMLDivElement>(null)
  useNow(30000)
  useEffect(() => {
    if (!open) return
    const close = (): void => set({ inboxOpen: false })
    const down = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('[data-inbox-toggle]')) close()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  if (!open) return null
  const row = (i: InboxItem) => (
    <div key={`${i.projectPath}#${i.agentId}`} className="inbox-row" role="button" onClick={() => openInboxItem(i)}>
      {i.assistant ? <AssistantMark status={dotOf(i)} unseen={i.kind === 'finished'} /> : <span className={cx('dot', dotOf(i), i.kind === 'finished' && 'unseen')} />}
      <div className="inbox-text">
        <div className="inbox-name">
          <strong>{i.projectName}</strong>
          {!i.assistant && ` · ${i.agentName}`}
        </div>
        <div className="inbox-state">{i.kind === 'review' && i.branch ? branchSummary(i.branch) : inboxStateText(i)}</div>
      </div>
      {i.kind === 'review' ? (
        <div className="inbox-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn subtle small" onClick={() => openInboxChanges(i)}>
            Changes
          </button>
          <button className="btn subtle small" onClick={() => openInboxMerge(i)}>
            Merge…
          </button>
        </div>
      ) : (
        i.since && <span className="inbox-time">{timeAgo(i.since)}</span>
      )}
    </div>
  )
  return createPortal(
    <div className="inbox-panel" ref={ref} role="dialog" aria-label="Agents that need you">
      <div className="inbox-section">Need you{needYou.length ? ` (${needYou.length})` : ''}</div>
      {needYou.length ? needYou.map(row) : <div className="inbox-empty faint">Nothing needs you right now.</div>}
      {toReview.length > 0 && (
        <>
          <div className="inbox-section">To review ({toReview.length})</div>
          {toReview.map(row)}
        </>
      )}
    </div>,
    document.body
  )
}
