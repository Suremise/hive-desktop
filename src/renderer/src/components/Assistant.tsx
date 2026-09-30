import { useEffect, useRef, useState } from 'react'
import { ASSISTANT_AGENT_ID, assistantPersona } from '@shared/assistant'
import { agentProvider, providerDescriptor } from '@shared/providers'
import type { AgentDef, AgentInfo, EffortLevel, PermissionMode, PersonaInfo, ProjectInfo, ProviderId } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { agentProviderOf, confirm, get, NO_PROJECTS, projectKey, revealAgent, set, setActivity, setAssistantOpen, showView, useStore } from '../store'
import { useLiveUsage } from '../usage'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { Overrides, ProviderChoice } from './AgentDialogs'
import { PaneFooter, useWidth } from './AgentPanes'
import { confirmDangerousMode } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { TerminalView } from './TerminalView'
import { Icon, IconButton, Modal, STATUS_TEXT, StatusDot, Tooltip, useContextMenu, type MenuEntry } from './ui'

/**
 * The Hive Assistant's side panel: the workspace's overseer. Its header (status, persona, controls), what is
 * happening in the workspace, its terminal, and its footer (model, mode, context, cost). Everything about the
 * Assistant is here, apart from managing personas (their own view) and its defaults (Settings → Assistant).
 */

const AGENT = ASSISTANT_AGENT_ID

/** The workspace's personas, reloaded when they change. */
export function usePersonas(): PersonaInfo[] {
  const version = useStore((s) => s.personasVersion)
  const ws = useStore((s) => s.workspace?.path)
  const [list, setList] = useState<PersonaInfo[]>([])
  useEffect(() => {
    if (!ws) return setList([])
    void call('personas:list')
      .then(setList)
      .catch(() => setList([]))
  }, [version, ws])
  return list
}

/** Changes the Assistant's settings for this workspace; a change that needs a new conversation restarts it after asking. */
async function changeAssistant(patch: Partial<Pick<AgentDef, 'provider' | 'model' | 'effort' | 'permissionMode' | 'persona'>>, restart: { title: string; message: string } | null): Promise<boolean> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  if (!a || !agent) return false
  const wasLive = !!agent.live && !!restart
  if (wasLive) {
    const ok = await confirm({ title: restart!.title, message: restart!.message, detail: 'You can resume the current conversation later from the Assistant\'s ⋯ menu.', confirmLabel: 'Restart the Assistant' })
    if (!ok) return false
    await actions.attempt('Could not stop the Assistant', () => call('session:stop', a.path, AGENT))
    await actions.waitForStop(a.path, AGENT)
  }
  const done = await actions.attempt('Could not save the Assistant\'s settings', () => call('agents:update', a.path, AGENT, patch))
  await actions.refreshWorkspace()
  if (done && wasLive) await actions.newSession(a.path, AGENT)
  return !!done
}

/** Makes a persona this workspace's; a running Assistant restarts as it (after asking). */
export async function choosePersona(p: Pick<PersonaInfo, 'id' | 'name'>): Promise<void> {
  const agent = get().workspace?.assistant?.agents[0]
  if (!agent) return
  const current = assistantPersona(agent, get().settings)
  if (current === p.id && agent.persona === p.id) return
  await changeAssistant(
    { persona: p.id },
    current === p.id ? null : { title: `Switch to ${p.name}?`, message: `The Assistant is running as another persona. Switching stops this conversation and starts a new one as ${p.name}.` }
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function AssistantPanel() {
  const open = useStore((s) => s.assistantOpen)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const epochs = useStore((s) => s.sessionEpoch)
  const width = usePaneSize('assistant', 430)
  // The overview's share of the height once dragged; until then it takes what it needs (up to a third).
  const topShare = useStore((s) => s.panes.assistantTop)
  const body = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  if (!a) return null
  if (!open) return <AssistantRail a={a.agents[0] ?? null} />
  const agent = a.agents[0]
  if (!agent) return null
  const key = projectKey(a.path, AGENT)
  const hasTerminal = !!agent.live || epochs[key] !== undefined

  // The line between the workspace overview and the terminal: drag to share the height.
  const startSplit = (e: React.MouseEvent): void => {
    if (e.button !== 0 || !body.current) return
    e.preventDefault()
    const box = body.current.getBoundingClientRect()
    setDragging(true)
    document.body.classList.add('pane-resizing-v')
    const move = (ev: MouseEvent): void => {
      const share = Math.max(0.12, Math.min(0.7, (ev.clientY - box.top) / box.height))
      set((s) => ({ panes: { ...s.panes, assistantTop: share } }))
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing-v')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void call('ui:setPane', 'assistantTop', get().panes.assistantTop ?? null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="assistant-panel" style={{ width }}>
      <PaneResizer paneKey="assistant" edge="left" min={300} max={900} keep={380} />
      <AssistantHeader project={a} a={agent} />
      <div className="assistant-body" ref={body}>
        <div className={cx('assistant-top', topShare === undefined && 'auto')} style={topShare === undefined ? undefined : { height: `${topShare * 100}%` }}>
          <WorkspaceOverview />
        </div>
        <div
          className={cx('assistant-split', dragging && 'dragging')}
          onMouseDown={startSplit}
          onDoubleClick={() => {
            set((s) => {
              const panes = { ...s.panes }
              delete panes.assistantTop
              return { panes }
            })
            void call('ui:setPane', 'assistantTop', null)
          }}
        />
        <div className="assistant-terminal">
          {hasTerminal && (
            <TerminalView
              key={`${key}:${epochs[key] ?? 0}`}
              ptyKey={key}
              visible
              projectPath={a.path}
              agentId={AGENT}
              provider={agentProviderOf(a, agent)}
              autoFocus={!!agent.live}
            />
          )}
          {!agent.live && <AssistantIdle project={a} a={agent} ended={hasTerminal} />}
        </div>
      </div>
      <div className="assistant-footer">
        <PaneFooter project={a} a={agent} onSettings={() => set({ assistantSettingsOpen: true })} onContext={() => undefined} settingsName="Assistant Settings" />
      </div>
    </div>
  )
}

/** The hidden panel: a strip down the right edge; click it to show the panel. Its dot shows what the Assistant is doing. */
function AssistantRail({ a }: { a: AgentInfo | null }) {
  const kb = commandKeybinding('assistant.toggle')
  const live = a?.live
  return (
    <div className="assistant-rail" role="button" aria-label="Show the Hive Assistant" onClick={() => setAssistantOpen(true)}>
      <Tooltip content={`Show the Hive Assistant${kb ? ` (${formatKeybinding(kb)})` : ''}`}>
        <span className="rail-btn">
          <Icon name="chevron-left" />
        </span>
      </Tooltip>
      {live && <span className={cx('dot', live.status, live.unseen && 'unseen')} title={live.statusMessage ?? STATUS_TEXT[live.status]} />}
      <span className="assistant-rail-label">Hive Assistant</span>
    </div>
  )
}

/** Shown while the Assistant isn't running: start it, or resume a conversation. */
function AssistantIdle({ project, a, ended }: { project: ProjectInfo; a: AgentInfo; ended: boolean }) {
  const settings = useStore((s) => s.settings)
  const personas = usePersonas()
  const personaId = assistantPersona(a, settings)
  const persona = personas.find((p) => p.id === personaId)
  const picker = useConversationPicker()
  const resume = a.resume ? (
    <button className="btn subtle small" onClick={() => void actions.resumeLast(project.path, AGENT)} title={`Resume "${sessionLabel(a.resume, 'Assistant')}", ${timeAgo(a.resume.lastActiveAt)}`}>
      <Icon name="debug-continue" /> Resume
    </button>
  ) : null
  if (ended) {
    return (
      <div className="session-ended compact assistant-ended">
        <Icon name="debug-disconnect" />
        <span className="grow">The conversation has ended.</span>
        {resume}
        <button className="btn primary small" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="add" /> New
        </button>
      </div>
    )
  }
  return (
    <div className="assistant-idle">
      <div className="assistant-idle-mark">{persona?.icon || '🐝'}</div>
      <p>
        <strong>{persona?.name ?? 'The Assistant'}</strong> watches over this workspace: ask it what the agents are doing, about any project, or for a plan or a review.
      </p>
      <p className="faint">For now it only looks and advises; it doesn't change files or run agents.</p>
      <div className="btns">
        <button className="btn primary" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="play" /> Start Assistant
        </button>
        {resume}
        <button className="btn subtle small" onClick={(e) => picker.openBelow(e.currentTarget, project)}>
          <Icon name="history" /> Conversations
        </button>
      </div>
      {picker.element}
    </div>
  )
}

/** A menu of the Assistant's past conversations, newest first. */
function useConversationPicker() {
  const menu = useContextMenu()
  const openAt = async (project: ProjectInfo, x: number, y: number): Promise<void> => {
    const list = await actions.attempt('Could not list conversations', () => call('session:list', project.path))
    if (!list) return
    const open = project.agents[0]?.live?.sessionId
    const all = list.filter((s) => s.source === 'hive' && !s.archived)
    const items: MenuEntry[] = [{ header: true, label: 'Resume a conversation' }]
    if (!all.length) items.push({ label: 'No conversations yet', disabled: true })
    for (const s of all.slice(0, 12)) {
      items.push({
        label: sessionLabel(s, 'Assistant'),
        detail: [timeAgo(s.lastActivity), s.id === open ? 'open now' : null, s.provider ? providerDescriptor(s.provider).name : null].filter(Boolean).join(' · '),
        icon: s.id === open ? 'circle-filled' : 'history',
        disabled: s.id === open,
        onClick: () => void actions.resumeSession(project.path, s, AGENT)
      })
    }
    menu.openAt(x, y, items)
  }
  const openBelow = (el: Element, project: ProjectInfo): void => {
    const r = el.getBoundingClientRect()
    void openAt(project, r.left, r.bottom + 2)
  }
  return { openAt, openBelow, element: menu.element }
}

/** Below this header width Start, Compact and Stop fold into ⋯. */
const BUTTONS_FROM = 380

function AssistantHeader({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const buttons = width === 0 || width >= BUTTONS_FROM
  const settings = useStore((s) => s.settings)
  const personas = usePersonas()
  const menu = useContextMenu()
  const picker = useConversationPicker()
  const usage = useLiveUsage(project, AGENT)
  const live = a.live
  const idle = live && (live.status === 'ready' || live.status === 'finished')
  const empty = !usage || usage.userMessages === 0 || (usage.contextTokens ?? 0) === 0
  const personaId = assistantPersona(a, settings)
  const persona = personas.find((p) => p.id === personaId)

  const personaMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    menu.openAt(r.left, r.bottom + 2, [
      { header: true, label: live ? 'Switch persona (starts a new conversation)' : 'Persona' },
      ...personas
        .filter((p) => p.bundled !== 'missing')
        .map(
          (p): MenuEntry => ({
            label: `${p.icon ? `${p.icon}  ` : ''}${p.name}`,
            detail: p.description,
            icon: p.id === personaId ? 'check' : undefined,
            onClick: () => void choosePersona(p)
          })
        ),
      { separator: true },
      { label: 'Manage Personas…', icon: 'person', onClick: () => showView('personas') }
    ])
  }
  const start = (): void => void actions.newSession(project.path, AGENT)
  const stop = (): void => void actions.stopSession(project.path, AGENT)
  const compact = (): void => set({ compactFor: { project: project.path, agentId: AGENT } })
  const compactTip = empty ? 'Nothing to compact yet' : idle ? `Compact the conversation${usage ? ` (now ${formatTokens(usage.contextTokens ?? 0)} tokens)` : ''}` : 'Compact once the Assistant has finished'
  /** A header button: an icon with a tooltip, like an agent pane's in its icon size. */
  const btn = (icon: string, label: string, onClick: () => void, tone: string, tip: string, disabled = false) => (
    <Tooltip content={tip}>
      <button type="button" className={cx('btn small pane-btn icon-only', tone)} disabled={disabled} aria-label={label} onClick={onClick}>
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
  const moreMenu = (e: React.MouseEvent): void => {
    const { clientX: x, clientY: y } = e
    // Start, Compact and Stop are the header's buttons until it gets too narrow for them.
    const folded: MenuEntry[] = buttons
      ? []
      : live
        ? [
            { label: 'Compact…', icon: 'fold', disabled: !idle || empty, onClick: compact },
            { label: 'Stop', icon: 'debug-stop', onClick: stop }
          ]
        : [{ label: 'Start', icon: 'play', onClick: start }]
    menu.openAt(x, y, [
      ...folded,
      live
        ? { label: 'New Conversation', icon: 'add', onClick: start }
        : { label: 'Resume', icon: 'debug-continue', disabled: !a.resume, onClick: () => void actions.resumeLast(project.path, AGENT) },
      { label: 'Resume a Conversation…', icon: 'history', onClick: () => void picker.openAt(project, x, y) },
      { separator: true },
      { label: 'Assistant Settings…', icon: 'settings', onClick: () => set({ assistantSettingsOpen: true }) },
      { label: 'Manage Personas…', icon: 'person', onClick: () => showView('personas') },
      { separator: true },
      { label: 'Hide the Assistant', icon: 'layout-sidebar-right-off', onClick: () => setAssistantOpen(false) }
    ])
  }
  const kb = commandKeybinding('assistant.toggle')
  return (
    <div className="assistant-header" ref={ref}>
      <StatusDot live={live} active />
      <Tooltip content={providerDescriptor(agentProviderOf(project, a)).name}>
        <span>
          <ProviderIcon provider={agentProviderOf(project, a)} />
        </span>
      </Tooltip>
      <strong className="assistant-title">Assistant</strong>
      <Tooltip content={persona ? `${persona.name}: ${persona.description}` : 'Choose a persona'}>
        <button className="btn subtle small assistant-persona" onClick={personaMenu}>
          <span className="assistant-persona-icon">{persona?.icon || '🐝'}</span>
          <span className="assistant-persona-name">{persona?.name ?? personaId}</span>
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      <span className="faint pane-status">{live ? live.statusMessage ?? STATUS_TEXT[live.status] : 'Not running'}</span>
      <div className="grow" />
      {buttons &&
        (live ? (
          <>
            {btn('fold', 'Compact', compact, 'subtle', compactTip, !idle || empty)}
            {btn('stop-circle', 'Stop', stop, 'tint-red', 'Stop the Assistant (the conversation is kept)')}
          </>
        ) : (
          btn('play', 'Start', start, 'primary', 'Start the Assistant')
        ))}
      <IconButton icon="ellipsis" title="More" onClick={moreMenu} />
      <IconButton icon="chevron-right" title={`Hide the Assistant (it keeps running)${kb ? ` (${formatKeybinding(kb)})` : ''}`} onClick={() => setAssistantOpen(false)} />
      {menu.element}
      {picker.element}
    </div>
  )
}

/** Whether a workspace's overview shows its inactive projects (remembered per workspace). */
const inactiveKey = (ws: string): string => `assistant-inactive:${ws.toLowerCase()}`

/**
 * What is happening in the workspace: agents needing you first, then each project and its agents. Click one to go
 * to it. Inactive projects without a running agent fold into one row at the end.
 */
function WorkspaceOverview() {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const ws = useStore((s) => s.workspace?.path ?? '')
  const showInactive = useStore((s) => s.panes[inactiveKey(ws)] === 1)
  const toggleInactive = (): void => {
    const v = showInactive ? 0 : 1
    set((s) => ({ panes: { ...s.panes, [inactiveKey(ws)]: v } }))
    void call('ui:setPane', inactiveKey(ws), v)
  }
  const go = (p: ProjectInfo, id?: string): void => {
    set({ selectedProject: p.path })
    showView('projects')
    if (id) revealAgent(p, id)
  }
  const attention = projects.flatMap((p) => p.agents.filter((a) => a.live?.status === 'waiting' || a.live?.status === 'error').map((a) => ({ p, a })))
  const running = projects.reduce((n, p) => n + p.agents.filter((a) => a.live).length, 0)
  const shown = projects.filter((p) => p.active || p.agents.some((a) => a.live))
  const folded = projects.filter((p) => !shown.includes(p))
  const row = (p: ProjectInfo) => (
    <div key={p.path} className={cx('assistant-project', !p.active && 'inactive')}>
      <span className="assistant-project-name" onClick={() => go(p)}>
        {p.name}
      </span>
      <div className="assistant-agents">
        {p.agents.length === 0 && <span className="faint">no agents</span>}
        {p.agents.map((a) => (
          <Tooltip key={a.id} content={`${a.name}: ${a.live ? a.live.statusMessage ?? STATUS_TEXT[a.live.status] : 'not running'}${a.worktree ? ` · worktree ${a.worktree.branch}` : ''}`}>
            <span className="assistant-agent" onClick={() => go(p, a.id)}>
              <span className={cx('dot', a.live?.status ?? 'stopped', a.live?.unseen && 'unseen')} />
              <ProviderIcon provider={agentProviderOf(p, a)} />
              <span className="assistant-agent-name">{a.name}</span>
              {a.live && <span className="faint assistant-agent-status">{a.live.statusMessage ?? STATUS_TEXT[a.live.status]}</span>}
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  )
  return (
    <div className="assistant-overview">
      <div className="assistant-section-title">
        Workspace
        <span className="faint">
          {running} running · {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
      </div>
      {attention.map(({ p, a }) => (
        <div key={`${p.path}#${a.id}`} className="assistant-attention" onClick={() => go(p, a.id)}>
          <Icon name={a.live?.status === 'error' ? 'error' : 'bell-dot'} />
          <span>
            <strong>{p.name}</strong>
            {p.agents.length > 1 ? ` · ${a.name}` : ''} {a.live?.status === 'error' ? 'has a problem' : 'is waiting for you'}
            {a.live?.statusMessage ? `: ${a.live.statusMessage}` : ''}
          </span>
        </div>
      ))}
      {projects.length === 0 && <div className="faint assistant-empty">No projects in this workspace yet.</div>}
      {shown.map(row)}
      {folded.length > 0 && (
        <div className="assistant-fold" role="button" aria-expanded={showInactive} onClick={toggleInactive}>
          <Icon name={showInactive ? 'chevron-down' : 'chevron-right'} />
          {folded.length} inactive project{folded.length === 1 ? '' : 's'}
        </div>
      )}
      {showInactive && folded.map(row)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant Settings: this workspace's choices, over Settings → Assistant
// ---------------------------------------------------------------------------

export function AssistantSettingsDialog() {
  const openFlag = useStore((s) => s.assistantSettingsOpen)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const settings = useStore((s) => s.settings)
  const personas = usePersonas()
  const agent = a?.agents[0] ?? null
  const current: ProviderId = a && agent ? (agent.live?.provider ?? agentProvider(agent, a.config, settings)) : ''
  const [provider, setProvider] = useState<ProviderId>(current)
  const [persona, setPersona] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState('')
  useEffect(() => {
    setProvider(current)
    setPersona(agent?.persona ?? '')
    setModel(agent?.model ?? '')
    setEffort(agent?.effort ?? '')
    setPermission(agent?.permissionMode ?? '')
    // Reset each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFlag])
  if (!openFlag || !a || !agent) return null
  const close = (): void => set({ assistantSettingsOpen: false })
  const chooseProvider = (v: ProviderId): void => {
    setProvider(v)
    if (v !== provider) {
      setModel('')
      setEffort('')
      setPermission('')
    }
  }
  const defaultPersona = personas.find((p) => p.id === (settings?.assistant.persona || 'overseer'))
  const save = async (): Promise<void> => {
    const providerChanged = provider !== current
    const personaChanged = assistantPersona({ persona }, settings) !== assistantPersona(agent, settings)
    if (permission && permission !== agent.permissionMode && !(await confirmDangerousMode(provider, permission, 'The Assistant'))) return
    const ok = await changeAssistant(
      {
        ...(providerChanged ? { provider } : {}),
        persona: persona || undefined,
        model: model || undefined,
        effort: (effort || undefined) as EffortLevel | undefined,
        permissionMode: (permission || undefined) as PermissionMode | undefined
      },
      providerChanged || personaChanged
        ? {
            title: 'Restart the Assistant?',
            message: providerChanged
              ? `Switching to ${providerDescriptor(provider).name} stops this conversation (${providerDescriptor(current).name} conversations can't move to another provider) and starts a new one.`
              : 'A new persona needs a new conversation: this one stops and a new one starts.'
          }
        : null
    )
    if (ok) close()
  }
  return (
    <Modal
      title="Assistant Settings"
      icon="settings"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="hint">
        For this workspace. Anything left at <em>Default</em> follows{' '}
        <a
          onClick={() => {
            close()
            set({ settingsSection: 'assistant', settingsQuery: '' })
            setActivity('settings')
          }}
        >
          Settings → Assistant
        </a>
        .
      </p>
      <div className="agent-form">
        <label>Persona</label>
        <select className="select" value={persona} onChange={(e) => setPersona(e.target.value)}>
          <option value="">Default ({defaultPersona?.name ?? settings?.assistant.persona ?? 'Overseer'})</option>
          {personas
            .filter((p) => p.bundled !== 'missing')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ''}
                {p.name}
              </option>
            ))}
        </select>
      </div>
      <h3 className="agent-dialog-h">Coding agent</h3>
      <ProviderChoice value={provider} current={current} onChange={chooseProvider} />
      <h3 className="agent-dialog-h">Settings</h3>
      <Overrides project={a} provider={provider} model={model} effort={effort} permission={permission} onModel={setModel} onEffort={setEffort} onPermission={setPermission} inherit="Default" />
      {agent.live && <div className="detail">Model, effort and mode apply when the Assistant next starts. A new provider or persona restarts it now (after asking).</div>}
    </Modal>
  )
}
