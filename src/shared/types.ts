// Types shared by the main process, preload bridge and renderer.

export type ThemeSetting = 'dark' | 'light' | 'system'
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ChimeSound = 'chime' | 'bell' | 'soft' | 'pop'
export type CacheTtlSetting = 'auto' | '5m' | '1h'

export type QuitConfirm = 'working' | 'always' | 'never'
/** What Hive does when an agent edits a file another agent in the same folder is editing. */
export type FileLockMode = 'off' | 'warn' | 'block' | 'ask'
export type MergeStyle = 'squash' | 'merge'
/** How the Session tab arranges a project's agents. */
export type SessionLayout = 'single' | 'columns2' | 'columns3' | 'grid'
export type QuitChoice = 'now' | 'wait' | 'cancel'

/** A running session listed in the quit dialog. */
export interface QuitSession {
  projectPath: string
  project: string
  status: SessionStatus
  /** The agent's name, when the project has more than one. */
  agent?: string
}

export interface AppSettings {
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
  claude: {
    executablePath: string
    defaultModel: string
    defaultEffort: EffortLevel | ''
    defaultPermissionMode: Exclude<PermissionMode, 'bypassPermissions'>
    enableBypassOption: boolean
    extraArgs: string
    checkUpdatesOnLaunch: boolean
  }
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

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  version: 1
  settings: AppSettings
  recentWorkspaces: string[]
  lastWorkspace: string | null
  /** Active project names, keyed by workspace path. */
  activeProjects: Record<string, string[]>
  window: WindowState
  /** `panes`: resizable pane sizes by key (pixels, or a fraction for split views). */
  ui: { sidebarWidth: number; sidebarVisible: boolean; sidebarCompact?: boolean; panes?: Record<string, number> }
  /** Model last seen in a session started without --model (i.e. Claude Code's default). */
  observedDefaultModel: string | null
  /** Last plan usage Claude Code reported (account-wide). */
  planUsage: PlanUsage | null
  /** Highest warning shown per limit, and for which reset period. */
  planWarnings: Record<string, { resetsAt: string | null; level: number }>
}

export interface PlanLimit {
  usedPercent: number
  resetsAt: string | null
}

/** Subscription limits reported by Claude Code: the rolling 5-hour window and the weekly limit. */
export interface PlanUsage {
  fiveHour: PlanLimit | null
  sevenDay: PlanLimit | null
  updatedAt: string
}

export interface WorkspaceConfig {
  version: 1
  skills: { enabled: string[] }
  mcp: { enabled: string[] }
}

export type Inherit<T> = 'inherit' | T

export interface ProjectConfig {
  version: 1
  skills: { disabled: string[] }
  mcp: { disabled: string[] }
  chime: 'inherit' | 'on' | 'off'
  model: string // 'inherit' or a model alias / id
  effort: Inherit<EffortLevel>
  permissionMode: Inherit<PermissionMode>
  extraArgs: string
  /** Overrides settings.sessions.compactSuggestTokens for this project; null inherits. */
  compactSuggestTokens: number | null
  /** The project's agents. Agent 1 ("main", the project folder) is always present, even when not listed. */
  agents: AgentDef[]
  sessionLayout: SessionLayout
  fileLocks: Inherit<FileLockMode>
  /** Overrides settings.agents.worktreeCopy; null inherits. */
  worktreeCopy: string | null
  /** Command run in a new worktree before its agent's first session, e.g. "npm install". */
  worktreeSetup: string
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
  /** "main" for Agent 1, which always works in the project folder. */
  id: string
  name: string
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
  agent: string
  name: string
  createdAt: string
  lastActiveAt: string
  archived: boolean
  /** The agent that ran it; absent means Agent 1. */
  agentId?: string
  /** Folder it ran in, when not the project folder (a worktree). Claude Code files transcripts by folder. */
  cwd?: string
  branch?: string
}

export type SessionStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'waiting' | 'finished' | 'error'

export interface LiveSessionState {
  projectPath: string
  /** Which of the project's agents this is ("main" = Agent 1). */
  agentId: string
  agentName?: string
  /** Folder the session runs in: the project folder or the agent's worktree. */
  cwd: string
  sessionId: string
  /** The session's name in Hive (renamable in the Sessions tab). */
  sessionName?: string
  status: SessionStatus
  statusMessage?: string
  pid?: number
  startedAt: string
  /** Effective settings the session launched with — used to detect "restart to apply". */
  launchSignature: string
  unseen: boolean
  /** Reported by Claude Code (status line) once the session has started. */
  effort?: string
  modelName?: string
  /** API-equivalent cost of the session so far, in USD. */
  costUsd?: number
  /** Files this agent has claimed by editing them (relative to its folder), while locks are on. */
  lockedFiles?: string[]
  /** The worktree's setup command is running before Claude Code starts. */
  settingUp?: boolean
}

export interface ProjectInfo {
  name: string
  path: string
  active: boolean
  isGitRepo: boolean
  branch: string | null
  config: ProjectConfig
  /** Agent 1's session if it runs, else the first running agent's. */
  live: LiveSessionState | null
  /** True when the project's effective settings differ from the live session's launch settings. */
  restartNeeded: boolean
  /** Every agent, Agent 1 first, with its running session. */
  agents: AgentInfo[]
  /** MCP servers defined in the project's own .mcp.json that are not deployed to the workspace. */
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
  name: string
  description: string
  level: SkillLevel
  path: string
  /** For hive skills: enabled globally. */
  globallyEnabled?: boolean
  /** Plugin name for plugin skills. */
  plugin?: string
}

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
  sessionId: string
  title: string | null
  model: string | null
  cliVersion: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  contextTokens: number
  compactions: CompactionEvent[]
  cacheTtlSeconds: number
  firstActivity: string | null
  lastActivity: string | null
  userMessages: number
  lastPrompt: string | null
  /** API-equivalent cost Claude Code recorded for the session (USD), if any. */
  costUsd: number | null
}

export interface RecacheEstimate {
  tokens: number
  warm: boolean
  secondsLeft: number
  ttlSeconds: number
}

export interface SessionListItem extends Partial<SessionRecord> {
  id: string
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
  /** No CLI found, but an editor extension with its own Claude Code is installed. */
  editorExtensionOnly?: boolean
  /**
   * The model Claude Code uses when Hive passes no --model: its own settings' "model", else the model
   * last seen answering in such a session. Null until known.
   */
  defaultModel?: string | null
}

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
  | { type: 'agent-install'; info: AgentInstallInfo }
  | { type: 'menu-command'; command: string; args?: unknown[] }
  | { type: 'usage-changed'; projectPath: string; sessionId: string }
  | { type: 'notes-changed' }
  /** Quitting needs the user's decision: the renderer shows the quit dialog and answers with app:quitDecision. */
  | { type: 'quit-request'; sessions: QuitSession[] }
  /** Hive is waiting for working agents to finish before quitting (or stopped waiting). */
  | { type: 'quit-pending'; pending: boolean; working: number }
  /** Files changed in a project that has a Files or Images tab open. dirs are relative, '' is the root. */
  | { type: 'files-changed'; projectPath: string; dirs: string[] }
  | { type: 'skills-changed' }
  | { type: 'plan-usage'; usage: PlanUsage }
  | { type: 'window-state'; maximized: boolean; focused: boolean }
