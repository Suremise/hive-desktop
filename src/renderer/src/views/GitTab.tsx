import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import {
  GIT_SECTIONS,
  GIT_VIEW_GUIDE,
  aheadBehindText,
  folderBusy,
  gitStateText,
  gitStatusText,
  gitStatusTip,
  headText,
  identityProblem,
  identityWarnings,
  parentRepoText,
  remoteNameProblem,
  remoteUrlProblem,
  type GitFolderAction,
  type GitHistory,
  type GitRepoInfo,
  type GitRepoSummary,
  type GitSection
} from '@shared/gitRepo'
import { gitFixText } from '@shared/gitTool'
import { samePath } from '@shared/movePaths'
import type { HiveRequests } from '@shared/api'
import { call, errorMessage } from '../api'
import { attempt } from '../actions'
import { bumpGit, choose, confirm, notify, prompt, set, showGit, showView, UNUSED_ROOT, useStore } from '../store'
import { openGuideAt } from '../tips'
import { useNow } from '../usage'
import { cx, timeAgo } from '../util'
import { projectSlots, useMergeSlots } from '../components/MergeSlots'
import { BusyButton, Icon, IconButton, LoadFailed, Modal, StaleNote, Tooltip, useBusy } from '../components/ui'
import { ChangesTab } from './ProjectTabs'

/**
 * The project's Git tab (#607): Changes (whose changes, as the Changes tab had them), History (the project folder's
 * last commits and its tags) and Branches & remotes (its branch or detached HEAD, upstream and ahead/behind as of the
 * last fetch, branches, remotes, other worktrees read-only, and the commit identity). Every change here is the user's
 * own (never an agent tool), in the project folder only: switching branch or pulling is refused while an agent works
 * there or holds its merge slot.
 */

const at = (ms: number | null): string | null => (ms ? timeAgo(new Date(ms).toISOString()) : null)

/**
 * Reads a Git channel for the project: again when the project's git changes here, its agents work, the window gets
 * focus, or on `reload`; the last answer stays while it does.
 */
function useGitRead<C extends 'git:summary' | 'git:info' | 'git:history'>(channel: C, project: ProjectInfo): { data: Awaited<ReturnType<HiveRequests[C]>> | null; error: string | null; loading: boolean; at: number; reload: () => void } {
  type T = Awaited<ReturnType<HiveRequests[C]>>
  const version = useStore((s) => s.gitVersion[project.path] ?? 0)
  const usage = useStore((s) => s.usageVersion[project.path] ?? 0)
  const [state, setState] = useState<{ for: string; data: T | null; error: string | null; loading: boolean; at: number }>({ for: project.path, data: null, error: null, loading: true, at: 0 })
  const loads = useRef(0)
  const reload = useCallback(() => {
    const n = ++loads.current
    const path = project.path
    setState((s) => (s.for === path ? { ...s, loading: true } : { for: path, data: null, error: null, loading: true, at: 0 }))
    void (call as (c: C, p: string) => Promise<T>)(channel, path).then(
      (data) => n === loads.current && setState({ for: path, data, error: null, loading: false, at: Date.now() }),
      (e) => n === loads.current && setState((s) => ({ ...s, for: path, error: errorMessage(e), loading: false }))
    )
  }, [channel, project.path])
  useEffect(reload, [reload, version, usage, project.branch])
  // What the user did in a terminal meanwhile (a commit, git init) shows on coming back to the window.
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  // Another project's answer never shows for this one.
  const mine = state.for === project.path
  return { data: mine ? state.data : null, error: mine ? state.error : null, loading: !mine || state.loading, at: mine ? state.at : 0, reload }
}

/** Why an action that moves the project folder is refused now (an agent works there, or its merge slot is held), or null. */
function useFolderBusy(project: ProjectInfo): (action: GitFolderAction) => string | null {
  const slots = projectSlots(useMergeSlots(), project.path)
  const agents = project.agents.filter((a) => !a.worktree).map((a) => ({ name: a.name, status: a.live?.status ?? null }))
  const folder = slots.map((s) => ({ branch: s.branch, holder: s.holder && s.holder.kind !== 'user' ? s.holder.name : null, ...(s.holder?.kind === 'user' ? { byUser: true } : {}), waiting: s.waiting.map((w) => w.name) }))
  return (action) => folderBusy(agents, folder, action)
}

/** Runs a Git action from the window: its reply as a notice, its failure as an error, and the view read again either way. */
async function gitAction(project: ProjectInfo, title: string, fn: () => Promise<string>): Promise<boolean> {
  const done = await attempt(title, fn)
  bumpGit(project.path)
  if (done === undefined) return false
  notify('success', done)
  return true
}

export function GitTab({ project }: { project: ProjectInfo }) {
  const section: GitSection = useStore((s) => s.gitSection[project.path]) ?? 'changes'
  const summary = useGitRead('git:summary', project)
  const s = summary.data
  return (
    <div className="git-view">
      <div className="git-head">
        <div className="segmented git-sections" role="tablist" aria-label="Git">
          {GIT_SECTIONS.map((x) => (
            <button key={x.id} role="tab" aria-selected={section === x.id} className={cx(section === x.id && 'active')} onClick={() => showGit(project.path, x.id)}>
              <Icon name={x.icon} /> {x.label}
            </button>
          ))}
        </div>
        {s?.isRepo && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{gitStatusTip(s, at(s.fetchedAt))}</span>}>
            <span className="git-head-status faint">
              <Icon name="git-branch" /> {gitStatusText(s)}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="git-body">
        {s && !s.isRepo && !s.gitProblem ? (
          <GitSetupNotes project={project} />
        ) : section === 'changes' ? (
          <ChangesTab project={project} />
        ) : s?.gitProblem ? (
          <GitProblem problem={s.gitProblem} retry={summary.reload} />
        ) : section === 'history' ? (
          <HistorySection project={project} summary={s} />
        ) : (
          <BranchesSection project={project} />
        )}
      </div>
    </div>
  )
}

/** A project without git (#607): it says so, what that means, and how to start. */
function GitSetupNotes({ project }: { project: ProjectInfo }) {
  return (
    <div className="scroll-page">
      <div className="page-narrow git-setup" data-git-setup="">
        <h2 className="section">
          <Icon name="source-control" /> {project.name} isn't a git repository
        </h2>
        <p>Without git, agents work in the project folder, and Hive has no worktrees, merging or Git view for it.</p>
        <p className="hint">
          To use them, make it a repository: run <code>git init</code> in the project folder (or ask an agent to) and commit its files. Then add a remote under Branches &amp; remotes to push it.
        </p>
        <p className="hint">
          <a onClick={() => openGuideAt(GIT_VIEW_GUIDE)}>Learn more</a>
        </p>
      </div>
    </div>
  )
}

function GitProblem({ problem, retry }: { problem: string; retry: () => void }) {
  const tool = useStore((s) => s.gitTool)
  return (
    <div className="empty-state changes-git-missing" style={{ paddingTop: '15vh' }}>
      <Icon name="warning" />
      {problem}, so Hive can't read this repository.
      <p className="hint">{gitFixText(tool)}</p>
      <div className="flex" style={{ justifyContent: 'center' }}>
        <button className="btn small" onClick={() => set({ setupOpen: true })}>
          <Icon name="hubot" /> Agent Setup
        </button>
        <button className="btn small" onClick={retry}>
          <Icon name="refresh" /> Retry
        </button>
      </div>
    </div>
  )
}

/** A section's first load: its spinner, or why it failed. */
function Loading<T>({ read, what, children }: { read: { data: T | null; error: string | null; loading: boolean; at: number; reload: () => void }; what: string; children: (data: T) => React.ReactNode }) {
  if (!read.data) {
    return (
      <div className="scroll-page">
        <div className="page-narrow">{read.error && !read.loading ? <LoadFailed inline what={what} error={read.error} onRetry={read.reload} /> : <p className="hint"><Icon name="loading" spin /> Reading git…</p>}</div>
      </div>
    )
  }
  return (
    <div className="scroll-page">
      <div className="page-narrow">
        {read.error && <StaleNote what={what} error={read.error} at={read.at} onRetry={read.reload} />}
        {children(read.data)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistorySection({ project, summary }: { project: ProjectInfo; summary: GitRepoSummary | null }) {
  const read = useGitRead('git:history', project)
  const [form, setForm] = useState<FormSpec | null>(null)
  useNow(60000)
  return (
    <Loading read={read} what="the history">
      {(h: GitHistory) => (
        <div className="git-history" data-git-history="">
          <h2 className="section git-section-head">
            History {summary ? <span className="faint">of {headText(summary)}</span> : null}
            <span className="git-section-actions">
              <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title="Read the history again" onClick={read.reload} />
            </span>
          </h2>
          {h.commits.length === 0 ? (
            <p className="hint">No commits yet.</p>
          ) : (
            <div className="git-rows">
              {h.commits.map((c) => (
                <Tooltip block key={c.hash} content={<span style={{ whiteSpace: 'pre-line' }}>{`${c.hash}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString()}`}</span>}>
                  <div className="git-row git-commit" data-commit={c.short}>
                    <code className="git-hash">{c.short}</code>
                    <span className="git-subject">{c.subject}</span>
                    {c.refs.map((r) => (
                      <span key={r} className={cx('badge', 'git-ref', r.startsWith('tag: ') && 'git-tag', r.startsWith('HEAD') && 'git-headref')}>
                        {r.replace(/^tag: /, '')}
                      </span>
                    ))}
                    <span className="git-meta faint">
                      {c.author} · {at(c.date)}
                    </span>
                  </div>
                </Tooltip>
              ))}
            </div>
          )}
          <h2 className="section git-section-head">
            Tags <span className="badge">{h.tags.length + h.moreTags}</span>
            <span className="git-section-actions">
              <button className="btn small" disabled={!summary?.head || !!summary.parentRepo} onClick={() => setForm(tagForm(project, summary))}>
                <Icon name="tag" /> Create tag…
              </button>
            </span>
          </h2>
          {h.tags.length === 0 ? (
            <p className="hint">No tags. Create tag… tags the commit the project folder has checked out.</p>
          ) : (
            <div className="git-rows">
              {h.tags.map((t) => (
                <div key={t.name} className="git-row git-tag-row" data-tag={t.name}>
                  <Icon name="tag" />
                  <span className="git-name">{t.name}</span>
                  <code className="git-hash">{t.commit}</code>
                  <span className="git-subject faint">{t.subject}</span>
                  <span className="git-meta faint">{at(t.date)}</span>
                </div>
              ))}
              {h.moreTags > 0 && <p className="hint">and {h.moreTags} older</p>}
            </div>
          )}
          {form && <GitForm spec={form} onClose={() => setForm(null)} />}
        </div>
      )}
    </Loading>
  )
}

// ---------------------------------------------------------------------------
// Branches & remotes
// ---------------------------------------------------------------------------

function BranchesSection({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:info', project)
  const busyFor = useFolderBusy(project)
  const { busy, run } = useBusy()
  const [form, setForm] = useState<FormSpec | null>(null)
  const [showRemote, setShowRemote] = useState(false)
  useNow(60000)

  const act = (name: string, title: string, fn: () => Promise<string>): void => void run(name, () => gitAction(project, title, fn))

  /** A branch, after a confirm that names the agents whose session runs in the folder (idle now: they find it on their next turn). */
  const switchTo = async (target: string, current: string | null): Promise<void> => {
    const idle = project.agents.filter((a) => !a.worktree && a.live).map((a) => a.name)
    const ok = await confirm({
      title: `Switch ${project.name} to ${target}?`,
      message: `The project folder leaves ${current ?? 'its detached HEAD'} for ${target}. Uncommitted changes come along when they don't clash with ${target}; if they do, git refuses and nothing changes.`,
      ...(idle.length ? { detail: `${idle.join(', ')} ${idle.length === 1 ? 'has a session' : 'have sessions'} in the project folder: ${idle.length === 1 ? 'it finds' : 'they find'} ${target} on the next turn.` } : {}),
      confirmLabel: 'Switch'
    })
    if (ok) act(`switch:${target}`, `Couldn't switch to ${target}`, () => call('git:switch', project.path, target))
  }

  const newBranch = async (s: GitRepoSummary): Promise<void> => {
    const blocked = busyFor('create')
    let switchNow = !blocked
    const name = await prompt({
      title: 'New branch',
      message: `A branch at ${s.head}${s.branch ? `, where ${s.branch} is now` : ''}.${blocked ? ` It can't be switched to now: ${blocked}` : ''}`,
      placeholder: 'feature/name',
      confirmLabel: 'Create',
      validate: (v) => (!v.trim() ? 'Enter a name' : /\s/.test(v.trim()) ? 'Branch names have no spaces' : null),
      check: blocked ? undefined : { label: 'Switch to it now', initial: true, set: (v) => (switchNow = v) }
    })
    if (name) act('create', `Couldn't create ${name.trim()}`, () => call('git:createBranch', project.path, name.trim(), !switchNow))
  }

  const pushNow = async (s: GitRepoSummary): Promise<void> => {
    if (s.upstream?.remote && !s.upstream.gone) return act('push', `Couldn't push ${s.branch}`, () => call('git:push', project.path))
    let remote = s.remotes.includes('origin') ? 'origin' : s.remotes[0]
    const go = await choose({
      title: `Push ${s.branch}`,
      message: `${s.branch} tracks no remote branch yet. Push it, and track it from now on:`,
      select: { label: 'Remote', options: s.remotes.map((r) => ({ label: r, value: r })), initial: remote, set: (v) => (remote = v) },
      choices: [
        { label: 'Cancel', value: '' },
        { label: 'Push', value: 'push' }
      ]
    })
    if (go === 'push') act('push', `Couldn't push ${s.branch}`, () => call('git:push', project.path, remote))
  }

  const editRemote = async (name: string, url: string): Promise<void> => {
    const next = await prompt({ title: `Change ${name}'s URL`, initial: url, confirmLabel: 'Change', validate: remoteUrlProblem })
    // An https URL shows with its password hidden: unchanged, nothing to save.
    if (next && next.trim() !== url) act(`remote:${name}`, `Couldn't change ${name}'s URL`, () => call('git:setRemoteUrl', project.path, name, next.trim()))
  }

  return (
    <Loading read={read} what="the branches and remotes">
      {(info: GitRepoInfo) => {
        const s = info.summary
        // Inside another repository (a workspace kept in git): shown, never changed here.
        const ro = parentRepoText(s)
        const off = !!busy || !!ro
        const switchBlocked = ro ?? busyFor('switch')
        const pullBlocked = ro ? ro : !s.branch ? 'HEAD is detached: switch to a branch to pull.' : !s.upstream || s.upstream.gone ? `${s.branch} tracks no remote branch to pull from.` : s.state ? `Git is ${gitStateText(s.state)}: finish or abort it first.` : busyFor('pull')
        const pushBlocked = ro ? ro : !s.branch ? 'HEAD is detached: switch to a branch to push.' : !s.head ? 'No commits to push yet.' : !s.remotes.length ? 'Add a remote to push to.' : null
        const fetched = at(s.fetchedAt)
        const remoteOnly = info.remoteBranches.filter((r) => !info.branches.some((b) => b.name === r.slice(r.indexOf('/') + 1)))
        const warnings = identityWarnings(info.identity, info.remotes)
        const agentOf = (path: string | null) => (path ? project.agents.find((a) => a.worktree && samePath(a.worktree.path, path)) : undefined)
        return (
          <div className="git-branches" data-git-branches="">
            <h2 className="section git-section-head">
              Branch
              <span className="git-section-actions">
                <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title="Read git again (doesn't fetch)" onClick={read.reload} />
              </span>
            </h2>
            {ro && (
              <div className="banner info" data-git-parent="">
                <Icon name="info" /> {ro}
              </div>
            )}
            <div className="git-current" data-git-current="">
              <div className="git-current-line">
                <Icon name="git-branch" /> <strong data-git-head="">{headText(s)}</strong>
                {s.state && <span className="badge warn">{gitStateText(s.state)}</span>}
                {s.upstream ? (
                  <span className="faint" data-git-upstream="">
                    tracks {s.upstream.name} · <span data-git-ab="">{aheadBehindText(s.upstream)}</span>
                  </span>
                ) : s.branch && s.remotes.length ? (
                  <span className="faint">tracks no remote branch: Push sets one</span>
                ) : null}
              </div>
              {s.state && <div className="banner warn">Git is {gitStateText(s.state)} in the project folder. Finish or abort it in a terminal (or ask an agent to): Hive doesn't.</div>}
              {s.remotes.length > 0 && (
                <div className="git-fetched faint" data-git-fetched="">
                  {fetched ? `As of the last fetch, ${fetched}.` : 'Never fetched.'} Hive never fetches by itself.
                  <Tooltip content="Fetch every remote: ahead/behind and remote branches as they are now">
                    <button className="btn small subtle" disabled={off} aria-label="Fetch" onClick={() => act('fetch', "Couldn't fetch", () => call('git:fetch', project.path))}>
                      <Icon name={busy === 'fetch' ? 'loading' : 'refresh'} spin={busy === 'fetch'} /> Fetch
                    </button>
                  </Tooltip>
                </div>
              )}
              <div className="git-actions">
                <Tooltip content={pullBlocked ?? `Fetch ${s.upstream?.name} and bring ${s.branch} up to it (only when that needs no merge)`}>
                  <span>
                    <BusyButton className="small" busy={busy === 'pull'} busyLabel="Pulling…" disabled={!!pullBlocked || off} onClick={() => act('pull', "Couldn't pull", () => call('git:pull', project.path))}>
                      <Icon name="repo-pull" /> Pull
                    </BusyButton>
                  </span>
                </Tooltip>
                <Tooltip content={pushBlocked ?? (s.upstream?.remote && !s.upstream.gone ? `Push ${s.branch} to ${s.upstream.name} (never forced)` : `Push ${s.branch} to a remote and track it`)}>
                  <span>
                    <BusyButton className="small" busy={busy === 'push'} busyLabel="Pushing…" disabled={!!pushBlocked || off} onClick={() => void pushNow(s)}>
                      <Icon name="repo-push" /> Push
                    </BusyButton>
                  </span>
                </Tooltip>
                <Tooltip content={!s.head ? 'Commit something first' : `A branch at ${s.head}`}>
                  <span>
                    <button className="btn small" disabled={!s.head || off} onClick={() => void newBranch(s)}>
                      <Icon name="git-branch-create" /> New branch…
                    </button>
                  </span>
                </Tooltip>
              </div>
            </div>

            <h2 className="section">
              Branches <span className="badge">{info.branches.length}</span>
            </h2>
            <div className="git-rows">
              {info.branches.map((b) => {
                const agent = agentOf(b.worktree)
                const why = b.current ? null : b.worktree ? `Checked out in ${agent ? `${agent.name}'s worktree` : 'another worktree'}: a branch is in one folder at a time.` : switchBlocked
                return (
                  <div key={b.name} className={cx('git-row', 'git-branch', b.current && 'current')} data-branch={b.name}>
                    <Icon name={b.current ? 'check' : b.worktree ? 'repo' : 'git-branch'} />
                    <span className="git-name">{b.name}</span>
                    {b.worktree && <span className="badge" data-worktree="">{agent ? `${agent.name}'s worktree` : 'worktree'}</span>}
                    {b.upstream && (
                      <span className="faint git-track">
                        {b.upstream} · {aheadBehindText(b)}
                      </span>
                    )}
                    <span className="git-subject faint">{b.subject}</span>
                    <span className="git-meta faint">{at(b.date)}</span>
                    {!b.current && (
                      <Tooltip content={why ?? `Switch the project folder to ${b.name}`}>
                        <span>
                          <button className="btn small subtle" disabled={!!why || off} onClick={() => void switchTo(b.name, s.branch)}>
                            {busy === `switch:${b.name}` ? <Icon name="loading" spin /> : 'Switch'}
                          </button>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                )
              })}
              {remoteOnly.length > 0 && (
                <button className="btn small subtle git-more" onClick={() => setShowRemote(!showRemote)}>
                  <Icon name={showRemote ? 'chevron-down' : 'chevron-right'} /> Remote branches ({remoteOnly.length})
                </button>
              )}
              {showRemote &&
                remoteOnly.map((r) => (
                  <div key={r} className="git-row git-branch remote" data-remote-branch={r}>
                    <Icon name="cloud" />
                    <span className="git-name">{r}</span>
                    <Tooltip content={switchBlocked ?? `A local ${r.slice(r.indexOf('/') + 1)} tracking ${r}, and switch to it`}>
                      <span>
                        <button className="btn small subtle" disabled={!!switchBlocked || off} onClick={() => void switchTo(r, s.branch)}>
                          Switch
                        </button>
                      </span>
                    </Tooltip>
                  </div>
                ))}
            </div>

            <h2 className="section git-section-head">
              Remotes <span className="badge">{info.remotes.length}</span>
              <span className="git-section-actions">
                <button className="btn small" disabled={off} onClick={() => setForm(remoteForm(project))}>
                  <Icon name="add" /> Add remote…
                </button>
              </span>
            </h2>
            {info.remotes.length === 0 ? (
              <p className="hint">No remotes: this repository is only on this computer. Add one (a GitHub repository's URL, say) to push to it.</p>
            ) : (
              <div className="git-rows">
                {info.remotes.map((r) => (
                  <div key={r.name} className="git-row git-remote" data-remote={r.name}>
                    <Icon name="cloud" />
                    <span className="git-name">{r.name}</span>
                    <span className="git-url">
                      {r.fetchUrl}
                      {r.pushUrl && r.pushUrl !== r.fetchUrl && <span className="faint"> (pushes to {r.pushUrl})</span>}
                    </span>
                    <IconButton icon="edit" title={`Change ${r.name}'s URL`} disabled={off} onClick={() => void editRemote(r.name, r.fetchUrl)} />
                  </div>
                ))}
              </div>
            )}

            {info.worktrees.length > 0 && (
              <>
                <h2 className="section">
                  Worktrees <span className="badge">{info.worktrees.length}</span>
                </h2>
                <p className="hint">Read-only here: an agent's work comes into the project folder through Merge.</p>
                <div className="git-rows">
                  {info.worktrees.map((w) => {
                    const agent = agentOf(w.path)
                    return (
                      <div key={w.path} className="git-row git-worktree" data-worktree-row={w.path}>
                        <Icon name="repo" />
                        <span className="git-name">{agent ? `${agent.name}'s worktree` : 'Unused worktree'}</span>
                        <span className="faint">{w.branch ?? (w.head ? `detached at ${w.head}` : '')}</span>
                        <span className="git-url faint">{w.path}</span>
                        <button
                          className="btn small subtle"
                          onClick={() => {
                            set((st) => ({ changesRoot: { ...st.changesRoot, [project.path]: agent?.id ?? UNUSED_ROOT } }))
                            showGit(project.path, 'changes')
                          }}
                        >
                          Changes
                        </button>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            <h2 className="section git-section-head">
              Commit identity
              <span className="git-section-actions">
                <button className="btn small" disabled={off} onClick={() => setForm(identityForm(project, info))}>
                  <Icon name="person" /> Set for this repository…
                </button>
              </span>
            </h2>
            {warnings.map((w) => (
              <div key={w} className="banner warn" data-identity-warning="">
                <Icon name="warning" /> {w}
              </div>
            ))}
            <table className="kv git-identity" data-git-identity="">
              <tbody>
                <tr>
                  <td></td>
                  <td className="faint">This repository</td>
                  <td className="faint">Global</td>
                  <td className="faint">Commits use</td>
                </tr>
                {(['name', 'email'] as const).map((k) => (
                  <tr key={k}>
                    <td>{k === 'name' ? 'Name' : 'Email'}</td>
                    <td>{info.identity.local[k] ?? <span className="faint">not set</span>}</td>
                    <td>{info.identity.global[k] ?? <span className="faint">not set</span>}</td>
                    <td data-identity-used={k}>
                      <strong>{info.identity.effective[k] ?? '—'}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {form && <GitForm spec={form} onClose={() => setForm(null)} />}
          </div>
        )
      }}
    </Loading>
  )
}

// ---------------------------------------------------------------------------
// Forms: Add remote, Create tag, commit identity
// ---------------------------------------------------------------------------

interface FormField {
  key: string
  label: string
  initial?: string
  placeholder?: string
  /** A drop-down instead of a text box. */
  options?: { label: string; value: string }[]
}

interface FormSpec {
  title: string
  icon: string
  about?: string
  fields: FormField[]
  confirm: string
  busyLabel: string
  validate: (v: Record<string, string>) => string | null
  submit: (v: Record<string, string>) => Promise<string>
  project: ProjectInfo
}

function GitForm({ spec, onClose }: { spec: FormSpec; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.initial ?? ''])))
  const { busy, error, run } = useBusy()
  const problem = spec.validate(values)
  const submit = async (): Promise<void> => {
    if (problem) return
    const r = await run('submit', () => spec.submit(values))
    bumpGit(spec.project.path)
    if (!r) return
    notify('success', r.value)
    onClose()
  }
  return (
    <Modal
      title={spec.title}
      icon={spec.icon}
      onClose={onClose}
      busy={!!busy}
      error={error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="primary" busy={!!busy} busyLabel={spec.busyLabel} disabled={!!problem} onClick={() => void submit()}>
            {spec.confirm}
          </BusyButton>
        </>
      }
    >
      {spec.about && <p className="hint">{spec.about}</p>}
      <div className="agent-form git-form">
        {spec.fields.map((f, i) => (
          <FormRow key={f.key} field={f} value={values[f.key]} first={i === 0} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} onEnter={() => void submit()} />
        ))}
      </div>
      {problem && Object.values(values).some((v) => v.trim()) && <div className="field-error">{problem}</div>}
    </Modal>
  )
}

function FormRow({ field, value, first, onChange, onEnter }: { field: FormField; value: string; first: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <>
      <label htmlFor={`git-form-${field.key}`}>{field.label}</label>
      {field.options ? (
        <select id={`git-form-${field.key}`} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={`git-form-${field.key}`} className="input" value={value} placeholder={field.placeholder} autoFocus={first} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
      )}
    </>
  )
}

function remoteForm(project: ProjectInfo): FormSpec {
  return {
    project,
    title: 'Add a remote',
    icon: 'cloud',
    about: 'A repository to fetch from and push to: a URL (https://github.com/you/repo.git, git@github.com:you/repo.git) or a folder.',
    fields: [
      { key: 'name', label: 'Name', initial: 'origin', placeholder: 'origin' },
      { key: 'url', label: 'URL', placeholder: 'https://github.com/you/repo.git' }
    ],
    confirm: 'Add',
    busyLabel: 'Adding…',
    validate: (v) => remoteNameProblem(v.name) ?? remoteUrlProblem(v.url),
    submit: (v) => call('git:addRemote', project.path, v.name.trim(), v.url.trim())
  }
}

function tagForm(project: ProjectInfo, s: GitRepoSummary | null): FormSpec {
  const remotes = s?.remotes ?? []
  return {
    project,
    title: `Tag ${s?.head ?? 'the commit'}`,
    icon: 'tag',
    about: `Tags the commit the project folder has checked out${s?.branch ? ` (${s.branch})` : ''}. With a message, it's an annotated tag.`,
    fields: [
      { key: 'name', label: 'Name', placeholder: 'v1.0.0' },
      { key: 'message', label: 'Message', placeholder: 'Optional' },
      ...(remotes.length ? [{ key: 'push', label: 'Push it to', initial: '', options: [{ label: "Don't push", value: '' }, ...remotes.map((r) => ({ label: r, value: r }))] }] : [])
    ],
    confirm: 'Create tag',
    busyLabel: 'Tagging…',
    validate: (v) => (!v.name.trim() ? 'Enter a name' : /\s/.test(v.name.trim()) ? 'Tag names have no spaces' : null),
    submit: (v) => call('git:createTag', project.path, v.name.trim(), v.message ?? '', v.push || undefined)
  }
}

function identityForm(project: ProjectInfo, info: GitRepoInfo): FormSpec {
  return {
    project,
    title: 'Commit identity for this repository',
    icon: 'person',
    about: `Who ${project.name}'s commits are made as, agents' too (git config --local). Leave both empty to use your global identity${info.identity.global.email ? ` (${info.identity.global.email})` : ''}. On GitHub, its no-reply address keeps your email private.`,
    fields: [
      { key: 'name', label: 'Name', initial: info.identity.local.name ?? '', placeholder: info.identity.global.name ?? 'Your Name' },
      { key: 'email', label: 'Email', initial: info.identity.local.email ?? '', placeholder: info.identity.global.email ?? 'id+you@users.noreply.github.com' }
    ],
    confirm: 'Save',
    busyLabel: 'Saving…',
    validate: (v) => identityProblem(v.name, v.email),
    submit: (v) => call('git:setIdentity', project.path, v.name.trim(), v.email.trim())
  }
}

// ---------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------

/**
 * The selected project's git in the status bar (#607): "main · origin · ↑2 ↓0", as of the last fetch. Read again when
 * its branch or agents change, after a Git action, when the window gets focus, and every minute; it opens Git →
 * Branches & remotes.
 */
export function GitStatusBarItem({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:summary', project)
  const reload = read.reload
  useNow(60000)
  useEffect(() => {
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [reload])
  const s = read.data
  if (s && !s.isRepo) return null
  const text = s ? gitStatusText(s) : project.branch
  if (!text) return null
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{s ? gitStatusTip(s, at(s.fetchedAt)) : 'Git branch of the selected project'}</span>}>
      <div className={cx('status-item', s?.state && 'caution')} data-git-status="" onClick={() => {
          showView('projects')
          showGit(project.path, 'branches')
        }}>
        <Icon name="git-branch" /> {text}
      </div>
    </Tooltip>
  )
}
