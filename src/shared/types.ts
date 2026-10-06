// Types shared by the main process, preload bridge and renderer.

import type { StartFailure } from './startFailure'
import type { TipsState } from './tips'
import type { TemplateAgent, TemplateScope } from './templates'
import type { KeepAwakeSetting } from './keepAwake'
import type { DateFormat, TimeFormat } from './dates'
import type { ProjectPref } from './uiPrefs'

export type ThemeSetting = 'dark' | 'light' | 'system'
/** A coding-agent CLI Hive can run ("claude-code", "codex"). See src/shared/providers.ts. */
export type ProviderId = string
/** A permission mode id from the agent's provider (e.g. Claude Code's "auto", Codex's "approve-for-me"). */
export type PermissionMode = string
/** A reasoning effort id from the agent's provider (e.g. "low", "high", "max"). */
export type EffortLevel = string
export type ChimeSound = 'chime' | 'bell' | 'soft' | 'pop'
/** Settings → Notifications, *While Hive is focused*: Show in Hive, Show nothing, or a Windows notification. */
export type WhileFocused = 'inApp' | 'nothing' | 'windows'
/** Settings → Notifications, *Show banners for*. */
export type BannerScope = 'all' | 'workspace' | 'project'
export type BannerPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

/** A notice shown as a banner in the focused window (#157): an agent finished or waiting, or another notice. */
export interface Notice {
  id: string
  kind: 'finished' | 'waiting' | 'notice'
  title: string
  body: string
  /** The project it is about (null: app-wide, such as plan usage); clicking the banner shows it. */
  projectPath: string | null
  /** The agent waiting, for a waiting banner to close once it is answered. */
  agentId?: string
}
export type CacheTtlSetting = 'auto' | '5m' | '1h'

export type QuitConfirm = 'working' | 'always' | 'never'
/** What Hive does when an agent edits a file another agent in the same folder is editing. */
export type FileLockMode = 'off' | 'warn' | 'block' | 'ask'
export type MergeStyle = 'squash' | 'merge'
/** How the Session tab arranges the agents of one page. */
export type SessionLayout = 'single' | 'columns2' | 'columns3' | 'grid' | 'grid6'
/** A project's layout as saved: 'auto' is the one that shows its agents, up to the 3×2 grid (until one is chosen by hand). */
export type PageLayout = SessionLayout | 'auto'
/** 'window': quitting was asked, but only the window showing the question closes (Close this window only). */
export type QuitChoice = 'now' | 'wait' | 'cancel' | 'window'
/** What the quit dialog is for: quitting, closing a window, closing its workspace, or switching the window to another workspace. */
export type QuitScope = 'app' | 'window' | 'workspace' | 'switch'

/** A running session listed in the quit dialog. */
export interface QuitSession {
  projectPath: string
  project: string
  status: SessionStatus
  /** The agent's name, when the project has more than one. */
  agent?: string
  /** The name of the workspace it runs in (its folder's), shown over its group when several windows are open. */
  workspace?: string
  /** That workspace's full path: the quit dialog groups agents by it, so two workspaces with the same name stay apart. */
  workspacePath?: string
  provider?: ProviderId
  /** A watching agent: what it waits for ("Waiting for #12 → Review"). */
  watch?: string
  /** It keeps "Quit when agents finish" waiting: a card it watches is being worked on by another agent. */
  keepsQuitWaiting?: boolean
}

export type UpdateInstallMode = 'auto' | 'manual'

/** Command id → key combination ("Mod+Shift+P", chords as "Mod+K Mod+S"); null removes the default. */
export type KeybindingOverrides = Record<string, string | null>

export interface AppSettings {
  /** The user's changes to the default keyboard shortcuts. */
  keybindings: KeybindingOverrides
  updates: {
    checkAutomatically: boolean
    downloadAutomatically: boolean
    /** auto: a downloaded update installs when Hive quits. manual: only with Restart and Update. */
    install: UpdateInstallMode
    prerelease: boolean
  }
  general: {
    closeToTray: boolean
    minimizeToTray: boolean
    startMinimized: boolean
    launchAtLogin: boolean
    reopenLastWorkspace: boolean
    /** When to ask before quitting while sessions run. Older configs stored a boolean (migrated on load). */
    confirmOnQuit: QuitConfirm
    /** A tip when Hive starts (at most one a day), and at the moments a tip helps. Help → Tips… has them all. */
    showTips: boolean
    /** Keep Windows from sleeping while agents work: only on mains power, always, or never. */
    keepAwake: KeepAwakeSetting
    /** The Progress panel (long runs agents report, with taskbar progress). Off: reports are accepted and ignored. */
    progressPanel: boolean
    /**
     * Agents run long commands (about 30 s or more) through hive-progress without being asked, so they show in the
     * panel: Hive's session guidance says so. Off, or with the panel off: only when the user asks. New sessions.
     */
    progressCommands: boolean
    /** How dates show everywhere in Hive (session names, lists, tooltips, exports): 2026-10-04 by default. */
    dateFormat: DateFormat
    /** How times show with them: 24-hour (14:05) by default. */
    timeFormat: TimeFormat
  }
  appearance: {
    theme: ThemeSetting
    uiFontSize: number
    terminalFontFamily: string
    terminalFontSize: number
    terminalScrollback: number
    terminalCursorBlink: boolean
  }
  /** Each provider's settings, keyed by provider id. Providers start disabled on a fresh install. */
  providers: Record<ProviderId, ProviderSettings>
  /** The provider Add Agent's quick add uses unless the project says otherwise. */
  defaultProvider: ProviderId
  notifications: {
    chimeEnabled: boolean
    chimeSound: ChimeSound
    chimeVolume: number
    desktopNotifications: boolean
    notifyOnFinished: boolean
    notifyOnWaiting: boolean
    /** While a Hive window is focused: a banner in it, nothing, or a Windows notification (shared/bursts.ts noticeRoute). */
    whileFocused: WhileFocused
    /** Which notices the focused window shows as banners: from every window, its workspace, or the project it shows. */
    bannerScope: BannerScope
    bannerPosition: BannerPosition
    /** How long a banner for a finished agent (or another notice) stays, in seconds; kept while the pointer is on it. */
    bannerSeconds: number
    /** Banners for an agent waiting for you stay until handled (clicked, dismissed or answered); off: they close like the others. */
    waitingBannerStays: boolean
    /** A badge with the count of agents that need you on the window's taskbar button, and the count in its title. */
    taskbarCount: boolean
    /** Flash the taskbar button when an agent starts waiting for your input and the window isn't focused. */
    flashOnWaiting: boolean
  }
  sessions: {
    backupTranscripts: boolean
    cacheTtl: CacheTtlSetting
    confirmStop: boolean
    /** Context size (tokens) above which Compact is highlighted. 0 never highlights. */
    compactSuggestTokens: number
    /** A running session's transcript over this many MB is flagged (footer, notification): long ones slow the CLI and Hive. 0 never. */
    transcriptWarnMB: number
    /** How many transcripts' usage Hive keeps, in memory and in usage-cache.json, so a restart doesn't read them again. */
    usageCacheSize: number
    /** The Sessions tab's transcript of a running session follows new messages without a Refresh. */
    followTranscripts: boolean
    /** How the Overview and the session lists update: as sessions change (at most every 15 s), every minute, or on Refresh. */
    overviewRefresh: 'live' | 'minute' | 'manual'
    /** Hive counts what its Agent API, tools, guidance and skill service cost (aggregates only), per workspace. */
    recordPerformance: boolean
  }
  agentApi: {
    enabled: boolean
    port: number
    provideHiveMcp: boolean
    allowSessionInput: boolean
  }
  /** The Hive Assistant's defaults (each workspace's Assistant Settings can override them). */
  assistant: AssistantSettings
  agents: {
    /** Per-file locks between agents working in the same folder. */
    fileLocks: FileLockMode
    /** Git-ignored files copied into new worktrees: glob patterns, one per line or comma separated. */
    worktreeCopy: string
    /** Default for merging a worktree agent's branch. */
    mergeStyle: MergeStyle
    /** How long a background task an agent started counts as running if it never reports its end, in minutes. */
    backgroundTaskMinutes: number
  }
  board: {
    /** Done cards are archived this many days after they went into Done. 0 never. */
    archiveDoneDays: number
    /** Colour each column's heading and tint its cards. */
    columnColors: boolean
    /** The columns' colours (#rrggbb). */
    colors: Record<TaskColumn, string>
  }
}

export type AssistantPanelSide = 'right' | 'left'

/** The Hive Assistant's defaults: its provider, its persona and, per provider, its model, effort, mode and arguments. */
export interface AssistantSettings {
  /** '' follows the default provider. */
  provider: ProviderId | ''
  /** The persona new conversations use (a file in the workspace's .hive/personas, without .md). */
  persona: string
  /** What the Assistant may do beyond looking (see AssistantControl). */
  control: AssistantControl
  /** Seconds after the user types in an agent's terminal before the Assistant may type there (0: no pause). */
  typingPause: number
  /** The user pressing Enter (sending what they typed) ends that pause. */
  enterEndsPause: boolean
  /** Which side of the window its panel is on (the same in every workspace and window). */
  panelSide: AssistantPanelSide
  providers: Partial<Record<ProviderId, AssistantProviderSettings>>
}

/**
 * How far the Hive Assistant may act: only look and advise; also run the agents (add, change, start, stop and
 * prompt them); or that and create projects. It never removes agents, discards worktrees or deletes projects.
 */
export type AssistantControl = 'look' | 'agents' | 'projects'

/** Something the Hive Assistant did (or tried), for the list in its panel and hive.log. */
export interface AssistantAction {
  id: string
  at: string
  /** One line, e.g. "Started Agent 2 in hive". */
  text: string
  ok: boolean
  /** Why it failed or was refused. */
  error?: string
}

/** A question the Hive Assistant's action is waiting on (e.g. stopping a busy agent), shown as a card in its panel. */
export interface AssistantQuestion {
  id: string
  title: string
  message: string
  yes: string
  no: string
}

/** Empty values follow the provider's own settings; an empty permission mode is the provider's assistantMode (reads freely, asks before changing anything). */
export interface AssistantProviderSettings {
  model: string
  effort: EffortLevel | ''
  permissionMode: PermissionMode | ''
  extraArgs: string
  /** Run with a 200K context window instead of the model's 1M one (capabilities.contextLimit); '' follows the provider's settings. */
  use200kContext: '' | 'on' | 'off'
}

/** A persona the Hive Assistant can take: a Markdown file of instructions in the workspace's .hive/personas. */
export interface PersonaInfo {
  /** The file name without .md. */
  id: string
  name: string
  description: string
  /** An emoji or short mark shown beside the name. */
  icon: string
  /** The file; for a bundled persona missing from the workspace, its copy in Hive's installation. */
  path: string
  /** Personas that ship with Hive: the workspace copy matches Hive's, was changed, or isn't in the workspace. */
  bundled?: 'same' | 'changed' | 'missing'
  /** A changed copy of an older version of Hive's: reverting it also brings in this version's. */
  updateAvailable?: true
}

/** API prices for one model, in USD per million tokens (for estimated costs). */
export interface ModelPrice {
  input: number
  cachedInput: number
  cacheWrite?: number
  output: number
}

export interface ProviderSettings {
  enabled: boolean
  executablePath: string
  defaultModel: string
  defaultEffort: EffortLevel | ''
  defaultPermissionMode: PermissionMode
  /** The provider's no-guardrails mode (Claude Code's Bypass, Codex's Full Access) can be chosen. */
  enableDangerousMode: boolean
  extraArgs: string
  checkUpdatesOnLaunch: boolean
  /** Let sessions move into the CLI's own background service (capabilities.backgroundSessions). Off: Hive turns it off. */
  allowBackgroundSessions: boolean
  /** Run sessions with a 200K context window instead of the model's 1M one (capabilities.contextLimit). */
  use200kContext: boolean
  /** The user's price overrides by model id; missing models use the prices Hive ships. */
  prices: Record<string, ModelPrice>
  /** Shipped prices the user removed from the table (a model of their own in `prices` wins). */
  pricesRemoved?: string[]
  /**
   * The models offered when the CLI can't be asked (not installed, too old, an odd reply), as the user edited them;
   * absent: the descriptor's. Only an edited list is stored, so improved shipped defaults reach everyone else.
   */
  modelFallback?: FallbackModel[]
  /** The effort levels offered when the CLI doesn't report a model's own, as the user edited them; absent: the descriptor's. */
  effortFallback?: EffortOption[]
}

/** An effort level and what to call it. */
export interface EffortOption {
  value: EffortLevel
  label: string
}

/** A model of the fallback list (Settings → provider → Models): older ones are behind "Show older versions". */
export interface FallbackModel {
  value: string
  label: string
  older?: boolean
}

/**
 * A model as the provider's CLI describes it (Claude Code's initialize reply, codex debug models). A field the CLI
 * doesn't report is absent, and Hive falls back for it.
 */
export interface CatalogModel {
  /** What to pass to the CLI (an alias such as "opus", or a model id). */
  value: string
  label: string
  /** The id an alias stands for ("claude-opus-5-5"), when the CLI says. */
  resolved?: string
  description?: string
  /** The effort levels the model takes ([]: none, it has no effort setting); absent: not reported. */
  efforts?: EffortLevel[]
  /** The effort the CLI uses with it when none is chosen, when the CLI says. */
  defaultEffort?: EffortLevel
  /** Whether the CLI runs it in its automatic mode (Claude Code's Auto); absent: not reported. */
  supportsAuto?: boolean
  /** Listed by the CLI as not available to this account. */
  unavailable?: boolean
}

/** The models a CLI reported, and which version of it said so. */
export interface ModelCatalog {
  /** cli: read just now; cache: the last good reply from this version, while a fresh read runs. */
  source: 'cli' | 'cache'
  version: string | null
  models: CatalogModel[]
  /** The model the CLI runs when none is passed, when it says (Claude Code's "default" entry). */
  defaultModel?: string
  /** When it was read (ISO). */
  at: string
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  /** 6 since notices show in Hive while it is focused; 3 since the Assistant uses the agents' model and effort (0.3.0); 2 since providers (0.2.0); 1 was Claude Code only. */
  version: 6
  settings: AppSettings
  recentWorkspaces: string[]
  /** The workspace of the window focused last (what 0.1 reopened); `windows` has every window. */
  lastWorkspace: string | null
  /** Active project names, keyed by workspace path. */
  activeProjects: Record<string, string[]>
  /** The last focused window's size and place, for a new window. */
  window: WindowState
  /** The windows open when Hive last quit, each with its workspace (null: the welcome page), reopened at start. */
  windows?: (WindowState & { workspace: string | null })[]
  /** Always on Top: the workspaces (lowercased paths) whose window was left pinned. This machine's, never in .hive. */
  alwaysOnTop?: Record<string, true>
  /** `panes`: resizable pane sizes by key (pixels, or a fraction for split views). `tips`: what the tips know (shared/tips.ts). */
  ui: {
    sidebarWidth: number
    sidebarVisible: boolean
    sidebarCompact?: boolean
    panes?: Record<string, number>
    tips?: TipsState
    /** The provider each project's Skills tab last showed, by project path in lower case (#118). */
    skillsProvider?: Record<string, ProviderId>
    /** Each project's Skills tab groups as the user last left them open or folded, by project path in lower case (#118). */
    skillsFold?: Record<string, { hive?: boolean; provider?: boolean }>
    /** Each project's Sessions tree branches the user opened (true) or folded (false), by project path in lower case (#239). */
    sessionsTree?: Record<string, Record<string, boolean>>
    /** Each workspace's board as the user left it, by workspace path in lower case (#170): collapsed columns, folded cards. */
    boardFold?: Record<string, BoardFold>
    /** Each workspace's Progress panel filter (#251), by workspace path in lower case: one project's runs (and agent's), or all. */
    progressFilter?: Record<string, { project: string; agent?: string }>
  }
  /** Per provider: the model last seen in a session started without a model choice (the CLI's own default). */
  observedDefaultModel: Record<ProviderId, string>
  /**
   * Per provider and model: the effort last seen in a session started without an effort choice (the CLI's own default
   * for that model, for CLIs that don't report it otherwise).
   */
  observedDefaultEffort?: Record<ProviderId, Record<string, EffortLevel>>
  /** Per provider: the last good model catalog its CLI gave, keyed by the CLI version, so pickers fill at once on start. */
  modelCatalogs?: Record<ProviderId, ModelCatalog>
  /** Per provider: the plan usage it last reported (account-wide). */
  planUsage: Record<ProviderId, PlanUsage>
  /** Highest warning shown per "provider:limit", and for which reset period. */
  planWarnings: Record<string, { resetsAt: string | null; level: number }>
  /** A version the user chose to skip; automatic checks don't offer it. */
  skippedUpdate?: string
  /** Version that last ran, to say "Hive updated" once after an update. */
  lastRunVersion?: string
}

export interface PlanLimit {
  /** Stable id within the provider, e.g. "five_hour", "seven_day". */
  id: string
  /** "5-hour", "weekly". */
  label: string
  windowMinutes: number | null
  usedPercent: number
  resetsAt: string | null
}

/** Subscription limits a provider reported (e.g. a rolling 5-hour window and a weekly limit). */
export interface PlanUsage {
  provider: ProviderId
  /** The plan's name when the provider says (e.g. "plus"). */
  plan: string | null
  limits: PlanLimit[]
  updatedAt: string
}

export interface WorkspaceConfig {
  version: 1
  /** Where the workspace was last opened (#146): a different folder now means it was moved, and Repair… is offered. */
  lastPath?: string
  mcp: { enabled: string[] }
  /** Project folders Hive leaves out (Hide, or Remove from Hive while the folder is still in the workspace), by folder name. */
  hiddenProjects?: HiddenProject[]
}

/** A project folder Hive leaves out of the workspace, until it's restored in Settings → Workspace. */
export interface HiddenProject {
  name: string
  /** hidden: everything left where it is. removed: its workspace files were packed into the folder's .hive/removed. */
  mode: 'hidden' | 'removed'
  at: string
}

// ---------------------------------------------------------------------------
// Task board: one per workspace, a card per file in .hive/tasks.
// ---------------------------------------------------------------------------

/** On Hold, Todo, Doing, Review, Passed, Done (#170): Passed is reviewed and waiting to be merged, Done is merged. */
export type TaskColumn = 'hold' | 'todo' | 'doing' | 'review' | 'passed' | 'done'

/** A board as the user left it (a view preference, never in the cards' files): collapsed columns and folded cards. */
export interface BoardFold {
  columns?: TaskColumn[]
  cards?: number[]
}

export interface TaskComment {
  at: string
  /** "You", "Assistant", or an agent ("Agent 2 (Claude Code) in hive"). */
  by: string
  text: string
  /** Unique on the card (#224): what a card watch counts its view of the card by. Comments from before have none. */
  id?: string
}

export interface TaskHistoryEntry {
  at: string
  by: string
  what: string
  /** Unique on the card (#224), as a comment's. */
  id?: string
}

export interface TaskCard {
  /** #number, unique in the workspace and never reused. */
  number: number
  title: string
  /** Markdown. */
  description: string
  /** The project's folder name; '' for a card about the workspace. */
  project: string
  /** The agent working on it (its id in the project), if any. */
  agent: string | null
  /** The agent's name when it was assigned, for when the agent is gone. */
  agentName?: string
  /**
   * An agent reviewing it now, apart from the agent that has it (who did the work): from its review "start" to its
   * verdict, while the card stays in Review. Absent when nobody is (and in cards from before reviews were marked).
   */
  review?: TaskReview
  column: TaskColumn
  /** Position in its column, smallest first. */
  order: number
  labels: string[]
  /** Why it can't go on, when it can't (shown in red in any column). */
  blocked: string | null
  /** Cards that have to be done first. */
  blockedBy: number[]
  /** Related cards. */
  links: number[]
  comments: TaskComment[]
  history: TaskHistoryEntry[]
  /** Hidden from the board, kept and searchable. */
  archived: boolean
  /**
   * Who archived it: the user, Hive after its days in Done (Settings → Board), or its project being hidden or
   * removed (restoring the project brings those back).
   */
  archivedFor?: 'user' | 'done' | 'project-hidden' | 'project-removed'
  createdAt: string
  createdBy: string
  updatedAt: string
}

/** An agent reviewing a card (TaskCard.review). */
export interface TaskReview {
  /** The reviewing agent's id in the card's project, and its name then. */
  agent: string
  agentName: string
  /** When it started (ISO). */
  since: string
}

/** What a change to a card may set (the board's own fields: number, history and dates are Hive's). */
export interface TaskPatch {
  /**
   * An agent reviewing the card (in Review): "start" marks it as reviewing it, "passed" or "failed" ends the review
   * with its verdict. The card keeps the agent that did the work.
   */
  review?: 'start' | 'passed' | 'failed'
  title?: string
  description?: string
  project?: string
  agent?: string | null
  column?: TaskColumn
  /** Before this card in the column (null: at the end). Only with column or on its own to reorder. */
  before?: number | null
  /** At the top or the bottom of the column (instead of before). */
  position?: 'top' | 'bottom'
  labels?: string[]
  blocked?: string | null
  blockedBy?: number[]
  links?: number[]
}

/** Which agent Start gives a card to. */
export type TaskStartTarget = { kind: 'agent'; agentId: string } | { kind: 'new-agent'; worktree: boolean; name?: string; provider?: ProviderId }

/** How a project leaves Hive (the main menu's Project → Remove Project…). */
export type ProjectRemoval = 'hide' | 'remove' | 'delete'

/** What removing a project touches, for its dialog. */
export interface ProjectRemovalInfo {
  name: string
  path: string
  /** Running agents, which are stopped first. */
  running: number
  /** Its handovers in the shared notes. */
  handovers: string[]
  /** Its board cards (not archived / archived). */
  cards: number
  archivedCards: number
  /** Worktree agents: their folder, and work not merged into the project folder (commits ahead, uncommitted files). */
  /** `error`: git couldn't check it, which counts as holding work. */
  worktrees: { agent: string; path: string; branch: string; ahead: number; dirty: number; error?: string }[]
}

/** A project folder holding what Remove from Hive packed into its .hive/removed. */
export interface RemovedData {
  at: string
  workspace: string
  handovers: number
  cards: number
}

export type Inherit<T> = 'inherit' | T

export interface ProjectConfig {
  /** 2 since 0.2.0: agents are all equal and a project starts with none (0.1's agents are cleared). */
  version: 2
  /** Project-scoped shortcut overrides (project, session and agent commands), over the global ones. */
  keybindings?: KeybindingOverrides
  mcp: { disabled: string[] }
  chime: 'inherit' | 'on' | 'off'
  /** The provider new agents get (Add Agent's quick add); inherit uses the global default. */
  defaultProvider: Inherit<ProviderId>
  /** The project's settings per provider, over the global ones. */
  providers: Record<ProviderId, ProjectProviderConfig>
  /** Overrides settings.sessions.compactSuggestTokens for this project; null inherits. */
  compactSuggestTokens: number | null
  /** Overrides settings.sessions.transcriptWarnMB for this project; null inherits. */
  transcriptWarnMB: number | null
  /** The project's agents, in the order they were added. All are equal; a new project has none. */
  agents: AgentDef[]
  /** The Session tab's layout (one for the project, #134); its pages hold as many agents as it has panes. */
  layout: PageLayout
  /** Where the project folder was last opened (#146), as workspace.json's lastPath. */
  lastPath?: string
  /**
   * Folders that moved (an agent's worktree repaired or recreated at a new place) whose CLI data (copyPathData) isn't
   * all copied yet (#146): kept until a copy works, so Repair tries again, after a restart too.
   */
  pendingCopies?: { from: string; to: string; of: string }[]
  fileLocks: Inherit<FileLockMode>
  /** Overrides settings.agents.worktreeCopy; null inherits. */
  worktreeCopy: string | null
  /** Command run in a new worktree before its agent's first session, e.g. "npm install". */
  worktreeSetup: string
}

export interface ProjectProviderConfig {
  model: string // 'inherit' or a model alias / id
  effort: Inherit<EffortLevel>
  permissionMode: Inherit<PermissionMode>
  extraArgs: string
  /** 200K context instead of 1M (capabilities.contextLimit). */
  use200kContext: Inherit<'on' | 'off'>
}

/** A worktree an agent works in: its own checkout of the project on its own branch. */
export interface AgentWorktree {
  path: string
  branch: string
  /** Branch it was created from, and merges back into. */
  base: string
}

/** One of a project's (up to twelve) agents. Settings left undefined follow the project's. */
export interface AgentDef {
  /** Random and never reused, so session records of removed agents don't attach to new ones. */
  id: string
  name: string
  /** The CLI this agent runs. Always stored when the agent is added. */
  provider?: ProviderId
  worktree?: AgentWorktree
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /** 200K context instead of 1M (capabilities.contextLimit). */
  use200kContext?: boolean
  /** Session to resume for this agent. */
  lastSessionId?: string
  /** The worktree's setup command hasn't run successfully yet. */
  needsSetup?: boolean
  /** The Hive Assistant only: this workspace's persona, over Settings → Assistant. */
  persona?: string
  /** What the agent is for ("builder", "reviewer"; free text, #126): saved in templates; empty, its name is its role. */
  role?: string
}

/** A change to an agent's settings: empty values (null for use200kContext) clear an override so it follows the project. */
export type AgentPatch = Partial<Pick<AgentDef, 'name' | 'provider' | 'model' | 'effort' | 'permissionMode' | 'persona' | 'role'>> & { use200kContext?: boolean | null }

/** What loading a template into a project would do (#126), and what stops it now. */
export interface TemplateLoadPlan {
  scope: TemplateScope
  file: string
  name: string
  layout: PageLayout
  /** The project's agents, all removed: running ones and uncommitted worktree work block the load. */
  remove: { id: string; name: string; running: boolean; dirty: number; worktree?: { path: string; branch: string } }[]
  create: TemplateAgent[]
  /** Providers the template needs that are off or not installed, and which of its agents need each. */
  missing: { provider: ProviderId; reason: string; agents: string[] }[]
  /** Why it can't be loaded now (empty: it can). */
  blocked: string[]
}

export interface AgentInfo extends AgentDef {
  live: LiveSessionState | null
  restartNeeded: boolean
  /** The session Resume opens for this agent while it isn't running (null: nothing to resume). */
  resume: ResumeTarget | null
}

export interface ResumeTarget {
  id: string
  name: string
  lastActiveAt: string
  createdAt?: string
  titleAtRename?: string | null
}

export interface AddAgentOptions {
  name?: string
  location: 'project' | 'new-worktree' | 'existing-worktree'
  /** new-worktree: branch to create (default hive/<name>) and the branch to base it on (default the current one). */
  branch?: string
  base?: string
  /** existing-worktree: its folder. */
  worktreePath?: string
  provider?: ProviderId
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  use200kContext?: boolean
  role?: string
}

export interface ProjectGitInfo {
  isRepo: boolean
  current: string | null
  branches: string[]
  /** Worktrees of the project other than the project folder, and whether an agent uses them. */
  worktrees: { path: string; branch: string | null; used: boolean }[]
  /** Where new worktrees are created. */
  worktreesRoot: string
}

/** A worktree agent's branch compared with the branch it merges into. */
export interface AgentBranchStatus {
  branch: string
  base: string
  /** The project folder's current branch, which a merge goes into. */
  into: string | null
  /** Commits on the branch that aren't in `into`. */
  ahead: number
  /** Uncommitted changes in the worktree. */
  dirty: number
  /** What a merge would bring (unmerged commits and tracked uncommitted changes): files changed, lines added and removed. */
  diff?: { files: number; insertions: number; deletions: number }
}

export interface MergeResult {
  ok: boolean
  /** Files that would conflict; nothing was changed. */
  conflicts?: string[]
  error?: string
  /** The worktree and branch were removed afterwards. */
  cleanedUp?: boolean
  /** After a squash merge, the agent's branch was moved to the merged branch; or why it wasn't. */
  branchMoved?: boolean
  moveError?: string
}

export interface SessionRecord {
  id: string
  /** The provider that ran it ("claude-code", "codex"). The field name predates providers. */
  agent: ProviderId
  name: string
  createdAt: string
  lastActiveAt: string
  archived: boolean
  /** The agent that ran it (absent in records from 0.1's Agent 1, and in adopted sessions). */
  agentId?: string
  /** That agent's name then, so a session still says whose it was after the agent is removed (absent in older records). */
  agentName?: string
  /** Folder it ran in, when not the project folder (a worktree). Claude Code files transcripts by folder. */
  cwd?: string
  branch?: string
  /** Where the provider keeps the transcript, when it can't be found from the folder (Codex). */
  transcriptPath?: string
  /** The session whose work was handed over to this one ("Hand Over to…"). */
  handedOverFrom?: string
  /**
   * Board cards its agent had in Doing while it ran, in order, with the title each had then; `review`: one it reviewed
   * (TaskCard.review) rather than worked on.
   */
  cards?: { number: number; title: string; review?: true }[]
  /**
   * The CLI's own name for the session (SessionUsage.customTitle) when it was last renamed in Hive, null when it had
   * none. Once the CLI's name changes from this (a /rename since), it is the newer rename and wins (sessionLabel).
   */
  titleAtRename?: string | null
  /**
   * What it used, saved when Clean Up removed Hive's backup of it (the CLI still had the transcript): totals keep
   * counting it once the CLI's copy is gone too.
   */
  keptUsage?: SessionUsage
  /** A session the CLI started for another one (e.g. a Codex guardian review), kept when it was adopted. */
  sub?: SubSession
}

/**
 * A session a CLI started for another one rather than a conversation of its own: Codex's guardian reviews (it starts
 * one to judge each action in Approve for me) and other sub-agent sessions. Read from the transcript's first line by
 * the provider's adapter. `parentId`: the session that started it (null when the CLI doesn't say); `kind`: what it is,
 * for labels ("guardian review", "sub-agent").
 */
export interface SubSession {
  parentId: string | null
  kind: string
}

/** What a bulk action on the Sessions tab does to each session (session:bulk). */
export type SessionBulkAction = 'archive' | 'unarchive' | 'delete'

/**
 * Why a bulk action left a session alone: `live`: running (in any window); `in-use`: its files are in use (its CLI
 * still writing its transcript, or another program holding the CLI's transcript or Hive's copy open); `reading`: Hive
 * is reading its transcript (an export, a search); `open`: its transcript is open in a Hive window (the window asking
 * closes its own view first);
 * `external`: started outside Hive, so Hive has nothing of it to archive; `failed`: anything else (`message` says what).
 */
export type SessionSkipReason = 'live' | 'in-use' | 'reading' | 'open' | 'external' | 'failed'

export interface SessionBulkResult {
  done: string[]
  skipped: { id: string; reason: SessionSkipReason; message?: string }[]
}

/** background: the agent's turn has ended, but it has background tasks that will start it again when they end. */
/**
 * `watching`: its turn has ended and it waits on cards (a wake-on-change watch, #128): Hive types one line to wake it
 * when a watched card changes. It runs nothing meanwhile, but it isn't idle: nothing else is given to it.
 */
export type SessionStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'waiting' | 'background' | 'watching' | 'finished' | 'error'

/** An agent's wake-on-change watch, as its state shows it: the cards and condition, since when, and its overall limit. */
export interface TaskWatchInfo {
  cards: number[]
  changes: ('column' | 'comment' | 'verdict' | 'agent')[]
  column?: TaskColumn
  /** "Waiting for #12 → Review". */
  label: string
  since: string
  /** When Hive wakes it to say nothing changed (ISO). */
  limitAt: string
}

export interface LiveSessionState {
  provider: ProviderId
  /** This launch, until the process exits; hooks name it so they reach the right agent. */
  runId: string
  projectPath: string
  /** Which of the project's agents this is. */
  agentId: string
  agentName?: string
  /** Folder the session runs in: the project folder or the agent's worktree. */
  cwd: string
  /** The provider's session id. Empty until the provider reports it, for providers that choose it themselves. */
  sessionId: string
  /** The mode the session is actually in: from launch, Hive's live switches, Shift+Tab in the terminal (its footer) and hooks. */
  permissionMode?: PermissionMode
  /**
   * The mode the CLI itself last showed (its footer, a hook, its transcript); absent until it has shown one. The
   * mode Hive shows (permissionMode) starts as the one asked for at launch, so this says it was seen (#234).
   */
  modeObserved?: PermissionMode
  /** The session's name in Hive (renamable in the Sessions tab and the agent's footer). */
  sessionName?: string
  /** See SessionRecord.titleAtRename. */
  titleAtRename?: string | null
  status: SessionStatus
  /** When the status last changed (ISO): how long an agent has been waiting or finished. */
  statusSince?: string
  statusMessage?: string
  /** An action under the CLI's automatic review (Codex's Approve for me), as asked ("Codex asks to run …"): shown beside the status, never as it. */
  review?: string
  /**
   * A question the agent asked without stopping for it (Codex's request_user_input_async): it carries on working
   * and takes the answer when it comes. It needs you (the attention inbox) until answered.
   */
  question?: { text: string; since: string }
  pid?: number
  startedAt: string
  /** Effective settings the session launched with — used to detect "restart to apply". */
  launchSignature: string
  /**
   * What it was given at launch (GET /v1/projects/{name}): Hive's guidance revision, the content hash of each Hive skill's
   * copy it reads, and why a skill isn't as asked for (a folder of the user's has its name, an old copy kept while in use).
   */
  launched?: { guidance: string; skills: Record<string, string>; problems?: Record<string, string> }
  /** Finished or waiting since its pane was last on screen in a focused window (the renderer marks it seen). */
  unseen: boolean
  /** Its wake-on-change watch, while it has one (status `watching` while its turn has ended). */
  watch?: TaskWatchInfo
  /** Reported by the provider once the session has started. */
  effort?: string
  modelName?: string
  /** The model's id as the session reports it (Claude Code's status line, Codex's rollout): what the footer shows (#248). */
  modelId?: string
  /** API-equivalent cost of the session so far, in USD. */
  costUsd?: number
  /** The model's context window in tokens, as the provider reports it for the running session (Claude Code's status line). */
  contextWindow?: number
  /** costUsd was estimated by Hive from token counts, not reported by the provider. */
  costEstimated?: boolean
  /** A live permission-mode change Hive has asked for and is waiting to see confirmed. */
  modeSwitching?: PermissionMode
  /** Codex's Plan mode, which is separate from its permission preset. */
  planMode?: boolean
  /** Files this agent has claimed by editing them (relative to its folder), while locks are on. */
  lockedFiles?: string[]
  /** The worktree's setup command is running before the agent starts. */
  settingUp?: boolean
  /** Background tasks the agent started that are still running (commands, Monitors, Codex's background terminals). */
  backgroundTasks?: number
  /** The running conversation's transcript size in bytes, once the provider has written one. */
  transcriptBytes?: number
}

export interface ProjectInfo {
  name: string
  path: string
  active: boolean
  isGitRepo: boolean
  branch: string | null
  config: ProjectConfig
  /** The first running agent's session. */
  live: LiveSessionState | null
  /** True when the project's effective settings differ from the live session's launch settings. */
  restartNeeded: boolean
  /** Every agent, in the order added, with its running session. */
  agents: AgentInfo[]
  /** MCP servers defined in the project's own config (.mcp.json, .codex/config.toml) that are not deployed to the workspace. */
  unmanagedMcp: string[]
  /** The folder holds what Remove from Hive packed (handovers, board cards), which Hive offers to restore. */
  removedData?: RemovedData | null
}

export interface WorkspaceInfo {
  path: string
  name: string
  config: WorkspaceConfig
  projects: ProjectInfo[]
  /**
   * The Hive Assistant, the workspace's overseer: a session host like a project (its home is .hive/assistant,
   * never listed as a project) with one agent, working in the workspace folder.
   */
  assistant: ProjectInfo | null
  /** Moved since Hive last opened it, with something to repair (#146): the banner offers Repair…. */
  moved?: WorkspaceMoved | null
}

/** What moved (#146): the workspace (from its old folder), or only some of its projects. */
export interface WorkspaceMoved {
  /** The workspace's old folder; null when only projects moved (renamed or moved in from elsewhere). */
  from: string | null
  /** The projects that moved, by name. */
  projects: string[]
  /** Projects that didn't move but have a worktree's sessions or data still to follow it to a new folder (#146). */
  pending: string[]
}

/** What Repair… would do for a moved workspace or project (#146). */
export interface MovePlan extends WorkspaceMoved {
  to: string
  /** Agents running in the workspace ("project · agent"): Repair waits until they are stopped. */
  running: string[]
  hosts: MoveHostPlan[]
  /** The old folder is in File → Open Recent, to be replaced by the new one. */
  recent: boolean
  /** Projects marked Working on at the old folder and not yet at the new one (kept per workspace folder). */
  working: string[]
}

/** One moved project (or the Assistant's home) and what Repair does for it. */
export interface MoveHostPlan {
  /** Its folder now (where its sessions.json is), and the folder its sessions ran in, then and now: its own, except the Assistant's, which works in the workspace folder. */
  path: string
  name: string
  from: string
  folder: string
  worktrees: MoveWorktree[]
  /** Session records whose folder (cwd) moves with it. */
  sessions: number
  /** What a CLI keeps by folder path (Claude Code's transcripts and memory), to copy to the new path's name. */
  folders: PathDataCopy[]
}

/**
 * An agent's worktree whose links need repairing. moved: found at a new place; stayed: still where it was (outside the
 * moved folder), its links to the repository repaired; located: the folder the user picked; missing: not found
 * (Recreate, Locate… or Remove the link); recreate: to be made again on its branch, or new from its base when the
 * branch is gone (`to`: where, if that place can be used); unlink: the agent's worktree link is to be removed;
 * original: the project is still at its old folder too (a copy), which keeps the worktree.
 */
export interface MoveWorktree {
  agentId: string
  agentName: string
  from: string
  to: string | null
  how: 'moved' | 'stayed' | 'located' | 'missing' | 'recreate' | 'unlink' | 'original'
  /** missing and recreate: its branch, and whether the branch survives (Recreate) or not (Create a new worktree). */
  branch?: string
  branchExists?: boolean
}

/** An agent's worktree whose folder is missing (#146): Recreate makes it again on its branch, or new from its base when the branch is gone. */
export interface WorktreeGone {
  agentName: string
  path: string
  branch: string
  base: string
  branchExists: boolean
}

/** A CLI's per-path folder copied for a moved folder: files to copy, and files already there with other content (kept). */
export interface PathDataCopy {
  provider: ProviderId
  /** Whose folder it is, as the dialog says it: "the project", "Builder's worktree" (set by the move, not the CLI). */
  of?: string
  from: string
  to: string
  copy: number
  kept: string[]
  failed?: string[]
}

/** The user's choices for Repair…: worktree folders picked with Locate…, and links to remove, by `${projectPath}#${agentId}`. */
export interface MoveOptions {
  locate?: Record<string, string>
  unlink?: string[]
  /** Missing worktrees to make again (on their branch, or new from their base). */
  recreate?: string[]
}

/** What Repair did: each line a step, for the dialog and the log. */
export interface MoveReport {
  done: string[]
  skipped: string[]
  failed: string[]
  /** Nothing is left to repair: the banner goes. */
  complete: boolean
}

export type SkillLevel = 'hive' | 'machine' | 'plugin' | 'local'

export interface SkillInfo {
  /** For machine (user), plugin and local skills: the provider that loads them. */
  provider?: ProviderId
  name: string
  description: string
  level: SkillLevel
  /** The skill's folder. For a bundled skill missing from the workspace: its folder in Hive's installation. */
  path: string
  /** Plugin name for plugin skills. */
  plugin?: string
  /**
   * Hive skills that ship with Hive: the workspace copy matches this version of Hive's ('same'), was edited
   * ('changed'), or isn't in the workspace ('missing'). Untouched copies of older versions are updated by Hive.
   */
  bundled?: 'same' | 'changed' | 'missing'
  /** A changed copy of an older version of Hive's: reverting it also brings in this version's. */
  updateAvailable?: true
  /** Hive skills: who gets it (SKILL.md's metadata.audience): project agents (the default), the Assistant, or both. */
  audience?: SkillAudience
  /** Hive skills: its header is broken or its audience unknown, so nobody gets it until it's fixed (why, in words). */
  problem?: string
}

/** Who a Hive skill is for. */
export type SkillAudience = 'agents' | 'assistant' | 'all'

/** Where a new skill goes: the workspace's Hive skills, or a provider's local skills folder in a project. */
export type SkillTarget = { kind: 'hive' } | { kind: 'local'; projectPath: string; provider: ProviderId }

export interface McpServerDef {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
  headers?: Record<string, string>
  description?: string
  [key: string]: unknown
}

export interface McpServerInfo {
  name: string
  path: string
  def: McpServerDef | null
  error?: string
  globallyEnabled: boolean
  secretWarnings: string[]
}

export interface CompactionEvent {
  timestamp: string
  trigger: string
  preTokens: number
  postTokens: number
  /**
   * The last request before it: its input (what the context showed before that turn) and its output (thinking
   * included). A turn with a big output is often what pushed the context past the threshold. Absent when not known.
   */
  lastInputTokens?: number
  lastOutputTokens?: number
}

export interface SessionUsage {
  provider: ProviderId
  sessionId: string
  /** The session's title: the name the user gave it in the CLI, else one the CLI made up. */
  title: string | null
  /** A name the user gave the session in the CLI (Claude Code's /rename, Codex's thread name); absent when unknown. */
  customTitle?: string | null
  model: string | null
  cliVersion: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  /** Reasoning tokens, where the provider reports them separately (included in outputTokens). */
  reasoningTokens: number
  /**
   * The context now: the last request's input (cache included) plus its output (thinking included), which stays in
   * the context and is what the CLI compacts on. Right after a compaction, what it left.
   */
  contextTokens: number
  /** contextTokens' two parts (the gauge's tooltip); absent from usage read by older versions. */
  contextInputTokens?: number
  lastOutputTokens?: number
  /** The model's context window when the provider reports it. */
  contextWindow: number | null
  compactions: CompactionEvent[]
  cacheTtlSeconds: number
  firstActivity: string | null
  lastActivity: string | null
  userMessages: number
  lastPrompt: string | null
  /** API-equivalent cost for the session (USD): reported by the provider, else estimated by Hive; null if unknown. */
  costUsd: number | null
  costEstimated: boolean
  /**
   * Tokens used after the provider last reported the cost (Claude Code writes it only at some turns' ends):
   * Hive adds its estimate for them to the reported cost.
   */
  costUnreported?: Pick<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens'>
  /** The session's usage by local day (YYYY-MM-DD in this computer's time zone), for periods (see usageDays.ts). */
  days?: Record<string, DayUsage>
  /** From the parser: each cost report's increase and the tokens it covered by day. Hive turns them into day costs and removes them. */
  costReports?: { costUsd: number; days: Record<string, UsageTokens> }[]
}

export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

/** One local day's share of a session's usage. */
export interface DayUsage extends UsageTokens {
  requests: number
  prompts: number
  compactions: number
  /** The day's API-equivalent cost: its share of the reported cost, else Hive's estimate; null when no price is known. */
  costUsd: number | null
  costEstimated: boolean
}

export interface RecacheEstimate {
  tokens: number
  warm: boolean
  secondsLeft: number
  ttlSeconds: number
}

/** A deleted session's usage, kept so totals (the Overview, the Assistant's summary) still count it. */
export interface KeptUsage {
  id: string
  provider: ProviderId
  agentId?: string
  cwd?: string
  name: string
  usage: SessionUsage
}

/** What Hive keeps for a project or the Assistant (Project Settings → Storage), in bytes. */
export interface ProjectStorage {
  path: string
  name: string
  assistant?: boolean
  /** Transcript backups (.hive/sessions). */
  sessions: number
  /** Archived sessions' backups (.hive/archive). */
  archive: number
  /** Images pasted or dropped into sessions (.hive/images). */
  images: number
  /** The agents' worktree folders. */
  worktrees: { agent: string; path: string; bytes: number }[]
  total: number
  computedAt: string
}

export interface WorkspaceStorage {
  /** Projects and the Assistant, biggest first. */
  projects: ProjectStorage[]
  total: number
}

/** What Clean Up… removes; a days value of null leaves that kind out. */
export interface CleanupOptions {
  archivedImagesDays: number | null
  /** Images of deleted sessions, and of launches that never got a session id. */
  orphanImages: boolean
  /** Hive's backups of archived sessions the CLI still has. */
  archivedBackupsDays: number | null
  /** Backups of archived sessions the CLI no longer has: the session is deleted (its usage still counts). */
  goneBackups: boolean
}

export interface CleanupItem {
  kind: 'archived-images' | 'orphan-images' | 'archived-backup' | 'gone-backup'
  path: string
  bytes: number
  sessionId?: string
  label: string
}

export interface CleanupResult {
  removed: number
  bytes: number
  /** Listed items that no longer qualified, or couldn't be moved (with why). */
  skipped: string[]
}

export interface SessionListItem extends Partial<SessionRecord> {
  id: string
  provider: ProviderId
  source: 'hive' | 'external'
  title: string | null
  lastActivity: string | null
  hasTranscript: boolean
  hasBackup: boolean
  /** A deleted session kept only for its usage (session:keptUsage), never in lists. */
  deleted?: boolean
  usage: SessionUsage | null
  recache: RecacheEstimate | null
}

/**
 * The workspace's usage for the Workspace Overview: each project's sessions (Hive's own, and deleted ones' kept
 * usage) and the Assistant's, with their usage by day, from the usage cache.
 */
export interface WorkspaceUsage {
  workspacePath: string
  projects: { name: string; path: string; items: SessionListItem[] }[]
  assistant: SessionListItem[]
  /** Projects left out: hidden, or removed from Hive. */
  hidden: number
}

/** A tool call and its result, as shown in the transcript viewer. */
export interface TranscriptTool {
  toolUseId: string
  name: string
  /** One line, e.g. the command's description or the file edited. */
  summary: string
  input: string
  result: string | null
  isError: boolean
  /** Images the tool returned (e.g. a screenshot it read). */
  images: TranscriptImageRef[]
  /** Set when input/result were shortened for display; fetch the full call with transcript:tool. */
  inputLength?: number
  resultLength?: number
}

export interface TranscriptImageRef {
  /** Pass to transcript:image to get the picture. */
  id: number
  /** Where the image was pasted from, when Claude Code recorded it (e.g. .hive/images/…). */
  path: string | null
}

interface TranscriptItemBase {
  /** Position in the transcript; stable, because transcripts are append-only. */
  id: number
  timestamp: string | null
}

export type TranscriptItem = TranscriptItemBase &
  (
    | { kind: 'user'; text: string; images: TranscriptImageRef[] }
    | { kind: 'assistant'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; tool: TranscriptTool }
    | { kind: 'compaction'; trigger: string; preTokens: number; postTokens: number; nextRequestTokens: number | null; summary: string | null }
    | { kind: 'command'; name: string; args: string; output: string }
    | { kind: 'notice'; text: string; level: 'info' | 'error' }
  )

export interface Transcript {
  sessionId: string
  /** File size read so far; pass back to transcript:read to get null when nothing changed. */
  size: number
  /** Items in the whole conversation; `items` holds those from `from` on (an item's id is its index). */
  total: number
  from: number
  items: TranscriptItem[]
}

export interface TranscriptSearchHit {
  itemId: number
  kind: TranscriptItem['kind']
  snippet: string
}

export interface TranscriptSearchResult {
  sessionId: string
  hits: TranscriptSearchHit[]
  /** More matches than returned. */
  more: boolean
}

export interface MemorySource {
  provider: ProviderId
  id: string
  label: string
  path: string
  kind: 'claude-md' | 'local-md' | 'auto-memory'
  exists: boolean
}

export interface GitFileChange {
  path: string
  status: string
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
}

export interface GitDiff {
  path: string
  original: string
  modified: string
  binary: boolean
}

/** A recent workspace as a window sees it (File → Open Recent, the welcome page; #144). */
export interface RecentWorkspace {
  path: string
  /** Whether its folder is there now (one that isn't stays listed: an unplugged drive's may come back). */
  exists: boolean
  /** Open in another window: choosing it brings that window forward. */
  openElsewhere?: boolean
}

export interface AgentInstallInfo {
  provider: ProviderId
  found: boolean
  path: string | null
  version: string | null
  source: string | null
  latestVersion: string | null
  updateAvailable: boolean
  loggedIn: boolean | null
  authMethod: string | null
  checking?: boolean
  /** Candidates skipped because they belong to an editor extension rather than the standalone CLI. */
  rejected?: string[]
  /** No CLI found, but an editor extension with its own copy is installed. */
  editorExtensionOnly?: boolean
  /**
   * The model the CLI uses when Hive passes none: its own settings, else the model last seen answering
   * in such a session. Null until known.
   */
  defaultModel?: string | null
  /** What still stands between the provider and running agents (not installed, not signed in, setup). */
  readiness?: ReadinessIssue[]
  /** The models the installed CLI reports, in its own order, with their capabilities; null when it couldn't be asked. */
  catalog?: ModelCatalog | null
  /** The effort the CLI's own settings choose for every model (Codex's model_reasoning_effort), if any. */
  configuredEffort?: EffortLevel | null
  /** Per model: the effort seen in sessions started without an effort choice (observedDefaultEffort). */
  observedEfforts?: Record<string, EffortLevel>
}

export interface ReadinessIssue {
  id: string
  /** error: agents can't start; warning: they can, with limits; info: nice to know. */
  level: 'error' | 'warning' | 'info'
  message: string
  /** Button: a provider task Hive runs in a terminal. */
  action?: { label: string; task: ProviderTask }
  /** Shown in Agent Setup with the button: what the task will ask and how to choose (paragraphs, `code` allowed). */
  detail?: string[]
}

export type ProviderTask = 'install' | 'update' | 'login' | 'setup'

/** An entry in a project's file browser. relPath uses forward slashes and is relative to the project. */
export interface FileEntry {
  name: string
  relPath: string
  isDir: boolean
  size: number
  modified: string
  /** Ignored by git, or Hive's own .hive folder — shown dimmed. */
  ignored: boolean
}

/** A file opened in the Files tab editor. */
export interface FileContent {
  kind: 'text' | 'binary' | 'too-large'
  text: string
  size: number
  modified: string
  /** The file started with a UTF-8 byte order mark; it is kept on save. */
  bom: boolean
}

export interface SessionImage {
  path: string
  name: string
  size: number
  modified: string
}

/** Images pasted or dropped into one session, from <project>/.hive/images/<sessionId>. */
export interface SessionImageGroup {
  sessionId: string
  name: string | null
  archived: boolean
  images: SessionImage[]
}

export interface NoteFile {
  path: string
  relPath: string
  name: string
  isDir: boolean
  children?: NoteFile[]
  modified?: string
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  command: string
  args?: unknown[]
}

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'

/** Hive's own updates (electron-updater, GitHub Releases). */
export interface UpdateState {
  status: UpdateStatus
  /** The running version. */
  current: string
  /** The newer version found. */
  version?: string
  releaseName?: string
  /** From the GitHub release (HTML or Markdown). */
  releaseNotes?: string
  releaseDate?: string
  /** Installer size in bytes. */
  size?: number
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
  error?: string
  checkedAt?: string
  /** The last check was started by the user. */
  manual?: boolean
  /** The version found is one the user skipped. */
  skipped?: boolean
}

export interface ToastMessage {
  id: string
  level: ToastLevel
  title: string
  message?: string
  actions?: ToastAction[]
  timestamp: string
  source?: string
  /** Kept in the Notifications panel (the bell) only, not shown as a toast: a notice told another way, or not at all (#157). */
  quiet?: boolean
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  userData: string
  logsPath: string
  isPackaged: boolean
}

export interface AgentApiInfo {
  enabled: boolean
  running: boolean
  url: string | null
  token: string
  error?: string
}

/** Events pushed from main to renderer. */
export type HiveEvent =
  | { type: 'workspace-changed'; workspace: WorkspaceInfo | null }
  /** The recent workspaces changed (opened, removed, cleared): each window asks for its own view of them (#144). */
  | { type: 'recent-changed' }
  | { type: 'session-status'; state: LiveSessionState }
  /** `failure`: the CLI exited before its session started (and nobody stopped it): why, for the agent's pane. */
  | { type: 'session-exit'; projectPath: string; agentId: string; sessionId: string; exitCode: number; failure?: StartFailure }
  | { type: 'toast'; toast: ToastMessage }
  | { type: 'chime'; projectPath: string; silent?: boolean }
  | { type: 'settings-changed'; settings: AppSettings }
  /** One project's view preference saved (ui:setProjectPref): every window's store follows. */
  | { type: 'ui-pref-changed'; pref: ProjectPref; project: string; value: unknown }
  | { type: 'provider-install'; provider: ProviderId; info: AgentInstallInfo }
  | { type: 'menu-command'; command: string; args?: unknown[] }
  | { type: 'usage-changed'; projectPath: string; sessionId: string }
  | { type: 'notes-changed' }
  /** The workspace's task board changed (its path names the window). */
  | { type: 'tasks-changed'; workspacePath: string }
  /** Quitting needs the user's decision: the renderer shows the quit dialog and answers with app:quitDecision. */
  | { type: 'quit-request'; sessions: QuitSession[]; unsaved: string[]; /** Anything but 'app' stops only this window's workspace's sessions. */ scope?: QuitScope }
  /** Hive is waiting for working agents to finish before quitting (or stopped waiting). */
  | { type: 'quit-pending'; pending: boolean; working: number }
  /** How many working agents keep the PC awake (0: it may sleep). */
  | { type: 'keep-awake'; working: number }
  /** Files changed in a project that has a Files or Images tab open. dirs are relative, '' is the root. */
  | { type: 'files-changed'; projectPath: string; dirs: string[] }
  | { type: 'skills-changed' }
  | { type: 'personas-changed' }
  /** The Hive Assistant acted, or asks the user something (its home's path names the window). */
  | { type: 'assistant-activity'; projectPath: string; action: AssistantAction }
  | { type: 'assistant-questions'; projectPath: string; questions: AssistantQuestion[] }
  /** An agent was added by the Hive Assistant: the view doesn't move to it. */
  | { type: 'agent-added'; projectPath: string; agentId: string }
  /** A worktree agent's unmerged work changed (null: git couldn't check it). */
  | { type: 'branch-status'; projectPath: string; agentId: string; status: AgentBranchStatus | null }
  | { type: 'plan-usage'; provider: ProviderId; usage: PlanUsage }
  | { type: 'window-state'; maximized: boolean; focused: boolean; alwaysOnTop: boolean }
  /** A window opened or closed: how many there are now (File → Exit says it closes them all). */
  | { type: 'windows-changed'; count: number }
  | { type: 'notice'; notice: Notice }
  /** The agent no longer waits for you: its waiting banner closes, in whichever window shows it. */
  | { type: 'notice-resolved'; projectPath: string; agentId: string }
  | { type: 'update-state'; state: UpdateState }
  /** A workspace's progress runs changed (all of them, newest first). */
  | { type: 'progress-changed'; workspacePath: string; runs: ProgressRun[] }

/** Who reported a progress run: a project agent (by its token), the Hive Assistant, or a script with the workspace token. */
export type ProgressSource = 'agent' | 'assistant' | 'api'

/**
 * A long run an agent reports (tests, a build), for the Progress panel. `step` counts finished steps (0 to `total`),
 * `stepName` is the one running now, and `estimateMs` the time left as of `updatedAt` (epoch ms throughout).
 */
export interface ProgressRun {
  id: string
  workspacePath: string
  /** The reporting agent's project (null for the Assistant and scripts). */
  projectPath: string | null
  agentId: string | null
  /** Its agent's name, "Hive Assistant", or "Script". */
  agentName: string
  provider: ProviderId | null
  source: ProgressSource
  title: string
  command: string | null
  total: number | null
  step: number | null
  stepName: string | null
  estimateMs: number | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  /** stale: running, but no report for longer than expected, or its agent stopped. */
  state: 'running' | 'stale' | 'passed' | 'failed'
  /** Why a stale run is stale: no report for too long, or its agent's session stopped. */
  staleReason: 'quiet' | 'agent-stopped' | null
  summary: string | null
  /** The user dismissed it: listed under Recent only. */
  dismissed: boolean
  /** When the user saw it failed or stale (the panel open, Hive focused): it folds into Recent a few seconds later. */
  seenAt: number | null
  /** How long it was expected to take in all (ms), from its first estimate; null without one. */
  expectedMs: number | null
  /** The command's exit code, when its reporter gave one. */
  exitCode: number | null
  /** A log or run record the reporter named (a path). */
  logPath: string | null
}
