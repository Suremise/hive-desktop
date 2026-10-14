import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { msg, tr } from '@shared/i18n'
import { branchSummary, inboxName, inboxStateText, type InboxItem } from '@shared/inbox'
import type { SessionStatus } from '@shared/types'
import { openInboxChanges, openInboxItem, openInboxMerge, useInbox } from '../inbox'
import { set, useLanguage, useStore } from '../store'
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
  useLanguage()
  if (!needYou.length && !toReview.length && !open) return null
  const toggle = (): void => set((s) => ({ inboxOpen: !s.inboxOpen }))
  const tip = needYou.length
    ? tr(msg({ id: 'board.inbox.needYouTip', defaultMessage: 'Agents waiting for you or finished since you last looked', description: "Tooltip of the status bar's inbox item (\"2 need you\")." }))
    : tr(msg({ id: 'board.inbox.toReviewTip', defaultMessage: 'Worktree agents with work to review', description: "Tooltip of the status bar's inbox item when only worktree agents' work waits (\"1 to review\")." }))
  return (
    <Tooltip content={tip}>
      <div className={cx('status-item', 'inbox-item', needYou.length > 0 && 'caution')} data-inbox-toggle onClick={toggle} role="button" aria-expanded={open}>
        {needYou.length ? (
          <>
            <Icon name="bell-dot" /> {tr(msg({ id: 'board.inbox.needYouCount', defaultMessage: '{n, plural, one {# needs you} other {# need you}}', description: "The status bar's inbox item: how many agents wait for the user or finished unseen (\"2 need you\"). Keep it short." }), { n: needYou.length })}
          </>
        ) : (
          <>
            <Icon name="git-merge" /> {tr(msg({ id: 'board.inbox.toReviewCount', defaultMessage: '{n, plural, one {# to review} other {# to review}}', description: "The status bar's inbox item: how many worktree agents have work for the user to review (\"1 to review\"). Keep it short." }), { n: toReview.length })}
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
  useLanguage()
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
          <strong>{inboxName(i)}</strong>
          {!i.assistant && ` · ${i.agentName}`}
        </div>
        <div className="inbox-state">{i.kind === 'review' && i.branch ? branchSummary(i.branch) : inboxStateText(i)}</div>
      </div>
      {i.kind === 'review' ? (
        <div className="inbox-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn subtle small" onClick={() => openInboxChanges(i)}>
            {tr(msg({ id: 'board.inbox.changes', defaultMessage: 'Changes', description: "Button on a worktree agent's row in the inbox: shows its changes in the Git tab." }))}
          </button>
          <button className="btn subtle small" onClick={() => openInboxMerge(i)}>
            {tr(msg({ id: 'board.inbox.merge', defaultMessage: 'Merge…', description: "Button on a worktree agent's row in the inbox: opens the merge dialog for its branch." }))}
          </button>
        </div>
      ) : (
        i.since && <span className="inbox-time">{timeAgo(i.since)}</span>
      )}
    </div>
  )
  return createPortal(
    <div className="inbox-panel" ref={ref} role="dialog" aria-label={tr(msg({ id: 'board.inbox.panel', defaultMessage: 'Agents that need you', description: "The inbox popover's accessible name (above the status bar)." }))}>
      <div className="inbox-section">{needYou.length ? tr(msg({ id: 'board.inbox.needYouHeading', defaultMessage: 'Need you ({n})', description: 'Heading in the inbox popover above the agents that wait for the user, with how many ({n}).' }), { n: needYou.length }) : tr(msg({ id: 'board.inbox.needYouEmptyHeading', defaultMessage: 'Need you', description: 'Heading in the inbox popover above the agents that wait for the user, when there are none.' }))}</div>
      {needYou.length ? needYou.map(row) : <div className="inbox-empty faint">{tr(msg({ id: 'board.inbox.nothing', defaultMessage: 'Nothing needs you right now.', description: 'The inbox popover when no agent waits for the user.' }))}</div>}
      {toReview.length > 0 && (
        <>
          <div className="inbox-section">{tr(msg({ id: 'board.inbox.toReviewHeading', defaultMessage: 'To review ({n})', description: "Heading in the inbox popover above worktree agents whose work waits for the user's review, with how many ({n})." }), { n: toReview.length })}</div>
          {toReview.map(row)}
        </>
      )}
    </div>,
    document.body
  )
}
