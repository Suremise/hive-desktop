import type { AgentDef, AppConfig, AppSettings, KeybindingOverrides, EffortLevel, FileLockMode, PermissionMode, ProjectConfig, SessionLayout, SessionRecord, WorkspaceConfig } from './types'

export const APP_NAME = 'Hive'
export const HIVE_DIR = '.hive'

/** Claude Code session ids are UUIDs; this also accepts other plain ids but never anything that could be a path. */
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)

/** Throws unless id is a valid session id (see isSessionId). Session ids end up in file names. */
export function assertSessionId(id: unknown): string {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return id
}
export const DEFAULT_API_PORT = 47821

export const DEFAULT_SETTINGS: AppSettings = {
  keybindings: {},
  updates: {
    checkAutomatically: true,
    downloadAutomatically: true,
    install: 'auto',
    prerelease: false
  },
  general: {
    closeToTray: true,
    minimizeToTray: false,
    startMinimized: false,
    launchAtLogin: false,
    reopenLastWorkspace: true,
    confirmOnQuit: 'working'
  },
  appearance: {
    theme: 'dark',
    uiFontSize: 13,
    terminalFontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
    terminalFontSize: 13,
    terminalScrollback: 10000,
    terminalCursorBlink: true
  },
  claude: {
    executablePath: '',
    defaultModel: '',
    defaultEffort: '',
    defaultPermissionMode: 'auto',
    enableBypassOption: false,
    extraArgs: '',
    checkUpdatesOnLaunch: true
  },
  notifications: {
    chimeEnabled: true,
    chimeSound: 'chime',
    chimeVolume: 0.6,
    desktopNotifications: true,
    notifyOnFinished: true,
    notifyOnWaiting: true,
    onlyWhenUnfocused: true
  },
  sessions: {
    backupTranscripts: true,
    cacheTtl: 'auto',
    confirmStop: true,
    compactSuggestTokens: 200000
  },
  agentApi: {
    enabled: true,
    port: DEFAULT_API_PORT,
    provideHiveMcp: true,
    allowSessionInput: false
  },
  agents: {
    fileLocks: 'block',
    worktreeCopy: '.env*',
    mergeStyle: 'squash'
  }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  recentWorkspaces: [],
  lastWorkspace: null,
  activeProjects: {},
  window: { width: 1400, height: 900, maximized: false },
  ui: { sidebarWidth: 280, sidebarVisible: true },
  observedDefaultModel: null,
  planUsage: null,
  planWarnings: {}
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  version: 1,
  skills: { enabled: [] },
  mcp: { enabled: [] }
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  skills: { disabled: [] },
  mcp: { disabled: [] },
  chime: 'inherit',
  model: 'inherit',
  effort: 'inherit',
  permissionMode: 'inherit',
  extraArgs: '',
  compactSuggestTokens: null,
  agents: [],
  sessionLayout: 'single',
  fileLocks: 'inherit',
  worktreeCopy: null,
  worktreeSetup: ''
}

/** A project can run up to this many agents at once. */
export const MAX_AGENTS = 4
export const MAIN_AGENT = 'main'

/** The project's agents, Agent 1 (the project folder) first. */
export function projectAgents(cfg: Pick<ProjectConfig, 'agents'>): AgentDef[] {
  const list = Array.isArray(cfg.agents) ? cfg.agents.filter((a) => a && typeof a.id === 'string') : []
  const main = list.find((a) => a.id === MAIN_AGENT)
  return [{ ...main, id: MAIN_AGENT, name: main?.name || 'Agent 1', worktree: undefined }, ...list.filter((a) => a.id !== MAIN_AGENT)]
}

/** Terminal key of an agent's session. Agent 1 keeps the key sessions had before projects had agents. */
export function agentPtyKey(projectPath: string, agentId: string = MAIN_AGENT): string {
  const base = `session:${projectPath.toLowerCase()}`
  return agentId === MAIN_AGENT ? base : `${base}#${agentId}`
}

export const FILE_LOCK_MODES: { value: FileLockMode; label: string; description: string }[] = [
  { value: 'block', label: 'Block', description: 'An agent that tries to edit a file another agent is editing is told to wait or work on something else.' },
  { value: 'ask', label: 'Ask me', description: 'The edit waits for your approval, like a permission prompt.' },
  { value: 'warn', label: 'Warn', description: 'The edit goes ahead, and the agent is told another agent is editing the file.' },
  { value: 'off', label: 'Off', description: 'Agents edit freely. Use with care when several agents share the project folder.' }
]

export const SESSION_LAYOUTS: { value: SessionLayout; label: string; panes: number; icon: string }[] = [
  { value: 'single', label: 'One at a time', panes: 1, icon: 'layout-single' },
  { value: 'columns2', label: 'Two columns', panes: 2, icon: 'layout-columns2' },
  { value: 'columns3', label: 'Three columns', panes: 3, icon: 'layout-columns3' },
  { value: 'grid', label: 'Grid of four', panes: 4, icon: 'layout-grid' }
]

export function layoutPanes(layout: SessionLayout | undefined): number {
  return SESSION_LAYOUTS.find((l) => l.value === layout)?.panes ?? 1
}

const URGENCY: Record<string, number> = { waiting: 6, working: 5, error: 4, starting: 3, finished: 2, ready: 1, stopped: 0 }

/**
 * The state that speaks for several agents in one dot: the most urgent status (needs input, then
 * working…), marked unseen if any agent has something you haven't looked at.
 */
export function mostUrgent<T extends { status: string; unseen?: boolean }>(states: (T | null | undefined)[]): T | null {
  const list = states.filter((s): s is T => !!s)
  if (!list.length) return null
  const top = list.reduce((a, b) => ((URGENCY[b.status] ?? 0) > (URGENCY[a.status] ?? 0) ? b : a))
  return list.some((s) => s.unseen) && !top.unseen ? { ...top, unseen: true } : top
}

/** Folder-safe slug for branch and worktree names: "Agent 2" → "agent-2". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'agent'
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'manual', label: 'Manual', description: 'Asks before file edits and shell commands unless you have pre-approved them.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Makes file edits in the working folder without asking; still asks before shell commands.' },
  { value: 'plan', label: 'Plan', description: 'Read-only: explores and proposes a plan, changes nothing until you approve.' },
  { value: 'auto', label: 'Auto', description: 'A safety classifier approves low-risk actions itself and only asks about risky ones.' },
  { value: 'dontAsk', label: "Don't ask", description: 'Never prompts. Anything not pre-approved is refused instead of asked about.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks and allows everything — any edit, command or network call. Use only in disposable environments.' }
]

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelOption {
  value: string
  label: string
}

const pinned = (...ids: string[]): ModelOption[] => ids.map((id) => ({ value: id, label: modelLabel(id) }))

/**
 * Models offered in the pickers. Aliases follow new releases; full IDs pin a version. The list is
 * what Claude Code knows about; whether an account can use a model is only known when a session
 * starts, and anything else can be typed as a custom ID.
 */
export const MODEL_GROUPS: { label: string; older?: boolean; models: ModelOption[] }[] = [
  {
    label: 'Latest (follows new releases)',
    models: [
      { value: 'fable', label: 'Fable (latest)' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'haiku', label: 'Haiku (latest)' }
    ]
  },
  { label: 'Pinned versions', models: pinned('claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5') },
  {
    label: 'Older versions',
    older: true,
    models: pinned('claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1')
  }
]

export const MODEL_PRESETS: ModelOption[] = MODEL_GROUPS.flatMap((g) => g.models)

const ONE_M = /\[1m\]$/i

/** The model without its 1M-context suffix. */
export const baseModel = (model: string): string => model.replace(ONE_M, '')
export const isOneM = (model: string): boolean => ONE_M.test(model)

/** Whether Claude Code offers a 1M-context variant: Fable, Opus 4.6+ and Sonnet 4.5+ (and their aliases). */
export function supportsOneM(model: string): boolean {
  const id = baseModel(model).toLowerCase()
  if (id === 'fable' || id === 'opus' || id === 'sonnet' || id.startsWith('claude-fable-')) return true
  const m = /^claude-(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (!m) return false
  const version = Number(m[2]) + Number(m[3] ?? 0) / 10
  return m[1] === 'opus' ? version >= 4.6 : version >= 4.5
}

export const withOneM = (model: string, on: boolean): string => (on && supportsOneM(model) ? `${baseModel(model)}[1m]` : baseModel(model))

export const isOlderModel = (model: string): boolean => MODEL_GROUPS.some((g) => g.older && g.models.some((m) => m.value === baseModel(model)))

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/** Friendly model name: "opus" → "Opus", "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelLabel(model: string): string {
  const oneM = /\[1m\]$/i.test(model)
  const id = model.replace(/\[1m\]$/i, '').trim()
  const named = /^claude-([a-z]+)-(\d+)-(\d{1,2})(?:-\d{8})?$/i.exec(id) // claude-opus-5-5 (not a date)
  const legacy = /^claude-(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/i.exec(id) // claude-3-5-sonnet-20241022
  const major = /^claude-([a-z]+)-(\d+)(?:-\d{8})?$/i.exec(id) // claude-opus-4-20250514
  let out = id
  if (named) out = `${cap(named[1])} ${named[2]}.${named[3]}`
  else if (legacy) out = `${cap(legacy[3])} ${legacy[1]}.${legacy[2]}`
  else if (major) out = `${cap(major[1])} ${major[2]}`
  else if (/^[a-z]+$/i.test(id)) out = cap(id)
  return oneM ? `${out} (1M)` : out
}

/**
 * The model a project's sessions use, for display. A project override shows plainly; anything
 * inherited (Hive's default, or Claude Code's own) is marked "(default)".
 */
export function effectiveModelLabel(projectModel: string, globalModel: string, claudeDefault: string | null): string {
  if (projectModel && projectModel !== 'inherit') return modelLabel(projectModel)
  const m = globalModel || claudeDefault
  return m ? `${modelLabel(m)} (default)` : 'Claude Code default'
}

/** Context size at which a project's Compact button is highlighted (0 = never). */
export function compactThreshold(project: { compactSuggestTokens?: number | null } | null | undefined, globalTokens: number): number {
  const p = project?.compactSuggestTokens
  return typeof p === 'number' && p >= 0 ? p : globalTokens
}

export function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode
}

/** Deep-merge saved values over defaults so new settings get their defaults after an upgrade. */
/** Upgrades settings saved by older versions. */
export function migrateConfig(cfg: AppConfig): AppConfig {
  const g = cfg.settings.general
  const q = g.confirmOnQuit as unknown
  // 0.1 stored on/off; "on" asked whenever sessions ran, which maps to asking when an agent is working.
  if (typeof q === 'boolean') g.confirmOnQuit = q ? 'working' : 'never'
  else if (q !== 'working' && q !== 'always' && q !== 'never') g.confirmOnQuit = 'working'
  return cfg
}

export function mergeDefaults<T>(defaults: T, saved: unknown): T {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return (saved === undefined ? defaults : (saved as T)) ?? defaults
  }
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return saved as T
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    const d = (defaults as Record<string, unknown>)[k]
    out[k] = d !== undefined && d !== null && typeof d === 'object' && !Array.isArray(d) ? mergeDefaults(d, v) : v
  }
  return out as T
}

const EFFORT_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/**
 * Effort to show next to the model: what the running session reports, else what new sessions use
 * (the project's choice, then the global default). Null when Claude Code picks its own default.
 */
export function effortLabel(live: string | undefined, project: string | undefined, global: string | undefined): string | null {
  const v = live || (project && project !== 'inherit' ? project : global)
  return v ? EFFORT_NAMES[v] ?? cap(v) : null
}

/** Whether a session record ran in the folder an agent works in (its worktree, or the project folder). */
export function sessionInAgentFolder(projectPath: string, a: Pick<AgentDef, 'worktree'>, rec: Pick<SessionRecord, 'cwd'>): boolean {
  const folder = (a.worktree?.path ?? projectPath).toLowerCase()
  return (rec.cwd ?? projectPath).toLowerCase() === folder
}

/**
 * The session an agent's Resume opens: its last session, else the latest one it ran. Archived
 * sessions, sessions from another folder and sessions open in another agent are skipped.
 */
export function resumeRecord<R extends Pick<SessionRecord, 'id' | 'archived' | 'lastActiveAt'> & Partial<Pick<SessionRecord, 'cwd' | 'agentId'>>>(
  projectPath: string,
  a: Pick<AgentDef, 'id' | 'worktree' | 'lastSessionId'>,
  records: R[],
  open: Set<string>
): R | null {
  const usable = records
    .filter((r) => !r.archived && !open.has(r.id) && sessionInAgentFolder(projectPath, a, r))
    .sort((x, y) => (y.lastActiveAt ?? '').localeCompare(x.lastActiveAt ?? ''))
  return usable.find((r) => r.id === a.lastSessionId) ?? usable.find((r) => !!a.worktree || (r.agentId ?? MAIN_AGENT) === a.id) ?? null
}

/**
 * A session's display name: its Hive name, unless that is still the automatic "<project> · <date>"
 * one and Claude Code has titled the conversation.
 */
export function sessionLabel(s: { id: string; name?: string | null; title?: string | null }, projectName: string): string {
  const auto = !s.name || (s.name.startsWith(`${projectName} · `) && /\d{1,4}[/.-]\d{1,2}/.test(s.name))
  return (auto ? s.title || s.name : s.name) || `Session ${s.id.slice(0, 8)}`
}

/** Where Hive's releases (and its update feed) are published. */
export const RELEASES_URL = 'https://github.com/Suremise/hive-desktop/releases'

// ---------------------------------------------------------------------------
// Permission modes in a running session
// ---------------------------------------------------------------------------

/** The modes Claude Code's Shift+Tab cycles through, in order (checked with Claude Code 2.1.284). */
export const MODE_CYCLE: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']

const FOOTER_MODE = /(manual\s*mode|accept\s*edits|plan\s*mode|auto\s*mode|bypass\s*permissions|don['’]?t\s*ask)\s*on\s*(?:\(|·)/gi

/**
 * The permission mode in Claude Code's footer ("⏵⏵ auto mode on (shift+tab to cycle)"), from terminal
 * output with control sequences already replaced by spaces. The last one wins; null when there is none.
 */
export function footerMode(text: string): PermissionMode | null {
  let last: string | null = null
  for (const m of text.matchAll(FOOTER_MODE)) last = m[1].toLowerCase().replace(/\s+/g, '')
  if (!last) return null
  if (last.startsWith('manual')) return 'manual'
  if (last.startsWith('accept')) return 'acceptEdits'
  if (last.startsWith('plan')) return 'plan'
  if (last.startsWith('auto')) return 'auto'
  if (last.startsWith('bypass')) return 'bypassPermissions'
  return 'dontAsk'
}

/** The permission_mode Claude Code sends with hooks ("default" is Manual). */
export function hookMode(v: unknown): PermissionMode | null {
  if (v === 'default' || v === 'manual') return 'manual'
  return PERMISSION_MODES.some((m) => m.value === v) ? (v as PermissionMode) : null
}

/**
 * Whether a running session can switch to a mode with Shift+Tab. Don't ask leaves the cycle once left;
 * Bypass is only in it for a session launched in Bypass. Anything else needs a restart.
 */
export function canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  if (target === current) return true
  if (MODE_CYCLE.includes(target)) return true
  return target === 'bypassPermissions' && launched === 'bypassPermissions'
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/** Command categories whose shortcuts a project can override. */
export const PROJECT_KEYBINDING_CATEGORIES = ['Project', 'Session']

/**
 * The shortcut a command uses: the project's override, else the user's, else the default. An override
 * of null (or empty) means "no shortcut".
 */
export function resolveKeybinding(id: string, fallback: string | undefined, global: KeybindingOverrides | undefined, project: KeybindingOverrides | undefined): string | undefined {
  if (project && id in project) return project[id] || undefined
  if (global && id in global) return global[id] || undefined
  return fallback
}

/** Keys Hive never lets a shortcut take: typing, clipboard and undo, and the terminal's own mode switch. */
export function keybindingProblem(key: string): string | null {
  const parts = key.split(' ')
  for (const p of parts) {
    const mods = p.split('+').slice(0, -1)
    const k = p.split('+').pop() ?? ''
    const fn = /^F\d{1,2}$/.test(k)
    if (!mods.length && !fn && k !== 'Escape') return 'Add Ctrl or Alt: a single key would stop you typing it.'
    if (mods.length === 1 && mods[0] === 'Shift' && !fn) return 'Add Ctrl or Alt: Shift alone types a character.'
    if (mods.join('+') === 'Mod' && ['C', 'V', 'X', 'A', 'Z', 'Y'].includes(k)) return `Ctrl+${k} is kept for copy, paste and undo.`
    if (mods.join('+') === 'Shift' && k === 'Tab') return "Shift+Tab switches the permission mode inside Claude Code's terminal."
    if (!mods.length && k === 'Escape') return 'Escape closes dialogs and interrupts the agent.'
  }
  return null
}
