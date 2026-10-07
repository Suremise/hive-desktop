import type { AntivirusStatus, AvAction, AvChangeResult, AvSuggestionReply } from './antivirus'
import type {
  ArchiveBatch,
  ArchiveRequest,
  ArchiveResult,
  UnarchiveResult,
  BoardFold,
  UpdateState,
  WorktreeGone,
  WorktreeCheck,
  RemovedAgent,
  MoveOptions,
  MovePlan,
  MoveReport,
  ProgressRun,
  PermissionMode,
  AddAgentOptions,
  AssistantAction,
  AssistantQuestion,
  AgentApiInfo,
  AgentBranchStatus,
  AgentDef,
  TemplateLoadPlan,
  OldWorktreeOutcome,
  AgentPatch,
  CleanupItem,
  CleanupOptions,
  CleanupResult,
  PersonaInfo,
  RecentWorkspace,
  AgentInstallInfo,
  AppConfig,
  AppInfo,
  AppSettings,
  EffortOption,
  FallbackModel,
  FileContent,
  FileEntry,
  GitDiff,
  HiddenProject,
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
  ProjectRemoval,
  ProjectRemovalInfo,
  ProjectStorage,
  QuitChoice,
  QuitScope,
  QuitSession,
  SessionBulkAction,
  SessionBulkResult,
  SessionImageGroup,
  SessionListItem,
  WorkspaceUsage,
  WorkspaceStorage,
  SessionUsage,
  SkillInfo,
  SkillTarget,
  TaskCard,
  TaskColumn,
  TaskPatch,
  TaskStartTarget,
  Transcript,
  TranscriptSearchResult,
  TranscriptTool,
  WorkspaceInfo
} from './types'
import type { MetricsQuery, MetricsReport } from './metrics'
import type { Artifact, CompareScope, ImportResult, KeptEntry } from './benchmark'
import type { AgentTemplate, TemplateDest, TemplateEntry, TemplateRef, TemplateScope } from './templates'
import type { ProjectPref, ProjectPrefValue } from './uiPrefs'
import type { TipsChange, TipsState } from './tips'
import type { BoardFoldChange } from './tasks'

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
  /** Help → Copy Diagnostics: versions, coding agents, counts, key settings and the end of the log, redacted, as Markdown. */
  'app:diagnostics': () => string
  /** How many working agents keep the PC awake now (0: none, or the setting doesn't). */
  'app:keepAwake': () => number
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
  /** How many Hive windows are open. */
  'window:count': () => number
  /** Opens another Hive window (the welcome page), like VS Code's New Window. */
  'window:new': () => void
  'window:toggleDevTools': () => void
  'window:zoom': (direction: 'in' | 'out' | 'reset') => void
  'window:toggleFullScreen': () => void
  'window:edit': (role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  'window:setTitleBarColors': (color: string, symbolColor: string) => void
  /** How many backdrops (dialogs, nested or not, the command palette) are up in this window: dims the window buttons to match. */
  'window:setBackdrops': (count: number) => void
  /** The taskbar button's badge: a PNG (base64) drawn at `scale`, or none at 0. */
  'window:setBadge': (count: number, png: string | null, scale: number) => void
  /** Always on Top for this window, remembered for its workspace (pin.ts). Returns the window's state now. */
  'window:setAlwaysOnTop': (on: boolean) => boolean
  'window:getAlwaysOnTop': () => boolean
  /** The project this window's page shows (null: none), for banners shown for "This project". */
  'window:showing': (projectPath: string | null) => void
  /** A banner was clicked: brings up the window showing its project, and the project (as a Windows notification's click). */
  'notice:open': (projectPath: string | null) => void

  'settings:get': () => AppSettings
  'settings:update': (patch: SettingsPatch) => AppSettings
  'settings:reset': (section?: keyof AppSettings) => AppSettings
  /** Replaces a provider's price overrides (USD per million tokens, by model id). */
  /** Replaces a provider's price overrides, and (when given) which shipped prices are removed from its table. */
  'settings:setProviderPrices': (provider: ProviderId, prices: Record<string, ModelPrice>, removed?: string[]) => AppSettings
  /** Replaces a provider's fallback list of models or effort levels (#125); null goes back to Hive's defaults. */
  'settings:setProviderFallback': (provider: ProviderId, kind: 'models' | 'efforts', list: (FallbackModel | EffortOption)[] | null) => AppSettings
  /** Sets (string), removes (null) or resets to the default (undefined) one command's shortcut. */
  'settings:setKeybinding': (commandId: string, key: string | null | undefined) => AppSettings
  'ui:get': () => AppConfig['ui']
  'ui:set': (ui: Partial<AppConfig['ui']>) => void
  /** Saves one pane's size (null: back to its default), leaving the other panes as they are: several windows save them. */
  'ui:setPane': (key: string, size: number | null) => void
  /** Saves (null: forgets) one project's view preference (Skills tab provider or groups, Sessions tree), merged into what is saved: several windows save them (#245). */
  'ui:setProjectPref': <P extends ProjectPref>(pref: P, project: string, value: ProjectPrefValue<P> | null) => void
  /** Changes this window's workspace's board fold (#170), on what is saved now, leaving other workspaces' as they are; replies with them all. */
  /** Applies one change to what the tips know, on what is saved (#266): several windows change it. Replies with the state saved. */
  'ui:changeTips': (change: TipsChange) => TipsState
  'ui:changeBoardFold': (change: BoardFoldChange) => Record<string, BoardFold>

  'workspace:get': () => WorkspaceInfo | null
  'workspace:open': (path?: string) => WorkspaceInfo | null
  'workspace:create': () => WorkspaceInfo | null
  /** False when the user cancelled (running agents would have been stopped). */
  'workspace:close': () => boolean
  /** The recent workspaces as this window sees them: whether each folder is there, and whether another window has it open (#144). */
  'workspace:recent': () => RecentWorkspace[]
  /** Every project's (and the Assistant's) sessions with their usage, for the Workspace Overview. */
  'workspace:usage': () => WorkspaceUsage
  /** The workspace's performance metrics for a scope and range (metrics.ts; the Performance view and tab). */
  'metrics:query': (q: MetricsQuery) => MetricsReport
  /** Clears the workspace's performance metrics. */
  'metrics:reset': () => void
  /** Saves a report as a JSON file (a save dialog): the path, or null if cancelled. `sanitize` replaces project names. */
  'metrics:export': (q: MetricsQuery, sanitize: boolean) => string | null
  /** Ends an agent's card watch (#128: the Cancel in its header). Whether it had one. */
  'watch:cancel': (projectPath: string, agentId: string) => boolean
  /** Kept comparisons (Performance → Compare), for a scope only: a project's page sees its own project's. */
  'benchmarks:list': (scope: CompareScope) => { entries: KeptEntry[]; base: string | null; run: string | null; notice?: string }
  /** Imports a benchmark or export (an open dialog; or, with `token`, a file an earlier answer asked about). Null if cancelled. */
  'benchmarks:import': (scope: CompareScope, answer?: { token: string; useProjectPart: boolean }) => ImportResult | null
  /** Keeps the page's current report (its query: scope, range, filters) as a comparison. */
  'benchmarks:keep': (q: MetricsQuery, label?: string) => KeptEntry
  'benchmarks:read': (scope: CompareScope, id: string) => Artifact
  'benchmarks:remove': (scope: CompareScope, id: string) => void
  'benchmarks:pin': (scope: CompareScope, id: string, pinned: boolean) => void
  /** Remembers a scope's chosen baseline and run. */
  'benchmarks:select': (scope: CompareScope, base: string | null, run: string | null) => void
  /** Forgets a recent workspace (the folder is left alone), whatever the case of the path given (#144). */
  'workspace:removeRecent': (path: string) => RecentWorkspace[]
  /** Clears the recent workspaces, keeping those open in a window now (#144). */
  'workspace:clearRecent': () => RecentWorkspace[]
  'workspace:refresh': () => WorkspaceInfo | null
  /** What Repair… would do for a moved workspace or project (#146), with the user's choices; null when nothing moved. */
  'workspace:movePlan': (opts?: MoveOptions) => MovePlan | null
  /** Repairs it (refused while agents run): worktrees, session folders, the CLIs' per-path data (copied), Open Recent. */
  'workspace:moveRepair': (opts?: MoveOptions) => MoveReport
  /** Locate…: a folder picker for an agent's worktree that wasn't found; the folder, or null when cancelled. */
  'workspace:moveLocate': (projectPath: string, agentId: string) => string | null

  'project:create': (name: string) => WorkspaceInfo | null
  'project:setActive': (projectPath: string, active: boolean) => WorkspaceInfo | null
  'project:updateConfig': (projectPath: string, patch: Partial<ProjectConfig>) => ProjectConfig
  /** Adds the project's .hive to its git repository's info/exclude (#345); refuses where no git repository holds it. */
  'project:excludeHive': (projectPath: string) => WorkspaceInfo
  /** Changes one provider's overrides for a project, merged under the file lock. */
  'project:updateProvider': (projectPath: string, provider: ProviderId, patch: Partial<ProjectProviderConfig>) => ProjectConfig
  'project:openInExplorer': (projectPath: string) => void
  'project:openTerminal': (projectPath: string) => void
  /** What hiding, removing or deleting the project would touch (Project → Remove Project…). */
  'project:removalInfo': (projectPath: string) => ProjectRemovalInfo
  /** Hides it, removes it from Hive (packing its workspace files into its folder) or deletes it (to the Recycle Bin). */
  'project:remove': (projectPath: string, how: ProjectRemoval) => { warnings: string[] }
  /** Projects hidden or removed from Hive, and whether each folder is still in the workspace. */
  'project:hidden': () => (HiddenProject & { present: boolean })[]
  'project:restore': (name: string) => { handovers: number; cards: number }
  /** Stops listing a hidden or removed project whose folder is gone. */
  'project:forget': (name: string) => void
  /** A folder holding what Remove from Hive packed: keep (unpack into this workspace) or discard it. */
  'project:takeRemovedData': (projectPath: string, keep: boolean) => { handovers: number; cards: number }

  /** Every card on the workspace's board, archived ones too. */
  'tasks:list': () => TaskCard[]
  'tasks:create': (input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[] }) => TaskCard
  'tasks:update': (n: number, patch: TaskPatch) => TaskCard
  'tasks:comment': (n: number, text: string) => TaskCard
  'tasks:archive': (n: number, archived: boolean) => TaskCard
  /** Archives the cards listed as one batch (#351), the user's: Undo or "Unarchive this batch" brings it back. */
  'tasks:archiveBatch': (numbers: number[], req: ArchiveRequest) => ArchiveResult
  /** Brings a batch back, each card where it was in its column; a batch with cards that couldn't come back is kept. */
  'tasks:unarchiveBatch': (id: string) => UnarchiveResult
  /** The bulk archives kept (the latest 50), oldest first. */
  'tasks:archiveBatches': () => ArchiveBatch[]
  /** To the Recycle Bin. */
  'tasks:delete': (n: number) => void
  /** Gives the card to an agent (an existing one, or a new one) with the card as its prompt, and moves it to Doing. */
  'tasks:start': (n: number, target: TaskStartTarget) => { agentId: string; agentName: string; added: boolean }

  'session:list': (projectPath: string) => SessionListItem[]
  /** agentId: without one, the project's only agent. skipSetup starts the agent even though the worktree's setup command hasn't succeeded. */
  'session:start': (projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean }) => LiveSessionState
  /** Stops the CLI's background job holding a conversation, then resumes it in the agent. */
  'session:stopBackgroundAndResume': (projectPath: string, agentId: string, jobId: string, sessionId: string) => void
  'session:stop': (projectPath: string, agentId?: string) => void
  /** Types a short "carry on" into a running agent whose turn a refused sign-in stopped (Resume (n), #309). */
  'session:carryOn': (projectPath: string, agentId: string) => void
  'session:archive': (projectPath: string, sessionId: string, archived: boolean) => void
  'session:rename': (projectPath: string, sessionId: string, name: string) => void
  /** Deletes a session that isn't running from Hive (its record and backups; the CLI's transcript stays). */
  'session:delete': (projectPath: string, sessionId: string) => void
  /** Archives, unarchives or deletes several sessions (a branch of the Sessions tab), each all or nothing; skips those in use. */
  'session:bulk': (projectPath: string, action: SessionBulkAction, sessionIds: string[]) => SessionBulkResult
  /** Deleted sessions' usage (list items with deleted: true), which totals still count. */
  'session:keptUsage': (projectPath: string) => SessionListItem[]
  /** What Hive keeps for a project or the Assistant (Project Settings → Storage); the last result unless refresh. `request` lets storage:abandon end the call. */
  'storage:project': (projectPath: string, refresh?: boolean, request?: string) => ProjectStorage
  /** Every project's storage and the Assistant's, biggest first (Settings → Workspace); `request` as for storage:project. */
  'storage:workspace': (refresh?: boolean, request?: string) => WorkspaceStorage
  /** The window stopped waiting for a storage request (its page closed): the call fails, and a measurement nothing else waits for stops. */
  'storage:abandon': (request: string) => void
  /** Antivirus scanning of the window's workspace (#316, main/antivirus.ts): cached unless refresh. */
  'antivirus:status': (refresh?: boolean) => AntivirusStatus
  /** Works out a change (add or remove the workspace's exclusions, or read Defender's list) for the user to confirm: its exact folders. */
  'antivirus:prepare': (action: AvAction) => { id: string; action: AvAction; paths: string[]; workspacePath: string }
  /** Runs a prepared change exactly as confirmed, with administrator rights (one UAC prompt); refused if anything changed. Status null: the workspace changed meanwhile. */
  'antivirus:apply': (id: string) => { result: AvChangeResult; status: AntivirusStatus | null }
  /** Whether to suggest exclusions now (marks the offer made): the suggestion (status, which time) or null, and when a reminder may come. */
  'antivirus:suggestion': () => AvSuggestionReply
  /** "Don't ask again" for the window's workspace. */
  'antivirus:dismiss': () => void
  /** What Clean Up… would move to the Recycle Bin with these options. */
  'storage:cleanupPreview': (projectPath: string, opts: CleanupOptions) => CleanupItem[]
  /** Moves what the preview listed (its paths) to the Recycle Bin, skipping what no longer qualifies. */
  'storage:cleanup': (projectPath: string, opts: CleanupOptions, listed: string[]) => CleanupResult
  /** Forgets every transcript's usage, in memory and in usage-cache.json (Settings → Sessions → Usage cache). */
  'session:clearUsageCache': () => void
  'session:adopt': (projectPath: string, sessionId: string) => void
  'session:usage': (projectPath: string, sessionId: string) => SessionUsage | null
  /** The window showed these agents' panes (all of the project's agents when none are named). */
  'session:markSeen': (projectPath: string, agentIds?: string[]) => void
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
  'agents:update': (projectPath: string, agentId: string, patch: AgentPatch) => AgentDef
  /**
   * Removes an agent (its session must be stopped). deleteWorktree also removes its worktree and branch; 'merged-clean'
   * only when they are fully merged into the main branch (`mergedInto`, the one the user was shown) and clean then,
   * guarded against changes while deleting, and never one another agent of the project still works in (#291).
   */
  'agents:remove': (projectPath: string, agentId: string, opts: { deleteWorktree: boolean | 'merged-clean'; mergedInto?: string | null; releaseCards?: boolean }) => RemovedAgent
  /** Whether each worktree agent's worktree could be deleted without losing work (merged and clean), for Remove All's question (#291). */
  'agents:worktreeChecks': (projectPath: string) => ({ agentId: string } & WorktreeCheck)[]
  /** The agent's worktree when its folder is missing, with whether its branch survives (#146); null when it isn't missing. */
  'agents:missingWorktree': (projectPath: string, agentId: string) => WorktreeGone | null
  /** Makes a missing worktree again: on its branch when it survives, else new from its base (#146). */
  'agents:recreateWorktree': (projectPath: string, agentId: string) => AgentDef
  /** Removes the link of an agent whose worktree folder is missing: it works in the project folder from now on. */
  'agents:unlinkWorktree': (projectPath: string, agentId: string) => AgentDef
  /** Moves an agent to `index` in the project's order (its position afterwards); returns the agents' ids in order. */
  'agents:move': (projectPath: string, agentId: string, index: number) => string[]
  /** Swaps two agents' places in the project's order (one dropped on another's pane); returns the agents' ids in order. */
  'agents:swap': (projectPath: string, agentId: string, otherId: string) => string[]
  /** Agent templates (#126): the workspace's and the project's. */
  'templates:list': (projectPath: string) => TemplateEntry[]
  /** Saves the project's agents and layout; a name already there is replaced only with `overwrite` (else `exists`). */
  'templates:save': (projectPath: string, scope: TemplateScope, name: string, overwrite: boolean) => { saved: TemplateEntry } | { exists: string }
  /** What loading a template would do, and what stops it now. `from`: the project a project's template is kept in, if not this one. */
  'templates:plan': (projectPath: string, scope: TemplateScope, file: string, from?: string) => TemplateLoadPlan
  /** Replaces the project's agents and layout with a template's; `expected` is the agents' ids as the user saw them. */
  'templates:load': (projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, removeOld?: { paths: string[]; mergedInto: string | null }) => { created: string[]; removed: string[]; oldWorktrees: OldWorktreeOutcome[] }
  /** Adds one agent of a template (the `index`-th), the others left alone. */
  'templates:addAgent': (projectPath: string, scope: TemplateScope, file: string, index: number, from?: string) => AgentDef & { reused?: true }
  /** Every template of the workspace (#127, the Templates view): the workspace's, then each project's. */
  'templates:all': () => TemplateEntry[]
  /** Renames a template where it is kept (another of that name there refuses it). */
  'templates:rename': (ref: TemplateRef, name: string) => TemplateEntry
  /** An edited template (#271), saved where it is kept; `savedAt`: as it was when the editor opened it. */
  'templates:update': (ref: TemplateRef, edited: Pick<AgentTemplate, 'name' | 'description' | 'layout' | 'agents'>, savedAt: string | null) => TemplateEntry
  /** Copies a template into the workspace or a project; a name taken there gets a number ("Pair (2)"). */
  'templates:duplicate': (ref: TemplateRef, to: TemplateDest) => TemplateEntry
  /** Deletes a template (to the Recycle Bin). */
  'templates:delete': (ref: TemplateRef) => void
  /** Exports a template to a file the user chooses (a save dialog); its path, or null if cancelled. */
  'templates:export': (ref: TemplateRef) => string | null
  /** Picks a file to import (an open dialog) and checks it: what it holds, refused saying why; null if cancelled. */
  'templates:pickImport': () => { path: string; name: string; agents: number; unknown: string[] } | null
  /** Imports a checked file into a place; a name already there is a clash unless `onClash` says replace or keep both. */
  'templates:import': (path: string, to: TemplateDest, onClash?: 'replace' | 'keep') => { imported: TemplateEntry } | { clash: string }
  /** Branches and worktrees, for the Add Agent dialog. */
  'agents:gitInfo': (projectPath: string) => ProjectGitInfo
  'agents:branchStatus': (projectPath: string, agentId: string) => AgentBranchStatus
  /** Every worktree agent's unmerged work known so far (then `branch-status` events as it changes). */
  'agents:branchStatuses': () => { projectPath: string; agentId: string; status: AgentBranchStatus | null }[]
  /** Commits the worktree's changes and merges its branch into the project folder's current branch. */
  'agents:merge': (projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean; moveBranch?: boolean }) => MergeResult

  /** The conversation for the transcript viewer; null when the file has not grown since knownSize. Long tool input/output is shortened. */
  /** The conversation from item `from` on (default: the last TRANSCRIPT_WINDOW items); null when the file hasn't grown since knownSize and `from` is unchanged. */
  'transcript:read': (projectPath: string, sessionId: string, opts?: { knownSize?: number; from?: number }) => Transcript | null
  /** One tool call with its full input and output. */
  'transcript:tool': (projectPath: string, sessionId: string, itemId: number) => TranscriptTool
  /** An image stored in the transcript, as a data URL. */
  'transcript:image': (projectPath: string, sessionId: string, imageId: number) => string
  /** Searches one session, or all of the project's sessions when sessionId is null. */
  'transcript:search': (projectPath: string, query: string, sessionId: string | null) => TranscriptSearchResult[]
  /** The transcript's compactions, oldest first: each one's item id (to open the transcript at its divider). */
  /** A Sessions view (`view`: its id) shows this transcript now, or none (null): archiving or deleting it from another window skips it. */
  'transcript:viewing': (view: string, projectPath: string, sessionId: string | null) => void
  'transcript:compactions': (projectPath: string, sessionId: string) => number[]
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
  /** The Hive Assistant's actions in this window's workspace, oldest first, and the questions it waits on. */
  'assistant:actions': () => AssistantAction[]
  'assistant:questions': () => AssistantQuestion[]
  'assistant:answer': (id: string, yes: boolean) => void
  /** Revert on a setting the Assistant changed (its activity list): sets it back, and lists that too (#186). */
  'assistant:revertSetting': (actionId: string) => void
  /** Switches this workspace's Assistant to a mode (a persona file): told at once if it runs, else when it starts (#259). */
  'assistant:switchMode': (personaId: string, save?: boolean) => 'told' | 'later' | 'saved'
  /** This window's workspace's progress runs, newest first. */
  'progress:list': () => ProgressRun[]
  /** Moves a finished or stale run to Recent. */
  'progress:dismiss': (id: string) => void
  /** The user looked at the Progress panel: the taskbar stops showing a failure in red. */
  'progress:seen': () => void
  /** Opens the log a run reported (a text log or report, in its default app); an error says why it can't. */
  'progress:openLog': (id: string) => void
  /** Shows the log a run reported in its folder. */
  'progress:showLog': (id: string) => void
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
  /** Which entries are files that exist (folders and missing paths are false); for the terminal's file links. */
  'files:linkFiles': (projectPath: string, rels: string[]) => (string | null)[]
  /** Starts/stops live 'files-changed' events for a project (reference counted). */
  'files:watch': (projectPath: string) => void
  /** The files with unsaved edits in the renderer (absolute paths), so quitting can ask about them. */
  'files:setUnsaved': (paths: string[]) => void
  'files:unwatch': (projectPath: string) => void

  'images:list': (projectPath: string) => SessionImageGroup[]
  'images:trash': (projectPath: string, path: string) => void
  /** Moves all of a session's images to the Recycle Bin, all or none (not while it runs): how many went. */
  'images:trashGroup': (projectPath: string, sessionId: string) => number
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
