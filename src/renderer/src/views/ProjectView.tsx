import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { agentLaunchSettings, defaultProviderWarning, isProviderEnabled, modeOption, providerName } from '@shared/providers'
import { agentsToResume, stalledOnSignIn } from '@shared/resumeAll'
import { archiveTarget, batchCounts } from '@shared/startAll'
import { PROJECT_TABS, tabCommand } from '@shared/projectTabs'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import hexUrl from '../assets/icon.svg'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { AddAgentButton, AgentStrip, PANE_FOOTER, PANE_HEADER, PaneChrome, RESUME_TINT, ResumeButton, TerminalLayer, usePanes, useWidth } from '../components/AgentPanes'
import { Icon, IconButton, STATUS_TEXT, Switch, Tooltip, useContextMenu, useFolds } from '../components/ui'
import { ProjectAgentsTable, useAgentsText } from '../components/AgentsTable'
import { agentProviderOf, projectKey, projectState, set, setProjectTab, useFocusedAgent, useLanguage, useStore, type ProjectTab } from '../store'
import { carriesFiles, cx, formatKeybinding } from '../util'
import { AttachmentsTab, FilesTab } from './FilesTab'
import { GitTab } from './GitTab'
import { MemoryTab, OverviewTab, ProjectMcpTab, ProjectSettingsTab, ProjectSkillsTab } from './ProjectTabs'
import { ProjectTemplatesTab } from '../components/Templates'
import { PerformanceTab } from './Performance'
import { SessionsTab } from './SessionsTab'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProjectTasksTab } from '../components/Board'
import { RemovedDataBanner } from '../components/ProjectRemoval'

// The tabs, in order: shared with the title bar's Project menu (#216).
const TABS = PROJECT_TABS

const M = {
  tabTip: msg({ id: 'project.tabs.tip', defaultMessage: '{tab} ({key})', description: "A project tab's tooltip with its keyboard shortcut. {tab} is the tab's name, {key} the shortcut, such as Alt+4." }),
  providerOff: msg({ id: 'project.empty.providerOff', defaultMessage: '{provider} is turned off — Settings → Providers', description: "Warning on the Session tab when the agent's provider is turned off. Settings → Providers: name it as Settings does." }),
  providerMissing: msg({ id: 'project.empty.providerMissing', defaultMessage: '{provider} is required — Help → Agent Setup', description: "Warning on the Session tab when the agent's CLI isn't installed. Help → Agent Setup is the menu item." }),
  sessionEnded: msg({ id: 'project.session.ended', defaultMessage: 'The session has ended. Resume it, or start a new one.', description: "Over an agent's terminal when its session has ended." }),
  resume: msg({ id: 'project.session.resume', defaultMessage: 'Resume', description: 'Button: resumes the last session.' }),
  newSession: msg({ id: 'project.session.new', defaultMessage: 'New Session', description: 'Button: starts a new session (adding an agent first when there is none).' }),
  noAgents: msg({ id: 'project.empty.noAgents', defaultMessage: 'No agents yet', description: 'Heading of the Session tab of a project with no agents, and the tooltip of its status badge.' }),
  notActive: msg({ id: 'project.empty.notActive', defaultMessage: '{project} is not active', description: 'Heading of the Session tab of a project not marked as one you are working on.' }),
  notRunning: msg({ id: 'project.empty.notRunning', defaultMessage: '{agent} is not running', description: "Heading of the Session tab when the focused agent (of several) has no session running. {agent} is its name." }),
  noSessionRunning: msg({ id: 'project.empty.noSession', defaultMessage: 'No session running', description: 'Heading of the Session tab when its one agent has no session running.' }),
  addAnAgent: msg({ id: 'project.empty.addAgent', defaultMessage: 'Add an agent to work on {project}: Add Agent adds a {provider} agent with its default settings (▾ to choose another provider, a worktree or settings). New Session adds one and starts it.', description: 'The Session tab of a project with no agents. Add Agent and New Session are its buttons; ▾ is the arrow beside Add Agent.' }),
  startOrResume: msg({ id: 'project.empty.startOrResume', defaultMessage: 'Start a new {provider} session, or resume a previous one. Sessions keep running when you switch to other projects.', description: 'The Session tab when its agent has no session running. {provider} is Claude Code, Codex…' }),
  markActive: msg({ id: 'project.empty.markActive', defaultMessage: 'Mark this project as one you are working on to run sessions and see its status. You can also start a session directly.', description: 'The Session tab of a project not marked as one you are working on.' }),
  resumeLast: msg({ id: 'project.empty.resumeLast', defaultMessage: 'Resume Last', description: "Button on the Session tab: resumes the agent's last session." }),
  allSessions: msg({ id: 'project.empty.allSessions', defaultMessage: 'All Sessions', description: 'Button on the Session tab: opens the Sessions tab.' }),
  markWorking: msg({ id: 'project.empty.markWorking', defaultMessage: 'Mark as working on', description: 'Button: marks the project as one you are working on.' }),
  selectProject: msg({ id: 'project.none.select', defaultMessage: 'Select a project from the sidebar.', description: 'Shown when the workspace has projects but none is selected.' }),
  createFirst: msg({ id: 'project.none.createFirst', defaultMessage: 'Create your first project to get started.', description: 'Shown when the workspace has no projects.' }),
  newProject: msg({ id: 'project.none.newProject', defaultMessage: 'New Project', description: 'Button: creates a project.' }),
  resumeAgent: msg({ id: 'project.header.resumeAgent', defaultMessage: 'Resume Agent', description: "The project header's button when one agent can be resumed." }),
  resumeAll: msg({ id: 'project.header.resumeAll', defaultMessage: 'Resume All Agents ({count})', description: "The project header's button: resumes every stopped agent. {count} is how many." }),
  resumeShort: msg({ id: 'project.header.resumeShort', defaultMessage: 'Resume ({count})', description: "The project header's Resume All Agents button when the header is narrow." }),
  resuming: msg({ id: 'project.header.resuming', defaultMessage: 'Resuming…', description: "The project header's Resume button while it runs." }),
  carryOn: msg({ id: 'project.header.carryOnTip', defaultMessage: 'Carry on {agent}: its turn stopped when its sign-in expired', description: 'Tooltip on Resume Agent when its turn stopped because the CLI sign-in expired.' }),
  resumeOne: msg({ id: 'project.header.resumeOneTip', defaultMessage: "Resume {agent}'s last session", description: 'Tooltip on Resume Agent.' }),
  carryOnMany: msg({ id: 'project.header.carryOnManyTip', defaultMessage: '{stopped, plural, =0 {Carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)} one {Resume the stopped agent and carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)} other {Resume the # stopped agents and carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)}}', description: 'Tooltip on Resume All Agents when some agents stopped because a sign-in expired. {stopped} is how many are stopped; {stalled} how many stopped mid-turn on a refused sign-in.' }),
  resumeMany: msg({ id: 'project.header.resumeManyTip', defaultMessage: 'Resume the {count} stopped agents (running ones are left alone)', description: 'Tooltip on Resume All Agents.' }),
  stopAgent: msg({ id: 'project.header.stopAgent', defaultMessage: 'Stop Agent', description: "The project header's button when one agent is running." }),
  stopMany: msg({ id: 'project.header.stopMany', defaultMessage: 'Stop ({count})', description: "The project header's button: stops every running agent. {count} is how many." }),
  stopTip: msg({ id: 'project.header.stopTip', defaultMessage: '{count, plural, one {Stop the running agent} other {Stop the # running agents}}', description: "Tooltip on the project header's Stop button." }),
  startNew: msg({ id: 'project.header.startNew', defaultMessage: '{many, select, yes {Start New ({count})} other {Start New}}', description: "The project header's button: starts a fresh session for each agent. {count} is how many (shown with several agents)." }),
  startNewTip: msg({ id: 'project.header.startNewTip', defaultMessage: '{many, select, yes {Start a fresh session for each of the {count} agents; running ones are stopped first} other {Start a fresh session; a running one is stopped first}}', description: 'Tooltip on Start New.' }),
  archiveNew: msg({ id: 'project.header.archiveNew', defaultMessage: '{many, select, yes {Archive and Start New ({count})} other {Archive and Start New}}', description: "The project header's button: archives each agent's session and starts a fresh one." }),
  archiveNewTip: msg({ id: 'project.header.archiveNewTip', defaultMessage: "{many, select, yes {{count, plural, one {Archive {agent}'s session and start a fresh one} other {Archive the sessions of the # agents that have one and start fresh ones}}} other {Archive the current session and start a fresh one}}", description: "Tooltip on Archive and Start New. {agent} is the one agent with a session to archive." }),
  removeAll: msg({ id: 'project.header.removeAll', defaultMessage: '{many, select, yes {Remove All ({count})} other {Remove Agent}}', description: "The project header's button: removes every agent (asks first)." }),
  removeAllMenu: msg({ id: 'project.header.removeAllMenu', defaultMessage: '{many, select, yes {Remove All ({count})…} other {Remove Agent…}}', description: "The same in the header's ⋯ menu (it asks first)." }),
  removeAllTip: msg({ id: 'project.header.removeAllTip', defaultMessage: '{many, select, yes {Remove the {count} agents (asks first; their sessions are kept)} other {Remove {agent} (asks first; its sessions are kept)}}', description: 'Tooltip on Remove All.' }),
  dangerousMode: msg({ id: 'project.banner.dangerousMode', defaultMessage: '{agent}: {mode}', description: 'One agent and its permission mode, in the banner about modes that run without asking.' }),
  agentsTip: msg({ id: 'project.header.noAgents', defaultMessage: 'No agents yet', description: "Tooltip on the project's status badge when it has no agents." }),
  noSession: msg({ id: 'project.header.noSession', defaultMessage: 'No session', description: "The project's status badge when no agent has a session." }),
  inStatus: msg({ id: 'project.header.inStatus', defaultMessage: '· {count} of {total} agents', description: 'After the status in the project\'s badge: how many of its agents are in it ("Working · 1 of 2 agents").' }),
  workingOn: msg({ id: 'project.header.workingOn', defaultMessage: 'You are working on this project', description: "Tooltip on the project header's Active switch, on." }),
  notWorkingOn: msg({ id: 'project.header.notWorkingOn', defaultMessage: 'Not working on this project', description: "Tooltip on the project header's Active switch, off." }),
  active: msg({ id: 'project.header.active', defaultMessage: 'Active', description: "Label of the project header's switch: you are working on this project." }),
  more: msg({ id: 'project.header.more', defaultMessage: 'More actions', description: "Tooltip on the project header's ⋯ button." }),
  explorer: msg({ id: 'project.menu.explorer', defaultMessage: 'Explorer', description: "The project header's ⋯ menu: opens the project folder in File Explorer." }),
  terminal: msg({ id: 'project.menu.terminal', defaultMessage: 'Terminal', description: "The project header's ⋯ menu: opens a terminal in the project folder." }),
  projectSettings: msg({ id: 'project.menu.settings', defaultMessage: 'Project Settings', description: "The project header's ⋯ menu." }),
  removeProject: msg({ id: 'project.menu.remove', defaultMessage: 'Remove Project…', description: "The project header's ⋯ menu: removes the project from the workspace (asks first)." }),
  restartNeeded: msg({ id: 'project.banner.restartNeeded', defaultMessage: "Skills, MCP servers or settings changed since {many, select, yes {{agent}'s} other {this}} session started. Restart the session to apply them — the conversation continues.", description: "Banner over a running session whose skills, MCP servers or settings changed. {agent} is the focused agent's name (when there are several)." }),
  restart: msg({ id: 'project.banner.restart', defaultMessage: 'Restart session', description: 'Button in that banner.' }),
  unmanagedMcp: msg({ id: 'project.banner.unmanagedMcp', defaultMessage: 'This project defines MCP servers that are not in the workspace: <b>{names}</b>. They stay disabled until copied to the workspace.', description: 'Banner of a project with MCP servers of its own. {names} is their names. <b> is bold.' }),
  copyToWorkspace: msg({ id: 'project.banner.copyToWorkspace', defaultMessage: 'Copy to workspace', description: "Button: copies the project's own MCP servers to the workspace." }),
  dangerous: msg({ id: 'project.banner.dangerous', defaultMessage: '{modes} {count, plural, one {is} other {are}} on in this project: the agent runs every command and edit without asking.', description: 'Banner when an agent of the project runs in a permission mode that never asks. {modes} names the modes (with the agents when there are several).' }),
  change: msg({ id: 'project.banner.change', defaultMessage: 'Change', description: 'Button in that banner: opens Project Settings.' }),
  thisTab: msg({ id: 'project.tabs.errorLabel', defaultMessage: 'This tab', description: 'What failed, in the message shown when a project tab crashes ("This tab hit a problem").' })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

/** A tab's tooltip, with its shortcut (they can be changed, and Tasks has none by default). */
function tabTip(id: ProjectTab, label: string): string {
  const kb = commandKeybinding(tabCommand(id))
  return kb ? tr(M.tabTip, { tab: label, key: formatKeybinding(kb) }) : label
}

/** How the tab strip fits: every tab labelled; icons, with the active tab's label; or icons only, scrolling if even they don't. */
type TabFit = 'labels' | 'icons' | 'all-icons'
const TAB_FITS: TabFit[] = ['labels', 'icons', 'all-icons']
/** Room a roomier fit needs to spare before the strip goes back to it, so it doesn't flicker at the switching point. */
const TAB_FIT_SPARE = 12

/** The least of the project's name the header keeps beside its status before its actions fold further (#886). */
const TITLE_MIN = 96
/** How far the header's actions can fold: every label; batch actions as icons; Resume, Stop and Active too; batch actions in ⋯. */
const HEADER_FOLDS = 3

/**
 * The width the project header's title (its least room) and actions (all of them, on one row) need side by side, for
 * `useFolds` (#886): 0 shows every label; 1 shows the batch actions as icons; 2 Resume, Stop and Active too (the status
 * says less, and Remove All moves into ⋯); 3 moves the other batch actions into ⋯ as well.
 */
function headerNeed(el: HTMLElement): number | null {
  const title = el.querySelector<HTMLElement>('.project-title')
  const name = title?.querySelector<HTMLElement>('h1')
  const badge = title?.querySelector<HTMLElement>('.badge')
  const buttons = el.querySelector<HTMLElement>(':scope > .actions')
  if (!title || !name || !badge || !buttons) return null
  const gap = (e: HTMLElement): number => parseFloat(getComputedStyle(e).columnGap) || 0
  // Each part's whole width, even while it is cut short (scrollWidth: the name and status are cut with "…").
  const items = [...buttons.children] as HTMLElement[]
  const actionsNeed = items.reduce((n, c) => n + c.scrollWidth, 0) + gap(buttons) * Math.max(0, items.length - 1)
  const status = badge.querySelector<HTMLElement>('.badge-text')
  const badgeNeed = badge.offsetWidth + (status ? status.scrollWidth - status.clientWidth : 0)
  const titleNeed = Math.min(name.scrollWidth, TITLE_MIN) + gap(title) + badgeNeed
  return Math.ceil(titleNeed + gap(el) + actionsNeed)
}

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
          <Tooltip key={t.id} content={tabTip(t.id, tr(t.label))}>
            <div
              ref={tab === t.id ? activeRef : undefined}
              className={cx('tab', tab === t.id && 'active', (fit === 'all-icons' || (fit === 'icons' && tab !== t.id)) && 'icon-only')}
              onClick={() => setProjectTab(project.path, t.id)}
              // Dragging files over the Session tab switches to it, so they can be dropped on the terminal.
              onDragOver={t.id === 'session' ? (e) => carriesFiles(e.dataTransfer) && live && tab !== 'session' && setProjectTab(project.path, 'session') : undefined}
            >
              <Icon name={t.icon} /> <span className="tab-label">{tr(t.label)}</span>
            </div>
          </Tooltip>
        ))}
      </div>
      {/* Each tab labelled, then icon only, for measuring; the labels are CSS content, so no text here repeats a tab's. */}
      <div className="tabs-measure" ref={measureRef} aria-hidden>
        {TABS.flatMap((t) => [
          <div key={`${t.id}-label`} className="tab-m" data-label={tr(t.label)}>
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
  // With no agent, the provider new agents get: Automatic's follows what's installed, so this re-renders with it.
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const provider = agentProviderOf(project, focused)
  const info = providers[provider]
  const on = isProviderEnabled(settings, provider)
  // An agent's own provider by name; with none, only what the project's default needs (#474).
  const warning = focused
    ? !on
      ? tr(M.providerOff, { provider: providerName(provider) })
      : info && !info.checking && !info.found
        ? tr(M.providerMissing, { provider: providerName(provider) })
        : null
    : defaultProviderWarning(project.config, settings, (id) => providers[id])?.text ?? null
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
          <span className="grow">{tr(M.sessionEnded)}</span>
          <button className="btn act-resume solid" onClick={() => void actions.resumeLast(project.path)}>
            <Icon name="debug-continue" /> {tr(M.resume)}
          </button>
          <button className="btn act-start" onClick={() => void actions.newSession(project.path)}>
            <Icon name="add" /> {tr(M.newSession)}
          </button>
        </>
      ) : (
        <div className="session-empty-card">
          <img src={hexUrl} className="hex-mark" alt="" />
          <h2>{!focused ? tr(M.noAgents) : !project.active ? tr(M.notActive, { project: project.name }) : many ? tr(M.notRunning, { agent: focused.name }) : tr(M.noSessionRunning)}</h2>
          <p>
            {!focused
              ? tr(M.addAnAgent, { project: project.name, provider: providerName(provider) })
              : project.active
                ? tr(M.startOrResume, { provider: providerName(provider) })
                : tr(M.markActive)}
          </p>
          {warning && (
            <p>
              <span className="badge warn" data-provider-warning="">
                <Icon name="warning" /> {warning}
              </span>
            </p>
          )}
          <div className="btns">
            <button className="btn act-start solid" onClick={() => void actions.newSession(project.path)}>
              <Icon name="add" /> {tr(M.newSession)} {newKey && <kbd style={{ marginLeft: 6 }}>{formatKeybinding(newKey)}</kbd>}
            </button>
            {focused ? <ResumeButton project={project} a={focused} className={RESUME_TINT} label={tr(M.resumeLast)} /> : <AddAgentButton project={project} className="tint-amber" />}
            <button className="btn subtle" onClick={() => setProjectTab(project.path, 'sessions')}>
              <Icon name="history" /> {tr(M.allSessions)}
            </button>
          </div>
          {!project.active && (
            <div className="btns">
              <button className="btn subtle small" onClick={() => void actions.setProjectActive(project.path, true)}>
                <Icon name="pass" /> {tr(M.markWorking)}
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
  // status says less), and Remove All, the rarest, moves into ⋯; tighter still (both panels open beside the narrowest
  // window), the other batch actions follow it. The title gives way to the actions down to its least room (#216, #291);
  // how far they fold is measured, so a longer language folds sooner (#886).
  const [headerWidthRef, headerWidth] = useWidth<HTMLDivElement>()
  const header = useRef<HTMLDivElement | null>(null)
  const headerRef = useCallback(
    (el: HTMLDivElement | null) => {
      header.current = el
      headerWidthRef(el)
    },
    [headerWidthRef]
  )
  const language = useLanguage()
  const headerContent = project
    ? [language, project.name, project.agents.map((a) => `${a.live?.status ?? '-'}`).join(), ...['resumeAll', 'startNewAll', 'archiveAll', 'removeAll'].map((k) => !!runningActions[`${k}:${project.path}`])].join('|')
    : ''
  const folds = useFolds(header, headerWidth, headerContent, HEADER_FOLDS, headerNeed)
  const narrow = folds >= 1
  const tight = folds >= 2
  const cramped = folds >= 3
  // The status badge's table as text, for its accessible description (#529).
  const agentsDescription = useAgentsText(project)

  if (!workspace) return null

  if (!project) {
    return (
      <div className="tab-body" style={{ display: visible ? undefined : 'none' }}>
        <TerminalLayer visibleFor={null} panes={[]} />
        <div className="empty-state" style={{ paddingTop: '20vh' }}>
          <Icon name="files" />
          {tr(workspace.projects.length ? M.selectProject : M.createFirst)}
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => void actions.createProject()}>
              <Icon name="new-folder" /> {tr(M.newProject)}
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
  const removingAll = !!runningActions[`removeAll:${project.path}`]
  // How many agents each batch action acts on, as its confirmation lists them (#275): shown in its label, or beside its
  // icon when narrow.
  const counts = batchCounts(project.agents)
  const resumeLabel = resumable.length === 1 ? tr(M.resumeAgent) : tr(M.resumeAll, { count: resumable.length })
  // Running agents a refused sign-in stopped are carried on, the stopped ones resumed (#309).
  const stalled = resumable.filter((a) => stalledOnSignIn(a.live)).length
  const stoppedCount = resumable.length - stalled
  const resumeTip =
    resumable.length === 1
      ? tr(stalled ? M.carryOn : M.resumeOne, { agent: resumable[0].name })
      : stalled
        ? tr(M.carryOnMany, { stopped: stoppedCount, stalled })
        : tr(M.resumeMany, { count: resumable.length })
  const stopLabel = running.length === 1 ? tr(M.stopAgent) : tr(M.stopMany, { count: running.length })
  const yes = many ? 'yes' : 'no'
  // The batch actions, as buttons or (cramped) as ⋯ items; with one agent, no count.
  const startNew = counts.startNew
    ? { label: tr(M.startNew, { many: yes, count: counts.startNew }), count: many ? counts.startNew : null, tip: tr(M.startNewTip, { many: yes, count: counts.startNew }), run: () => void actions.startNewAll(project.path) }
    : null
  const archiveNew = counts.archive
    ? {
        label: tr(M.archiveNew, { many: yes, count: counts.archive }),
        count: many ? counts.archive : null,
        tip: tr(M.archiveNewTip, { many: yes, count: counts.archive, agent: project.agents.find((a) => archiveTarget(a))?.name ?? '' }),
        run: () => void actions.startNewAll(project.path, true)
      }
    : null
  // Remove All (#291): every agent, after one question.
  const removeAll = project.agents.length
    ? {
        label: tr(M.removeAll, { many: yes, count: project.agents.length }),
        menuLabel: tr(M.removeAllMenu, { many: yes, count: project.agents.length }),
        count: many ? project.agents.length : null,
        tip: tr(M.removeAllTip, { many: yes, count: project.agents.length, agent: project.agents[0].name }),
        run: () => void actions.removeAllAgents(project.path)
      }
    : null
  const dangerous = settings
    ? project.agents.flatMap((a) => {
        const l = agentLaunchSettings(a, project.config, settings)
        const m = modeOption(l.provider, a.live?.permissionMode ?? l.permissionMode)
        return m?.danger ? [many ? tr(M.dangerousMode, { agent: a.name, mode: m.label }) : m.label] : []
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
            content={project.agents.length ? <ProjectAgentsTable project={project} /> : tr(M.agentsTip)}
            className={project.agents.length ? 'agents-tip' : undefined}
            focus
          >
            <span tabIndex={0} aria-description={agentsDescription || undefined} className={cx('badge', (combined?.status === 'working' || combined?.status === 'background') && 'accent', combined?.status === 'waiting' && 'warn', combined?.status === 'signin' && 'signin', combined?.status === 'finished' && 'success')}>
              <span className={cx('dot', combined?.status ?? 'idle')} />
              <span className="badge-text">
                {combined ? STATUS_TEXT[combined.status] : tr(M.noSession)}
                {many && inStatus > 0 && !tight && <span className="faint"> {tr(M.inStatus, { count: inStatus, total: project.agents.length })}</span>}
              </span>
            </span>
          </Tooltip>
        </div>
        <div className="actions">
          <Tooltip content={tr(project.active ? M.workingOn : M.notWorkingOn)}>
            <label className="flex muted" style={{ cursor: 'pointer', marginRight: tight ? 0 : 6 }} aria-label={tight ? tr(M.active) : undefined}>
              <Switch checked={project.active} onChange={(v) => void actions.setProjectActive(project.path, v)} />
              {!tight && ` ${tr(M.active)}`}
            </label>
          </Tooltip>
          {resumable.length > 0 && (
            <Tooltip content={resumeTip}>
              <button className="btn act-resume" disabled={resuming} aria-busy={resuming || undefined} aria-label={resumeLabel} onClick={() => void actions.resumeAllAgents(project.path)}>
                <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} />
                {!tight && ` ${resuming ? tr(M.resuming) : resumable.length === 1 ? tr(M.resumeAgent) : narrow ? tr(M.resumeShort, { count: resumable.length }) : resumeLabel}`}
                {tight && resumable.length > 1 && <span className="btn-count">{resumable.length}</span>}
              </button>
            </Tooltip>
          )}
          {running.length > 0 && (
            <Tooltip content={tr(M.stopTip, { count: running.length })}>
              <button className="btn act-stop" aria-label={stopLabel} onClick={() => void actions.stopAllAgents(project.path)}>
                <Icon name="stop-circle" />
                {!tight && ` ${stopLabel}`}
                {tight && running.length > 1 && <span className="btn-count">{running.length}</span>}
              </button>
            </Tooltip>
          )}
          {/* Every agent at once, after one confirmation (#216): icons (and their counts) when narrow, in ⋯ when even those don't fit. */}
          {startNew && !cramped && (
            <Tooltip content={startNew.tip}>
              <button className="btn act-start" disabled={startingAll} aria-busy={startingAll || undefined} aria-label={startNew.label} onClick={startNew.run}>
                <Icon name={startingAll ? 'loading' : 'add'} spin={startingAll} />
                {!narrow && ` ${startNew.label}`}
                {narrow && startNew.count && <span className="btn-count">{startNew.count}</span>}
              </button>
            </Tooltip>
          )}
          {archiveNew && !cramped && (
            <Tooltip content={archiveNew.tip}>
              <button className="btn act-archive-start" disabled={archivingAll} aria-busy={archivingAll || undefined} aria-label={archiveNew.label} onClick={archiveNew.run}>
                <Icon name={archivingAll ? 'loading' : 'archive'} spin={archivingAll} />
                {!narrow && ` ${archiveNew.label}`}
                {narrow && archiveNew.count && <span className="btn-count">{archiveNew.count}</span>}
              </button>
            </Tooltip>
          )}
          {removeAll && !tight && (
            <Tooltip content={removeAll.tip}>
              <button className="btn act-remove" disabled={removingAll} aria-busy={removingAll || undefined} aria-label={removeAll.label} onClick={removeAll.run}>
                <Icon name={removingAll ? 'loading' : 'trash'} spin={removingAll} />
                {!narrow && ` ${removeAll.label}`}
                {narrow && removeAll.count && <span className="btn-count">{removeAll.count}</span>}
              </button>
            </Tooltip>
          )}
          <IconButton
            icon="ellipsis"
            title={tr(M.more)}
            action="project-menu"
            onClick={(e) =>
              menu.open(e, [
                ...(cramped && startNew ? [{ label: startNew.label, icon: 'add', action: 'start' as const, disabled: startingAll, onClick: startNew.run }] : []),
                ...(cramped && archiveNew ? [{ label: archiveNew.label, icon: 'archive', action: 'archive-start' as const, disabled: archivingAll, onClick: archiveNew.run }] : []),
                ...(tight && removeAll ? [{ label: removeAll.menuLabel, icon: 'trash', action: 'remove' as const, disabled: removingAll, onClick: removeAll.run }] : []),
                ...((cramped && startNew) || (tight && removeAll) ? [{ separator: true as const }] : []),
                { label: tr(M.explorer), icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
                { label: tr(M.terminal), icon: 'terminal', onClick: () => void call('project:openTerminal', project.path) },
                { separator: true },
                { label: tr(M.projectSettings), icon: 'settings', onClick: () => setProjectTab(project.path, 'settings') },
                { separator: true },
                { label: tr(M.removeProject), icon: 'trash', onClick: () => set({ removeProjectFor: project.path }) }
              ])
            }
          />
        </div>
      </div>

      {focusedAgent?.restartNeeded && live && (
        <div className="banner warn">
          <Icon name="refresh" /> {tr(M.restartNeeded, { many: yes, agent: focusedAgent.name })}
          <button className="btn small primary" onClick={() => void restart()}>
            {tr(M.restart)}
          </button>
        </div>
      )}
      <RemovedDataBanner project={project} />
      {project.unmanagedMcp.length > 0 && (
        <div className="banner warn">
          <Icon name="plug" /> {Children.toArray(tRich<React.ReactNode>(M.unmanagedMcp, { names: fmt.list(project.unmanagedMcp, 'unit'), b: bold }))}
          <button className="btn small" onClick={() => void actions.importProjectMcp(project.path, project.unmanagedMcp)}>
            {tr(M.copyToWorkspace)}
          </button>
        </div>
      )}
      {bypass && (
        <div className="banner danger">
          <Icon name="warning" /> {tr(M.dangerous, { modes: fmt.list(dangerous, 'unit'), count: dangerous.length })}
          <button className="btn small" onClick={() => setProjectTab(project.path, 'settings')}>
            {tr(M.change)}
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
        <ErrorBoundary label={tr(M.thisTab)} resetKey={`${project.path}|${tab}`}>
          {tab === 'overview' && <OverviewTab project={project} />}
          {tab === 'performance' && <PerformanceTab project={project} />}
          {tab === 'tasks' && <ProjectTasksTab project={project} />}
          {tab === 'sessions' && <SessionsTab project={project} />}
          {tab === 'files' && <FilesTab project={project} />}
          {tab === 'images' && <AttachmentsTab project={project} />}
          {tab === 'changes' && <GitTab project={project} />}
          {tab === 'memory' && <MemoryTab project={project} />}
          {tab === 'skills' && <ProjectSkillsTab project={project} />}
          {tab === 'templates' && <ProjectTemplatesTab project={project} />}
          {tab === 'mcp' && <ProjectMcpTab project={project} />}
          {tab === 'settings' && <ProjectSettingsTab project={project} />}
        </ErrorBoundary>
      </div>
      {menu.element}
    </div>
  )
}

