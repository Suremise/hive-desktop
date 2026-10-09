import type { AgentBranchStatus, AgentDef, AppConfig, AppSettings, CompactionEvent, KeybindingOverrides, FileLockMode, PageLayout, PlanLimit, PlanUsage, ProjectConfig, ProjectProviderConfig, ProviderId, ProviderSettings, SessionLayout, SessionRecord, SessionStatus, WorkspaceConfig } from './types'
import { CLAUDE_CODE } from './claude'
import { DEFAULT_COLUMN_COLORS } from './tasks'
import { formatDateTime } from './dates'
import { DEFAULT_PROVIDER, PROVIDERS, defaultProviderSettings, isKnownProvider, providerDescriptor } from './providers'
import { chosenName, effortName, modelIdName, resolvedModel, runsAsName, type ModelInfo } from './models'

export const HIVE_DIR = '.hive'

/** Session ids are UUIDs (Claude Code, Codex); this also accepts other plain ids but never anything that could be a path. */
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)

/** Throws unless id is a valid session id (see isSessionId). Session ids end up in file names. */
export function assertSessionId(id: unknown): string {
  if (!isSessionId(id)) throw new Error('Invalid session id')
  return id
}
export const DEFAULT_API_PORT = 47821

/**
 * Personas Hive shipped until working modes replaced them (#259), and the mode each became. A workspace's copy Hive
 * never changed goes; one the user changed is theirs and stays. A choice of a removed one moves to its mode.
 */
export const RETIRED_PERSONAS: Record<string, string> = { overseer: 'coordinator', orchestrator: 'coordinator', reviewer: 'qa-triager' }

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
    confirmOnQuit: 'working',
    showTips: true,
    keepAwake: 'plugged-in',
    progressPanel: true,
    progressCommands: true,
    dateFormat: 'ymd',
    timeFormat: '24h',
    userName: 'User'
  },
  appearance: {
    theme: 'dark',
    uiFontSize: 13,
    terminalFontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
    terminalFontSize: 13,
    terminalScrollback: 10000,
    terminalCursorBlink: true
  },
  providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, defaultProviderSettings(p)])),
  defaultProvider: DEFAULT_PROVIDER,
  notifications: {
    chimeEnabled: true,
    chimeSound: 'chime',
    chimeVolume: 0.6,
    desktopNotifications: true,
    notifyOnFinished: true,
    notifyOnWaiting: true,
    whileFocused: 'inApp',
    bannerScope: 'all',
    bannerPosition: 'top-center',
    bannerSeconds: 6,
    waitingBannerStays: true,
    taskbarCount: true,
    flashOnWaiting: true
  },
  sessions: {
    backupTranscripts: true,
    cacheTtl: 'auto',
    confirmStop: true,
    compactSuggestTokens: 200000,
    transcriptWarnMB: 20,
    usageCacheSize: 5000,
    followTranscripts: false,
    overviewRefresh: 'live',
    recordPerformance: true
  },
  agentApi: {
    enabled: true,
    port: DEFAULT_API_PORT,
    provideHiveMcp: true,
    allowSessionInput: false
  },
  // The agents' model and effort (empty): a lighter choice saves tokens but makes the Assistant careless.
  assistant: {
    provider: '',
    persona: 'coordinator',
    control: 'projects',
    changeSettings: false,
    typingPause: 15,
    enterEndsPause: true,
    tellReplies: true,
    panelSide: 'right',
    compactSuggestTokens: 500000,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { model: '', effort: '', permissionMode: '', extraArgs: '', use200kContext: '' }]))
  },
  agents: {
    fileLocks: 'block',
    worktreeCopy: '.env*',
    mergeStyle: 'merge',
    backgroundTaskMinutes: 60
  },
  board: {
    archiveDoneDays: 14,
    columnColors: true,
    colors: { ...DEFAULT_COLUMN_COLORS }
  }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 7,
  settings: DEFAULT_SETTINGS,
  recentWorkspaces: [],
  lastWorkspace: null,
  activeProjects: {},
  window: { width: 1400, height: 900, maximized: false },
  ui: { sidebarWidth: 280, sidebarVisible: true },
  observedDefaultModel: {},
  planUsage: {},
  planWarnings: {}
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  version: 1,
  mcp: { enabled: [] }
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 2,
  mcp: { disabled: [] },
  chime: 'inherit',
  defaultProvider: 'inherit',
  providers: {},
  compactSuggestTokens: null,
  transcriptWarnMB: null,
  agents: [],
  layout: 'auto',
  fileLocks: 'inherit',
  worktreeCopy: null,
  worktreeSetup: ''
}

/** The transcript viewer loads this many items at a time (the latest first, earlier ones as you scroll up). */
export const TRANSCRIPT_WINDOW = 200

/** A project can run up to this many agents at once. */
export const MAX_AGENTS = 12
/** An agent's role (#126) is at most this long. */
export const ROLE_MAX = 60
/** Adding the agent that makes this many: a note that each is its own CLI process. */
export const MANY_AGENTS = 7

/**
 * How many agents one page of the Session tab holds (#134): a pane each, so a page shows all its agents. One at a time
 * (Single) is one page of every agent, its tabs choosing which is shown, so it never has page buttons.
 */
export function agentsPerPage(layout: SessionLayout): number {
  return layout === 'single' ? MAX_AGENTS : layoutPanes(layout)
}

/** How many agent pages `count` agents take, `perPage` to a page (at least one). */
export function agentPageCount(count: number, perPage: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, perPage)))
}

/** The page of the agent at this position (0 is page 1). */
export function pageOfAgent(index: number, perPage: number): number {
  return Math.max(0, Math.floor(index / Math.max(1, perPage)))
}

/** The agents on one page. */
export function pageAgents<T>(agents: T[], page: number, perPage: number): T[] {
  const n = Math.max(1, perPage)
  return agents.slice(page * n, (page + 1) * n)
}

/** The agents with one moved to `index`, its position afterwards (clamped). An unknown id leaves the order as it is. */
export function moveAgentTo<T extends { id: string }>(agents: readonly T[], id: string, index: number): T[] {
  const from = agents.findIndex((a) => a.id === id)
  if (from < 0) return [...agents]
  const rest = agents.filter((a) => a.id !== id)
  const to = Math.max(0, Math.min(rest.length, Math.round(index)))
  return [...rest.slice(0, to), agents[from], ...rest.slice(to)]
}

/**
 * The agents with two of them swapped (#135: an agent dropped on another's pane): each takes the other's place, across
 * pages too. An unknown id, or the same one twice, leaves the order as it is.
 */
export function swapAgentsIn<T extends { id: string }>(agents: readonly T[], a: string, b: string): T[] {
  const i = agents.findIndex((x) => x.id === a)
  const j = agents.findIndex((x) => x.id === b)
  if (i < 0 || j < 0 || i === j) return [...agents]
  const out = [...agents]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Where an agent dropped before another one ends up (`before` null, or itself: at the end, or where it is). */
export function dropIndex(ids: readonly string[], id: string, before: string | null): number {
  if (before === id) return Math.max(0, ids.indexOf(id))
  const rest = ids.filter((x) => x !== id)
  const i = before === null ? -1 : rest.indexOf(before)
  return i < 0 ? rest.length : i
}

/** Where an agent dropped on a page's button ends up: that page's last place (the last agent's, on the last page). */
export function pageEndIndex(count: number, page: number, perPage: number): number {
  return Math.max(0, Math.min((page + 1) * Math.max(1, perPage) - 1, count - 1))
}

/** The project's agents, in the order the user put them (the order they were added, until moved). All are equal; a project can have none. */
export function projectAgents(cfg: Pick<ProjectConfig, 'agents'>): AgentDef[] {
  return Array.isArray(cfg.agents) ? cfg.agents.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string') : []
}

/** Terminal key of an agent's session. */
export function agentPtyKey(projectPath: string, agentId: string): string {
  return `session:${projectPath.toLowerCase()}#${agentId}`
}

/** The layout that shows this many agents (up to the 3×2 grid): the automatic layout. */
export function layoutForAgents(count: number): SessionLayout {
  return count >= 5 ? 'grid6' : count === 4 ? 'grid' : count === 3 ? 'columns3' : count === 2 ? 'columns2' : 'single'
}

/** Whether a saved layout is one Hive knows ('auto' included). */
const isLayout = (v: unknown): v is PageLayout => v === 'auto' || SESSION_LAYOUTS.some((l) => l.value === v)

/**
 * The project's layout (#134: one for the project, not one a page): the one chosen by hand, else the one that shows its
 * agents, up to the 3×2 grid. Its pages hold `agentsPerPage` agents each.
 */
export function projectLayout(cfg: Pick<ProjectConfig, 'agents' | 'layout'>): SessionLayout {
  const chosen = cfg.layout
  if (chosen && chosen !== 'auto' && isLayout(chosen)) return chosen
  return layoutForAgents(projectAgents(cfg).length)
}

/** How many agents a page of this project's Session tab holds. */
export const projectPerPage = (cfg: Pick<ProjectConfig, 'agents' | 'layout'>): number => agentsPerPage(projectLayout(cfg))

/** The layout to save when one is chosen: choosing the one that shows the agents makes it automatic again. */
export function chosenLayout(cfg: Pick<ProjectConfig, 'agents'>, layout: SessionLayout): PageLayout {
  return layout === layoutForAgents(projectAgents(cfg).length) ? 'auto' : layout
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
  { value: 'grid', label: 'Grid of four', panes: 4, icon: 'layout-grid' },
  { value: 'grid6', label: 'Grid of six', panes: 6, icon: 'layout-grid6' }
]

export function layoutPanes(layout: SessionLayout | undefined): number {
  return SESSION_LAYOUTS.find((l) => l.value === layout)?.panes ?? 1
}

const URGENCY: Record<string, number> = { signin: 8, waiting: 7, working: 6, background: 5, error: 4, starting: 3, finished: 2, ready: 1, stopped: 0 }

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

/** The status message of a session while it compacts its conversation (started from Hive or by the CLI itself). */
export const COMPACTING_MESSAGE = 'Compacting the conversation…'

/** Whether a session is compacting its conversation now. */
export function isCompacting(live: { status: SessionStatus; statusMessage?: string } | null | undefined): boolean {
  return live?.status === 'working' && live.statusMessage === COMPACTING_MESSAGE
}

/**
 * Why a worktree agent's work can't be merged now, or null. A merge commits the worktree's uncommitted files first,
 * so not while the agent is in the middle of a task (working, asking you something, waiting on background tasks or on cards).
 */
export function mergeBlocked(name: string, status: SessionStatus | null | undefined): string | null {
  switch (status) {
    case 'starting':
    case 'working':
      return `${name} is working. Merge once it has finished.`
    case 'waiting':
      return `${name} is waiting for your answer. Merge once it has finished.`
    case 'background':
      return `${name} is waiting on background tasks it started. Merge once it has finished.`
    case 'watching':
      return `${name} is waiting for cards to change (a card watch) and carries on when they do. Merge once it has finished, or cancel its watch first.`
    case 'signin':
      return `${name} stopped in the middle of a task when its sign-in expired. Sign in again and let it finish first.`
    default:
      return null
  }
}

/**
 * Whether stopping an agent at the Assistant's request asks the user first: when it is in the middle of something
 * (starting, working, asking, waiting on background tasks, or on cards in a card loop).
 */
export const stopAsksUser = (status: SessionStatus | null | undefined): boolean =>
  status === 'starting' || status === 'working' || status === 'waiting' || status === 'background' || status === 'watching'

/** Folder-safe slug for branch and worktree names: "Agent 2" → "agent-2". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'agent'
}

/** Friendly model name, as the provider names it ("claude-opus-5-5" → "Opus 5.5"). */
export function modelLabel(model: string, provider: string = DEFAULT_PROVIDER): string {
  return providerDescriptor(provider).modelLabel(model)
}

/** The model an agent runs, for display (#248): its name, and the choice it came from when that reads differently. */
export interface ModelShown {
  /** "Opus 5.5", "Opus 5.5 (default)" when inherited (Hive's default or the CLI's own), "Claude Code default" when unknown. */
  label: string
  /** The choice's own name when it isn't the model's ("Opus", an alias), else null. */
  chosenAs: string | null
}

/**
 * The model an agent's sessions run, for display (#248): the running session's model when it reports one (`running`:
 * the status line's or the transcript's model id), else what the choice resolves to (an alias by the model the CLI says
 * it stands for), else the CLI's default model. Never guessed: what nothing resolves shows as the CLI or provider names
 * it. An own or project choice shows plainly; anything inherited is marked "(default)".
 */
export function agentModelShown(provider: ProviderId, chosen: string | undefined, globalModel: string, info: ModelInfo, running?: string | null): ModelShown {
  const own = chosen && chosen !== 'inherit' ? chosen : ''
  // Nothing chosen in Hive: the CLI's default, which its own settings may give as an alias too (Claude Code's `model`).
  const choice = own || globalModel || info?.defaultModel || ''
  const name = running ? modelIdName(provider, running, info) : choice ? runsAsName(provider, choice, info) : null
  if (!name) return { label: `${providerDescriptor(provider).name} default`, chosenAs: null }
  // The CLI's default is named in the tooltip only when it is an alias ("chosen as Opus"): an id was nobody's choice.
  const fromCli = !own && !globalModel
  const picked = choice && (!fromCli || resolvedModel(info, choice) !== choice) ? chosenName(provider, choice, info) : null
  return { label: own ? name : `${name} (default)`, chosenAs: picked && picked !== name ? picked : null }
}

/** agentModelShown's label for new sessions (no running model). */
export function effectiveModelLabel(provider: ProviderId, chosen: string | undefined, globalModel: string, info: ModelInfo): string {
  return agentModelShown(provider, chosen, globalModel, info).label
}

/** Context size at which a project's Compact button is highlighted (0 = never). */
export function compactThreshold(project: { compactSuggestTokens?: number | null } | null | undefined, globalTokens: number): number {
  const p = project?.compactSuggestTokens
  return typeof p === 'number' && p >= 0 ? p : globalTokens
}

/**
 * How full the context window is, in whole percent (0–100), or null when the window isn't known. The window is
 * only ever what the CLI reports for the session (Claude Code's status line, Codex's rollout), never guessed from
 * the model: Claude Code's 1M window depends on the model and the plan.
 */
export function contextPercent(tokens: number, window: number | null | undefined): number | null {
  if (!window || window <= 0) return null
  return Math.min(100, Math.round((Math.max(0, tokens) / window) * 100))
}

/** The transcript size (MB) past which a session is flagged in a project (its own setting, else the global one); 0 never. */
export function transcriptWarnLimit(project: { transcriptWarnMB?: number | null } | null | undefined, globalMB: number): number {
  const p = project?.transcriptWarnMB
  return typeof p === 'number' && p >= 0 ? p : globalMB
}

/** A size in bytes for the footer: "820 KB", "6.1 MB", "118 MB". */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  const mb = n / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Claude Code's plan limits as 0.1 stored them. */
const V1_LIMITS: Record<string, Pick<PlanLimit, 'id' | 'label' | 'windowMinutes'>> = {
  fiveHour: { id: 'five_hour', label: '5-hour', windowMinutes: 300 },
  sevenDay: { id: 'seven_day', label: 'weekly', windowMinutes: 10080 }
}

/**
 * Upgrades a config saved by an older version. `raw` is the file as read (before defaults were merged
 * in), so version 1 (Claude Code only, 0.1.x) can be told apart from a fresh install.
 */
/** The Assistant's model and effort defaults before 0.3, saved into every config. */
const OLD_ASSISTANT_DEFAULTS: Record<string, { model?: string; effort: string }> = { 'claude-code': { model: 'sonnet', effort: 'low' }, codex: { effort: 'low' } }

export function migrateConfig(cfg: AppConfig, raw?: Record<string, any>): AppConfig {
  const g = cfg.settings.general
  const q = g.confirmOnQuit as unknown
  // 0.1 stored on/off; "on" asked whenever sessions ran, which maps to asking when an agent is working.
  if (typeof q === 'boolean') g.confirmOnQuit = q ? 'working' : 'never'
  else if (q !== 'working' && q !== 'always' && q !== 'never') g.confirmOnQuit = 'working'

  if (raw && (raw.version ?? 1) < 2) {
    // 0.1.x ran Claude Code only: its settings become Claude Code's, and it stays enabled.
    const old = (raw.settings?.claude ?? {}) as Record<string, any>
    const c: ProviderSettings = { ...cfg.settings.providers[CLAUDE_CODE], enabled: true }
    for (const k of ['executablePath', 'defaultModel', 'defaultEffort', 'defaultPermissionMode', 'extraArgs', 'checkUpdatesOnLaunch'] as const) {
      if (old[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = old[k]
    }
    if (typeof old.enableBypassOption === 'boolean') c.enableDangerousMode = old.enableBypassOption
    cfg.settings.providers[CLAUDE_CODE] = c
    cfg.settings.defaultProvider = CLAUDE_CODE
    const oldModel = raw.observedDefaultModel
    cfg.observedDefaultModel = typeof oldModel === 'string' && oldModel ? { [CLAUDE_CODE]: oldModel } : {}
    const oldUsage = raw.planUsage
    cfg.planUsage = {}
    if (oldUsage && typeof oldUsage === 'object' && !('limits' in oldUsage)) {
      const limits: PlanLimit[] = []
      for (const [key, meta] of Object.entries(V1_LIMITS)) {
        const l = oldUsage[key]
        if (l && typeof l.usedPercent === 'number') limits.push({ ...meta, usedPercent: l.usedPercent, resetsAt: l.resetsAt ?? null })
      }
      if (limits.length) cfg.planUsage[CLAUDE_CODE] = { provider: CLAUDE_CODE, plan: null, limits, updatedAt: oldUsage.updatedAt ?? new Date(0).toISOString() } as PlanUsage
    }
    const warnings: AppConfig['planWarnings'] = {}
    for (const [k, v] of Object.entries(raw.planWarnings ?? {})) {
      const meta = V1_LIMITS[k]
      warnings[meta ? `${CLAUDE_CODE}:${meta.id}` : k] = v as AppConfig['planWarnings'][string]
    }
    cfg.planWarnings = warnings
  }
  if (raw && (raw.version ?? 1) < 3) {
    // 0.2 saved a lighter model and effort as the Assistant's defaults; they now follow the agents'.
    for (const [id, old] of Object.entries(OLD_ASSISTANT_DEFAULTS)) {
      const a = cfg.settings.assistant.providers[id]
      if (!a) continue
      if (old.model && a.model === old.model) a.model = ''
      if (a.effort === old.effort) a.effort = ''
    }
  }
  if (raw && (raw.version ?? 1) < 4 && cfg.settings.agents.mergeStyle === 'squash') {
    // Squash was the default until 0.3 (saved into every config): merging keeps a long-lived agent's commits, so
    // its next merge brings only what is new. Anyone who wants Squash chooses it again.
    cfg.settings.agents.mergeStyle = 'merge'
  }
  if (raw && (raw.version ?? 1) < 5 && cfg.settings.sessions.transcriptWarnMB === 50) {
    // 50 MB was the default up to 0.3.x (saved into every config); long transcripts slow things well before that.
    // Anyone who wants 50 sets it again.
    cfg.settings.sessions.transcriptWarnMB = 20
  }
  if (raw && (raw.version ?? 1) < 6) {
    // Up to 0.3.x, "Only when Hive is in the background" (onlyWhenUnfocused) decided whether a Windows notification
    // showed while you used Hive. Now notices show in Hive instead, and everyone starts there, whatever it was.
    cfg.settings.notifications.whileFocused = 'inApp'
  }
  if (raw && (raw.version ?? 1) < 7) {
    // Up to 0.3.x Hive shipped character personas; working modes replaced them (#259): a default persona that went
    // becomes the closest mode.
    const was = cfg.settings.assistant.persona
    if (RETIRED_PERSONAS[was]) cfg.settings.assistant.persona = RETIRED_PERSONAS[was]
  }
  delete (cfg.settings.notifications as unknown as Record<string, unknown>).onlyWhenUnfocused
  cfg.version = 7
  // Settings for providers this version doesn't know are kept (a newer Hive wrote them), but never used.
  if (!isKnownProvider(cfg.settings.defaultProvider)) cfg.settings.defaultProvider = DEFAULT_PROVIDER
  return cfg
}

/**
 * The settings as 0.1.x reads them: `claude` mirrors Claude Code's provider settings, so going back to
 * an older Hive keeps them. Newer versions ignore it.
 */
export function withLegacySettings(cfg: AppConfig): AppConfig & { settings: AppSettings & { claude: Record<string, unknown> } } {
  const c = cfg.settings.providers[CLAUDE_CODE] ?? defaultProviderSettings(providerDescriptor(CLAUDE_CODE))
  const legacyMode = c.defaultPermissionMode === 'bypassPermissions' ? 'auto' : c.defaultPermissionMode
  return {
    ...cfg,
    settings: {
      ...cfg.settings,
      claude: {
        executablePath: c.executablePath,
        defaultModel: c.defaultModel,
        defaultEffort: c.defaultEffort,
        defaultPermissionMode: legacyMode,
        enableBypassOption: c.enableDangerousMode,
        extraArgs: c.extraArgs,
        checkUpdatesOnLaunch: c.checkUpdatesOnLaunch
      }
    }
  }
}

/**
 * Upgrades a project.json read from disk (before defaults are merged in). Projects from 0.1.x ran
 * Claude Code only: their model, effort, mode and arguments become Claude Code's, and the project's
 * default provider is Claude Code, so its existing agents (which name no provider) stay on it.
 */
export function migrateProjectConfig(raw: Record<string, any>): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let out = withoutSkillSwitches(raw)
  if (out.providers === undefined) {
    // 0.1's model, effort, mode and arguments were Claude Code's.
    const legacy: Partial<ProjectProviderConfig> = {}
    for (const k of ['model', 'effort', 'permissionMode', 'extraArgs'] as const) if (out[k] !== undefined) legacy[k] = out[k]
    const { model: _m, effort: _e, permissionMode: _p, extraArgs: _x, ...rest } = out
    out = { ...rest, providers: Object.keys(legacy).length ? { [CLAUDE_CODE]: legacy } : {} }
  }
  if ((Number(out.version) || 1) < 2) {
    // 0.2.0: agents are all equal and none is made by default, so 0.1's agents (and their layout) are
    // cleared. Their sessions stay in sessions.json and can be resumed by an agent added again.
    out = { ...out, version: 2, agents: [], sessionLayout: 'single' }
  }
  if (out.layouts === undefined && out.layout === undefined) {
    // Before agent pages, one layout was set to show every agent whenever one was added. One that does (or
    // none) becomes automatic; any other was chosen by hand and is kept.
    const { sessionLayout: legacy, ...rest } = out
    const count = Array.isArray(rest.agents) ? rest.agents.length : 0
    const chosen = SESSION_LAYOUTS.some((l) => l.value === legacy) && legacy !== layoutForAgents(count)
    out = { ...rest, layout: chosen ? legacy : 'auto' }
  }
  if (out.layout === undefined) {
    // One layout a page (0.3) becomes one for the project (#134): page 1's, else automatic.
    const { layouts, ...rest } = out
    const first = Array.isArray(layouts) ? layouts[0] : undefined
    out = { ...rest, layout: isLayout(first) ? first : 'auto' }
  } else if (out.layouts !== undefined) {
    const { layouts: _old, ...rest } = out
    out = rest
  }
  if (!isLayout(out.layout)) out = { ...out, layout: 'auto' }
  return out
}

/** project.json as written: Claude Code's project settings are also kept in 0.1.x's flat fields. */
export function withLegacyProjectFields(cfg: ProjectConfig): ProjectConfig & Partial<ProjectProviderConfig> {
  const c = cfg.providers?.[CLAUDE_CODE]
  return c ? { ...cfg, model: c.model, effort: c.effort, permissionMode: c.permissionMode, extraArgs: c.extraArgs } : cfg
}

/**
 * A workspace.json or project.json without the skill switches from before 0.2 (`skills.enabled` / `skills.disabled`),
 * which nothing reads: every skill is available to its audience. They go when the file is next saved.
 */
export function withoutSkillSwitches<T extends Record<string, any>>(raw: T): T {
  if (!raw || typeof raw !== 'object' || !('skills' in raw)) return raw
  const { skills: _skills, ...rest } = raw
  return rest as T
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

/**
 * Effort to show next to the model: what the running session reports, else what new sessions use
 * (the agent's or project's choice, then the global default). With none of those, the model's own default when the
 * CLI said what it is ("Medium (default)", models.ts modelCaps); else null.
 */
export function effortLabel(provider: string, live: string | undefined, chosen: string | undefined, global: string | undefined, modelDefault?: string | null, settings?: Pick<AppSettings, 'providers'> | null): string | null {
  // The names the pickers use: the effort fallback as the user named it, else the descriptor's (#230).
  const name = (v: string): string => effortName(provider, v, settings)
  const v = live || (chosen && chosen !== 'inherit' ? chosen : global)
  if (v) return name(v)
  return modelDefault ? `${name(modelDefault)} (default)` : null
}

/** Whether a session record ran in the folder an agent works in (its worktree, or the project folder). */
export function sessionInAgentFolder(projectPath: string, a: Pick<AgentDef, 'worktree'>, rec: Pick<SessionRecord, 'cwd'>): boolean {
  const folder = (a.worktree?.path ?? projectPath).toLowerCase()
  return (rec.cwd ?? projectPath).toLowerCase() === folder
}

/**
 * The session an agent's Resume opens: its last session, else the latest one it ran, else the latest
 * one no current agent owns (its agent was removed, e.g. by the 0.2 upgrade). Archived sessions,
 * sessions from another folder and sessions open in another agent are skipped. Callers pass only
 * records of the agent's provider.
 */
export function resumeRecord<R extends Pick<SessionRecord, 'id' | 'archived' | 'lastActiveAt'> & Partial<Pick<SessionRecord, 'cwd' | 'agentId' | 'sub'>>>(
  projectPath: string,
  a: Pick<AgentDef, 'id' | 'worktree' | 'lastSessionId'>,
  records: R[],
  open: Set<string>,
  agentIds: Set<string> = new Set([a.id])
): R | null {
  const usable = records
    .filter((r) => !r.archived && !r.sub && !open.has(r.id) && sessionInAgentFolder(projectPath, a, r))
    .sort((x, y) => (y.lastActiveAt ?? '').localeCompare(x.lastActiveAt ?? ''))
  return (
    usable.find((r) => r.id === a.lastSessionId) ??
    usable.find((r) => !!a.worktree || r.agentId === a.id) ??
    usable.find((r) => !r.agentId || !agentIds.has(r.agentId)) ??
    null
  )
}

/** What sessionLabel reads: a session record, list item, live session or resume target, with what is known of its titles. */
export interface SessionNaming {
  id: string
  /** Hive's name for it. */
  name?: string | null
  /** The CLI's title (a /rename, else its own). */
  title?: string | null
  /** The CLI's /rename name; undefined when not known (then it doesn't override Hive's name). */
  customTitle?: string | null
  titleAtRename?: string | null
  /** When it started, for sessions with no name yet: the live session's start, else the record's creation. */
  startedAt?: string | null
  createdAt?: string | null
  usage?: { customTitle?: string | null; firstActivity?: string | null } | null
}

/** Hive's automatic name for a new session ("<project> · <agent> · <date>"), which counts as no name. */
export function isAutoSessionName(name: string | null | undefined, projectName: string): boolean {
  return !name || (name.startsWith(`${projectName} · `) && /\d{1,4}[/.-]\d{1,2}/.test(name))
}

/**
 * The name the session was given in the CLI (/rename) when it is newer than Hive's: Hive's name is automatic, or
 * the CLI's changed after the session was last renamed in Hive. Null when Hive's name stands. Hive passes its own
 * name to the CLI at launch (Claude Code's --name), so a CLI name that is Hive's, or automatic, is no rename.
 */
export function cliRename(s: SessionNaming, projectName: string): string | null {
  const custom = s.customTitle !== undefined ? s.customTitle : s.usage?.customTitle
  if (!custom || custom === s.name || isAutoSessionName(custom, projectName)) return null
  if (isAutoSessionName(s.name, projectName)) return custom
  return s.titleAtRename !== undefined && custom !== s.titleAtRename ? custom : null
}

/**
 * Whether one turn's output (thinking included) explains a compaction: at least 20K tokens, and at least half of the
 * jump from what the context showed before that turn (its input) to where it was compacted. The context gauge showed the
 * input, so without this the compaction looks early (#154).
 */
export function turnPushedCompaction(c: Pick<CompactionEvent, 'preTokens' | 'lastInputTokens' | 'lastOutputTokens'>): boolean {
  const out = c.lastOutputTokens ?? 0
  return out >= 20_000 && out * 2 >= c.preTokens - (c.lastInputTokens ?? c.preTokens)
}

/**
 * A session's display name. The latest rename wins: a name given in Hive, until the CLI's own name (/rename)
 * changes after it; then the CLI's. Without either, the CLI's title, else when the session started ("2026-10-04 14:05",
 * in the user's date and time format).
 */
export function sessionLabel(s: SessionNaming, projectName: string): string {
  const cli = cliRename(s, projectName)
  if (cli) return cli
  if (!isAutoSessionName(s.name, projectName)) return s.name!
  if (s.title && !isAutoSessionName(s.title, projectName)) return s.title
  const at = s.startedAt || s.createdAt || s.usage?.firstActivity
  return (at && formatDateTime(at)) || `Session ${s.id.slice(0, 8)}`
}

/**
 * A worktree agent's work not yet merged, for its Merge… button and tab: `badge` is the number of commits
 * (• when there are only uncommitted files, null when there is nothing to merge) and `text` says it in words.
 */
export function unmergedWork(st: AgentBranchStatus | null | undefined): { badge: string | null; text: string } | null {
  if (!st) return null
  const into = st.into ?? st.base
  const parts: string[] = []
  if (st.ahead > 0) parts.push(`${st.ahead} commit${st.ahead === 1 ? '' : 's'} not merged into ${into}`)
  if (st.dirty > 0) parts.push(`${st.dirty} uncommitted file${st.dirty === 1 ? '' : 's'}`)
  if (!parts.length) return { badge: null, text: `Nothing to merge into ${into}` }
  return { badge: st.ahead > 0 ? String(st.ahead) : '•', text: parts.join(' · ') }
}

/** Where Hive's releases (and its update feed) are published. */
export const RELEASES_URL = 'https://github.com/Suremise/hive-desktop/releases'

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
    if (mods.join('+') === 'Shift' && k === 'Tab') return "Shift+Tab switches modes inside the agents' terminals."
    if (!mods.length && k === 'Escape') return 'Escape closes dialogs and interrupts the agent.'
  }
  return null
}
