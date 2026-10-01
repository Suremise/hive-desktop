import type { ProjectInfo } from '@shared/types'
import { agentLaunchSettings, isProviderEnabled, modeOption, providerName } from '@shared/providers'
import hexUrl from '../assets/icon.svg'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { AddAgentButton, AgentStrip, PANE_FOOTER, PANE_HEADER, PaneChrome, ResumeButton, TerminalLayer, usePanes, useWidth } from '../components/AgentPanes'
import { Icon, IconButton, STATUS_TEXT, statusText, Switch, Tooltip, useContextMenu } from '../components/ui'
import { agentProviderOf, projectKey, projectState, set, setProjectTab, useFocusedAgent, useStore, type ProjectTab } from '../store'
import { carriesFiles, cx, formatKeybinding } from '../util'
import { FilesTab, ImagesTab } from './FilesTab'
import { ChangesTab, MemoryTab, OverviewTab, ProjectMcpTab, ProjectSettingsTab, ProjectSkillsTab } from './ProjectTabs'
import { SessionsTab } from './SessionsTab'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProjectTasksTab } from '../components/Board'
import { RemovedDataBanner } from '../components/ProjectRemoval'

const TABS: { id: ProjectTab; label: string; icon: string }[] = [
  { id: 'session', label: 'Session', icon: 'terminal' },
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'tasks', label: 'Tasks', icon: 'project' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'images', label: 'Images', icon: 'file-media' },
  { id: 'changes', label: 'Changes', icon: 'git-compare' },
  { id: 'memory', label: 'Memory', icon: 'book' },
  { id: 'skills', label: 'Skills', icon: 'sparkle' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

/** A tab's tooltip, with its shortcut (they can be changed, and Tasks has none by default). */
function tabTip(id: ProjectTab, label: string): string {
  const kb = commandKeybinding(id === 'settings' ? 'project.tab.settings' : `project.tab.${id}`)
  return kb ? `${label} (${formatKeybinding(kb)})` : label
}

function SessionEmpty({ project, framed }: { project: ProjectInfo; framed: boolean }) {
  const focused = useFocusedAgent(project)
  // Unbound in Keyboard Shortcuts: no key to show.
  const newKey = commandKeybinding('session.new')
  const provider = agentProviderOf(project, focused)
  const info = useStore((s) => s.providers[provider])
  const on = useStore((s) => isProviderEnabled(s.settings, provider))
  const epoch = useStore((s) => (focused ? s.sessionEpoch[projectKey(project.path, focused.id)] : undefined))
  const ended = epoch !== undefined
  // An ended session keeps its terminal; the pane shows the Resume bar over it.
  if (ended) return null
  const many = project.agents.length > 1
  return (
    <div className={ended ? 'session-ended' : 'session-empty'} style={framed ? { top: PANE_HEADER, bottom: PANE_FOOTER } : undefined}>
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
              <Icon name="add" /> New Session {newKey && <kbd style={{ marginLeft: 6 }}>{formatKeybinding(newKey)}</kbd>}
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
  const menu = useContextMenu()
  const project = workspace?.projects.find((p) => p.path === selected) ?? null
  const tab = (project && tabs[project.path]) || 'session'
  const terminalVisibleFor = visible && project && tab === 'session' ? project.path : null
  const panes = usePanes(project)
  const focusedAgent = useFocusedAgent(project)
  // A narrow header shows its buttons as icons.
  const [headerRef, headerWidth] = useWidth<HTMLDivElement>()
  const narrow = headerWidth > 0 && headerWidth < 860

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

  // The header is about the project: its status speaks for all its agents. Each agent's details and
  // controls are in its pane's header and footer.
  const live = focusedAgent?.live ?? null
  const many = project.agents.length > 1
  const combined = projectState(project)
  // How many agents are in the status the badge shows (e.g. Working · 1 of 2 agents), not just running.
  const inStatus = combined ? project.agents.filter((a) => a.live?.status === combined.status).length : 0
  const running = project.agents.filter((a) => a.live)
  const dangerous = settings
    ? project.agents.flatMap((a) => {
        const l = agentLaunchSettings(a, project.config, settings)
        const m = modeOption(l.provider, a.live?.permissionMode ?? l.permissionMode)
        return m?.danger ? [`${many ? `${a.name}: ` : ''}${m.label}`] : []
      })
    : []
  const bypass = dangerous.length > 0

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
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="project-header" ref={headerRef}>
        <div className="flex">
          <h1>{project.name}</h1>
          <Tooltip
            content={
              <span style={{ whiteSpace: 'pre-line' }}>
                {project.agents.length ? project.agents.map((a) => `${a.name}: ${a.live ? statusText(a.live) : 'not running'}`).join('\n') : 'No agents yet'}
              </span>
            }
          >
            <span className={cx('badge', (combined?.status === 'working' || combined?.status === 'background') && 'accent', combined?.status === 'waiting' && 'warn', combined?.status === 'finished' && 'success')}>
              <span className={cx('dot', combined?.status ?? 'idle')} /> {combined ? STATUS_TEXT[combined.status] : 'No session'}
              {many && inStatus > 0 && (
                <span className="faint">
                  {' '}
                  · {inStatus} of {project.agents.length} agents
                </span>
              )}
            </span>
          </Tooltip>
        </div>
        <div className="actions">
          <Tooltip content={project.active ? 'You are working on this project' : 'Not working on this project'}>
            <label className="flex muted" style={{ cursor: 'pointer', marginRight: 6 }}>
              <Switch checked={project.active} onChange={(v) => void actions.setProjectActive(project.path, v)} /> Active
            </label>
          </Tooltip>
          <Tooltip content="Reveal the project folder in File Explorer">
            <button className="btn subtle" onClick={() => void call('project:openInExplorer', project.path)}>
              <Icon name="folder-opened" />
              {!narrow && " Explorer"}
            </button>
          </Tooltip>
          <Tooltip content="Open a terminal in the project folder">
            <button className="btn subtle" onClick={() => void call('project:openTerminal', project.path)}>
              <Icon name="terminal" />
              {!narrow && " Terminal"}
            </button>
          </Tooltip>
          {running.length > 0 && (
            <Tooltip content={running.length === 1 ? 'Stop the running agent' : `Stop all ${running.length} running agents`}>
              <button className="btn tint-red" onClick={() => void actions.stopAllAgents(project.path)}>
                <Icon name="stop-circle" /> {running.length === 1 ? 'Stop Agent' : narrow ? 'Stop All' : 'Stop All Agents'}
              </button>
            </Tooltip>
          )}
          <IconButton
            icon="ellipsis"
            title="More actions"
            onClick={(e) =>
              menu.open(e, [
                { label: 'Changes', icon: 'git-compare', onClick: () => setProjectTab(project.path, 'changes') },
                { label: 'Project Settings', icon: 'settings', onClick: () => setProjectTab(project.path, 'settings') },
                { separator: true },
                { label: 'Remove Project…', icon: 'trash', onClick: () => set({ removeProjectFor: project.path }) }
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
      <RemovedDataBanner project={project} />
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
        {TABS.map((t) => (
          <Tooltip key={t.id} content={tabTip(t.id, t.label)}>
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
          {tab === 'session' && panes.length === 1 && !live && <SessionEmpty project={project} framed={!!focusedAgent} />}
        </div>
        <ErrorBoundary label="This tab" resetKey={`${project.path}|${tab}`}>
          {tab === 'overview' && <OverviewTab project={project} />}
          {tab === 'tasks' && <ProjectTasksTab project={project} />}
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

