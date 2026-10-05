import { useCallback, useEffect, useState } from 'react'
import type { MoveOptions, MovePlan, MoveReport, MoveWorktree } from '@shared/types'
import { providerName } from '@shared/providers'
import { moveHasWork } from '@shared/movePaths'
import { call } from '../api'
import { set, useStore } from '../store'
import { BusyButton, Icon, IconButton, Modal, useBusy } from './ui'
import { cx } from '../util'

/**
 * A workspace (or project) moved to another folder since Hive last opened it (#146): a banner over the main area, and
 * Repair…, which shows what it will do (worktrees, session folders, Claude Code's conversations and memory, Open
 * Recent), does it on confirmation and says what it did. Main works it all out (workspaceMove.ts).
 */

const movedKey = (m: { from: string | null; projects: string[]; pending: string[] }): string => `${m.from ?? ''}|${m.projects.join('|')}|${m.pending.join('|')}`

export function MovedBanner() {
  const moved = useStore((s) => s.workspace?.moved ?? null)
  const hidden = useStore((s) => s.moveBannerHidden)
  if (!moved || hidden === movedKey(moved)) return null
  const what = moved.from ? (
    <>
      This workspace was moved from <span className="mono">{moved.from}</span>.
    </>
  ) : moved.projects.length ? (
    <>
      {moved.projects.length === 1 ? `The project ${moved.projects[0]} was` : `${moved.projects.length} projects were`} moved to another folder.
    </>
  ) : (
    <>A worktree of {moved.pending.join(', ')} was made again at a new folder, and not everything has followed it yet.</>
  )
  return (
    <div className="banner warn moved-banner">
      <Icon name="folder-opened" /> <span className="grow">{what} Agents' worktrees, sessions and conversations still point to the old folder.</span>
      <button className="btn small primary" onClick={() => set({ moveRepairOpen: true })}>
        Repair…
      </button>
      <IconButton icon="close" title="Hide for now (Repair Moved Workspace… stays in the command palette)" onClick={() => set({ moveBannerHidden: movedKey(moved) })} />
    </div>
  )
}

const key = (projectPath: string, agentId: string): string => `${projectPath}#${agentId}`

type Choice = 'unlink' | 'recreate'

/** One worktree line of the plan: where it is now, or what to do about one that wasn't found. */
function WorktreeLine({ host, w, onLocate, onChoose }: { host: string; w: MoveWorktree; onLocate: (k: string, agentId: string) => void; onChoose: (k: string, choice: Choice | null) => void }) {
  const k = key(host, w.agentId)
  const undo = (
    <button className="btn small subtle" onClick={() => onChoose(k, null)}>
      Undo
    </button>
  )
  if (w.how === 'unlink') {
    return (
      <li>
        Remove <strong>{w.agentName}</strong>'s worktree link (its folder, if it turns up, is left as it is). {undo}
      </li>
    )
  }
  if (w.how === 'recreate') {
    return (
      <li>
        {w.branchExists ? (
          <>
            Recreate <strong>{w.agentName}</strong>'s worktree on its branch <span className="mono">{w.branch}</span>, with its commits
          </>
        ) : (
          <>
            Create a new worktree for <strong>{w.agentName}</strong> on <span className="mono">{w.branch}</span> (its branch is gone too)
          </>
        )}
        , at <span className="mono">{w.to}</span>; its setup command runs at its next start. {undo}
      </li>
    )
  }
  if (w.how === 'missing') {
    return (
      <li className="warn-text">
        <strong>{w.agentName}</strong>'s worktree wasn't found (it was at <span className="mono">{w.from}</span>){w.branchExists ? '' : ', and its branch is gone too'}.{' '}
        <button className="btn small subtle" onClick={() => onChoose(k, 'recreate')}>
          {w.branchExists ? 'Recreate worktree' : 'Create a new worktree'}
        </button>{' '}
        <button className="btn small subtle" onClick={() => onLocate(k, w.agentId)}>
          Locate…
        </button>{' '}
        <button className="btn small subtle" onClick={() => onChoose(k, 'unlink')}>
          Remove the agent's worktree link
        </button>
      </li>
    )
  }
  if (w.how === 'original') {
    return (
      <li className="faint">
        <strong>{w.agentName}</strong>'s worktree stays with the project at its old folder, which is still there (this looks like a copy).
      </li>
    )
  }
  return (
    <li>
      <strong>{w.agentName}</strong>'s worktree: {w.how === 'stayed' ? <>relink <span className="mono">{w.to}</span> to the moved project</> : <>now at <span className="mono">{w.to}</span></>}
      {w.how === 'located' && ' (located)'} — <span className="faint">git worktree repair</span>
    </li>
  )
}

export function MoveRepairDialog() {
  const open = useStore((s) => s.moveRepairOpen)
  const [plan, setPlan] = useState<MovePlan | null | undefined>(undefined)
  const [opts, setOpts] = useState<MoveOptions>({})
  const [report, setReport] = useState<MoveReport | null>(null)
  const action = useBusy()
  const { run, setError } = action
  const load = useCallback(
    (o: MoveOptions) => {
      void run('plan', async () => setPlan(await call('workspace:movePlan', o)))
    },
    [run]
  )
  useEffect(() => {
    if (!open) return
    setPlan(undefined)
    setOpts({})
    setReport(null)
    setError(null)
    load({})
  }, [open, load, setError])
  if (!open) return null
  const close = (): void => set({ moveRepairOpen: false })
  const choose = (next: MoveOptions): void => {
    setOpts(next)
    load(next)
  }
  const locate = async (k: string, agentId: string): Promise<void> => {
    const r = await action.run('locate', () => call('workspace:moveLocate', k.slice(0, k.lastIndexOf('#')), agentId))
    if (r?.value) choose({ ...opts, locate: { ...opts.locate, [k]: r.value }, unlink: opts.unlink?.filter((x) => x !== k), recreate: opts.recreate?.filter((x) => x !== k) })
  }
  /** A missing worktree's way out: its link removed, or the worktree made again; null takes the choice back. */
  const pick = (k: string, c: Choice | null): void => {
    const unlink = (opts.unlink ?? []).filter((x) => x !== k)
    const recreate = (opts.recreate ?? []).filter((x) => x !== k)
    choose({ ...opts, unlink: c === 'unlink' ? [...unlink, k] : unlink, recreate: c === 'recreate' ? [...recreate, k] : recreate })
  }
  const repair = async (): Promise<void> => {
    const r = await action.run('repair', () => call('workspace:moveRepair', opts))
    if (r) setReport(r.value)
  }
  const nothing = plan !== undefined && (!plan || !moveHasWork(plan))
  const footer = report ? (
    <button className="btn primary" onClick={close} autoFocus>
      Close
    </button>
  ) : (
    <>
      <button className="btn" onClick={close}>
        Cancel
      </button>
      <BusyButton className="primary" busy={action.busy === 'repair'} busyLabel="Repairing…" disabled={!plan || nothing || plan.running.length > 0 || action.busy === 'plan'} onClick={() => void repair()}>
        Repair
      </BusyButton>
    </>
  )
  return (
    <Modal title="Repair a Moved Workspace" icon="folder-opened" onClose={close} footer={footer} wide busy={action.busy === 'repair'} error={action.error}>
      <div className="move-repair">
        {report ? (
          <>
            <p>{report.failed.length ? 'Repair finished, with problems:' : report.complete ? 'Repaired. Everything now points to where the workspace is.' : 'Repair finished; something is left to do:'}</p>
            {report.failed.length > 0 && <ReportList icon="error" className="warn-text" lines={report.failed} />}
            {report.done.length > 0 && <ReportList icon="check" lines={report.done} />}
            {report.skipped.length > 0 && <ReportList icon="info" className="faint" lines={report.skipped} />}
            {!report.complete && <p className="hint">Repair… stays in the banner until it's done; running it again repeats nothing already done.</p>}
          </>
        ) : plan === undefined ? (
          <p className="faint">
            <Icon name="loading" spin /> Working out what moved…
          </p>
        ) : !plan || nothing ? (
          <p>Nothing to repair: everything already points to where the workspace is now.</p>
        ) : (
          <>
            <p>
              {plan.from ? (
                <>
                  The workspace moved from <span className="mono">{plan.from}</span> to <span className="mono">{plan.to}</span>.
                </>
              ) : (
                <>Projects moved to another folder.</>
              )}{' '}
              Repair will:
            </p>
            {plan.hosts.map((h) => {
              const copies = h.folders.filter((f) => f.copy > 0 || f.kept.length > 0 || !!f.failed?.length)
              if (!h.worktrees.length && !h.sessions && !copies.length) return null
              return (
                <section key={h.path}>
                  <h4>{h.name}</h4>
                  <ul>
                    {h.worktrees.map((w) => (
                      <WorktreeLine key={w.agentId} host={h.path} w={w} onLocate={(k, id) => void locate(k, id)} onChoose={pick} />
                    ))}
                    {h.sessions > 0 && (
                      <li>
                        Point {h.sessions} session{h.sessions === 1 ? '' : 's'} to the new folder{h.sessions === 1 ? '' : 's'}, so they resume where they ran.
                      </li>
                    )}
                    {copies.map((f) => (
                      <li key={`${f.provider}:${f.from}`}>
                        {f.copy > 0 ? (
                          <>
                            Copy {f.copy} file{f.copy === 1 ? '' : 's'} of {providerName(f.provider)}'s conversations and memory for {f.of ?? 'the folder'} to its folder for the new path (<span className="mono">{f.to}</span>); the old one stays.
                          </>
                        ) : (
                          <>
                            {providerName(f.provider)}'s conversations and memory for {f.of ?? 'the folder'}:
                          </>
                        )}
                        {f.kept.length > 0 && (
                          <span className="faint">
                            {' '}
                            {f.kept.length} file{f.kept.length === 1 ? ' is' : 's are'} already in <span className="mono">{f.to}</span> with other content and won't be overwritten: {f.kept.slice(0, 5).join(', ')}
                            {f.kept.length > 5 ? ` and ${f.kept.length - 5} more` : ''}.
                          </span>
                        )}
                        {!!f.failed?.length && (
                          <span className="warn-text">
                            {' '}
                            {f.failed.length} can't be read: {f.failed.slice(0, 5).join(', ')}
                            {f.failed.length > 5 ? ` and ${f.failed.length - 5} more` : ''}. Repair tries {f.failed.length === 1 ? 'it' : 'them'} again.
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {plan.recent && (
              <p>
                Open Recent: list <span className="mono">{plan.to}</span> instead of the old folder.
              </p>
            )}
            {plan.working.length > 0 && <p>Working on: mark {plan.working.join(', ')} again, as at the old folder.</p>}
            <p className="hint">Nothing at the old location is moved or deleted.</p>
            {plan.running.length > 0 && (
              <p className="warn-text">
                <Icon name="warning" /> Stop the running agents first: {plan.running.join(', ')}.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function ReportList({ icon, lines, className }: { icon: string; lines: string[]; className?: string }) {
  return (
    <ul className={cx('move-report', className)}>
      {lines.map((l, i) => (
        <li key={i}>
          <Icon name={icon} /> {l}
        </li>
      ))}
    </ul>
  )
}
