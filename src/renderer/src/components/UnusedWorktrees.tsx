import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo, UnusedWorktree, UnusedWorktreePreview, UnusedWorktreeRemoval, UnusedWorktrees } from '@shared/types'
import { formatSize } from '@shared/storage'
import { RecentCache } from '@shared/recentCache'
import { CHANGES_ABOUT, UNUSED_WORKTREES_GUIDE, holdsWork, lostByRemoving, originLabel, unusedState, unusedSummary, unusedWorkNotice } from '@shared/unusedWorktrees'
import { call, errorMessage } from '../api'
import { confirm, giveWorktreeToAgent, notify, showUnusedWorktrees, useStore } from '../store'
import { openGuideAt } from '../tips'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, InfoTip } from './ui'
import { useStorageRequests } from './Storage'

/**
 * Each project's unused worktrees as last listed (#476), with when: shown at once, while git is asked again, by every
 * list of them. The window's workspace's only (switching workspace empties it), and the 20 projects shown last.
 */
const lastListed = new RecentCache<{ data: UnusedWorktrees; at: number }>(20)

/**
 * The project's unused worktrees, as git says now: loaded again when its agents' worktrees change, when one changed
 * outside the list (a merge of one, `bumpUnused`), or on `reload`. Listing reads git for each worktree, which takes a
 * while: the last list shows meanwhile (`loading`; `at`, when it was read), and `error` says why the latest listing
 * failed (with or without a list from before).
 */
export function useUnusedWorktrees(project: ProjectInfo): { data: UnusedWorktrees | null; reload: () => void; loading: boolean; error: string | null; at: number } {
  const cacheKey = project.path.toLowerCase()
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const fromCache = useCallback(() => lastListed.scope(wsPath).get(cacheKey) ?? null, [wsPath, cacheKey])
  const [data, setData] = useState<UnusedWorktrees | null>(() => fromCache()?.data ?? null)
  const [at, setAt] = useState(() => fromCache()?.at ?? 0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loads = useRef(0)
  // The agents' worktrees: one removed (its worktree kept) or given to an agent changes the list.
  const trees = project.agents.map((a) => a.worktree?.path ?? '').join('|')
  const version = useStore((s) => s.unusedVersion[project.path] ?? 0)
  const reload = useCallback(() => {
    const n = ++loads.current
    setLoading(true)
    void call('worktrees:unused', project.path).then(
      (d) => {
        if (n !== loads.current) return
        const now = Date.now()
        lastListed.scope(wsPath).set(cacheKey, { data: d, at: now })
        setData(d)
        setAt(now)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (n !== loads.current) return
        setError(errorMessage(e))
        setLoading(false)
      }
    )
  }, [project.path, cacheKey, wsPath])
  useEffect(() => {
    const c = fromCache()
    setData(c?.data ?? null)
    setAt(c?.at ?? 0)
    setError(null)
    reload()
  }, [reload, trees, fromCache])
  // Changed elsewhere: the list stays shown while it loads again.
  useEffect(() => {
    if (version) reload()
  }, [version, reload])
  return { data, reload, loading, error, at }
}

/**
 * The Changes tab's "Unused worktrees (n)" (#353, moved there from the Overview by #400): worktrees no agent works in,
 * each merged and clean (Remove, with its branch) or holding work (what is at stake, Give to an agent…, Remove
 * anyway…), with their last commit and size, and Open to see its changes (and merge them) like an agent's worktree.
 * Removing is the user's: the Assistant can only see them.
 */
export function UnusedWorktreesSection({ project, data, reload, onOpen }: { project: ProjectInfo; data: UnusedWorktrees | null; reload: () => void; onOpen: (path: string) => void }) {
  const [sizes, setSizes] = useState<Record<string, number> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const request = useStorageRequests()
  const list = data?.worktrees ?? []
  const paths = list.map((w) => w.path).join('|')

  // Sizes as Storage measures them (once, cached there; cancelled when the Overview closes).
  useEffect(() => {
    setSizes(null)
    if (!paths) return
    const { result, current } = request((r) => call('storage:project', project.path, false, r))
    void result.then(
      (s) => current() && setSizes(Object.fromEntries((s.unusedWorktrees ?? []).map((w) => [w.path.toLowerCase(), w.bytes]))),
      () => undefined
    )
  }, [paths, project.path, request])

  if (!data) return <div className="empty-state"><Icon name="loading" spin />Loading…</div>
  if (!list.length)
    return (
      <div className="unused-worktrees">
        <UnusedHeading project={project} count={0} />
        <div className="empty-state">{data.gitProblem ? `${data.gitProblem}, so Hive can't list the unused worktrees.` : `${project.name} has no unused worktrees: every worktree belongs to an agent.`}</div>
      </div>
    )
  const merged = list.filter((w) => w.check.removable)
  const into = list.find((w) => w.check.into)?.check.into ?? 'the main branch'

  const removeOne = async (w: UnusedWorktree): Promise<void> => {
    setBusy(w.path)
    try {
      const r = await call('worktrees:removeUnused', project.path, w.path, { expectInto: w.check.into })
      if (!r.deleted) notify('warning', `${w.branch ?? w.path} was kept`, r.reason)
      else if (r.branchKept) notify('warning', `${w.path} was removed, its branch kept`, r.reason)
    } catch (e) {
      notify('error', "Couldn't remove the worktree", errorMessage(e))
    } finally {
      setBusy(null)
      reload()
    }
  }

  const removeMerged = async (): Promise<void> => {
    const kept: string[] = []
    const ok = await confirm({
      title: `Remove ${merged.length} merged worktree${merged.length === 1 ? '' : 's'}?`,
      message: `Each is merged into ${into} and clean: its folder and its branch are deleted. One that changed since is kept.`,
      list: merged.map((w) => `${w.branch} — ${w.path}`),
      confirmLabel: 'Remove',
      busyLabel: 'Removing…',
      run: async () => {
        for (const w of merged) {
          const r = await call('worktrees:removeUnused', project.path, w.path, { expectInto: w.check.into }).catch((e: unknown) => ({ deleted: false, reason: errorMessage(e) }))
          if (!r.deleted) kept.push(`${w.branch}: ${r.reason ?? 'kept'}`)
        }
      }
    })
    reload()
    if (ok && kept.length) notify('warning', `${kept.length} worktree${kept.length === 1 ? ' was' : 's were'} kept`, kept.join('\n'))
  }

  // What it loses, checked now in main (not the list's older counts), under a token the removal presents: main removes it
  // only if nothing in it changed since (#353), and spends the token whatever comes of it (#373). A refusal never leaves
  // the question offering to try that token again (#377): it closes, and when a new look settles it (expired, or the
  // worktree changed) a new preview is taken and asked about afresh, its own token and loss list, nothing removed meanwhile.
  const removeAnyway = async (w: UnusedWorktree): Promise<void> => {
    let refused: string | null = null
    for (;;) {
      setBusy(w.path)
      let preview: UnusedWorktreePreview
      try {
        preview = await call('worktrees:removalPreview', project.path, w.path)
      } catch (e) {
        notify('error', 'Nothing was removed', refused ? `${refused}. Checking it again failed: ${errorMessage(e)}` : errorMessage(e))
        break
      } finally {
        setBusy(null)
      }
      const outcome: { removal: UnusedWorktreeRemoval | null; error: string | null } = { removal: null, error: null }
      const ok = await confirm({
        title: refused ? 'Checked again: remove it anyway?' : 'Remove the worktree anyway?',
        message: `${refused ? `Nothing was removed: ${refused}. As it is now, this` : 'This'} deletes ${preview.path}${preview.branch ? ` and its branch ${preview.branch}` : ''}, with work that is nowhere else:`,
        list: preview.lost,
        detail: "It can't be undone. If anything in it changes before you confirm (a file, its branch, its commit), nothing is removed.",
        danger: true,
        confirmLabel: 'Remove Anyway',
        busyLabel: 'Removing…',
        run: async () => {
          // Never thrown: a failed run would offer Try Again with this spent token.
          outcome.removal = await call('worktrees:removeUnused', project.path, w.path, { force: preview.token }).catch((e: unknown) => {
            outcome.error = errorMessage(e)
            return null
          })
        }
      })
      if (!ok) break
      const r = outcome.removal
      if (outcome.error || !r) {
        notify('error', "Couldn't remove the worktree", outcome.error ?? undefined)
        break
      }
      if (r.deleted) {
        if (r.branchKept) notify('warning', `${w.path} was removed, its branch kept`, r.reason)
        break
      }
      if (!r.lookAgain) {
        notify('warning', `${w.branch ?? w.path} was kept`, r.reason)
        break
      }
      // Its own "look again" is what follows: the question says it once.
      refused = (r.reason ?? 'what it holds changed').replace(/:\s*(nothing was removed, )?look again$/, '')
    }
    // Removed, kept or cancelled: the list as it is now.
    reload()
  }

  return (
    <div className="unused-worktrees">
      <UnusedHeading project={project} count={list.length} into={into}>
        {merged.length > 0 && (
          <button className="btn small" onClick={() => void removeMerged()}>
            Remove all merged ({merged.length})…
          </button>
        )}
      </UnusedHeading>
      {list.map((w) => {
        const size = sizes?.[w.path.toLowerCase()]
        return (
          <div key={w.path} className="unused-wt" data-path={w.path}>
            <Icon name="git-branch" />
            <div className="grow">
              <div>
                <strong>{w.branch ?? '(detached)'}</strong>{' '}
                <span className={cx('badge', w.check.removable ? 'success' : holdsWork(w) ? 'warn' : '')}>{unusedState(w)}</span>{' '}
                {w.origin && (
                  <span className={cx('badge', w.origin.madeBy === 'other' && 'accent')} data-origin={w.origin.madeBy}>
                    {originLabel(w)}
                  </span>
                )}
              </div>
              <div className="muted mono" style={{ fontSize: 11 }}>
                {w.path}
              </div>
              <div className="faint" style={{ fontSize: 12 }}>
                {[w.lastCommit ? `${timeAgo(w.lastCommit.at)}: ${w.lastCommit.subject}` : '', size === undefined ? (sizes ? '' : 'measuring…') : formatSize(size)].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="flex">
              {w.branch && (
                <button className="btn small subtle" title={`Show ${w.branch}'s changes${holdsWork(w) ? ', and merge them' : ''}`} onClick={() => onOpen(w.path)}>
                  Open
                </button>
              )}
              {w.check.removable ? (
                <BusyButton className="btn small" busy={busy === w.path} busyLabel="Removing…" disabled={!!busy} onClick={() => void removeOne(w)}>
                  Remove
                </BusyButton>
              ) : (
                <>
                  <button className="btn small" onClick={() => giveWorktreeToAgent(project.path, w.path)}>
                    Give to an agent…
                  </button>
                  {lostByRemoving(w) && (
                    <BusyButton className="btn small danger-text" busy={busy === w.path} busyLabel="Checking…" disabled={!!busy} onClick={() => void removeAnyway(w)}>
                      Remove anyway…
                    </BusyButton>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The unused worktrees page's header (#476): its title, count and actions, and the one sentence saying what the page
 * shows (the Changes tab's description of it, on the right, whether the list is loading, empty or listed).
 */
export function UnusedHeading({ project, count, into, children }: { project: ProjectInfo; count?: number; into?: string; children?: React.ReactNode }) {
  return (
    <>
      <h2 className="section" id="unused-worktrees">
        Unused worktrees {count !== undefined && <span className="badge">{count}</span>}
        <InfoTip text="Worktrees no agent of this project uses right now, e.g. from another template (loading that template gives them back to its agents)." />
        <div className="grow" />
        {children}
        <button className="btn small subtle" onClick={() => openGuideAt(UNUSED_WORKTREES_GUIDE)}>
          Learn more
        </button>
      </h2>
      <p className="hint changes-about" data-about="unused">
        {CHANGES_ABOUT.unused(project.name, into ?? null)}
      </p>
    </>
  )
}

/** The Changes tab's notice (#353): only when an unused worktree holds work that isn't on the main branch. */
export function UnusedWorkNotice({ project, data }: { project: ProjectInfo; data: UnusedWorktrees | null }) {
  const text = data ? unusedWorkNotice(data.worktrees) : null
  if (!text) return null
  return (
    <div className="unused-work-notice">
      <Icon name="git-branch" />
      <span>{text}</span>
      <a onClick={() => showUnusedWorktrees(project.path)}>Review</a>
    </div>
  )
}

/** The Overview's one line (#400): "7 unused worktrees (7 merged) — Review in Changes". Nothing with none. */
export function UnusedWorktreesLine({ project }: { project: ProjectInfo }) {
  const { data } = useUnusedWorktrees(project)
  const text = data ? unusedSummary(data.worktrees) : null
  if (!text) return null
  return (
    <div className="unused-worktrees-line">
      <Icon name="git-branch" />
      <span>{text}</span>
      <span className="faint">—</span>
      <a onClick={() => showUnusedWorktrees(project.path)}>Review in Changes</a>
    </div>
  )
}
