import { useEffect, useState } from 'react'
import { EFFORT_LEVELS, MAX_AGENTS, PERMISSION_MODES, effectiveModelLabel, projectAgents, slugify } from '@shared/defaults'
import type { AddAgentOptions, AgentBranchStatus, EffortLevel, MergeResult, PermissionMode, ProjectGitInfo, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { notify, projectKey, set, showAgent, useStore } from '../store'
import { cx } from '../util'
import { ModelPicker } from './ModelPicker'
import { pasteIntoTerminal } from './TerminalView'
import { Icon, Modal } from './ui'

/** The agent's own model, effort and permission mode; empty values follow the project. */
function Overrides({
  project,
  model,
  effort,
  permission,
  onModel,
  onEffort,
  onPermission
}: {
  project: ProjectInfo
  model: string
  effort: string
  permission: string
  onModel: (v: string) => void
  onEffort: (v: string) => void
  onPermission: (v: string) => void
}) {
  const settings = useStore((s) => s.settings)
  const claudeDefault = useStore((s) => s.agent?.defaultModel ?? null)
  if (!settings) return null
  const cfg = project.config
  const projectModel = effectiveModelLabel(cfg.model, settings.claude.defaultModel, claudeDefault)
  const projectEffort = cfg.effort !== 'inherit' ? cfg.effort : settings.claude.defaultEffort || 'default'
  const projectPermission = PERMISSION_MODES.find((m) => m.value === (cfg.permissionMode === 'inherit' ? settings.claude.defaultPermissionMode : cfg.permissionMode))?.label
  const modes = PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions' || settings.claude.enableBypassOption)
  return (
    <div className="agent-form">
      <label>Model</label>
      <ModelPicker value={model} base={{ value: '', label: `Project's (${projectModel})` }} onChange={onModel} />
      <label>Effort</label>
      <select className="select" value={effort} onChange={(e) => onEffort(e.target.value)}>
        <option value="">Project's ({projectEffort})</option>
        {EFFORT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <label>Permission mode</label>
      <select className="select" value={permission} onChange={(e) => onPermission(e.target.value)}>
        <option value="">Project's ({projectPermission})</option>
        {modes.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add agent
// ---------------------------------------------------------------------------

export function AddAgentDialog() {
  const path = useStore((s) => s.addAgentFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.addAgentFor) ?? null)
  const settings = useStore((s) => s.settings)
  const [git, setGit] = useState<ProjectGitInfo | null>(null)
  const [name, setName] = useState('')
  const [location, setLocation] = useState<AddAgentOptions['location']>('project')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [base, setBase] = useState('')
  const [existing, setExisting] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState('')
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!path || !project) return
    const agents = projectAgents(project.config)
    let n = agents.length + 1
    while (agents.some((a) => a.name === `Agent ${n}`)) n++
    setName(`Agent ${n}`)
    setBranch(`hive/agent-${n}`)
    setBranchEdited(false)
    setModel('')
    setEffort('')
    setPermission('')
    setStartNow(true)
    setBusy(false)
    setGit(null)
    setExisting('')
    setLocation('project')
    void call('agents:gitInfo', path)
      .then((g) => {
        setGit(g)
        setBase(g.current ?? g.branches[0] ?? '')
        setExisting(g.worktrees.find((w) => !w.used)?.path ?? '')
      })
      .catch(() => setGit({ isRepo: false, current: null, branches: [], worktrees: [], worktreesRoot: '' }))
    // Only when the dialog opens for a project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  if (!path || !project || !settings) return null
  const close = (): void => set({ addAgentFor: null })
  const full = project.agents.length >= MAX_AGENTS
  const free = git?.worktrees.filter((w) => !w.used) ?? []
  const copy = project.config.worktreeCopy ?? settings.agents.worktreeCopy
  const setup = project.config.worktreeSetup.trim()
  const valid = !!name.trim() && !full && (location !== 'new-worktree' || (!!branch.trim() && !!base)) && (location !== 'existing-worktree' || !!existing)

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      const def = await call('agents:add', project.path, {
        name: name.trim(),
        location,
        branch: location === 'new-worktree' ? branch.trim() : undefined,
        base: location === 'new-worktree' ? base : undefined,
        worktreePath: location === 'existing-worktree' ? existing : undefined,
        model: model || undefined,
        effort: (effort || undefined) as EffortLevel | undefined,
        permissionMode: (permission || undefined) as PermissionMode | undefined
      })
      await actions.refreshWorkspace()
      close()
      const p = useStore.getState().workspace?.projects.find((x) => x.path === project.path)
      // Show the new agent in a pane: a single-pane layout switches to it.
      if (p) showAgent(p, def.id)
      if (startNow) await actions.newSession(project.path, def.id)
    } catch (e) {
      notify('error', 'Could not add agent', errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Add an agent to ${project.name}`}
      icon="person-add"
      onClose={close}
      wide
      footer={
        <>
          <label className="flex muted" style={{ marginRight: 'auto' }}>
            <input type="checkbox" className="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> Start a session now
          </label>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void add()}>
            <Icon name={busy ? 'loading' : 'add'} spin={busy} /> Add Agent
          </button>
        </>
      }
    >
      {full && <div className="banner warn">A project can have up to {MAX_AGENTS} agents. Remove one first.</div>}
      <div className="agent-form">
        <label>Name</label>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value)
            if (!branchEdited) setBranch(`hive/${slugify(e.target.value)}`)
          }}
        />
      </div>
      <h3 className="agent-dialog-h">Where it works</h3>
      <div className="choice-list">
        <label className={cx('choice', location === 'project' && 'selected')}>
          <input type="radio" checked={location === 'project'} onChange={() => setLocation('project')} />
          <div>
            <strong>Project folder</strong>
            <div className="faint">Shares the folder with the project's other agents. File locks stop two agents editing the same file at once.</div>
          </div>
        </label>
        <label className={cx('choice', location === 'new-worktree' && 'selected', !git?.isRepo && 'disabled')}>
          <input type="radio" disabled={!git?.isRepo} checked={location === 'new-worktree'} onChange={() => setLocation('new-worktree')} />
          <div>
            <strong>New worktree</strong>
            <div className="faint">{git?.isRepo === false ? 'Needs a git repository.' : 'Its own checkout on its own branch. Review and merge its work when it is done.'}</div>
            {location === 'new-worktree' && (
              <div className="agent-form nested">
                <label>Branch</label>
                <input
                  className="input mono"
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value)
                    setBranchEdited(true)
                  }}
                />
                <label>Based on</label>
                <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
                  {git?.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                      {b === git.current ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
                <div className="faint span2">
                  Created in <code>{git?.worktreesRoot}\{slugify(name)}</code>
                  {copy.trim() ? (
                    <>
                      , with <code>{copy.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).join(', ')}</code> copied from the project folder
                    </>
                  ) : null}
                  .{setup ? (
                    <>
                      {' '}
                      <code>{setup}</code> runs in the agent's pane before Claude Code starts.
                    </>
                  ) : (
                    ' Set a setup command (e.g. npm install) in Project Settings → Agents.'
                  )}
                </div>
              </div>
            )}
          </div>
        </label>
        <label className={cx('choice', location === 'existing-worktree' && 'selected', !free.length && 'disabled')}>
          <input type="radio" disabled={!free.length} checked={location === 'existing-worktree'} onChange={() => setLocation('existing-worktree')} />
          <div>
            <strong>Existing worktree</strong>
            <div className="faint">{free.length ? 'A worktree of this project that no agent uses, e.g. one kept when an agent was removed.' : 'This project has no unused worktrees.'}</div>
            {location === 'existing-worktree' && (
              <div className="agent-form nested">
                <label>Worktree</label>
                <select className="select" value={existing} onChange={(e) => setExisting(e.target.value)}>
                  {free.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.branch ?? '(detached)'} — {w.path}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </label>
      </div>
      <h3 className="agent-dialog-h">Settings</h3>
      <Overrides project={project} model={model} effort={effort} permission={permission} onModel={setModel} onEffort={setEffort} onPermission={setPermission} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Agent settings
// ---------------------------------------------------------------------------

export function AgentSettingsDialog() {
  const target = useStore((s) => s.agentSettingsFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.agentSettingsFor?.project) ?? null)
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState('')
  useEffect(() => {
    setName(agent?.name ?? '')
    setModel(agent?.model ?? '')
    setEffort(agent?.effort ?? '')
    setPermission(agent?.permissionMode ?? '')
    // Reset when another agent's dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId])
  if (!target || !project || !agent) return null
  const close = (): void => set({ agentSettingsFor: null })
  const save = async (): Promise<void> => {
    const ok = await actions.attempt('Could not save agent', () =>
      call('agents:update', project.path, agent.id, { name, model: model || undefined, effort: (effort || undefined) as EffortLevel | undefined, permissionMode: (permission || undefined) as PermissionMode | undefined })
    )
    if (ok) {
      await actions.refreshWorkspace()
      close()
    }
  }
  return (
    <Modal
      title={`${agent.name} settings`}
      icon="settings"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="agent-form">
        <label>Name</label>
        <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
        <label>Works in</label>
        <div className="muted">
          {agent.worktree ? (
            <>
              Worktree on <code>{agent.worktree.branch}</code> (from {agent.worktree.base})
              <div className="faint">{agent.worktree.path}</div>
            </>
          ) : (
            'The project folder'
          )}
        </div>
      </div>
      <h3 className="agent-dialog-h">Settings</h3>
      <Overrides project={project} model={model} effort={effort} permission={permission} onModel={setModel} onEffort={setEffort} onPermission={setPermission} />
      {agent.live && <div className="detail">Changes apply the next time {agent.name} starts; the running session keeps its settings until then.</div>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function MergeDialog() {
  const target = useStore((s) => s.mergeFor)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.mergeFor?.project) ?? null)
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [status, setStatus] = useState<AgentBranchStatus | null>(null)
  const [squash, setSquash] = useState(true)
  const [message, setMessage] = useState('')
  const [cleanup, setCleanup] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)

  useEffect(() => {
    setStatus(null)
    setResult(null)
    setBusy(false)
    if (!target || !agent?.worktree) return
    setSquash((settings?.agents.mergeStyle ?? 'squash') === 'squash')
    setMessage(`${agent.name}: work from ${agent.worktree.branch}`)
    setCleanup(true)
    void call('agents:branchStatus', target.project, target.agentId)
      .then(setStatus)
      .catch((e) => notify('error', 'Could not read the branch', errorMessage(e)))
    // Reset when the dialog opens for another agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId])

  if (!target || !project || !agent?.worktree) return null
  const close = (): void => set({ mergeFor: null })
  const running = !!agent.live
  const nothing = status && status.ahead === 0 && status.dirty === 0
  const folderAgent = project.agents.find((a) => !a.worktree && a.live && (a.live.status === 'ready' || a.live.status === 'finished'))

  const merge = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await call('agents:merge', project.path, agent.id, { squash, message, cleanup: cleanup && !running })
      setResult(r)
      if (r.ok) {
        notify('success', `Merged ${agent.worktree!.branch} into ${status?.into ?? 'the project folder'}`, r.cleanedUp ? `${agent.name}'s worktree and branch were removed.` : undefined)
        await actions.refreshWorkspace()
        close()
      }
    } catch (e) {
      notify('error', 'Could not merge', errorMessage(e))
    }
    setBusy(false)
  }

  const instructions = result?.conflicts
    ? `Merge branch ${agent.worktree.branch} into ${status?.into ?? 'the current branch'} and resolve the conflicts in: ${result.conflicts.join(', ')}. Keep the intent of both sides; ask me if it isn't clear which to keep. Commit the merge when done.`
    : ''

  return (
    <Modal
      title={`Merge ${agent.name}'s work`}
      icon="git-merge"
      onClose={close}
      wide
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {result?.conflicts ? 'Close' : 'Cancel'}
          </button>
          {!result?.conflicts && (
            <button className="btn primary" disabled={busy || !status || !!nothing || !status.into} onClick={() => void merge()}>
              <Icon name={busy ? 'loading' : 'git-merge'} spin={busy} /> Merge
            </button>
          )}
        </>
      }
    >
      {!status ? (
        <p className="muted">
          <Icon name="loading" spin /> Reading {agent.worktree.branch}…
        </p>
      ) : result?.conflicts ? (
        <>
          <div className="banner warn">
            <Icon name="warning" /> Merging would conflict. Nothing was changed.
          </div>
          <p>These files were changed on both {agent.worktree.branch} and {status.into}:</p>
          <ul className="conflict-list">
            {result.conflicts.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
          <p className="muted">An agent in the project folder can do the merge and resolve the conflicts. Send it these instructions, or copy them:</p>
          <pre className="instructions">{instructions}</pre>
          <div className="flex">
            <button className="btn subtle" onClick={() => void navigator.clipboard.writeText(instructions).then(() => notify('success', 'Instructions copied'))}>
              <Icon name="copy" /> Copy
            </button>
            {folderAgent && (
              <button
                className="btn primary"
                onClick={() => {
                  const key = projectKey(project.path, folderAgent.id)
                  if (!pasteIntoTerminal(key, instructions)) void call('pty:write', key, instructions)
                  setTimeout(() => void call('pty:write', key, '\r'), 300)
                  close()
                  showAgent(project, folderAgent.id)
                }}
              >
                <Icon name="send" /> Send to {folderAgent.name}
              </button>
            )}
          </div>
          {!folderAgent && <div className="detail">Start an agent in the project folder (and let it finish what it is doing) to send it the instructions from here.</div>}
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            {nothing ? (
              <>There is nothing to merge: {agent.worktree.branch} has no changes that aren't in {status.into}.</>
            ) : (
              <>
                Merges{' '}
                {[status.ahead > 0 && `${status.ahead} commit${status.ahead === 1 ? '' : 's'}`, status.dirty > 0 && `${status.dirty} uncommitted change${status.dirty === 1 ? '' : 's'}`]
                  .filter(Boolean)
                  .map((t, i) => (
                    <span key={i}>
                      {i > 0 && ' and '}
                      <strong>{t}</strong>
                    </span>
                  ))}{' '}
                from <code>{agent.worktree.branch}</code> into <code>{status.into ?? '(no branch)'}</code>, the branch checked out in the project folder.
              </>
            )}
          </p>
          {!status.into && <div className="banner warn">The project folder is not on a branch. Check one out first.</div>}
          {status.into && status.into !== agent.worktree.base && (
            <div className="banner warn">
              <Icon name="info" /> {agent.name}'s branch started from {agent.worktree.base}, but the project folder is on {status.into}.
            </div>
          )}
          {status.dirty > 0 && <div className="detail">The uncommitted changes are committed on {agent.worktree.branch} first, with the message below.</div>}
          <div className="choice-list">
            <label className={cx('choice', squash && 'selected')}>
              <input type="radio" checked={squash} onChange={() => setSquash(true)} />
              <div>
                <strong>Squash</strong>
                <div className="faint">One commit with everything the agent did.</div>
              </div>
            </label>
            <label className={cx('choice', !squash && 'selected')}>
              <input type="radio" checked={!squash} onChange={() => setSquash(false)} />
              <div>
                <strong>Merge</strong>
                <div className="faint">Keeps the agent's individual commits, plus a merge commit.</div>
              </div>
            </label>
          </div>
          <label className="compact-focus" style={{ marginTop: 10 }}>
            <span>Commit message</span>
            <textarea className="input" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <label className="flex muted" style={{ marginTop: 10 }}>
            <input type="checkbox" className="checkbox" disabled={running} checked={cleanup && !running} onChange={(e) => setCleanup(e.target.checked)} /> Remove the worktree and branch afterwards
            (and the agent)
          </label>
          {running && <div className="detail">{agent.name} is running, so its worktree stays. Stop it first to remove the worktree after merging.</div>}
          {result?.error && <div className="field-error">{result.error}</div>}
        </>
      )}
    </Modal>
  )
}
