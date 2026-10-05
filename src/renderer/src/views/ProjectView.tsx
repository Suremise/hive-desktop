import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { agentLaunchSettings, isProviderEnabled, modeOption, providerName } from '@shared/providers'
import { agentsToResume } from '@shared/resumeAll'
import { PROJECT_TABS, tabCommand } from '@shared/projectTabs'
import hexUrl from '../assets/icon.svg'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { AddAgentButton, AgentStrip, PANE_FOOTER, PANE_HEADER, PaneChrome, RESUME_TINT, ResumeButton, TerminalLayer, usePanes, useWidth } from '../components/AgentPanes'
import { Icon, IconButton, STATUS_TEXT, statusText, Switch, Tooltip, useContextMenu } from '../components/ui'
import { agentProviderOf, projectKey, projectState, set, setProjectTab, useFocusedAgent, useStore, type ProjectTab } from '../store'
import { carriesFiles, cx, formatKeybinding } from '../util'
import { FilesTab, ImagesTab } from './FilesTab'
import { ChangesTab, MemoryTab, OverviewTab, ProjectMcpTab, ProjectSettingsTab, ProjectSkillsTab } from './ProjectTabs'
import { PerformanceTab } from './Performance'
import { SessionsTab } from './SessionsTab'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProjectTasksTab } from '../components/Board'
import { RemovedDataBanner } from '../components/ProjectRemoval'

// The tabs, in order: shared with the title bar's Project menu (#216).
const TABS = PROJECT_TABS

/** A tab's tooltip, with its shortcut (they can be changed, and Tasks has none by default). */
function tabTip(id: ProjectTab, label: string): string {
  const kb = commandKeybinding(tabCommand(id))
  return kb ? `${label} (${formatKeybinding(kb)})` : label
}

/** How the tab strip fits: every tab labelled; icons, with the active tab's label; or icons only, scrolling if even they don't. */
type TabFit = 'labels' | 'icons' | 'all-icons'
const TAB_FITS: TabFit[] = ['labels', 'icons', 'all-icons']
/** Room a roomier fit needs to spare before the strip goes back to it, so it doesn't flicker at the switching point. */
const TAB_FIT_SPARE = 12

/**
 * The project's tabs. When their labels don't fit, they shrink to icons, the active tab keeping its label while that fits;
 * narrower still, all are icons, and the strip scrolls with the active tab in view. Every tab's width with and without its
 * label is measured off screen (`.tabs-measure`), so the fit follows the strip's width (window, sidebar, panels) both ways
 * without trying each fit on screen. Icon-only tabs keep their label for screen readers and their name in the tooltip.
 */
function ProjectTabStrip({ project, tab, live }: { project: ProjectInfo; tab: ProjectTab; live: boolean }) {
  const [widthRef, width] = useWidth<HTMLDivElement>()
  const strip = useRef<HTMLDivElement | null>(null)
  const stripRef = useCallback(
    (el: HTMLDivElement | null) => {
      strip.current = el
      widthRef(el)
    },
    [widthRef]
  )
  const measureRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<{ labelled: number[]; icon: number[] } | null>(null)
  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    const measure = (): void => {
      const w = [...el.children].map((c) => c.getBoundingClientRect().width)
      // Nothing to measure while the project isn't shown: keep the last widths.
      if (w.every((x) => x === 0)) return
      setWidths({ labelled: w.filter((_, i) => i % 2 === 0), icon: w.filter((_, i) => i % 2 === 1) })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  const fitRef = useRef<TabFit>('labels')
  let fit = fitRef.current
  if (widths && width > 0) {
    const active = Math.max(0, TABS.findIndex((t) => t.id === tab))
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
    const need: Record<TabFit, number> = { labels: sum(widths.labelled), icons: sum(widths.icon) - widths.icon[active] + widths.labelled[active], 'all-icons': 0 }
    const now = TAB_FITS.indexOf(fitRef.current)
    fit = TAB_FITS.find((f, i) => Math.ceil(need[f]) + (i < now ? TAB_FIT_SPARE : 0) <= width) ?? 'all-icons'
  }
  fitRef.current = fit
  // The active tab stays in view when the strip has to scroll.
  useEffect(() => {
    const s = strip.current
    const a = activeRef.current
    if (!s || !a) return
    const sr = s.getBoundingClientRect()
    const ar = a.getBoundingClientRect()
    if (ar.left < sr.left) s.scrollLeft -= sr.left - ar.left
    else if (ar.right > sr.right) s.scrollLeft += ar.right - sr.right
  }, [fit, tab, width])
  return (
    <div className="tabs-row">
      <div className="tabs" ref={stripRef} data-fit={fit}>
        {TABS.map((t) => (
          <Tooltip key={t.id} content={tabTip(t.id, t.label)}>
            <div
              ref={tab === t.id ? activeRef : undefined}
              className={cx('tab', tab === t.id && 'active', (fit === 'all-icons' || (fit === 'icons' && tab !== t.id)) && 'icon-only')}
              onClick={() => setProjectTab(project.path, t.id)}
              // Dragging files over the Session tab switches to it, so they can be dropped on the terminal.
              onDragOver={t.id === 'session' ? (e) => carriesFiles(e.dataTransfer) && live && tab !== 'session' && setProjectTab(project.path, 'session') : undefined}
            >
              <Icon name={t.icon} /> <span className="tab-label">{t.label}</span>
            </div>
          </Tooltip>
        ))}
      </div>
      {/* Each tab labelled, then icon only, for measuring; the labels are CSS content, so no text here repeats a tab's. */}
      <div className="tabs-measure" ref={measureRef} aria-hidden>
        {TABS.flatMap((t) => [
          <div key={`${t.id}-label`} className="tab-m" data-label={t.label}>
            <Icon name={t.icon} />
          </div>,
          <div key={`${t.id}-icon`} className="tab-m icon-only">
            <Icon name={t.icon} />
          </div>
        ])}
      </div>
    </div>
  )
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
            {focused ? <ResumeButton project={project} a={focused} className={RESUME_TINT} label="Resume Last" /> : <AddAgentButton project={project} className="tint-amber" />}
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
  const runningActions = useStore((s) => s.running)
  const menu = useContextMenu()
  const project = workspace?.projects.find((p) => p.path === selected) ?? null
  const tab = (project && tabs[project.path]) || 'session'
  const terminalVisibleFor = visible && project && tab === 'session' ? project.path : null
  const panes = usePanes(project)
  const focusedAgent = useFocusedAgent(project)
  // A narrow header shows its buttons as icons: the batch actions first; tighter, Resume, Stop and Active too (and the
  // status says less); tighter still (both panels open beside the narrowest window), the batch actions move into ⋯. The
  // title gives way before any action does (#216).
  const [headerRef, headerWidth] = useWidth<HTMLDivElement>()
  const narrow = headerWidth > 0 && headerWidth < 860
  const tight = headerWidth > 0 && headerWidth < 640
  const cramped = headerWidth > 0 && headerWidth < 460

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
  const resumable = agentsToResume(project.agents)
  const resuming = !!runningActions[`resumeAll:${project.path}`]
  const startingAll = !!runningActions[`startNewAll:${project.path}`]
  const archivingAll = !!runningActions[`archiveAll:${project.path}`]
  // Some agent has a session to archive (running, or one it ran or would resume); the dialog lists exactly which.
  const archivable = project.agents.some((a) => a.live || a.lastSessionId || a.resume)
  // The batch actions, as buttons or (cramped) as ⋯ items.
  const startNew = project.agents.length
    ? { label: many ? 'Start New (All)' : 'Start New', tip: many ? `Start a fresh session for every agent (${project.agents.length}); running ones are stopped first` : 'Start a fresh session; a running one is stopped first', run: () => void actions.startNewAll(project.path) }
    : null
  const archiveNew = archivable
    ? { label: many ? 'Archive and Start New (All)' : 'Archive and Start New', tip: many ? "Archive every agent's current session and start fresh ones" : 'Archive the current session and start a fresh one', run: () => void actions.startNewAll(project.path, true) }
    : null
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
        <div className="flex project-title">
          <h1 title={project.name}>{project.name}</h1>
          <Tooltip
            content={
              <span style={{ whiteSpace: 'pre-line' }}>
                {project.agents.length ? project.agents.map((a) => `${a.name}: ${a.live ? statusText(a.live) : 'not running'}`).join('\n') : 'No agents yet'}
              </span>
            }
          >
            <span className={cx('badge', (combined?.status === 'working' || combined?.status === 'background') && 'accent', combined?.status === 'waiting' && 'warn', combined?.status === 'finished' && 'success')}>
              <span className={cx('dot', combined?.status ?? 'idle')} /> {combined ? STATUS_TEXT[combined.status] : 'No session'}
              {many && inStatus > 0 && !tight && (
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
            <label className="flex muted" style={{ cursor: 'pointer', marginRight: tight ? 0 : 6 }} aria-label={tight ? 'Active' : undefined}>
              <Switch checked={project.active} onChange={(v) => void actions.setProjectActive(project.path, v)} />
              {!tight && ' Active'}
            </label>
          </Tooltip>
          {resumable.length > 0 && (
            <Tooltip content={resumable.length === 1 ? `Resume ${resumable[0].name}'s last session` : `Resume all ${resumable.length} stopped agents (running ones are left alone)`}>
              <button className="btn tint-amber" disabled={resuming} aria-busy={resuming || undefined} aria-label={resumable.length === 1 ? 'Resume Agent' : 'Resume All Agents'} onClick={() => void actions.resumeAllAgents(project.path)}>
                <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} />
                {!tight && ` ${resuming ? 'Resuming…' : resumable.length === 1 ? 'Resume Agent' : narrow ? 'Resume All' : 'Resume All Agents'}`}
              </button>
            </Tooltip>
          )}
          {running.length > 0 && (
            <Tooltip content={running.length === 1 ? 'Stop the running agent' : `Stop all ${running.length} running agents`}>
              <button className="btn tint-red" aria-label={running.length === 1 ? 'Stop Agent' : 'Stop (All)'} onClick={() => void actions.stopAllAgents(project.path)}>
                <Icon name="stop-circle" />
                {!tight && ` ${running.length === 1 ? 'Stop Agent' : 'Stop (All)'}`}
              </button>
            </Tooltip>
          )}
          {/* Every agent at once, after one confirmation (#216): icons when narrow, in ⋯ when even those don't fit. */}
          {startNew && !cramped && (
            <Tooltip content={startNew.tip}>
              <button className="btn subtle" disabled={startingAll} aria-busy={startingAll || undefined} aria-label={startNew.label} onClick={startNew.run}>
                <Icon name={startingAll ? 'loading' : 'add'} spin={startingAll} />
                {!narrow && ` ${startNew.label}`}
              </button>
            </Tooltip>
          )}
          {archiveNew && !cramped && (
            <Tooltip content={archiveNew.tip}>
              <button className="btn subtle" disabled={archivingAll} aria-busy={archivingAll || undefined} aria-label={archiveNew.label} onClick={archiveNew.run}>
                <Icon name={archivingAll ? 'loading' : 'archive'} spin={archivingAll} />
                {!narrow && ` ${archiveNew.label}`}
              </button>
            </Tooltip>
          )}
          <IconButton
            icon="ellipsis"
            title="More actions"
            onClick={(e) =>
              menu.open(e, [
                ...(cramped
                  ? [
                      ...(startNew ? [{ label: startNew.label, icon: 'add', disabled: startingAll, onClick: startNew.run }] : []),
                      ...(archiveNew ? [{ label: archiveNew.label, icon: 'archive', disabled: archivingAll, onClick: archiveNew.run }] : []),
                      ...(startNew ? [{ separator: true as const }] : [])
                    ]
                  : []),
                { label: 'Explorer', icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
                { label: 'Terminal', icon: 'terminal', onClick: () => void call('project:openTerminal', project.path) },
                { separator: true },
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

      <ProjectTabStrip project={project} tab={tab} live={!!live} />

      <div className="tab-body">
        {tab === 'session' && <AgentStrip project={project} />}
        <div className={cx('agents-area', tab === 'session' ? 'shown' : 'hidden')}>
          <TerminalLayer visibleFor={terminalVisibleFor} panes={panes} />
          {tab === 'session' && <PaneChrome project={project} panes={panes} />}
          {tab === 'session' && panes.length === 1 && !live && <SessionEmpty project={project} framed={!!focusedAgent} />}
        </div>
        <ErrorBoundary label="This tab" resetKey={`${project.path}|${tab}`}>
          {tab === 'overview' && <OverviewTab project={project} />}
          {tab === 'performance' && <PerformanceTab project={project} />}
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

