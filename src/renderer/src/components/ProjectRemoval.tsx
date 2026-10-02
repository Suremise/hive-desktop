import { useCallback, useEffect, useState } from 'react'
import type { HiddenProject, ProjectInfo, ProjectRemoval, ProjectRemovalInfo } from '@shared/types'
import { call, errorMessage } from '../api'
import { clearEditorDraftsUnder, hasEditorDraftsUnder } from '../editorDrafts'
import { useScopedLoad } from '../scopedLoad'
import { loadTasks, notify, set, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, LoadFailed, Modal, useBusy } from './ui'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const CHOICES: { id: ProjectRemoval; label: string; icon: string; summary: string }[] = [
  { id: 'hide', label: 'Hide', icon: 'eye-closed', summary: 'Hive leaves the project out until you restore it. Nothing is moved or deleted.' },
  {
    id: 'remove',
    label: 'Remove from Hive',
    icon: 'export',
    summary: "The folder stays on disk, and its handovers and cards are packed into it (.hive/removed), so you can move it elsewhere. Hive offers them back wherever it sees the folder again."
  },
  { id: 'delete', label: 'Delete', icon: 'trash', summary: 'The project folder, its worktrees and its handovers go to the Recycle Bin, and its cards are deleted.' }
]

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
    notify('success', how === 'hide' ? `${info.name} is hidden` : how === 'remove' ? `${info.name} was removed from Hive` : `${info.name} was moved to the Recycle Bin`, how === 'delete' ? undefined : 'Restore it in Settings → Workspace.')
    if (r.value.warnings.length) notify('warning', `Not everything of ${info.name} could be removed`, r.value.warnings.join('\n'))
  }

  const name = info?.name ?? path.split(/[\\/]/).pop()
  return (
    <Modal
      title={`Remove ${name}`}
      icon="trash"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <BusyButton
            className={how === 'delete' ? 'danger' : 'primary'}
            disabled={!ready}
            busy={action.busy === 'remove'}
            busyLabel={how === 'hide' ? 'Hiding…' : how === 'remove' ? 'Removing from Hive…' : 'Moving to the Recycle Bin…'}
            onClick={() => void go()}
          >
            {CHOICES.find((c) => c.id === how)!.label}
          </BusyButton>
        </>
      }
    >
      {!info && !error && <p className="faint">Looking at what the project has…</p>}
      {info && (
        <>
          <div className="choice-list" style={{ marginTop: 0 }}>
            {CHOICES.map((c) => (
              <label key={c.id} className={cx('choice', how === c.id && 'selected')}>
                <input type="radio" checked={how === c.id} onChange={() => setHow(c.id)} />
                <div>
                  <strong>
                    <Icon name={c.icon} /> {c.label}
                  </strong>
                  <div className="faint">{c.summary}</div>
                </div>
              </label>
            ))}
          </div>
          <div className="agent-dialog-h">What it touches</div>
          <ul className="removal-list">
            {info.running > 0 && <li>{plural(info.running, 'running agent')}: stopped first (their conversations are kept).</li>}
            <li>
              The folder {info.path}: {how === 'delete' ? 'to the Recycle Bin.' : how === 'remove' ? 'stays where it is.' : 'stays, hidden from Hive.'}
            </li>
            <li>
              {info.handovers.length === 0
                ? 'No handovers in the shared notes.'
                : `${plural(info.handovers.length, 'handover')} in the shared notes: ${how === 'hide' ? 'left where they are.' : how === 'remove' ? 'packed into the folder, then moved to the Recycle Bin.' : 'to the Recycle Bin.'}`}
            </li>
            <li>
              {info.cards + info.archivedCards === 0
                ? 'No cards on the board.'
                : `${plural(info.cards, 'card')} on the board${info.archivedCards ? ` (and ${info.archivedCards} archived)` : ''}: ${how === 'delete' ? 'deleted.' : how === 'remove' ? 'archived, and a copy packed into the folder.' : 'archived until you restore it.'}`}
            </li>
            {info.worktrees.length > 0 && (
              <li>
                {plural(info.worktrees.length, 'worktree')}:{' '}
                {how === 'hide' ? 'left as they are.' : how === 'remove' ? 'removed with their branches, once nothing in them is unmerged.' : 'to the Recycle Bin.'}
                <ul>
                  {info.worktrees.map((w) => (
                    <li key={w.path} className={cx(!!(w.ahead || w.dirty || w.error) && how !== 'hide' && 'warn-text')}>
                      {w.agent} ({w.branch}){w.error ? `: ${w.error}` : ''}
                      {w.ahead ? `: ${plural(w.ahead, 'commit')} not merged` : ''}
                      {w.dirty ? `${w.ahead ? ',' : ':'} ${plural(w.dirty, 'uncommitted file')}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li className="faint">The coding agents' own transcripts (in ~/.claude and ~/.codex) are left alone.</li>
          </ul>
          {blocked && (
            <div className="banner warn">
              <Icon name="warning" /> Merge or discard the work in {unmerged.map((w) => w.agent).join(' and ')}'s worktree first: a worktree can't go with the project folder.
              {unmerged.some((w) => w.error) && " Git couldn't check one, so Hive can't tell whether anything would be lost."}
            </div>
          )}
          {drafts && how === 'delete' && (
            <div className="banner warn">
              <Icon name="warning" /> Files of this project have unsaved edits in Hive. They are lost.
            </div>
          )}
          {how === 'delete' && (
            <>
              <p style={{ marginBottom: 6 }}>
                Type <strong>{info.name}</strong> to delete it.
              </p>
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
  if (!workspace) return <div className="faint">Open a workspace to see its hidden projects.</div>
  if (error) return <LoadFailed inline what="the hidden projects" error={error} onRetry={load} />
  if (!loaded.data) return <div className="faint">Loading…</div>
  if (!list.length) return <div className="faint">None. Project → Remove Project… hides a project or removes it from Hive.</div>

  const restore = async (h: HiddenProject): Promise<void> => {
    try {
      const r = await call('project:restore', h.name)
      await loadTasks()
      load()
      const back = [r.handovers ? plural(r.handovers, 'handover') : '', r.cards ? plural(r.cards, 'card') : ''].filter(Boolean).join(' and ')
      notify('success', `${h.name} is back`, back ? `With ${back}.` : undefined)
    } catch (e) {
      notify('error', `Could not restore ${h.name}`, errorMessage(e))
    }
  }
  const forget = async (h: HiddenProject): Promise<void> => {
    try {
      await call('project:forget', h.name)
      load()
    } catch (e) {
      notify('error', `Could not forget ${h.name}`, errorMessage(e))
    }
  }

  return (
    <table className="table hidden-projects">
      <thead>
        <tr>
          <th>Project</th>
          <th>How</th>
          <th>When</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((h) => (
          <tr key={h.name}>
            <td>{h.name}</td>
            <td>
              {h.mode === 'hidden' ? 'Hidden' : 'Removed from Hive'}
              {!h.present && <div className="faint">The folder is no longer in the workspace.</div>}
            </td>
            <td className="faint">{timeAgo(h.at)}</td>
            <td className="actions">
              {h.present ? (
                <button className="btn small" onClick={() => void restore(h)}>
                  Restore
                </button>
              ) : (
                <button className="btn small subtle" onClick={() => void forget(h)}>
                  Forget
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
  const what = [d.handovers ? plural(d.handovers, 'handover') : '', d.cards ? plural(d.cards, 'board card') : ''].filter(Boolean).join(' and ') || 'Hive data'
  const take = async (keep: boolean): Promise<void> => {
    setBusy(true)
    try {
      await call('project:takeRemovedData', project.path, keep)
      await loadTasks()
      if (keep) notify('success', `${project.name}: ${what} restored`)
    } catch (e) {
      notify('error', keep ? 'Could not restore them' : 'Could not discard them', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner info">
      <Icon name="archive" /> This folder holds {what} from when it was removed from Hive ({timeAgo(d.at)}). Restore them to this workspace?
      <button className="btn small primary" disabled={busy} onClick={() => void take(true)}>
        Restore
      </button>
      <button className="btn small" disabled={busy} onClick={() => void take(false)}>
        Discard
      </button>
    </div>
  )
}
