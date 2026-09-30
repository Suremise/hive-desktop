import type {
  UpdateState,
  PermissionMode,
  AddAgentOptions,
  AgentApiInfo,
  AgentBranchStatus,
  AgentDef,
  PersonaInfo,
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
  ModelPrice,
  MemorySource,
  NoteFile,
  PlanUsage,
  ProjectConfig,
  ProjectProviderConfig,
  ProviderId,
  ProviderTask,
  ProjectGitInfo,
  QuitChoice,
  QuitScope,
  QuitSession,
  SessionImageGroup,
  SessionListItem,
  SessionUsage,
  SkillInfo,
  SkillTarget,
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
  /** The plan usage each provider last reported (e.g. 5-hour and weekly limits), by provider. */
  'app:planUsage': () => Record<ProviderId, PlanUsage>
  'app:quit': () => void
  'app:quitDecision': (choice: QuitChoice, dontAskAgain: boolean) => void
  'app:cancelPendingQuit': () => void
  /** Current quit state, for a window that reloads while a quit dialog or pending quit is open. */
  'app:quitState': () => { request: QuitSession[] | null; unsaved: string[]; scope: QuitScope; pending: boolean; working: number }
  'app:openExternal': (url: string) => void
  'app:openPath': (path: string) => void
  'app:showInFolder': (path: string) => void
  'app:openLogs': () => void
  'update:state': () => UpdateState
  /** A check started by the user; resolves with the result. */
  'update:check': () => UpdateState
  'update:download': () => void
  /** Restart and Update: quits (asking if agents are working), installs and restarts. */
  'update:install': () => void
  'update:skip': (version: string) => void
  /** Opens the Chromium/Electron licences that ship next to the app's executable. */
  'app:openChromiumLicenses': () => boolean

  'window:minimize': () => void
  'window:toggleMaximize': () => void
  'window:close': () => void
  /** Opens another Hive window (the welcome page), like VS Code's New Window. */
  'window:new': () => void
  'window:toggleDevTools': () => void
  'window:zoom': (direction: 'in' | 'out' | 'reset') => void
  'window:toggleFullScreen': () => void
  'window:edit': (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  'window:setTitleBarColors': (color: string, symbolColor: string) => void

  'settings:get': () => AppSettings
  'settings:update': (patch: SettingsPatch) => AppSettings
  'settings:reset': (section?: keyof AppSettings) => AppSettings
  /** Replaces a provider's price overrides (USD per million tokens, by model id). */
  'settings:setProviderPrices': (provider: ProviderId, prices: Record<string, ModelPrice>) => AppSettings
  /** Sets (string), removes (null) or resets to the default (undefined) one command's shortcut. */
  'settings:setKeybinding': (commandId: string, key: string | null | undefined) => AppSettings
  'ui:get': () => AppConfig['ui']
  'ui:set': (ui: Partial<AppConfig['ui']>) => void
  /** Saves one pane's size (null: back to its default), leaving the other panes as they are: several windows save them. */
  'ui:setPane': (key: string, size: number | null) => void

  'workspace:get': () => WorkspaceInfo | null
  'workspace:open': (path?: string) => WorkspaceInfo | null
  'workspace:create': () => WorkspaceInfo | null
  /** False when the user cancelled (running agents would have been stopped). */
  'workspace:close': () => boolean
  'workspace:recent': () => string[]
  'workspace:removeRecent': (path: string) => string[]
  'workspace:refresh': () => WorkspaceInfo | null

  'project:create': (name: string) => WorkspaceInfo | null
  'project:setActive': (projectPath: string, active: boolean) => WorkspaceInfo | null
  'project:updateConfig': (projectPath: string, patch: Partial<ProjectConfig>) => ProjectConfig
  /** Changes one provider's overrides for a project, merged under the file lock. */
  'project:updateProvider': (projectPath: string, provider: ProviderId, patch: Partial<ProjectProviderConfig>) => ProjectConfig
  'project:openInExplorer': (projectPath: string) => void
  'project:openTerminal': (projectPath: string) => void

  'session:list': (projectPath: string) => SessionListItem[]
  /** agentId: without one, the project's only agent. skipSetup starts the agent even though the worktree's setup command hasn't succeeded. */
  'session:start': (projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean }) => LiveSessionState
  /** Stops the CLI's background job holding a conversation, then resumes it in the agent. */
  'session:stopBackgroundAndResume': (projectPath: string, agentId: string, jobId: string, sessionId: string) => void
  'session:stop': (projectPath: string, agentId?: string) => void
  'session:archive': (projectPath: string, sessionId: string, archived: boolean) => void
  'session:rename': (projectPath: string, sessionId: string, name: string) => void
  'session:adopt': (projectPath: string, sessionId: string) => void
  'session:usage': (projectPath: string, sessionId: string) => SessionUsage | null
  'session:markSeen': (projectPath: string) => void
  'session:live': () => LiveSessionState[]
  /** Runs the CLI's /compact in the agent's session (only while the agent is idle). */
  'session:compact': (projectPath: string, focus?: string, agentId?: string) => void
  /** Switches a running agent's permission mode the way the CLI allows (Claude Code: Shift+Tab). ok false: not possible live (restart instead) or it didn't take. */
  'session:setMode': (projectPath: string, agentId: string, mode: PermissionMode) => { ok: boolean; restart?: boolean; message?: string }
  /** Lets an agent edit a file another agent holds ("Ask me" lock, for CLIs that can't ask themselves). */
  'session:allowLockedEdit': (projectPath: string, agentId: string, path: string) => void
  /** Continues one agent's work in another, of any provider: a handover from the source (optional), then the target picks it up. */
  'session:handOver': (projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }) => void
  /** Turns Plan mode on or off in a running agent, for providers where it is a toggle (Codex). */
  'session:setPlanMode': (projectPath: string, agentId: string, on: boolean) => void
  /** Stops the agent and resumes the same conversation in the given mode. */
  'session:restartInMode': (projectPath: string, agentId: string, mode: PermissionMode) => void
  /** Switches running agents whose settings now say a different mode (after "Switch now"). */
  'session:applyModes': () => { switched: string[]; skipped: string[] }
  /** Saves the clipboard image (or copies sourceFile) into .hive/images/<sessionId>; null if the clipboard has no image. */
  'session:saveImage': (projectPath: string, sourceFile?: string, agentId?: string) => string | null

  /** Adds an agent to the project (up to twelve), creating its worktree if asked. */
  'agents:add': (projectPath: string, opts: AddAgentOptions) => AgentDef
  /** Changing provider clears the agent's model, effort and mode, and its session to resume (conversations can't move between providers). */
  /** Changes an agent's name and settings; for the Hive Assistant's home, its settings for this workspace (persona too). */
  'agents:update': (projectPath: string, agentId: string, patch: Partial<Pick<AgentDef, 'name' | 'provider' | 'model' | 'effort' | 'permissionMode' | 'persona'>>) => AgentDef
  /** Removes an agent (its session must be stopped). deleteWorktree also removes its worktree and branch. */
  'agents:remove': (projectPath: string, agentId: string, opts: { deleteWorktree: boolean }) => void
  /** Branches and worktrees, for the Add Agent dialog. */
  'agents:gitInfo': (projectPath: string) => ProjectGitInfo
  'agents:branchStatus': (projectPath: string, agentId: string) => AgentBranchStatus
  /** Commits the worktree's changes and merges its branch into the project folder's current branch. */
  'agents:merge': (projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean }) => MergeResult

  /** The conversation for the transcript viewer; null when the file has not grown since knownSize. Long tool input/output is shortened. */
  /** The conversation from item `from` on (default: the last TRANSCRIPT_WINDOW items); null when the file hasn't grown since knownSize and `from` is unchanged. */
  'transcript:read': (projectPath: string, sessionId: string, opts?: { knownSize?: number; from?: number }) => Transcript | null
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
  /** The workspace's Hive skills, with the bundled skills it doesn't have (bundled: 'missing'). */
  'skills:workspace': () => SkillInfo[]
  'skills:create': (name: string, description: string, targets: SkillTarget[]) => SkillInfo
  /** Chooses a .md or .zip to add as a skill; returns it with a suggested name, or null if cancelled. */
  'skills:pickFile': () => { path: string; name: string } | null
  'skills:addFromFile': (file: string, name: string, targets: SkillTarget[]) => SkillInfo
  /** Moves a Hive or local skill to the Recycle Bin. */
  'skills:delete': (skillPath: string) => void
  /** Puts back a bundled skill as this version of Hive ships it. */
  'skills:restoreBundled': (name: string) => SkillInfo
  'skills:copyToWorkspace': (skillPath: string) => SkillInfo
  'skills:openFolder': () => void

  'mcp:list': () => McpServerInfo[]
  'mcp:setGlobal': (name: string, enabled: boolean) => void
  'mcp:setProject': (projectPath: string, name: string, enabled: boolean) => void
  'mcp:create': (name: string) => McpServerInfo
  'mcp:read': (name: string) => string
  /** With `expected` (the text as read), refuses with CONFLICT if the file has changed on disk since. */
  'mcp:save': (name: string, text: string, expected?: string) => McpServerInfo
  'mcp:delete': (name: string) => void
  'mcp:importFromProject': (projectPath: string, names: string[]) => string[]
  'mcp:openFolder': () => void

  'notes:tree': () => NoteFile[]
  'notes:create': (relPath: string, isDir: boolean) => string
  'notes:delete': (path: string) => void
  'notes:rename': (path: string, newName: string) => string

  /** The Hive Assistant's personas: the workspace's, then Hive's that it doesn't have (bundled: 'missing'). */
  'personas:list': () => PersonaInfo[]
  'personas:create': (name: string) => PersonaInfo
  /** Moves the persona's file to the Recycle Bin. */
  'personas:delete': (id: string) => void
  /** Puts back one of Hive's personas as this version ships it (the workspace's copy goes to the Recycle Bin). */
  'personas:restore': (id: string) => PersonaInfo

  'file:read': (path: string) => string
  /** With `expected` (the text as read), refuses with CONFLICT if the file has changed on disk since (a missing file reads as ''). */
  'file:write': (path: string, content: string, expected?: string) => void

  'memory:list': (projectPath: string) => MemorySource[]
  /** Whether the given providers all read the project's AGENTS.md (directly or through an import). */
  'memory:instructionsShared': (projectPath: string, providers: ProviderId[]) => boolean
  /** Makes the given providers share AGENTS.md; returns the files written. */
  'memory:shareInstructions': (projectPath: string, providers: ProviderId[]) => string[]

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
  /** The files with unsaved edits in the renderer (absolute paths), so quitting can ask about them. */
  'files:setUnsaved': (paths: string[]) => void
  'files:unwatch': (projectPath: string) => void

  'images:list': (projectPath: string) => SessionImageGroup[]
  'images:trash': (projectPath: string, path: string) => void
  'images:copy': (path: string) => void

  /** root is a project or one of its agents' worktrees. With base, lists everything changed since the branch left base. */
  'git:status': (root: string, base?: string) => GitStatus
  'git:diff': (root: string, file: string, base?: string) => GitDiff

  /** Each provider's installed CLI, by provider. */
  'provider:info': () => Record<ProviderId, AgentInstallInfo>
  /** Looks again (one provider, or all), including the latest version. */
  'provider:refresh': (provider?: ProviderId) => Record<ProviderId, AgentInstallInfo>
  /** Runs install, update, sign-in or setup in a terminal; returns the terminal's key. */
  'provider:task': (provider: ProviderId, task: ProviderTask) => string
  /** Stops every running agent of a provider (turning it off). */
  'provider:stopAgents': (provider: ProviderId) => void

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
