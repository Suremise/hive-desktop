import { DEFAULT_PERF_FILTERS, type PerfFilters } from '@shared/metricsView'
import { create } from 'zustand'
import type { Period } from '@shared/usageTotals'
import type { StartFailure } from '@shared/startFailure'
import { EMPTY_TIPS_STATE, type TipsState } from '@shared/tips'
import { agentPtyKey, layoutPanes, mostUrgent, pageAgents, pageLayout, pageOfAgent } from '@shared/defaults'
import { agentProvider } from '@shared/providers'
import { setDateStyle } from '@shared/dates'
import type { ProjectTab } from '@shared/projectTabs'
import type { AgentBranchStatus, AssistantPanelSide, QuitScope, TaskCard, UpdateState, WorkspaceUsage } from '@shared/types'
import type {
  AgentApiInfo,
  AgentInfo,
  AssistantAction,
  AssistantQuestion,
  ProgressRun,
  AgentInstallInfo,
  ProviderId,
  AppInfo,
  AppSettings,
  LiveSessionState,
  PlanUsage,
  ProjectInfo,
  QuitSession,
  ToastMessage,
  Notice,
  WorkspaceInfo
} from '@shared/types'

export type Activity = 'projects' | 'overview' | 'performance' | 'board' | 'notes' | 'skills' | 'mcp' | 'assistant' | 'docs' | 'settings'
export type { ProjectTab } from '@shared/projectTabs'

export interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** The action, run with the dialog open (a spinner, no closing) until it's done: a failure stays in the dialog. */
  run?: () => Promise<unknown>
  /** The confirm button's label while `run` runs ("Deleting…"). */
  busyLabel?: string
  resolve: (ok: boolean) => void
}

export interface PromptRequest {
  kind: 'prompt'
  title: string
  message?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
  /** A tick box under the field; `set` gets the user's choice before the dialog resolves. */
  check?: { label: string; initial: boolean; set: (checked: boolean) => void }
  resolve: (value: string | null) => void
}

/** A question with several answers (buttons); Esc or × cancels (null). */
export interface ChoiceRequest {
  kind: 'choice'
  title: string
  message: string
  detail?: string
  danger?: boolean
  /** Buttons left to right; the last is the default. */
  choices: { label: string; value: string }[]
  resolve: (value: string | null) => void
}

export type DialogRequest = ConfirmRequest | PromptRequest | ChoiceRequest

/**
 * A card the user moves into Doing (a drag, Move to, or the card dialog's Column): the Move to Doing dialog asks
 * whether nobody has it, an agent, or an agent that starts on it, and makes the change. project and agent: as the
 * user has them (the card dialog's unsaved fields). before: where a drag dropped it. prepare: saves the card dialog's
 * other edits first, once the user has chosen; done: after the change.
 */
export interface DoingRequest {
  n: number
  project: string
  agent: string | null
  before?: number | null
  prepare?: () => Promise<void>
  done?: () => void
}

interface State {
  settings: AppSettings | null
  workspace: WorkspaceInfo | null
  recent: string[]
  /** Each provider's installed CLI (install state, version, sign-in, readiness). */
  providers: Record<ProviderId, AgentInstallInfo>
  /** Subscription limits each provider last reported (account-wide), by provider. */
  planUsage: Record<ProviderId, PlanUsage>
  /** Worktree agents' unmerged work, by projectKey (null: git couldn't check it). */
  branchStatus: Record<string, AgentBranchStatus | null>
  /** Agents whose CLI exited before its session started, by projectKey: why, until the next launch or ✕. */
  startFailures: Record<string, StartFailure>
  /** What the tips know (saved in the profile), the tip in the card, and whether Help → Tips… is open. */
  tips: TipsState
  tipShown: string | null
  tipsOpen: boolean
  api: AgentApiInfo | null
  appInfo: AppInfo | null

  activity: Activity
  lastSideActivity: Exclude<Activity, 'docs' | 'settings'>
  sidebarVisible: boolean
  sidebarWidth: number
  /** Projects sidebar collapsed to a rail of status dots. */
  sidebarCompact: boolean
  /** Set to select a session in its project's Sessions tab. */
  /** Open the Sessions tab on a session, and in it at its nth compaction (from 0, oldest first) when given. */
  sessionsJump: { project: string; id: string; nonce: number; compaction?: number } | null
  /** A file to show in a project's Files tab (a terminal's file link): whose folder (`root`, a worktree agent's id or ''), the file and the line. */
  filesJump: { project: string; root: string; rel: string; line?: number; col?: number; nonce: number } | null
  /** Resizable pane sizes, saved with the window layout. */
  panes: Record<string, number>
  selectedProject: string | null
  projectTabs: Record<string, ProjectTab>
  selectedNote: string | null
  selectedSkill: string | null
  /** A Hive skill to open for editing (not preview) when the Skills view shows it: from a project's Edit in workspace. */
  skillEdit: string | null
  selectedMcp: string | null
  /** The persona open in the Personas view (its file). */
  selectedPersona: string | null
  /** What the Assistant view's main area shows: its conversations or the selected persona. */
  assistantSection: 'conversations' | 'personas'
  /** The Hive Assistant's panel is shown (per workspace, saved in the pane sizes as assistant-open:<path>). */
  assistantOpen: boolean
  /** This window's workspace's progress runs (newest first), for the Progress panel. */
  progressRuns: ProgressRun[]
  /** A pane (an agent's, or the Assistant's panel) briefly highlighted because something asked to show it: its pty key. */
  paneFlash: { key: string; at: number } | null
  /** Assistant Settings is open. */
  assistantSettingsOpen: boolean
  /** What the Hive Assistant did in this window's workspace (oldest first), and what it is asking the user. */
  assistantActions: AssistantAction[]
  assistantQuestions: AssistantQuestion[]
  /** Agents the Assistant added that the user hasn't looked at yet, by project path (their page's button shows a dot). */
  newAgents: Record<string, string[]>
  personasVersion: number
  docsPage: string
  /** A heading of the shown doc to scroll to (Learn more on a tip), cleared once there. */
  docsAnchor: string | null
  settingsSection: string
  settingsQuery: string

  toasts: ToastMessage[]
  /** In-app banners showing in this window (components/NoticeBanners.tsx), the newest first. */
  notices: Notice[]
  notifications: ToastMessage[]
  unread: number
  showNotifications: boolean
  /** The status bar's attention inbox popover. */
  inboxOpen: boolean
  paletteOpen: boolean
  /** What the palette lists: every command and project, or projects only (Go to Project). */
  paletteMode: 'commands' | 'projects'
  /** The permission mode menu, open for an agent at a point. */
  modeMenu: { project: string; agentId: string; x: number; y: number; above?: number } | null
  /** A shortcut is being recorded in the keyboard shortcuts editor: app shortcuts are paused. */
  recordingKeys: boolean
  aboutOpen: boolean
  /** Help → Copy Diagnostics: the preview dialog. */
  diagnosticsOpen: boolean
  /** Hive's own update state, and whether its dialog is open. */
  update: UpdateState | null
  updateOpen: boolean
  /** The Agent Setup dialog, open at a provider (or at the first one). */
  setupOpen: ProviderId | true | false
  shortcutsOpen: boolean
  dialog: DialogRequest | null
  /** Sessions listed in the quit dialog while main waits for a decision. */
  quitRequest: QuitSession[] | null
  /** Files with unsaved edits listed in the quit dialog (absolute paths). */
  quitUnsaved: string[]
  /** 'window': the dialog is for closing this window (its workspace's sessions), not quitting Hive. */
  quitScope: QuitScope
  /** Hive will quit once no agent is working. */
  quitPending: { working: number } | null
  /** How many Hive windows are open (File → Exit closes them all). */
  windowCount: number
  /** Working agents keeping the PC awake (0: none). */
  keepAwake: number
  /** The agent whose Compact dialog is open. */
  compactFor: AgentRef | null
  /** Project whose Add Agent dialog is open. */
  addAgentFor: string | null
  /** Agent whose settings dialog (name, model, effort, permission mode) is open. */
  agentSettingsFor: AgentRef | null
  /** Worktree agent whose Merge dialog is open. */
  mergeFor: AgentRef | null
  /** The agent whose work "Hand Over to…" hands to another agent. */
  handOverFor: AgentRef | null
  /** Shows this agent's session in its project's Overview and scrolls to it (the footer's context count); `at` makes each click count. */
  overviewJump: (AgentRef & { at: number }) | null
  /** Opens Project Settings on this section (Settings → Workspace's Storage links); `at` makes each click count. */
  projectSettingsJump: { project: string; section: string; at: number } | null
  /** Per project: the agent that session commands (header buttons, shortcuts, Insert into Session) act on. */
  focusedAgent: Record<string, string>
  /** Per project: which agent each pane of a multi-pane layout shows. */
  paneAgents: Record<string, string[]>
  /** An agent being dragged (its strip tab or pane header) to move it in its project's order. */
  agentDrag: { project: string; id: string } | null
  /** Actions without a dialog that are running (runOnce): their buttons show a spinner and ignore clicks. */
  running: Record<string, true>
  /** Per project and agent page ("<path>#<page>"): the agent last focused there, focused again on going back. */
  pageFocus: Record<string, string>
  /** Per project: whose folder the Changes and Files tabs show (a worktree agent's id; anything else = the project folder). */
  changesRoot: Record<string, string>
  filesRoot: Record<string, string>

  /** The workspace's task board (archived cards too), and the board view's filters. */
  tasks: TaskCard[]
  /**
   * The Performance view's filters (activity bar: the workspace, a project filter) and each project's Performance tab's
   * (fixed to that project), kept while you move around.
   */
  perfWorkspace: PerfFilters
  perfProjects: Record<string, PerfFilters>
  /** The Workspace Overview's period, and the workspace's usage it last loaded (with when). */
  overviewPeriod: Period
  workspaceUsage: WorkspaceUsage | null
  workspaceUsageAt: number
  /** Why its last load failed (for that workspace), shown with Retry in place of, or over, the last figures. */
  workspaceUsageError: { workspacePath: string; error: string } | null
  /** The Board view's filter: a project's folder name, '' for workspace cards, null for all. */
  boardProject: string | null
  boardQuery: string
  boardArchived: boolean
  /** The card open in the card dialog, or a new card (with the project it's for). */
  taskOpen: number | { project: string } | null
  /** The card whose Start dialog is open. */
  taskStartFor: number | null
  /** A card being moved to Doing: the Move to Doing dialog asks who has it. */
  taskDoing: DoingRequest | null
  /** The project whose Remove Project dialog is open. */
  removeProjectFor: string | null

  windowFocused: boolean
  maximized: boolean
  /** This window is Always on Top (pin.ts in main). */
  alwaysOnTop: boolean
  notesVersion: number
  skillsVersion: number
  usageVersion: Record<string, number>
  /** Incremented per agent terminal (pty key) whenever a new session starts, so its terminal is recreated. */
  sessionEpoch: Record<string, number>
}

export const useStore = create<State>(() => ({
  settings: null,
  workspace: null,
  recent: [],
  providers: {},
  planUsage: {},
  branchStatus: {},
  startFailures: {},
  tips: EMPTY_TIPS_STATE,
  tipShown: null,
  tipsOpen: false,
  api: null,
  appInfo: null,

  activity: 'projects',
  lastSideActivity: 'projects',
  sidebarVisible: true,
  sidebarWidth: 280,
  sidebarCompact: false,
  sessionsJump: null,
  filesJump: null,
  panes: {},
  selectedProject: null,
  projectTabs: {},
  selectedNote: null,
  selectedSkill: null,
  skillEdit: null,
  selectedMcp: null,
  selectedPersona: null,
  assistantSection: 'conversations',
  assistantOpen: false,
  progressRuns: [],
  paneFlash: null,
  assistantSettingsOpen: false,
  assistantActions: [],
  assistantQuestions: [],
  newAgents: {},
  personasVersion: 0,
  docsPage: 'guide',
  docsAnchor: null,
  settingsSection: 'general',
  settingsQuery: '',

  toasts: [],
  notices: [],
  notifications: [],
  unread: 0,
  showNotifications: false,
  inboxOpen: false,
  paletteOpen: false,
  paletteMode: 'commands',
  modeMenu: null,
  recordingKeys: false,
  aboutOpen: false,
  diagnosticsOpen: false,
  update: null,
  updateOpen: false,
  setupOpen: false,
  shortcutsOpen: false,
  dialog: null,
  quitRequest: null,
  quitUnsaved: [],
  quitScope: 'app',
  quitPending: null,
  windowCount: 1,
  keepAwake: 0,
  compactFor: null,
  addAgentFor: null,
  agentSettingsFor: null,
  mergeFor: null,
  handOverFor: null,
  overviewJump: null,
  projectSettingsJump: null,
  focusedAgent: {},
  paneAgents: {},
  agentDrag: null,
  running: {},
  pageFocus: {},
  changesRoot: {},
  filesRoot: {},

  tasks: [],
  perfWorkspace: DEFAULT_PERF_FILTERS,
  perfProjects: {},
  overviewPeriod: 'week',
  workspaceUsage: null,
  workspaceUsageAt: 0,
  workspaceUsageError: null,
  boardProject: null,
  boardQuery: '',
  boardArchived: false,
  taskOpen: null,
  taskStartFor: null,
  taskDoing: null,
  removeProjectFor: null,

  windowFocused: true,
  maximized: false,
  alwaysOnTop: false,
  notesVersion: 0,
  skillsVersion: 0,
  usageVersion: {},
  sessionEpoch: {}
}))

export const set = useStore.setState
export const get = useStore.getState

// Dates follow Settings → General. Subscribed before any component, so the formatters have the new choice by the
// time anything renders with the new settings (components that show dates read the choice with useDateStyle()).
useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) setDateStyle({ date: s.settings?.general.dateFormat, time: s.settings?.general.timeFormat })
})

/** The user's date and time format, for a component that shows dates: it renders again when they change. */
export function useDateStyle(): string {
  return useStore((s) => `${s.settings?.general.dateFormat}/${s.settings?.general.timeFormat}`)
}

export interface AgentRef {
  project: string
  agentId: string
}

/** Terminal key of an agent's session. */
/** Forgets an agent's failed start (✕, or a new launch). */
export function clearStartFailure(path: string, agentId: string): void {
  const key = projectKey(path, agentId)
  if (!(key in get().startFailures)) return
  set((s) => {
    const { [key]: _gone, ...rest } = s.startFailures
    return { startFailures: rest }
  })
}

/** Whether an agent's pane is shown in this window, focused or not (agentsOnScreen counts a focused window only). */
export function agentOnScreen(path: string, agentId: string): boolean {
  return !!agentsOnScreen({ ...get(), windowFocused: true }).get(path)?.includes(agentId)
}

export function projectKey(path: string, agentId: string): string {
  return agentPtyKey(path, agentId)
}

/** The agent session commands act on in this project: the focused one, else the first; null with no agents. */
export function focusedAgentId(p: ProjectInfo | null | undefined): string | null {
  if (!p) return null
  const id = get().focusedAgent[p.path]
  return id && p.agents.some((a) => a.id === id) ? id : (p.agents[0]?.id ?? null)
}

export function agentOf(p: ProjectInfo | null | undefined, agentId: string): AgentInfo | null {
  return p?.agents.find((a) => a.id === agentId) ?? null
}

/** The focused agent, re-rendering when focus changes. */
export function useFocusedAgent(p: ProjectInfo | null | undefined): AgentInfo | null {
  const id = useStore((s) => (p ? s.focusedAgent[p.path] : undefined))
  if (!p) return null
  return p.agents.find((a) => a.id === id) ?? p.agents[0] ?? null
}

/** The provider an agent runs (its own, else the project's default, else the global default). */
export function agentProviderOf(p: ProjectInfo | null | undefined, a: Pick<AgentInfo, 'provider' | 'live'> | null | undefined): ProviderId {
  return a?.live?.provider || agentProvider(a, p?.config, get().settings)
}

/** The combined state shown by a project's single status dot: its most urgent agent. */
export function projectState(p: ProjectInfo | null | undefined) {
  return p ? mostUrgent(p.agents.map((a) => a.live)) : null
}

export function focusAgent(path: string, agentId: string): void {
  set((s) => {
    const i = findProject(s, path)?.agents.findIndex((a) => a.id === agentId) ?? -1
    return { focusedAgent: { ...s.focusedAgent, [path]: agentId }, ...(i >= 0 ? { pageFocus: { ...s.pageFocus, [`${path}#${pageOfAgent(i)}`]: agentId } } : {}) }
  })
}

/** The agent page a project shows: the focused agent's (pages hold six agents each). */
export function agentPage(p: ProjectInfo, focused: string | null): number {
  const i = p.agents.findIndex((a) => a.id === focused)
  return i < 0 ? 0 : pageOfAgent(i)
}

/**
 * Which agent each pane shows, on the focused agent's page. One pane shows the focused agent; with more,
 * the panes keep the agents placed in them and fill up in agent order. Null is an empty pane.
 */
export function paneAssignment(p: ProjectInfo, focused: string | null, stored: string[] | undefined): (string | null)[] {
  const page = agentPage(p, focused)
  const n = layoutPanes(pageLayout(p.config, page))
  if (n === 1) return [focused]
  const ids = pageAgents(p.agents, page).map((a) => a.id)
  const out: string[] = []
  for (const id of stored ?? []) if (ids.includes(id) && !out.includes(id) && out.length < n) out.push(id)
  for (const id of ids) if (out.length < n && !out.includes(id)) out.push(id)
  return [...out, ...Array<null>(n - out.length).fill(null)]
}

/**
 * The agents the user can see now, by project path: the selected project's panes on its Session tab, and the
 * Assistant's while its panel is open. None while the window isn't focused.
 */
export function agentsOnScreen(s: State = get()): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!s.windowFocused || !s.workspace) return out
  const p = s.activity === 'projects' ? s.workspace.projects.find((x) => x.path === s.selectedProject) : undefined
  if (p && (s.projectTabs[p.path] ?? 'session') === 'session') {
    const focused = s.focusedAgent[p.path]
    const shown = paneAssignment(p, focused && p.agents.some((a) => a.id === focused) ? focused : (p.agents[0]?.id ?? null), s.paneAgents[p.path])
    out.set(p.path, shown.filter((id): id is string => !!id))
  }
  const a = s.workspace.assistant
  if (a && s.assistantOpen) out.set(a.path, a.agents.map((x) => x.id))
  return out
}

/**
 * Shows an agent: focuses its pane, or puts it in the focused agent's pane when it isn't on screen. An agent
 * on another page goes to that page.
 */
export function showAgent(p: ProjectInfo, agentId: string): void {
  const s = get()
  const focused = focusedAgentId(p)
  const panes = paneAssignment(p, focused, s.paneAgents[p.path])
  if (agentPage(p, agentId) === agentPage(p, focused) && panes.length > 1 && !panes.includes(agentId)) {
    const i = Math.max(0, panes.indexOf(focused))
    const next = panes.map((id, j) => (j === i ? agentId : id)).filter((id): id is string => !!id)
    set({ paneAgents: { ...s.paneAgents, [p.path]: next } })
  }
  focusAgent(p.path, agentId)
}

/**
 * Before an agent is removed: if it has focus, focus the agent that takes its place (the next), else the one
 * before it, so the view stays on its page unless that page empties. `p` is the project before the removal.
 */
export function focusAfterRemoving(p: ProjectInfo, agentId: string): void {
  if (focusedAgentId(p) !== agentId) return
  const i = p.agents.findIndex((a) => a.id === agentId)
  const next = p.agents[i + 1] ?? p.agents[i - 1]
  if (next) set((s) => ({ focusedAgent: { ...s.focusedAgent, [p.path]: next.id } }))
}

/** Goes to one of a project's agent pages, focusing the agent last focused there (else its first). */
export function showPage(p: ProjectInfo, page: number): void {
  const ids = pageAgents(p.agents, page).map((a) => a.id)
  if (!ids.length) return
  const last = get().pageFocus[`${p.path}#${page}`]
  focusAgent(p.path, last && ids.includes(last) ? last : ids[0])
}

/** A project, or the Hive Assistant (a session host like a project), by path. */
export function findProject(s: Pick<State, 'workspace'>, path: string | null | undefined): ProjectInfo | null {
  if (!path || !s.workspace) return null
  const p = path.toLowerCase()
  return s.workspace.projects.find((x) => x.path.toLowerCase() === p) ?? (s.workspace.assistant?.path.toLowerCase() === p ? s.workspace.assistant : null)
}

/** Whether a path is the open workspace's Hive Assistant. */
export function isAssistantPath(path: string | null | undefined): boolean {
  const a = get().workspace?.assistant
  return !!path && !!a && a.path.toLowerCase() === path.toLowerCase()
}

const assistantOpenKey = (ws: string): string => `assistant-open:${ws.toLowerCase()}`

/** Shows or hides the Hive Assistant's panel, remembered per workspace. */
export function setAssistantOpen(open: boolean): void {
  const ws = get().workspace?.path
  set({ assistantOpen: open })
  if (!ws) return
  set((s) => ({ panes: { ...s.panes, [assistantOpenKey(ws)]: open ? 1 : 0 } }))
  void window.hive.invoke('ui:setPane', assistantOpenKey(ws), open ? 1 : 0)
}

/** Whether the Assistant's panel is on the left of the window (Settings → Assistant → Panel side; right by default). */
export const assistantOnLeft = (s: State): boolean => s.settings?.assistant.panelSide === 'left'

/** Moves the Assistant's panel to that side of the window: a setting, so every window and workspace follows. */
export async function setAssistantSide(side: AssistantPanelSide): Promise<void> {
  set({ settings: await window.hive.invoke('settings:update', { assistant: { panelSide: side } }) })
}

const progressOpenKey = (ws: string): string => `progress-open:${ws.toLowerCase()}`

/** Whether this window's workspace's Progress panel is open (else it is folded to its strip). */
export function useProgressOpen(): boolean {
  return useStore((s) => !!s.workspace && s.panes[progressOpenKey(s.workspace.path)] === 1)
}

/** Shows or folds the Progress panel, remembered per workspace. */
export function setProgressOpen(open: boolean): void {
  const ws = get().workspace?.path
  if (!ws) return
  set((s) => ({ panes: { ...s.panes, [progressOpenKey(ws)]: open ? 1 : 0 } }))
  void window.hive.invoke('ui:setPane', progressOpenKey(ws), open ? 1 : 0)
}

/** Whether the Progress panel is open now (for commands). */
export function progressIsOpen(): boolean {
  const ws = get().workspace?.path
  return !!ws && get().panes[progressOpenKey(ws)] === 1
}

/** Whether a workspace's Assistant panel was left open. */
export function assistantWasOpen(ws: string | null | undefined): boolean {
  return !!ws && get().panes[assistantOpenKey(ws)] === 1
}

export function selectedProjectInfo() {
  const s = get()
  return s.workspace?.projects.find((p) => p.path === s.selectedProject) ?? null
}

export function setActivity(a: Activity): void {
  set((s) => ({
    activity: a,
    lastSideActivity: a === 'docs' || a === 'settings' ? s.lastSideActivity : a,
    sidebarVisible: a === s.activity && a !== 'docs' && a !== 'settings' ? !s.sidebarVisible : true
  }))
}

/** Collapses the Projects sidebar to a rail of status dots, or expands it again. Either way the Projects list is shown. */
export function toggleCompactSidebar(compact = !get().sidebarCompact): void {
  set((s) => ({
    sidebarCompact: compact,
    sidebarVisible: true,
    lastSideActivity: 'projects',
    activity: s.activity === 'docs' || s.activity === 'settings' ? s.activity : 'projects'
  }))
}

/** Shows a project's settings on one section (e.g. Storage). */
export function openProjectSettings(path: string, section: string): void {
  set({ selectedProject: path, projectSettingsJump: { project: path, section, at: Date.now() } })
  showView('projects')
  setProjectTab(path, 'settings')
}

/** Opens the Sessions tab on one session; with `compaction`, at that compaction's divider (its nth, from 0). */
export function openInSessionsTab(path: string, id: string, compaction?: number): void {
  set({ sessionsJump: { project: path, id, nonce: Date.now(), ...(compaction !== undefined ? { compaction } : {}) } })
  setProjectTab(path, 'sessions')
}

/** Shows an agent's pane on the Session tab and focuses it. */
export function revealAgent(p: ProjectInfo, agentId: string): void {
  showAgent(p, agentId)
  setProjectTab(p.path, 'session')
}

/** How long a pane stays highlighted after it was asked for (flashPane). */
export const PANE_FLASH_MS = 1200

/**
 * Says "here it is" for an agent (or the Assistant) just shown: its pane is highlighted for a moment, and its terminal
 * takes the keyboard, so showing one that was already on screen visibly does something.
 */
export function flashPane(key: string): void {
  const at = Date.now()
  set({ paneFlash: { key, at } })
  setTimeout(() => {
    if (get().paneFlash?.at === at) set({ paneFlash: null })
  }, PANE_FLASH_MS)
  // Once its terminal is on screen (it may be on another page, or its project only now shown), for up to a second.
  // Timers, not animation frames: those wait while the window is behind others.
  let tries = 0
  const focus = (): void => {
    const host = [...document.querySelectorAll<HTMLElement>('.terminal-host[data-pty]')].find((h) => h.dataset.pty === key && !h.classList.contains('hidden'))
    const input = host?.querySelector<HTMLTextAreaElement>('textarea')
    if (input) input.focus()
    else if (++tries < 20) setTimeout(focus, 50)
  }
  setTimeout(focus, 30)
}

/** Shows a sidebar view without toggling it (setActivity hides the sidebar when that view is already shown). */
export function showView(a: Exclude<Activity, 'docs' | 'settings'>): void {
  set({ activity: a, lastSideActivity: a, sidebarVisible: true })
}

/** Shows the Hive Assistant view (activity bar) on its conversations or its personas. */
export function showAssistantView(section: 'conversations' | 'personas'): void {
  set({ assistantSection: section })
  showView('assistant')
}

export function setProjectTab(path: string, tab: ProjectTab): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: tab } }))
}

/** Opens a project's Overview at one agent's session (picked there, and scrolled to). */
export function showInOverview(path: string, agentId: string): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: 'overview' }, overviewJump: { project: path, agentId, at: Date.now() } }))
}

export function applyLiveState(state: LiveSessionState): void {
  set((s) => {
    if (!s.workspace) return {}
    const agentId = state.agentId
    const live = state.status === 'stopped' ? null : state
    const projects = s.workspace.projects.map((p) => {
      if (p.path.toLowerCase() !== state.projectPath.toLowerCase()) return p
      const known = p.agents.some((a) => a.id === agentId)
      const agents = known
        ? p.agents.map((a) => (a.id === agentId ? { ...a, live, restartNeeded: live ? a.restartNeeded : false } : a))
        : live
          ? [...p.agents, { id: agentId, name: state.agentName ?? 'Agent', live, restartNeeded: false, resume: null }]
          : p.agents
      const primary = agents.find((a) => a.live)
      return { ...p, agents, live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, active: live ? true : p.active }
    })
    // The Hive Assistant's one agent.
    const a = s.workspace.assistant
    const assistant =
      a && a.path.toLowerCase() === state.projectPath.toLowerCase()
        ? { ...a, live, agents: a.agents.map((x) => (x.id === agentId ? { ...x, live, restartNeeded: live ? x.restartNeeded : false } : x)) }
        : a
    return { workspace: { ...s.workspace, projects, assistant } }
  })
}

export function pushToast(t: ToastMessage): void {
  set((s) => ({
    // A quiet one is for the Notifications panel only (told as a banner, a Windows notification, or not at all).
    toasts: t.quiet ? s.toasts : [...s.toasts.filter((x) => x.id !== t.id), t].slice(-5),
    notifications: [t, ...s.notifications].slice(0, 100),
    unread: s.showNotifications ? s.unread : s.unread + 1
  }))
  if (t.quiet) return
  const timeout = t.level === 'error' ? 12000 : t.actions?.length ? 15000 : 6000
  setTimeout(() => dismissToast(t.id), timeout)
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

let toastSeq = 0

/**
 * Runs an action that has no dialog (a header button, a menu item) once at a time: a second call while it runs is
 * ignored. `key` names it, so its button can show a spinner (`useStore((s) => s.running[key])`).
 */
export async function runOnce<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (get().running[key]) return undefined
  set((s) => ({ running: { ...s.running, [key]: true } }))
  try {
    return await fn()
  } finally {
    set((s) => {
      const { [key]: _, ...rest } = s.running
      return { running: rest }
    })
  }
}
export function notify(level: ToastMessage['level'], title: string, message?: string, actions?: ToastMessage['actions']): void {
  pushToast({ id: `local-${++toastSeq}-${Date.now()}`, level, title, message, actions, timestamp: new Date().toISOString() })
}

/** Dialogs asked for while another is open: each is shown in turn, so none is left unanswered. */
const dialogQueue: DialogRequest[] = []

function openDialog(d: DialogRequest): void {
  if (get().dialog) dialogQueue.push(d)
  else set({ dialog: d })
}

/** Closes the dialog shown (its caller resolves it) and shows the next one waiting, if any. */
export function closeDialog(): void {
  set({ dialog: dialogQueue.shift() ?? null })
}

export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => openDialog({ kind: 'confirm', ...opts, resolve }))
}

export function choose(opts: Omit<ChoiceRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'choice', ...opts, resolve }))
}

export function prompt(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'prompt', ...opts, resolve }))
}

/** Listeners for 'files-changed' events (Files and Images tabs). */
export const filesListeners = new Set<(projectPath: string, dirs: string[]) => void>()

let tasksLoad = 0

/**
 * Reads the board again (after a change here or a tasks-changed event). Only the latest read is kept, and only for
 * the workspace it was made for: an older answer, or one for a workspace this window has since left, is dropped.
 */
export async function loadTasks(): Promise<void> {
  const ws = get().workspace?.path
  const mine = ++tasksLoad
  if (!ws) return set({ tasks: [] })
  try {
    const tasks = await window.hive.invoke('tasks:list')
    if (mine === tasksLoad && get().workspace?.path === ws) set({ tasks })
  } catch {
    // The workspace closed meanwhile.
  }
}

/** Stable empty list for selectors — a fresh [] on every call makes zustand re-render forever. */
export const NO_PROJECTS: ProjectInfo[] = []
export const NO_IDS: string[] = []

/**
 * The Assistant added an agent. The user's view doesn't move: on the project they're looking at, its page's
 * button gets a dot; another project opens on the new agent's page next time.
 */
export function noteAgentAdded(path: string, agentId: string): void {
  set((s) => {
    const shown = s.selectedProject?.toLowerCase() === path.toLowerCase() && s.activity === 'projects'
    return {
      newAgents: { ...s.newAgents, [path]: [...(s.newAgents[path] ?? []), agentId] },
      ...(shown ? {} : { focusedAgent: { ...s.focusedAgent, [path]: agentId } })
    }
  })
}

/** The user saw these new agents (their page is shown). */
export function seenAgents(path: string, ids: string[]): void {
  set((s) => {
    const left = (s.newAgents[path] ?? []).filter((id) => !ids.includes(id))
    const next = { ...s.newAgents }
    if (left.length) next[path] = left
    else delete next[path]
    return { newAgents: next }
  })
}
