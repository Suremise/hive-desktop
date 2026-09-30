import { create } from 'zustand'
import { agentPtyKey, layoutPanes, mostUrgent } from '@shared/defaults'
import { agentProvider } from '@shared/providers'
import type { QuitScope, UpdateState } from '@shared/types'
import type {
  AgentApiInfo,
  AgentInfo,
  AgentInstallInfo,
  ProviderId,
  AppInfo,
  AppSettings,
  LiveSessionState,
  PlanUsage,
  ProjectInfo,
  QuitSession,
  ToastMessage,
  WorkspaceInfo
} from '@shared/types'

export type Activity = 'projects' | 'notes' | 'skills' | 'mcp' | 'personas' | 'docs' | 'settings'
export type ProjectTab = 'session' | 'overview' | 'sessions' | 'files' | 'images' | 'changes' | 'memory' | 'skills' | 'mcp' | 'settings'

export interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
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

interface State {
  settings: AppSettings | null
  workspace: WorkspaceInfo | null
  recent: string[]
  /** Each provider's installed CLI (install state, version, sign-in, readiness). */
  providers: Record<ProviderId, AgentInstallInfo>
  /** Subscription limits each provider last reported (account-wide), by provider. */
  planUsage: Record<ProviderId, PlanUsage>
  api: AgentApiInfo | null
  appInfo: AppInfo | null

  activity: Activity
  lastSideActivity: Exclude<Activity, 'docs' | 'settings'>
  sidebarVisible: boolean
  sidebarWidth: number
  /** Projects sidebar collapsed to a rail of status dots. */
  sidebarCompact: boolean
  /** Set to select a session in its project's Sessions tab. */
  sessionsJump: { project: string; id: string; nonce: number } | null
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
  /** The Hive Assistant's panel is shown (per workspace, saved in the pane sizes as assistant-open:<path>). */
  assistantOpen: boolean
  /** Assistant Settings is open. */
  assistantSettingsOpen: boolean
  personasVersion: number
  docsPage: string
  settingsSection: string
  settingsQuery: string

  toasts: ToastMessage[]
  notifications: ToastMessage[]
  unread: number
  showNotifications: boolean
  paletteOpen: boolean
  /** What the palette lists: every command and project, or projects only (Go to Project). */
  paletteMode: 'commands' | 'projects'
  /** The permission mode menu, open for an agent at a point. */
  modeMenu: { project: string; agentId: string; x: number; y: number; above?: number } | null
  /** A shortcut is being recorded in the keyboard shortcuts editor: app shortcuts are paused. */
  recordingKeys: boolean
  aboutOpen: boolean
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
  /** Per project: the agent that session commands (header buttons, shortcuts, Insert into Session) act on. */
  focusedAgent: Record<string, string>
  /** Per project: which agent each pane of a multi-pane layout shows. */
  paneAgents: Record<string, string[]>
  /** Per project: whose folder the Changes and Files tabs show (a worktree agent's id; anything else = the project folder). */
  changesRoot: Record<string, string>
  filesRoot: Record<string, string>

  windowFocused: boolean
  maximized: boolean
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
  api: null,
  appInfo: null,

  activity: 'projects',
  lastSideActivity: 'projects',
  sidebarVisible: true,
  sidebarWidth: 280,
  sidebarCompact: false,
  sessionsJump: null,
  panes: {},
  selectedProject: null,
  projectTabs: {},
  selectedNote: null,
  selectedSkill: null,
  skillEdit: null,
  selectedMcp: null,
  selectedPersona: null,
  assistantOpen: false,
  assistantSettingsOpen: false,
  personasVersion: 0,
  docsPage: 'guide',
  settingsSection: 'general',
  settingsQuery: '',

  toasts: [],
  notifications: [],
  unread: 0,
  showNotifications: false,
  paletteOpen: false,
  paletteMode: 'commands',
  modeMenu: null,
  recordingKeys: false,
  aboutOpen: false,
  update: null,
  updateOpen: false,
  setupOpen: false,
  shortcutsOpen: false,
  dialog: null,
  quitRequest: null,
  quitUnsaved: [],
  quitScope: 'app',
  quitPending: null,
  compactFor: null,
  addAgentFor: null,
  agentSettingsFor: null,
  mergeFor: null,
  handOverFor: null,
  focusedAgent: {},
  paneAgents: {},
  changesRoot: {},
  filesRoot: {},

  windowFocused: true,
  maximized: false,
  notesVersion: 0,
  skillsVersion: 0,
  usageVersion: {},
  sessionEpoch: {}
}))

export const set = useStore.setState
export const get = useStore.getState

export interface AgentRef {
  project: string
  agentId: string
}

/** Terminal key of an agent's session. */
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
  set((s) => ({ focusedAgent: { ...s.focusedAgent, [path]: agentId } }))
}

/**
 * Which agent each pane shows. One pane shows the focused agent; with more, the panes keep the
 * agents placed in them and fill up in agent order. Null is an empty pane.
 */
export function paneAssignment(p: ProjectInfo, focused: string | null, stored: string[] | undefined): (string | null)[] {
  const n = layoutPanes(p.config.sessionLayout)
  if (n === 1) return [focused]
  const ids = p.agents.map((a) => a.id)
  const out: string[] = []
  for (const id of stored ?? []) if (ids.includes(id) && !out.includes(id) && out.length < n) out.push(id)
  for (const id of ids) if (out.length < n && !out.includes(id)) out.push(id)
  return [...out, ...Array<null>(n - out.length).fill(null)]
}

/** Shows an agent: focuses its pane, or puts it in the focused agent's pane when it isn't on screen. */
export function showAgent(p: ProjectInfo, agentId: string): void {
  const s = get()
  const focused = focusedAgentId(p)
  const panes = paneAssignment(p, focused, s.paneAgents[p.path])
  if (panes.length > 1 && !panes.includes(agentId)) {
    const i = Math.max(0, panes.indexOf(focused))
    const next = panes.map((id, j) => (j === i ? agentId : id)).filter((id): id is string => !!id)
    set({ paneAgents: { ...s.paneAgents, [p.path]: next } })
  }
  focusAgent(p.path, agentId)
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

/** Opens the Sessions tab on one session. */
export function openInSessionsTab(path: string, id: string): void {
  set({ sessionsJump: { project: path, id, nonce: Date.now() } })
  setProjectTab(path, 'sessions')
}

/** Shows an agent's pane on the Session tab and focuses it. */
export function revealAgent(p: ProjectInfo, agentId: string): void {
  showAgent(p, agentId)
  setProjectTab(p.path, 'session')
}

/** Shows a sidebar view without toggling it (setActivity hides the sidebar when that view is already shown). */
export function showView(a: Exclude<Activity, 'docs' | 'settings'>): void {
  set({ activity: a, lastSideActivity: a, sidebarVisible: true })
}

export function setProjectTab(path: string, tab: ProjectTab): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: tab } }))
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
    toasts: [...s.toasts.filter((x) => x.id !== t.id), t].slice(-5),
    notifications: [t, ...s.notifications].slice(0, 100),
    unread: s.showNotifications ? s.unread : s.unread + 1
  }))
  const timeout = t.level === 'error' ? 12000 : t.actions?.length ? 15000 : 6000
  setTimeout(() => dismissToast(t.id), timeout)
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

let toastSeq = 0
export function notify(level: ToastMessage['level'], title: string, message?: string, actions?: ToastMessage['actions']): void {
  pushToast({ id: `local-${++toastSeq}-${Date.now()}`, level, title, message, actions, timestamp: new Date().toISOString() })
}

export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => set({ dialog: { kind: 'confirm', ...opts, resolve } }))
}

export function choose(opts: Omit<ChoiceRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => set({ dialog: { kind: 'choice', ...opts, resolve } }))
}

export function prompt(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => set({ dialog: { kind: 'prompt', ...opts, resolve } }))
}

/** Listeners for 'files-changed' events (Files and Images tabs). */
export const filesListeners = new Set<(projectPath: string, dirs: string[]) => void>()

/** Stable empty list for selectors — a fresh [] on every call makes zustand re-render forever. */
export const NO_PROJECTS: ProjectInfo[] = []
