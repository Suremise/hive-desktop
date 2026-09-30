import type { ProjectInfo } from '@shared/types'
import { compactThreshold, effectiveModelLabel, effortLabel } from '@shared/defaults'
import { agentLaunchSettings, isProviderEnabled, modeOption, projectProviderConfig, providerName, providerSettings } from '@shared/providers'
import { ProviderIcon } from '../components/ProviderIcon'
import { useLiveUsage } from '../usage'
import hexUrl from '../assets/icon.svg'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { AddAgentButton, AgentStrip, PaneChrome, ResumeButton, SessionTag, TerminalLayer, usePanes } from '../components/AgentPanes'
import { ModeBadge } from '../components/PermissionMode'
import { Icon, IconButton, STATUS_TEXT, Switch, Tooltip, useContextMenu } from '../components/ui'
import { agentProviderOf, projectKey, projectState, set, setProjectTab, useFocusedAgent, useStore, type ProjectTab } from '../store'
import { carriesFiles, cx, formatKeybinding, formatTokens } from '../util'
import { FilesTab, ImagesTab } from './FilesTab'
import { ChangesTab, MemoryTab, OverviewTab, ProjectMcpTab, ProjectSettingsTab, ProjectSkillsTab } from './ProjectTabs'
import { SessionsTab } from './SessionsTab'
import { ErrorBoundary } from '../components/ErrorBoundary'

const TABS: { id: ProjectTab; label: string; icon: string }[] = [
  { id: 'session', label: 'Session', icon: 'terminal' },
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'images', label: 'Images', icon: 'file-media' },
  { id: 'changes', label: 'Changes', icon: 'git-compare' },
  { id: 'memory', label: 'Memory', icon: 'book' },
  { id: 'skills', label: 'Skills', icon: 'sparkle' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

function SessionEmpty({ project }: { project: ProjectInfo }) {
  const focused = useFocusedAgent(project)
  const provider = agentProviderOf(project, focused)
  const info = useStore((s) => s.providers[provider])
  const on = useStore((s) => isProviderEnabled(s.settings, provider))
  const epoch = useStore((s) => (focused ? s.sessionEpoch[projectKey(project.path, focused.id)] : undefined))
  const ended = epoch !== undefined
  // An ended session keeps its terminal; the pane shows the Resume bar over it.
  if (ended) return null
  const many = project.agents.length > 1
  return (
    <div className={ended ? 'session-ended' : 'session-empty'}>
      {ended ? (
        <>
          <Icon name="debug-disconnect" />
          <span className="grow">The session has ended. Resume it, or start a new one.</span>
          <button className="btn primary" onClick={() => void actions.resumeLast(project.path)}>
            <Icon name="debug-continue" /> Resume
          </button>
          <button className="btn subtle" onClick={() => void actions.newSession(project.path)}>
            <Icon name="add" /> New Session
          </button>
        </>
      ) : (
        <div className="session-empty-card">
          <img src={hexUrl} className="hex-mark" alt="" />
          <h2>{!focused ? 'No agents yet' : !project.active ? `${project.name} is not active` : many ? `${focused.name} is not running` : 'No session running'}</h2>
          <p>
            {!focused
              ? `Add an agent to work on ${project.name}: Add Agent adds a ${providerName(provider)} agent with its default settings (▾ to choose another provider, a worktree or settings). New Session adds one and starts it.`
              : project.active
                ? `Start a new ${providerName(provider)} session, or resume a previous one. Sessions keep running when you switch to other projects.`
                : 'Mark this project as one you are working on to run sessions and see its status. You can also start a session directly.'}
          </p>
          {!on ? (
            <p>
              <span className="badge warn">
                <Icon name="warning" /> {providerName(provider)} is turned off — Settings → Providers
              </span>
            </p>
          ) : (
            !info?.found &&
            info &&
            !info.checking && (
              <p>
                <span className="badge warn">
                  <Icon name="warning" /> {providerName(provider)} is required — Help → Agent Setup
                </span>
              </p>
            )
          )}
          <div className="btns">
            <button className="btn primary" onClick={() => void actions.newSession(project.path)}>
              <Icon name="add" /> New Session <kbd style={{ marginLeft: 6 }}>{formatKeybinding(commandKeybinding('session.new')!)}</kbd>
            </button>
            {focused ? <ResumeButton project={project} a={focused} className="tint-amber" label="Resume Last" /> : <AddAgentButton project={project} className="tint-amber" />}
            <button className="btn subtle" onClick={() => setProjectTab(project.path, 'sessions')}>
              <Icon name="history" /> All Sessions
            </button>
          </div>
          {!project.active && (
            <div className="btns">
              <button className="btn subtle small" onClick={() => void actions.setProjectActive(project.path, true)}>
                <Icon name="pass" /> Mark as working on
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectView({ visible }: { visible: boolean }) {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const tabs = useStore((s) => s.projectTabs)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const menu = useContextMenu()
  const project = workspace?.projects.find((p) => p.path === selected) ?? null
  const tab = (project && tabs[project.path]) || 'session'
  const terminalVisibleFor = visible && project && tab === 'session' ? project.path : null
  const panes = usePanes(project)
  const focusedAgent = useFocusedAgent(project)

  if (!workspace) return null

  if (!project) {
    return (
      <div className="tab-body" style={{ display: visible ? undefined : 'none' }}>
        <TerminalLayer visibleFor={null} panes={[]} />
        <div className="empty-state" style={{ paddingTop: '20vh' }}>
          <Icon name="files" />
          {workspace.projects.length ? 'Select a project from the sidebar.' : 'Create your first project to get started.'}
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => void actions.createProject()}>
              <Icon name="new-folder" /> New Project
            </button>
          </div>
        </div>
      </div>
    )
  }

  // The header's session buttons act on the focused agent; the status badge speaks for all of them.
  const live = focusedAgent?.live ?? null
  const many = project.agents.length > 1
  const combined = projectState(project)
  const running = project.agents.filter((a) => a.live).length
  const agentId = focusedAgent?.id
  // The header shows the focused agent's provider, model and effort (its own, else the project's).
  const provider = agentProviderOf(project, focusedAgent)
  const pc = projectProviderConfig(project.config, provider)
  const ps = providerSettings(settings, provider)
  const dangerous = settings
    ? project.agents.flatMap((a) => {
        const l = agentLaunchSettings(a, project.config, settings)
        const m = modeOption(l.provider, a.live?.permissionMode ?? l.permissionMode)
        return m?.danger ? [`${many ? `${a.name}: ` : ''}${m.label}`] : []
      })
    : []
  const bypass = dangerous.length > 0
  const model = effectiveModelLabel(provider, focusedAgent?.model || pc.model, ps.defaultModel, providers[provider]?.defaultModel ?? null)
  const effort = effortLabel(provider, live?.effort, focusedAgent?.effort ?? pc.effort, ps.defaultEffort)

  const restart = async (): Promise<void> => {
    if (!live) return
    // Read the name first: a session that never got a message is dropped from the list when it stops.
    const item = (await call('session:list', project.path)).find((s) => s.id === live.sessionId)
    await call('session:stop', project.path, live.agentId)
    const start = Date.now()
    while (Date.now() - start < 8000 && (await call('session:live')).some((l) => l.projectPath === project.path && l.agentId === live.agentId)) await new Promise((r) => setTimeout(r, 150))
    await actions.resumeSession(project.path, { id: live.sessionId, recache: null, title: null, name: item?.name, agentId: live.agentId, cwd: item?.cwd }, live.agentId)
  }

  return (
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="project-header">
        <div>
          <div className="flex">
            <h1>{project.name}</h1>
            <Tooltip
              content={
                <span style={{ whiteSpace: 'pre-line' }}>
                  {many ? project.agents.map((a) => `${a.name}: ${a.live ? a.live.statusMessage ?? STATUS_TEXT[a.live.status] : 'not running'}`).join('\n') : live?.statusMessage ?? (live ? STATUS_TEXT[live.status] : 'No session running')}
                </span>
              }
            >
              <span className={cx('badge', combined?.status === 'working' && 'accent', combined?.status === 'waiting' && 'warn', combined?.status === 'finished' && 'success')}>
                <span className={cx('dot', combined?.status ?? 'idle')} /> {combined ? STATUS_TEXT[combined.status] : 'No session'}
                {many && running > 0 && (
                  <span className="faint">
                    {' '}
                    · {running} of {project.agents.length} agents
                  </span>
                )}
              </span>
            </Tooltip>
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            {project.branch && (
              <span className="badge">
                <Icon name="git-branch" /> {project.branch}
              </span>
            )}
            <Tooltip content={live?.effort ? 'Model for new sessions (Project Settings) and the effort the running session reports' : 'Model and effort for new sessions (Project Settings)'}>
              <span className="badge">
                <ProviderIcon provider={provider} /> {model}
                {effort && <span className="faint"> · {effort}</span>}
              </span>
            </Tooltip>
            <ModeBadge project={project} a={focusedAgent} variant="header" />
            {focusedAgent && <SessionTag project={project} a={focusedAgent} badge />}
          </div>
        </div>
        <div className="actions">
          <Tooltip content={project.active ? 'You are working on this project' : 'Not working on this project'}>
            <label className="flex muted" style={{ cursor: 'pointer', marginRight: 6 }}>
              <Switch checked={project.active} onChange={(v) => void actions.setProjectActive(project.path, v)} /> Active
            </label>
          </Tooltip>
          {many && focusedAgent && (
            <Tooltip content="The buttons act on the focused agent. Click another agent's pane or tab to switch.">
              <span className="muted header-agent">{focusedAgent.name}</span>
            </Tooltip>
          )}
          {live ? (
            <>
              <CompactButton project={project} />
              <button className="btn tint-red" onClick={() => void actions.stopSession(project.path, agentId)}>
                <Icon name="debug-stop" /> Stop
              </button>
              <button className="btn subtle" onClick={() => void actions.archiveCurrent(project.path, agentId)}>
                <Icon name="archive" /> Archive &amp; New
              </button>
            </>
          ) : (
            <>
              {focusedAgent ? (
                <ResumeButton project={project} a={focusedAgent} className="tint-amber" />
              ) : (
                <Tooltip content="Adds an agent and resumes the latest session it can">
                  <button className="btn tint-amber" onClick={() => void actions.resumeLast(project.path)}>
                    <Icon name="debug-continue" /> Resume
                  </button>
                </Tooltip>
              )}
              <button className="btn primary" onClick={() => void actions.newSession(project.path, agentId)}>
                <Icon name="add" /> New Session
              </button>
            </>
          )}
          <IconButton
            icon="ellipsis"
            title="More actions"
            onClick={(e) =>
              menu.open(e, [
                { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
                { label: 'Open External Terminal', icon: 'terminal', onClick: () => void call('project:openTerminal', project.path) },
                { separator: true },
                { label: 'Add Agent', icon: 'person-add', onClick: () => void actions.quickAddAgent(project.path) },
                { label: 'Add Agent…', icon: 'blank', onClick: () => set({ addAgentFor: project.path }) },
                { label: 'Archive Session and Start New', icon: 'archive', onClick: () => void actions.archiveCurrent(project.path, agentId) }
              ])
            }
          />
        </div>
      </div>

      {focusedAgent?.restartNeeded && live && (
        <div className="banner warn">
          <Icon name="refresh" /> Skills, MCP servers or settings changed since {many ? `${focusedAgent.name}'s` : 'this'} session started. Restart the session to apply them — the conversation continues.
          <button className="btn small primary" onClick={() => void restart()}>
            Restart session
          </button>
        </div>
      )}
      {project.unmanagedMcp.length > 0 && (
        <div className="banner warn">
          <Icon name="plug" /> This project defines MCP servers that are not in the workspace: <strong>{project.unmanagedMcp.join(', ')}</strong>. They stay disabled until copied to the
          workspace.
          <button className="btn small" onClick={() => void actions.importProjectMcp(project.path, project.unmanagedMcp)}>
            Copy to workspace
          </button>
        </div>
      )}
      {bypass && (
        <div className="banner danger">
          <Icon name="warning" /> {dangerous.join(', ')} {dangerous.length === 1 ? 'is' : 'are'} on in this project: the agent runs every command and edit without asking.
          <button className="btn small" onClick={() => setProjectTab(project.path, 'settings')}>
            Change
          </button>
        </div>
      )}

      <div className="tabs">
        {TABS.map((t, i) => (
          <Tooltip key={t.id} content={`${t.label} (Alt+${(i + 1) % 10})`}>
            <div
              className={cx('tab', tab === t.id && 'active')}
              onClick={() => setProjectTab(project.path, t.id)}
              // Dragging files over the Session tab switches to it, so they can be dropped on the terminal.
              onDragOver={t.id === 'session' ? (e) => carriesFiles(e.dataTransfer) && live && tab !== 'session' && setProjectTab(project.path, 'session') : undefined}
            >
              <Icon name={t.icon} /> {t.label}
            </div>
          </Tooltip>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'session' && <AgentStrip project={project} />}
        <div className={cx('agents-area', tab === 'session' ? 'shown' : 'hidden')}>
          <TerminalLayer visibleFor={terminalVisibleFor} panes={panes} />
          {tab === 'session' && <PaneChrome project={project} panes={panes} />}
          {tab === 'session' && panes.length === 1 && !live && <SessionEmpty project={project} />}
        </div>
        <ErrorBoundary label="This tab" resetKey={`${project.path}|${tab}`}>
          {tab === 'overview' && <OverviewTab project={project} />}
          {tab === 'sessions' && <SessionsTab project={project} />}
          {tab === 'files' && <FilesTab project={project} />}
          {tab === 'images' && <ImagesTab project={project} />}
          {tab === 'changes' && <ChangesTab project={project} />}
          {tab === 'memory' && <MemoryTab project={project} />}
          {tab === 'skills' && <ProjectSkillsTab project={project} />}
          {tab === 'mcp' && <ProjectMcpTab project={project} />}
          {tab === 'settings' && <ProjectSettingsTab project={project} />}
        </ErrorBoundary>
      </div>
      {menu.element}
    </div>
  )
}

/**
 * Compact the running session's conversation now. Enabled only while the agent is idle, and
 * highlighted once the context passes the project's (or global) threshold.
 */
function CompactButton({ project }: { project: ProjectInfo }) {
  const settings = useStore((s) => s.settings)
  const usage = useLiveUsage(project)
  const agent = useFocusedAgent(project)
  const live = agent?.live
  if (!live || !agent) return null
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const tokens = usage?.contextTokens ?? 0
  const suggested = threshold > 0 && tokens >= threshold
  const idle = live.status === 'ready' || live.status === 'finished'
  const empty = !usage || usage.userMessages === 0 || usage.contextTokens === 0
  const compacting = live.status === 'working' && !!live.statusMessage?.startsWith('Compacting')
  const tip = compacting
    ? 'Compacting the conversation…'
    : idle && empty
      ? 'Nothing to compact yet: the conversation has no messages.'
      : !idle
      ? live.status === 'waiting'
        ? 'The agent is waiting for your answer. Compact after it has finished.'
        : 'Available once the agent has finished.'
      : `Summarise the conversation to shrink its context${usage ? ` (now ${formatTokens(tokens)} tokens)` : ''}. The full history stays in the transcript.${suggested ? ' Recommended: the context is over your threshold.' : ''}`
  return (
    <Tooltip content={tip}>
      <button className={cx('btn subtle', suggested && idle && 'suggest')} disabled={!idle || empty} onClick={() => set({ compactFor: { project: project.path, agentId: agent.id } })}>
        <Icon name={compacting ? 'loading' : 'fold'} spin={compacting} /> Compact{usage && tokens > 0 ? <span className="btn-count">{formatTokens(tokens)}</span> : null}
      </button>
    </Tooltip>
  )
}
