// Types shared by the main process, preload bridge and renderer.

export type ThemeSetting = 'dark' | 'light' | 'system'
/** A coding-agent CLI Hive can run ("claude-code", "codex"). See src/shared/providers.ts. */
export type ProviderId = string
/** A permission mode id from the agent's provider (e.g. Claude Code's "auto", Codex's "approve-for-me"). */
export type PermissionMode = string
/** A reasoning effort id from the agent's provider (e.g. "low", "high", "max"). */
export type EffortLevel = string
export type ChimeSound = 'chime' | 'bell' | 'soft' | 'pop'
export type CacheTtlSetting = 'auto' | '5m' | '1h'

export type QuitConfirm = 'working' | 'always' | 'never'
/** What Hive does when an agent edits a file another agent in the same folder is editing. */
export type FileLockMode = 'off' | 'warn' | 'block' | 'ask'
export type MergeStyle = 'squash' | 'merge'
/** How the Session tab arranges a project's agents. */
export type SessionLayout = 'single' | 'columns2' | 'columns3' | 'grid'
export type QuitChoice = 'now' | 'wait' | 'cancel'
/** What the quit dialog is for: quitting, closing a window, closing its workspace, or switching the window to another workspace. */
export type QuitScope = 'app' | 'window' | 'workspace' | 'switch'

/** A running session listed in the quit dialog. */
export interface QuitSession {
  projectPath: string
  project: string
  status: SessionStatus
  /** The agent's name, when the project has more than one. */
  agent?: string
  provider?: ProviderId
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
    onlyWhenUnfocused: boolean
  }
  sessions: {
    backupTranscripts: boolean
    cacheTtl: CacheTtlSetting
    confirmStop: boolean
    /** Context size (tokens) above which Compact is highlighted. 0 never highlights. */
    compactSuggestTokens: number
    /** The Sessions tab's transcript of a running session follows new messages without a Refresh. */
    followTranscripts: boolean
    /** How the Overview and the session lists update: as sessions change (at most every 15 s), every minute, or on Refresh. */
    overviewRefresh: 'live' | 'minute' | 'manual'
  }
  agentApi: {
    enabled: boolean
    port: number
    provideHiveMcp: boolean
    allowSessionInput: boolean
  }
  agents: {
    /** Per-file locks between agents working in the same folder. */
    fileLocks: FileLockMode
    /** Git-ignored files copied into new worktrees: glob patterns, one per line or comma separated. */
    worktreeCopy: string
    /** Default for merging a worktree agent's branch. */
    mergeStyle: MergeStyle
  }
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
  /** The user's price overrides by model id; missing models use the prices Hive ships. */
  prices: Record<string, ModelPrice>
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  /** 2 since providers (0.2.0); 1 was Claude Code only. */
  version: 2
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
  /** `panes`: resizable pane sizes by key (pixels, or a fraction for split views). */
  ui: { sidebarWidth: number; sidebarVisible: boolean; sidebarCompact?: boolean; panes?: Record<string, number> }
  /** Per provider: the model last seen in a session started without a model choice (the CLI's own default). */
  observedDefaultModel: Record<ProviderId, string>
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
  skills: { enabled: string[] }
  mcp: { enabled: string[] }
}

export type Inherit<T> = 'inherit' | T

export interface ProjectConfig {
  /** 2 since 0.2.0: agents are all equal and a project starts with none (0.1's agents are cleared). */
  version: 2
  /** Project-scoped shortcut overrides (project, session and agent commands), over the global ones. */
  keybindings?: KeybindingOverrides
  skills: { disabled: string[] }
  mcp: { disabled: string[] }
  chime: 'inherit' | 'on' | 'off'
  /** The provider new agents get (Add Agent's quick add); inherit uses the global default. */
  defaultProvider: Inherit<ProviderId>
  /** The project's settings per provider, over the global ones. */
  providers: Record<ProviderId, ProjectProviderConfig>
  /** Overrides settings.sessions.compactSuggestTokens for this project; null inherits. */
  compactSuggestTokens: number | null
  /** The project's agents, in the order they were added. All are equal; a new project has none. */
  agents: AgentDef[]
  sessionLayout: SessionLayout
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
}

/** A worktree an agent works in: its own checkout of the project on its own branch. */
export interface AgentWorktree {
  path: string
  branch: string
  /** Branch it was created from, and merges back into. */
  base: string
}

/** One of a project's (up to four) agents. Settings left undefined follow the project's. */
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
  /** Session to resume for this agent. */
  lastSessionId?: string
  /** The worktree's setup command hasn't run successfully yet. */
  needsSetup?: boolean
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
}

export interface MergeResult {
  ok: boolean
  /** Files that would conflict; nothing was changed. */
  conflicts?: string[]
  error?: string
  /** The worktree and branch were removed afterwards. */
  cleanedUp?: boolean
}

export interface SessionRecord {
  id: string
  /** The provider that ran it ("claude-code", "codex"). The field name predates providers. */
  agent: ProviderId
  name: string
  createdAt: string
  lastActiveAt: string
  archived: boolean
  /** The agent that ran it (absent in records from 0.1's Agent 1). */
  agentId?: string
  /** Folder it ran in, when not the project folder (a worktree). Claude Code files transcripts by folder. */
  cwd?: string
  branch?: string
  /** Where the provider keeps the transcript, when it can't be found from the folder (Codex). */
  transcriptPath?: string
  /** The session whose work was handed over to this one ("Hand Over to…"). */
  handedOverFrom?: string
}

export type SessionStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'waiting' | 'finished' | 'error'

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
  /** The session's name in Hive (renamable in the Sessions tab). */
  sessionName?: string
  status: SessionStatus
  statusMessage?: string
  pid?: number
  startedAt: string
  /** Effective settings the session launched with — used to detect "restart to apply". */
  launchSignature: string
  unseen: boolean
  /** Reported by the provider once the session has started. */
  effort?: string
  modelName?: string
  /** API-equivalent cost of the session so far, in USD. */
  costUsd?: number
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
}

export interface WorkspaceInfo {
  path: string
  name: string
  config: WorkspaceConfig
  projects: ProjectInfo[]
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
   * Hive skills that ship with Hive: the workspace copy matches this version of Hive's ('same'), differs
   * because it was edited or is from an older version ('changed'), or isn't in the workspace ('missing').
   */
  bundled?: 'same' | 'changed' | 'missing'
}

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
}

export interface SessionUsage {
  provider: ProviderId
  sessionId: string
  title: string | null
  model: string | null
  cliVersion: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  /** Reasoning tokens, where the provider reports them separately (included in outputTokens). */
  reasoningTokens: number
  contextTokens: number
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
}

export interface RecacheEstimate {
  tokens: number
  warm: boolean
  secondsLeft: number
  ttlSeconds: number
}

export interface SessionListItem extends Partial<SessionRecord> {
  id: string
  provider: ProviderId
  source: 'hive' | 'external'
  title: string | null
  lastActivity: string | null
  hasTranscript: boolean
  hasBackup: boolean
  usage: SessionUsage | null
  recache: RecacheEstimate | null
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
  /** The models the installed CLI offers, in its own order (providers that can list them, e.g. Codex). */
  models?: { value: string; label: string }[] | null
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
  | { type: 'session-status'; state: LiveSessionState }
  | { type: 'session-exit'; projectPath: string; agentId: string; sessionId: string; exitCode: number }
  | { type: 'toast'; toast: ToastMessage }
  | { type: 'chime'; projectPath: string }
  | { type: 'settings-changed'; settings: AppSettings }
  | { type: 'provider-install'; provider: ProviderId; info: AgentInstallInfo }
  | { type: 'menu-command'; command: string; args?: unknown[] }
  | { type: 'usage-changed'; projectPath: string; sessionId: string }
  | { type: 'notes-changed' }
  /** Quitting needs the user's decision: the renderer shows the quit dialog and answers with app:quitDecision. */
  | { type: 'quit-request'; sessions: QuitSession[]; unsaved: string[]; /** Anything but 'app' stops only this window's workspace's sessions. */ scope?: QuitScope }
  /** Hive is waiting for working agents to finish before quitting (or stopped waiting). */
  | { type: 'quit-pending'; pending: boolean; working: number }
  /** Files changed in a project that has a Files or Images tab open. dirs are relative, '' is the root. */
  | { type: 'files-changed'; projectPath: string; dirs: string[] }
  | { type: 'skills-changed' }
  | { type: 'plan-usage'; provider: ProviderId; usage: PlanUsage }
  | { type: 'window-state'; maximized: boolean; focused: boolean }
  | { type: 'update-state'; state: UpdateState }
