import type {
  AddAgentOptions,
  AgentApiInfo,
  AgentBranchStatus,
  AgentDef,
  AgentInstallInfo,
  AppConfig,
  AppInfo,
  AppSettings,
  FileContent,
  FileEntry,
  GitDiff,
  GitStatus,
  HiveEvent,
  LiveSessionState,
  McpServerInfo,
  MergeResult,
  MemorySource,
  NoteFile,
  PlanUsage,
  ProjectConfig,
  ProjectGitInfo,
  QuitChoice,
  QuitSession,
  SessionImageGroup,
  SessionListItem,
  SessionUsage,
  SkillInfo,
  Transcript,
  TranscriptSearchResult,
  TranscriptTool,
  WorkspaceInfo
} from './types'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type SettingsPatch = DeepPartial<AppSettings>

/**
 * Every request the renderer can make of the main process.
 * The preload bridge exposes these as `window.hive.invoke(channel, ...args)`.
 */
export interface HiveRequests {
  'app:info': () => AppInfo
  /** Last plan usage Claude Code reported (5-hour and weekly limits); null until a session reports it. */
  'app:planUsage': () => PlanUsage | null
  'app:quit': () => void
  'app:quitDecision': (choice: QuitChoice, dontAskAgain: boolean) => void
  'app:cancelPendingQuit': () => void
  /** Current quit state, for a window that reloads while a quit dialog or pending quit is open. */
  'app:quitState': () => { request: QuitSession[] | null; pending: boolean; working: number }
  'app:openExternal': (url: string) => void
  'app:openPath': (path: string) => void
  'app:showInFolder': (path: string) => void
  'app:openLogs': () => void
  /** Opens the Chromium/Electron licences that ship next to the app's executable. */
  'app:openChromiumLicenses': () => boolean

  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  'window:toggleDevTools': () => void
  'window:zoom': (direction: 'in' | 'out' | 'reset') => void
  'window:toggleFullScreen': () => void
  'window:edit': (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  'window:setTitleBarColors': (color: string, symbolColor: string) => void

  'settings:get': () => AppSettings
  'settings:update': (patch: SettingsPatch) => AppSettings
  'settings:reset': (section?: keyof AppSettings) => AppSettings
  'ui:get': () => AppConfig['ui']
  'ui:set': (ui: Partial<AppConfig['ui']>) => void

  'workspace:get': () => WorkspaceInfo | null
  'workspace:open': (path?: string) => WorkspaceInfo | null
  'workspace:create': () => WorkspaceInfo | null
  'workspace:close': () => void
  'workspace:recent': () => string[]
  'workspace:removeRecent': (path: string) => string[]
  'workspace:refresh': () => WorkspaceInfo | null

  'project:create': (name: string) => WorkspaceInfo | null
  'project:setActive': (projectPath: string, active: boolean) => WorkspaceInfo | null
  'project:updateConfig': (projectPath: string, patch: Partial<ProjectConfig>) => ProjectConfig
  'project:openInExplorer': (projectPath: string) => void
  'project:openTerminal': (projectPath: string) => void

  'session:list': (projectPath: string) => SessionListItem[]
  /** agentId defaults to Agent 1. skipSetup starts Claude Code even though the worktree's setup command hasn't succeeded. */
  'session:start': (projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean }) => LiveSessionState
  'session:stop': (projectPath: string, agentId?: string) => void
  'session:archive': (projectPath: string, sessionId: string, archived: boolean) => void
  'session:rename': (projectPath: string, sessionId: string, name: string) => void
  'session:adopt': (projectPath: string, sessionId: string) => void
  'session:usage': (projectPath: string, sessionId: string) => SessionUsage | null
  'session:markSeen': (projectPath: string) => void
  'session:live': () => LiveSessionState[]
  /** Runs Claude Code's /compact in the project's session (only while the agent is idle). */
  'session:compact': (projectPath: string, focus?: string, agentId?: string) => void
  /** Saves the clipboard image (or copies sourceFile) into .hive/images/<sessionId>; null if the clipboard has no image. */
  'session:saveImage': (projectPath: string, sourceFile?: string, agentId?: string) => string | null

  /** Adds an agent to the project (up to four), creating its worktree if asked. */
  'agents:add': (projectPath: string, opts: AddAgentOptions) => AgentDef
  'agents:update': (projectPath: string, agentId: string, patch: Partial<Pick<AgentDef, 'name' | 'model' | 'effort' | 'permissionMode'>>) => AgentDef
  /** Removes an agent (its session must be stopped). deleteWorktree also removes its worktree and branch. */
  'agents:remove': (projectPath: string, agentId: string, opts: { deleteWorktree: boolean }) => void
  /** Branches and worktrees, for the Add Agent dialog. */
  'agents:gitInfo': (projectPath: string) => ProjectGitInfo
  'agents:branchStatus': (projectPath: string, agentId: string) => AgentBranchStatus
  /** Commits the worktree's changes and merges its branch into the project folder's current branch. */
  'agents:merge': (projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean }) => MergeResult

  /** The conversation for the transcript viewer; null when the file has not grown since knownSize. Long tool input/output is shortened. */
  'transcript:read': (projectPath: string, sessionId: string, knownSize?: number) => Transcript | null
  /** One tool call with its full input and output. */
  'transcript:tool': (projectPath: string, sessionId: string, itemId: number) => TranscriptTool
  /** An image stored in the transcript, as a data URL. */
  'transcript:image': (projectPath: string, sessionId: string, imageId: number) => string
  /** Searches one session, or all of the project's sessions when sessionId is null. */
  'transcript:search': (projectPath: string, query: string, sessionId: string | null) => TranscriptSearchResult[]
  /** Asks where to save, writes the conversation as Markdown and returns the path (null if cancelled). */
  'transcript:export': (projectPath: string, sessionId: string, title: string) => string | null

  'pty:write': (key: string, data: string) => void
  'pty:resize': (key: string, cols: number, rows: number) => void
  'pty:buffer': (key: string) => string
  'pty:kill': (key: string) => void

  'skills:list': (projectPath?: string) => SkillInfo[]
  'skills:setGlobal': (name: string, enabled: boolean) => void
  'skills:setProject': (projectPath: string, name: string, enabled: boolean) => void
  'skills:create': (name: string, description: string) => SkillInfo
  'skills:copyToWorkspace': (skillPath: string) => SkillInfo
  'skills:openFolder': () => void

  'mcp:list': () => McpServerInfo[]
  'mcp:setGlobal': (name: string, enabled: boolean) => void
  'mcp:setProject': (projectPath: string, name: string, enabled: boolean) => void
  'mcp:create': (name: string) => McpServerInfo
  'mcp:read': (name: string) => string
  'mcp:save': (name: string, text: string) => McpServerInfo
  'mcp:delete': (name: string) => void
  'mcp:importFromProject': (projectPath: string, names: string[]) => string[]
  'mcp:openFolder': () => void

  'notes:tree': () => NoteFile[]
  'notes:create': (relPath: string, isDir: boolean) => string
  'notes:delete': (path: string) => void
  'notes:rename': (path: string, newName: string) => string

  'file:read': (path: string) => string
  'file:write': (path: string, content: string) => void

  'memory:list': (projectPath: string) => MemorySource[]

  'files:list': (projectPath: string, rel: string) => FileEntry[]
  'files:create': (projectPath: string, parentRel: string, name: string, isDir: boolean) => string
  'files:rename': (projectPath: string, rel: string, newName: string) => string
  'files:move': (projectPath: string, rels: string[], destRel: string) => string[]
  'files:copy': (projectPath: string, rels: string[], destRel: string) => string[]
  /** Copies files from outside the project (e.g. dropped from Explorer) into destRel. */
  'files:import': (projectPath: string, sources: string[], destRel: string) => string[]
  /** Moves entries to the Recycle Bin. */
  'files:trash': (projectPath: string, rels: string[]) => void
  'files:find': (projectPath: string, query: string) => FileEntry[]
  'files:read': (projectPath: string, rel: string) => FileContent
  /** Saves text. With expectedModified, refuses (error "CONFLICT") if the file changed on disk since. */
  'files:write': (projectPath: string, rel: string, text: string, expectedModified: string | null, bom: boolean) => { modified: string; size: number }
  'files:open': (projectPath: string, rel: string) => void
  'files:reveal': (projectPath: string, rel: string) => void
  /** Starts/stops live 'files-changed' events for a project (reference counted). */
  'files:watch': (projectPath: string) => void
  'files:unwatch': (projectPath: string) => void

  'images:list': (projectPath: string) => SessionImageGroup[]
  'images:trash': (projectPath: string, path: string) => void
  'images:copy': (path: string) => void

  /** root is a project or one of its agents' worktrees. With base, lists everything changed since the branch left base. */
  'git:status': (root: string, base?: string) => GitStatus
  'git:diff': (root: string, file: string, base?: string) => GitDiff

  'agent:info': () => AgentInstallInfo
  'agent:refresh': () => AgentInstallInfo
  'agent:install': () => string
  'agent:update': () => string
  'agent:login': () => string

  'api:info': () => AgentApiInfo
  'api:regenerateToken': () => AgentApiInfo
}

export type HiveChannel = keyof HiveRequests

export interface HiveBridge {
  invoke<C extends HiveChannel>(channel: C, ...args: Parameters<HiveRequests[C]>): Promise<ReturnType<HiveRequests[C]>>
  onEvent(listener: (event: HiveEvent) => void): () => void
  onPtyData(listener: (key: string, data: string) => void): () => void
  onPtyExit(listener: (key: string, code: number) => void): () => void
  /** Full path of a file dropped from Explorer. */
  pathForFile(file: File): string
  platform: string
}
