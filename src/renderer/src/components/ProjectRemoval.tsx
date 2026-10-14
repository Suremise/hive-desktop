import { Children, useCallback, useEffect, useState } from 'react'
import type { HiddenProject, ProjectInfo, ProjectRemoval, ProjectRemovalInfo } from '@shared/types'
import { call, errorMessage } from '../api'
import { clearEditorDraftsUnder, hasEditorDraftsUnder } from '../editorDrafts'
import { useScopedLoad } from '../scopedLoad'
import { loadTasks, notify, set, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, LoadFailed, Modal, useBusy } from './ui'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'

const CHOICES: { id: ProjectRemoval; label: Msg; icon: string; summary: Msg }[] = [
  {
    id: 'hide',
    label: msg({ id: 'workspace.removal.hide', defaultMessage: 'Hide', description: "Remove Project: a choice, and the dialog's button for it." }),
    icon: 'eye-closed',
    summary: msg({ id: 'workspace.removal.hideSummary', defaultMessage: 'Hive leaves the project out until you restore it. Nothing is moved or deleted.', description: 'Remove Project: what Hide does.' })
  },
  {
    id: 'remove',
    label: msg({ id: 'workspace.removal.remove', defaultMessage: 'Remove from Hive', description: "Remove Project: a choice, and the dialog's button for it." }),
    icon: 'export',
    summary: msg({ id: 'workspace.removal.removeSummary', defaultMessage: 'The folder stays on disk, and its handovers and cards are packed into it (.hive/removed), so you can move it elsewhere. Hive offers them back wherever it sees the folder again.', description: 'Remove Project: what Remove from Hive does. Keep .hive/removed as it is.' })
  },
  {
    id: 'delete',
    label: msg({ id: 'workspace.removal.delete', defaultMessage: 'Delete', description: "Remove Project: a choice, and the dialog's button for it." }),
    icon: 'trash',
    summary: msg({ id: 'workspace.removal.deleteSummary', defaultMessage: 'The project folder, its worktrees and its handovers go to the Recycle Bin, and its cards are deleted.', description: 'Remove Project: what Delete does.' })
  }
]

const M = {
  hidden: msg({ id: 'workspace.removal.hiddenDone', defaultMessage: '{name} is hidden', description: 'A notice after Hide.' }),
  removed: msg({ id: 'workspace.removal.removedDone', defaultMessage: '{name} was removed from Hive', description: 'A notice after Remove from Hive.' }),
  deleted: msg({ id: 'workspace.removal.deletedDone', defaultMessage: '{name} was moved to the Recycle Bin', description: 'A notice after Delete.' }),
  restoreIn: msg({ id: 'workspace.removal.restoreIn', defaultMessage: 'Restore it in Settings → Workspace.', description: 'Under the notice after Hide or Remove from Hive.' }),
  notAll: msg({ id: 'workspace.removal.notAll', defaultMessage: 'Not everything of {name} could be removed', description: "A notice: some of the project's things stayed (why follows, one a line)." }),
  title: msg({ id: 'workspace.removal.title', defaultMessage: 'Remove {name}', description: "Remove Project's dialog title." }),
  cancel: msg({ id: 'workspace.removal.cancel', defaultMessage: 'Cancel', description: "Remove Project's button that closes it." }),
  hiding: msg({ id: 'workspace.removal.hiding', defaultMessage: 'Hiding…', description: "Remove Project's button while it hides the project." }),
  removing: msg({ id: 'workspace.removal.removing', defaultMessage: 'Removing from Hive…', description: "Remove Project's button while it works." }),
  deleting: msg({ id: 'workspace.removal.deleting', defaultMessage: 'Moving to the Recycle Bin…', description: "Remove Project's button while it deletes." }),
  looking: msg({ id: 'workspace.removal.looking', defaultMessage: 'Looking at what the project has…', description: 'Remove Project while it reads what the project has.' }),
  touches: msg({ id: 'workspace.removal.touches', defaultMessage: 'What it touches', description: "Remove Project: the heading over what the choice does to the project's things." }),
  running: msg({ id: 'workspace.removal.running', defaultMessage: '{count, plural, one {# running agent} other {# running agents}}: stopped first (their conversations are kept).', description: 'Remove Project, what it touches.' }),
  folder: msg({ id: 'workspace.removal.folder', defaultMessage: 'The folder {path}: {how, select, delete {to the Recycle Bin.} remove {stays where it is.} other {stays, hidden from Hive.}}', description: 'Remove Project, what it touches: the project folder, for the choice made.' }),
  noHandovers: msg({ id: 'workspace.removal.noHandovers', defaultMessage: 'No handovers in the shared notes.', description: 'Remove Project, what it touches.' }),
  handovers: msg({ id: 'workspace.removal.handovers', defaultMessage: '{count, plural, one {# handover} other {# handovers}} in the shared notes: {how, select, hide {left where they are.} remove {packed into the folder, then moved to the Recycle Bin.} other {to the Recycle Bin.}}', description: "Remove Project, what it touches: the project's handovers, for the choice made." }),
  noCards: msg({ id: 'workspace.removal.noCards', defaultMessage: 'No cards on the board.', description: 'Remove Project, what it touches.' }),
  cards: msg({ id: 'workspace.removal.cards', defaultMessage: '{count, plural, one {# card} other {# cards}} on the board{archived, plural, =0 {} other { (and # archived)}}: {how, select, delete {deleted.} remove {archived, and a copy packed into the folder.} other {archived until you restore it.}}', description: "Remove Project, what it touches: the project's cards, for the choice made." }),
  worktrees: msg({ id: 'workspace.removal.worktrees', defaultMessage: '{count, plural, one {# worktree} other {# worktrees}}: {how, select, hide {left as they are.} remove {removed with their branches, once nothing in them is unmerged.} other {to the Recycle Bin.}}', description: "Remove Project, what it touches: the agents' worktrees (each follows), for the choice made." }),
  worktree: msg({ id: 'workspace.removal.worktree', defaultMessage: '{agent} ({branch}){hasError, select, yes {: {error}} other {}}{ahead, plural, =0 {} one {: # commit not merged} other {: # commits not merged}}{dirty, plural, =0 {} other {{ahead, plural, =0 {:} other {,}} {dirty, plural, one {# uncommitted file} other {# uncommitted files}}}}', description: "Remove Project: an agent's worktree, and what in it isn't merged." }),
  transcripts: msg({ id: 'workspace.removal.transcripts', defaultMessage: "The coding agents' own transcripts (in ~/.claude and ~/.codex) are left alone.", description: 'Remove Project, what it touches. Keep the paths as they are.' }),
  blocked: msg({ id: 'workspace.removal.blocked', defaultMessage: "Merge or discard the work in {agents}'s worktree first: a worktree can't go with the project folder.{unchecked, select, yes { Git couldn't check one, so Hive can't tell whether anything would be lost.} other {}}", description: "Remove Project: why Remove from Hive can't go yet ({agents}: the agents whose worktrees hold work)." }),
  drafts: msg({ id: 'workspace.removal.drafts', defaultMessage: 'Files of this project have unsaved edits in Hive. They are lost.', description: 'Remove Project, before Delete.' }),
  typeName: msg({ id: 'workspace.removal.typeName', defaultMessage: 'Type <b>{name}</b> to delete it.', description: "Remove Project, before Delete: type the project's name in the box below. <b> is bold." }),
  noWorkspace: msg({ id: 'workspace.removal.noWorkspace', defaultMessage: 'Open a workspace to see its hidden projects.', description: 'Settings → Workspace, hidden projects, with no workspace open.' }),
  loadTarget: msg({ id: 'workspace.removal.loadTarget', defaultMessage: 'the hidden projects', description: 'What could not be loaded: shown in "Could not load {what}: {error}", with Retry.' }),
  loading: msg({ id: 'workspace.removal.loading', defaultMessage: 'Loading…', description: 'Settings → Workspace, hidden projects, while they are read.' }),
  none: msg({ id: 'workspace.removal.none', defaultMessage: 'None. Project → Remove Project… hides a project or removes it from Hive.', description: 'Settings → Workspace with no hidden projects. Project → Remove Project… is the menu item.' }),
  back: msg({ id: 'workspace.removal.back', defaultMessage: '{name} is back', description: 'A notice after Restore.' }),
  with: msg({ id: 'workspace.removal.with', defaultMessage: 'With {which, select, both {{handovers, plural, one {# handover} other {# handovers}} and {cards, plural, one {# card} other {# cards}}} handovers {{handovers, plural, one {# handover} other {# handovers}}} other {{cards, plural, one {# card} other {# cards}}}}.', description: 'Under {name} is back: the handovers and cards that came back with it.' }),
  restoreFailed: msg({ id: 'workspace.removal.restoreFailed', defaultMessage: 'Could not restore {name}', description: 'An error notice.' }),
  forgetFailed: msg({ id: 'workspace.removal.forgetFailed', defaultMessage: 'Could not forget {name}', description: 'An error notice.' }),
  project: msg({ id: 'workspace.removal.project', defaultMessage: 'Project', description: "Settings → Workspace's hidden projects table: a column." }),
  how: msg({ id: 'workspace.removal.how', defaultMessage: 'How', description: "Settings → Workspace's hidden projects table: a column (hidden, or removed from Hive)." }),
  when: msg({ id: 'workspace.removal.when', defaultMessage: 'When', description: "Settings → Workspace's hidden projects table: a column." }),
  modeHidden: msg({ id: 'workspace.removal.modeHidden', defaultMessage: 'Hidden', description: 'A hidden project, in Settings → Workspace.' }),
  modeRemoved: msg({ id: 'workspace.removal.modeRemoved', defaultMessage: 'Removed from Hive', description: 'A project removed from Hive, in Settings → Workspace.' }),
  folderGone: msg({ id: 'workspace.removal.folderGone', defaultMessage: 'The folder is no longer in the workspace.', description: 'Under a hidden project whose folder is gone.' }),
  restore: msg({ id: 'workspace.removal.restore', defaultMessage: 'Restore', description: 'A button: brings a hidden project (or its packed data) back.' }),
  forget: msg({ id: 'workspace.removal.forget', defaultMessage: 'Forget', description: "A button: drops a removed project whose folder is gone from Hive's list." }),
  what: msg({ id: 'workspace.removal.what', defaultMessage: '{which, select, both {{handovers, plural, one {# handover} other {# handovers}} and {cards, plural, one {# board card} other {# board cards}}} handovers {{handovers, plural, one {# handover} other {# handovers}}} cards {{cards, plural, one {# board card} other {# board cards}}} other {Hive data}}', description: 'What a folder holds from when its project was removed from Hive: handovers, board cards, or both.' }),
  restored: msg({ id: 'workspace.removal.restored', defaultMessage: '{project}: {what} restored', description: "A notice: the folder's packed handovers and cards are back ({what}: \"2 handovers and 3 board cards\")." }),
  restoreThemFailed: msg({ id: 'workspace.removal.restoreThemFailed', defaultMessage: 'Could not restore them', description: "An error notice: the folder's packed data." }),
  discardFailed: msg({ id: 'workspace.removal.discardFailed', defaultMessage: 'Could not discard them', description: "An error notice: the folder's packed data." }),
  banner: msg({ id: 'workspace.removal.banner', defaultMessage: 'This folder holds {what} from when it was removed from Hive ({when}). Restore them to this workspace?', description: 'A banner over a project whose folder holds what Remove from Hive packed ({when}: "3 days ago").' }),
  discard: msg({ id: 'workspace.removal.discard', defaultMessage: 'Discard', description: "A button on that banner: drops the folder's packed data." })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

/** What came back, or is packed: handovers, cards, or both, for M.what (cards are "board cards" in it). */
const whatArgs = (handovers: number, cards: number): { which: 'both' | 'handovers' | 'cards' | 'none'; handovers: number; cards: number } => ({ which: handovers && cards ? 'both' : handovers ? 'handovers' : cards ? 'cards' : 'none', handovers, cards })

/** Project → Remove Project…: hide it, remove it from Hive (keeping its files), or delete it. */
export function RemoveProjectDialog() {
  const path = useStore((s) => s.removeProjectFor)
  const [info, setInfo] = useState<ProjectRemovalInfo | null>(null)
  const [how, setHow] = useState<ProjectRemoval>('hide')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const action = useBusy()
  const { setError: setActionError } = action

  useEffect(() => {
    setInfo(null)
    setHow('hide')
    setTyped('')
    setError('')
    setActionError(null)
    if (!path) return
    call('project:removalInfo', path)
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)))
  }, [path, setActionError])

  if (!path) return null
  const close = (): void => set({ removeProjectFor: null })
  const unmerged = info?.worktrees.filter((w) => w.ahead || w.dirty || w.error) ?? []
  const drafts = hasEditorDraftsUnder(path)
  const blocked = how === 'remove' && unmerged.length > 0
  const ready = !!info && !blocked && (how !== 'delete' || typed.trim().toLowerCase() === info.name.toLowerCase())

  const go = async (): Promise<void> => {
    if (!info) return
    // The dialog stays open (no closing, a spinner) until it's done: there is no stopping half-way.
    const r = await action.run('remove', () => call('project:remove', info.path, how))
    if (!r) return
    if (how === 'delete') clearEditorDraftsUnder(info.path)
    await loadTasks()
    close()
    notify('success', tr(how === 'hide' ? M.hidden : how === 'remove' ? M.removed : M.deleted, { name: info.name }), how === 'delete' ? undefined : tr(M.restoreIn))
    if (r.value.warnings.length) notify('warning', tr(M.notAll, { name: info.name }), r.value.warnings.join('\n'))
  }

  const name = info?.name ?? path.split(/[\\/]/).pop()
  return (
    <Modal
      title={tr(M.title, { name: name ?? '' })}
      icon="trash"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(M.cancel)}
          </button>
          <BusyButton
            className={how === 'delete' ? 'danger' : 'primary'}
            disabled={!ready}
            busy={action.busy === 'remove'}
            busyLabel={tr(how === 'hide' ? M.hiding : how === 'remove' ? M.removing : M.deleting)}
            onClick={() => void go()}
          >
            {tr(CHOICES.find((c) => c.id === how)!.label)}
          </BusyButton>
        </>
      }
    >
      {!info && !error && <p className="faint">{tr(M.looking)}</p>}
      {info && (
        <>
          <div className="choice-list" style={{ marginTop: 0 }}>
            {CHOICES.map((c) => (
              <label key={c.id} className={cx('choice', how === c.id && 'selected')}>
                <input type="radio" checked={how === c.id} onChange={() => setHow(c.id)} />
                <div>
                  <strong>
                    <Icon name={c.icon} /> {tr(c.label)}
                  </strong>
                  <div className="faint">{tr(c.summary)}</div>
                </div>
              </label>
            ))}
          </div>
          <div className="agent-dialog-h">{tr(M.touches)}</div>
          <ul className="removal-list">
            {info.running > 0 && <li>{tr(M.running, { count: info.running })}</li>}
            <li>{tr(M.folder, { path: info.path, how })}</li>
            <li>{info.handovers.length === 0 ? tr(M.noHandovers) : tr(M.handovers, { count: info.handovers.length, how })}</li>
            <li>{info.cards + info.archivedCards === 0 ? tr(M.noCards) : tr(M.cards, { count: info.cards, archived: info.archivedCards, how })}</li>
            {info.worktrees.length > 0 && (
              <li>
                {tr(M.worktrees, { count: info.worktrees.length, how })}
                <ul>
                  {info.worktrees.map((w) => (
                    <li key={w.path} className={cx(!!(w.ahead || w.dirty || w.error) && how !== 'hide' && 'warn-text')}>
                      {tr(M.worktree, { agent: w.agent, branch: w.branch, hasError: w.error ? 'yes' : 'no', error: w.error ?? '', ahead: w.ahead ?? 0, dirty: w.dirty ?? 0 })}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li className="faint">{tr(M.transcripts)}</li>
          </ul>
          {blocked && (
            <div className="banner warn">
              <Icon name="warning" /> {tr(M.blocked, { agents: fmt.list(unmerged.map((w) => w.agent)), unchecked: unmerged.some((w) => w.error) ? 'yes' : 'no' })}
            </div>
          )}
          {drafts && how === 'delete' && (
            <div className="banner warn">
              <Icon name="warning" /> {tr(M.drafts)}
            </div>
          )}
          {how === 'delete' && (
            <>
              <p style={{ marginBottom: 6 }}>{Children.toArray(tRich<React.ReactNode>(M.typeName, { name: info.name, b: bold }))}</p>
              <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && void go()} />
            </>
          )}
        </>
      )}
      {error && <div className="field-error">{error}</div>}
    </Modal>
  )
}

/** Settings → Workspace: projects hidden or removed from Hive, to restore (or forget, once the folder is gone). */
export function HiddenProjectsList() {
  const workspace = useStore((s) => s.workspace)
  // This workspace's hidden projects: another workspace's never show (or restore) here.
  const wsPath = workspace?.path ?? ''
  const loaded = useScopedLoad<(HiddenProject & { present: boolean })[]>(wsPath)
  const list = loaded.data ?? []
  const error = loaded.error
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    if (wsPath) loadScoped(wsPath, () => call('project:hidden'))
  }, [wsPath, loadScoped])
  useEffect(load, [load])
  if (!workspace) return <div className="faint">{tr(M.noWorkspace)}</div>
  if (error) return <LoadFailed inline what={tr(M.loadTarget)} error={error} onRetry={load} />
  if (!loaded.data) return <div className="faint">{tr(M.loading)}</div>
  if (!list.length) return <div className="faint">{tr(M.none)}</div>

  const restore = async (h: HiddenProject): Promise<void> => {
    try {
      const r = await call('project:restore', h.name)
      await loadTasks()
      load()
      notify('success', tr(M.back, { name: h.name }), r.handovers || r.cards ? tr(M.with, whatArgs(r.handovers ?? 0, r.cards ?? 0)) : undefined)
    } catch (e) {
      notify('error', tr(M.restoreFailed, { name: h.name }), errorMessage(e))
    }
  }
  const forget = async (h: HiddenProject): Promise<void> => {
    try {
      await call('project:forget', h.name)
      load()
    } catch (e) {
      notify('error', tr(M.forgetFailed, { name: h.name }), errorMessage(e))
    }
  }

  return (
    <table className="table hidden-projects">
      <thead>
        <tr>
          <th>{tr(M.project)}</th>
          <th>{tr(M.how)}</th>
          <th>{tr(M.when)}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((h) => (
          <tr key={h.name}>
            <td>{h.name}</td>
            <td>
              {tr(h.mode === 'hidden' ? M.modeHidden : M.modeRemoved)}
              {!h.present && <div className="faint">{tr(M.folderGone)}</div>}
            </td>
            <td className="faint">{timeAgo(h.at)}</td>
            <td className="actions">
              {h.present ? (
                <button className="btn small" onClick={() => void restore(h)}>
                  {tr(M.restore)}
                </button>
              ) : (
                <button className="btn small subtle" onClick={() => void forget(h)}>
                  {tr(M.forget)}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** On a project whose folder holds what Remove from Hive packed: bring it in, or discard it. */
export function RemovedDataBanner({ project }: { project: ProjectInfo }) {
  const d = project.removedData
  const [busy, setBusy] = useState(false)
  if (!d) return null
  const what = tr(M.what, whatArgs(d.handovers ?? 0, d.cards ?? 0))
  const take = async (keep: boolean): Promise<void> => {
    setBusy(true)
    try {
      await call('project:takeRemovedData', project.path, keep)
      await loadTasks()
      if (keep) notify('success', tr(M.restored, { project: project.name, what }))
    } catch (e) {
      notify('error', tr(keep ? M.restoreThemFailed : M.discardFailed), errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner info">
      <Icon name="archive" /> {tr(M.banner, { what, when: timeAgo(d.at) })}
      <button className="btn small primary" disabled={busy} onClick={() => void take(true)}>
        {tr(M.restore)}
      </button>
      <button className="btn small" disabled={busy} onClick={() => void take(false)}>
        {tr(M.discard)}
      </button>
    </div>
  )
}
