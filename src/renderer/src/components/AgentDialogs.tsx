import { useEffect, useState } from 'react'
import { MAX_AGENTS, effectiveModelLabel, projectAgents, slugify } from '@shared/defaults'
import { PROVIDERS, agentProvider, isProviderEnabled, offeredModes, permissionLabel, projectDefaultProvider, projectProviderConfig, providerDescriptor, providerSettings } from '@shared/providers'
import type { AddAgentOptions, AgentBranchStatus, EffortLevel, MergeResult, PermissionMode, ProjectGitInfo, ProjectInfo, ProviderId } from '@shared/types'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { agentProviderOf, confirm, notify, projectKey, set, setActivity, showAgent, useStore } from '../store'
import { confirmDangerousMode } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { cx } from '../util'
import { ModelPicker } from './ModelPicker'
import { pasteIntoTerminal } from './TerminalView'
import { Icon, Modal } from './ui'

/** Which provider an agent runs: enabled providers, with what each still needs (install, sign-in). */
export function ProviderChoice({ value, current, onChange }: { value: ProviderId; current?: ProviderId; onChange: (v: ProviderId) => void }) {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const shown = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id) || p.id === value || p.id === current)
  if (!shown.length) {
    return (
      <div className="muted">
        No providers are turned on.{' '}
        <a
          onClick={() => {
            set({ addAgentFor: null, agentSettingsFor: null, settingsSection: 'providers', settingsQuery: '' })
            setActivity('settings')
          }}
        >
          Choose one in Settings → Providers
        </a>
      </div>
    )
  }
  return (
    <div className="provider-choice">
      {shown.map((p) => {
        const info = providers[p.id]
        const off = !isProviderEnabled(settings, p.id)
        const issue = off ? 'Turned off in Settings' : !info?.found ? 'Not installed' : info.readiness?.find((r) => r.level === 'error')?.message
        return (
          <label key={p.id} className={cx('choice', value === p.id && 'selected', off && 'disabled')}>
            <input type="radio" disabled={off} checked={value === p.id} onChange={() => onChange(p.id)} />
            <ProviderIcon provider={p.id} />
            <div>
              <strong>{p.name}</strong>
              <div className="faint">{issue ?? `${info?.version ?? ''}`}</div>
            </div>
          </label>
        )
      })}
    </div>
  )
}

/** The agent's own model, effort and permission mode for its provider; empty values follow the project (`inherit` names it). */
export function Overrides({
  project,
  provider,
  model,
  effort,
  permission,
  onModel,
  onEffort,
  onPermission,
  inherit = "Project's"
}: {
  inherit?: string
  project: ProjectInfo
  provider: ProviderId
  model: string
  effort: string
  permission: string
  onModel: (v: string) => void
  onEffort: (v: string) => void
  onPermission: (v: string) => void
}) {
  const settings = useStore((s) => s.settings)
  const cliDefault = useStore((s) => s.providers[provider]?.defaultModel ?? null)
  if (!settings) return null
  const p = providerDescriptor(provider)
  const pc = projectProviderConfig(project.config, provider)
  const g = providerSettings(settings, provider)
  const projectModel = effectiveModelLabel(provider, pc.model, g.defaultModel, cliDefault)
  const projectEffortId = pc.effort !== 'inherit' ? pc.effort : g.defaultEffort
  const projectEffort = projectEffortId ? p.effortLevels.find((l) => l.value === projectEffortId)?.label ?? projectEffortId : 'default'
  const projectPermission = permissionLabel(provider, pc.permissionMode === 'inherit' ? g.defaultPermissionMode : pc.permissionMode)
  const modes = offeredModes(provider, settings)
  return (
    <div className="agent-form">
      <label>Model</label>
      <ModelPicker key={provider} provider={provider} value={model} base={{ value: '', label: `${inherit} (${projectModel})` }} onChange={onModel} />
      <label>Effort</label>
      <select className="select" value={effort} onChange={(e) => onEffort(e.target.value)}>
        <option value="">
          {inherit} ({projectEffort})
        </option>
        {p.effortLevels.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <label>Permission mode</label>
      <select className="select" value={permission} onChange={(e) => onPermission(e.target.value)}>
        <option value="">
          {inherit} ({projectPermission})
        </option>
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
  const [provider, setProvider] = useState<ProviderId>('')
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
    // The project's default provider when it is on, else the first one that is.
    const s = useStore.getState().settings
    const preferred = projectDefaultProvider(project.config, s)
    setProvider(isProviderEnabled(s, preferred) ? preferred : PROVIDERS.find((p) => isProviderEnabled(s, p.id))?.id ?? preferred)
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
  const valid = !!name.trim() && !full && isProviderEnabled(settings, provider) && (location !== 'new-worktree' || (!!branch.trim() && !!base)) && (location !== 'existing-worktree' || !!existing)
  const chooseProvider = (v: ProviderId): void => {
    // Model, effort and mode are the provider's own: another provider starts from the project's.
    if (v === provider) return
    setProvider(v)
    setModel('')
    setEffort('')
    setPermission('')
  }

  const add = async (): Promise<void> => {
    if (permission && !(await confirmDangerousMode(provider, permission, name.trim()))) return
    setBusy(true)
    try {
      const def = await call('agents:add', project.path, {
        name: name.trim(),
        provider,
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
      actions.noteManyAgents(project.path)
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
      <h3 className="agent-dialog-h">Coding agent</h3>
      <ProviderChoice value={provider} onChange={chooseProvider} />
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
                      <code>{setup}</code> runs in the agent's pane before {providerDescriptor(provider).name} starts.
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
      <Overrides project={project} provider={provider} model={model} effort={effort} permission={permission} onModel={setModel} onEffort={setEffort} onPermission={setPermission} />
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
  const settings = useStore((s) => s.settings)
  const current = project && agent ? (agent.live?.provider ?? agentProvider(agent, project.config, settings)) : ''
  const [provider, setProvider] = useState<ProviderId>(current)
  useEffect(() => {
    setName(agent?.name ?? '')
    setModel(agent?.model ?? '')
    setEffort(agent?.effort ?? '')
    setPermission(agent?.permissionMode ?? '')
    setProvider(current)
    // Reset when another agent's dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId])
  if (!target || !project || !agent) return null
  const close = (): void => set({ agentSettingsFor: null })
  const changed = provider !== current
  const chooseProvider = (v: ProviderId): void => {
    setProvider(v)
    if (v !== provider) {
      setModel('')
      setEffort('')
      setPermission('')
    }
  }
  const save = async (): Promise<void> => {
    if (changed) {
      const ok = await confirm({
        title: `Switch ${agent.name} to ${providerDescriptor(provider).name}?`,
        message: `Its conversations stay in the Sessions tab, but ${providerDescriptor(provider).name} can't resume ${providerDescriptor(current).name} conversations, so ${agent.name} starts fresh next time.`,
        detail: 'To carry the work over, ask the agent for a handover before switching (Hive MCP: hive_create_handover), then ask the new agent to read it.',
        confirmLabel: 'Switch'
      })
      if (!ok) return
    }
    if (permission && permission !== agent.permissionMode && !(await confirmDangerousMode(provider, permission, agent.name))) return
    const ok = await actions.attempt('Could not save agent', () =>
      call('agents:update', project.path, agent.id, {
        name,
        ...(changed ? { provider } : {}),
        model: model || undefined,
        effort: (effort || undefined) as EffortLevel | undefined,
        permissionMode: (permission || undefined) as PermissionMode | undefined
      })
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
      <h3 className="agent-dialog-h">Coding agent</h3>
      {agent.live ? (
        <div className="muted flex">
          <ProviderIcon provider={current} /> {providerDescriptor(current).name} <span className="faint">— stop {agent.name} to change it</span>
        </div>
      ) : (
        <ProviderChoice value={provider} current={current} onChange={chooseProvider} />
      )}
      <h3 className="agent-dialog-h">Settings</h3>
      <Overrides project={project} provider={provider} model={model} effort={effort} permission={permission} onModel={setModel} onEffort={setEffort} onPermission={setPermission} />
      {agent.live && <div className="detail">Changes apply the next time {agent.name} starts; the running session keeps its settings until then.</div>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Hand Over to…
// ---------------------------------------------------------------------------

/**
 * Hands one agent's work to another, of any provider. Conversations can't move between providers,
 * so the source writes a handover (Hive's hive_create_handover tool) and the target reads it.
 */
export function HandOverDialog() {
  const target = useStore((s) => s.handOverFor)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.handOverFor?.project) ?? null)
  const from = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [to, setTo] = useState('')
  const [handover, setHandover] = useState(true)

  const idle = (a: { live?: { status: string } | null }): boolean => !a.live || a.live.status === 'ready' || a.live.status === 'finished'
  const fromReady = !!from?.live && idle(from)
  useEffect(() => {
    if (!target || !project) return
    setHandover(fromReady)
    const first = project.agents.find((a) => a.id !== target.agentId && idle(a) && isProviderEnabled(settings, agentProviderOf(project, a)))
    setTo(first?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId])

  if (!target || !project || !from) return null
  const close = (): void => set({ handOverFor: null })
  const others = project.agents.filter((a) => a.id !== from.id)
  const chosen = others.find((a) => a.id === to)
  const hiveTools = settings?.agentApi.provideHiveMcp !== false

  const go = (): void => {
    if (!chosen) return
    close()
    showAgent(project, chosen.id)
    void call('session:handOver', project.path, from.id, chosen.id, { handover: handover && fromReady }).catch((e) => notify('error', `Could not hand over to ${chosen.name}`, errorMessage(e)))
  }

  return (
    <Modal
      title={`Hand over ${from.name}'s work to…`}
      icon="arrow-swap"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen || !hiveTools} onClick={go}>
            <Icon name="arrow-swap" /> Hand Over
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Another agent picks up the work from a handover. It can use a different provider: the conversation itself stays with {from.name}; the handover carries the goal, what's done and
        the next steps.
      </p>
      {!hiveTools && (
        <div className="banner warn">
          <Icon name="warning" /> This needs Hive's tools in sessions. Turn on "Provide Hive tools to sessions" in Settings → Agent API.
        </div>
      )}
      <div className="choice-list">
        {others.map((a) => {
          const p = agentProviderOf(project, a)
          const enabled = isProviderEnabled(settings, p)
          const free = idle(a)
          return (
            <label key={a.id} className={cx('choice', to === a.id && 'selected', (!enabled || !free) && 'disabled')}>
              <input type="radio" disabled={!enabled || !free} checked={to === a.id} onChange={() => setTo(a.id)} />
              <div>
                <strong>
                  <ProviderIcon provider={p} /> {a.name}
                </strong>
                <div className="faint">
                  {!enabled
                    ? `${providerDescriptor(p).name} is turned off.`
                    : !free
                      ? 'Busy. Choose it once it has finished.'
                      : a.live
                        ? 'Running: gets the message in its current session.'
                        : `Starts a new ${providerDescriptor(p).name} session.`}
                </div>
              </div>
            </label>
          )
        })}
      </div>
      <label className="flex muted" style={{ marginTop: 10 }}>
        <input type="checkbox" className="checkbox" disabled={!fromReady} checked={handover && fromReady} onChange={(e) => setHandover(e.target.checked)} /> Ask {from.name} to write a
        handover first
      </label>
      <div className="detail">
        {fromReady
          ? `${from.name} writes it with Hive's handover tool; ${chosen?.name ?? 'the other agent'} starts when it's done.`
          : from.live
            ? `${from.name} is busy, so ${chosen?.name ?? 'the other agent'} continues from the latest handover.`
            : `${from.name} isn't running, so ${chosen?.name ?? 'the other agent'} continues from the latest handover. Resume ${from.name} first to have it write a new one.`}
      </div>
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
