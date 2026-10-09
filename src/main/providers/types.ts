import type { AgentInstallInfo, AutoCompactSetting, CatalogModel, EffortLevel, McpServerDef, MemorySource, PathDataCopy, PermissionMode, PlanUsage, ProviderId, ReadinessIssue, SessionUsage, SubSession, TranscriptImageRef, TranscriptItem } from '../../shared/types'
import type { ProviderDescriptor } from '../../shared/providers'
import type { StartHint } from '../../shared/startFailure'

export interface LaunchSkill {
  name: string
  sourcePath: string
}

/**
 * What a launch gave the session of a skill it asked for: the content hash of the copy the CLI reads (null when there
 * is no copy of Hive's), and why it isn't the skill as asked for, if it isn't. `lasting`: a restart won't change that
 * (a folder of the user's has its name), as opposed to an old copy kept because it was in use.
 */
export interface SkillDelivery {
  revision: string | null
  problem?: string
  lasting?: true
}

export interface LaunchContext {
  projectPath: string
  /** Which of the project's agents is launching; each gets its own launch folder. */
  agentId: string
  /** The provider's CLI, as found (providerService). */
  executable: string
  /** Its version, as it reported it (null when it didn't), for arguments only some versions take. */
  cliVersion?: string | null
  /** Folder the agent works in: the project folder or its worktree. */
  cwd: string
  workspacePath: string
  /** Hive's id for this launch; hooks carry it (see hookUrl). */
  runId: string
  /** The session to start (providers with fixed ids) or resume; empty for a new session of a provider that picks its own id. */
  sessionId: string
  resume: boolean
  name: string
  skills: LaunchSkill[]
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  /** Hook endpoint for this launch, with its run id (…/hook?run=<runId>). */
  hookUrl: string
  /**
   * The file holding this launch's hook Authorization header, for hook commands (`curl -H @<file>`): in Hive's user
   * data, never the project, so no generated file holds the token (#345). HTTP hooks read `HIVE_HOOK_TOKEN` instead.
   */
  hookAuthFile: string
  /**
   * The launch's private folder, in Hive's user data and removed when it ends (#345): for generated files that may hold
   * a secret (Claude Code's settings and MCP config, with the user's and the workspace's servers' own values), which
   * must never be written to the project.
   */
  privateDir: string
  /** Hive's guidance for the agent (the hive MCP server's instructions), for providers that don't show MCP instructions themselves. */
  guidance: string
  /** More instructions for this launch, over the provider's own (the Hive Assistant's role and persona). */
  instructions?: string
  /** Tools of the hive MCP server this launch may use without asking, for providers that can pre-approve tools. */
  trustedHiveTools?: string[]
  /** The first task, given on the command line so the CLI starts on it (e.g. from the Hive Assistant). */
  initialPrompt?: string
  env: Record<string, string>
  /** The user lets sessions move into the CLI's own background service (see capabilities.backgroundSessions). */
  allowBackgroundSessions: boolean
  /** A 200K context window instead of the model's 1M one (capabilities.contextLimit). */
  use200kContext: boolean
}

export interface CommandSpec {
  file: string
  args: string[]
  env?: Record<string, string>
  /** Typed into the program once its interface is ready (e.g. Codex's /permissions menu for its sandbox setup). */
  keys?: KeySteps
  /** What its screen shows once the program is ready for `keys` (matched against the screen its output draws: KeyGate). */
  readyPattern?: RegExp
  /**
   * A window title (set by the program's OSC 0/2 sequences) that means it is busy: `keys` wait until it has been
   * idle for a moment, since a busy CLI queues what is typed instead of acting on it (Codex: "tab to queue message").
   */
  busyTitle?: RegExp
  /**
   * Whether its screen (rendered, a line per row) shows it busy and holding what was typed (Codex: "tab to queue
   * message" under its input, #363): `keys` wait while it does, as for busyTitle. The title can say so later.
   */
  busyScreen?: (screen: string) => boolean
  /** True once the task has done its job, for a program that stays open afterwards (Codex after its sandbox setup): Hive then closes it. */
  done?: () => boolean
}

/**
 * Keys typed into a CLI's own interface (a menu, a slash command), with pauses between them. A step is keys as they
 * are, or a pick: it reads the CLI's screen as rendered and returns what to type, null until the screen shows it, for
 * a menu whose order the CLI can change (Codex's /permissions, #396); `what` names what it looks for, for the error
 * when it never shows (main/keySteps.ts). A step that submits (Enter) can say how the screen shows it wasn't taken:
 * `heldOn` is true while the CLI still holds what it submits, unrun (Codex's input still holding the command, #363).
 */
export type KeyStep = { keys: string; waitMs?: number; heldOn?: (screen: string) => boolean } | { pick: (screen: string) => string | null; what: string; waitMs?: number }
export type KeySteps = KeyStep[]

export interface ExternalSession {
  id: string
  transcriptPath: string
  modified: string
  /** A session the CLI started for another one (from the transcript's first line). */
  sub?: SubSession
}

/** Something the CLI asks the user, from its hooks. */
export interface Ask {
  /** A permission request (in a reviewed mode the CLI's own reviewer answers it), or a question. */
  kind: 'permission' | 'question'
  /** The agent stops until it is answered; otherwise it carries on, and the answer comes later as a prompt. */
  blocking: boolean
  /** What it asks, for the status and the notification ('' when the CLI doesn't say). */
  message: string
  /** The tool call it is about (ToolEnd's `call`), when the CLI says: that call ending answers it. */
  call?: string
}

/** A provider's hook call, turned into what Hive tracks. */
export type HookEvent =
  | { kind: 'start'; source: string | null }
  /** A prompt the CLI took: `text`, what it says (when the CLI reports it), for telling who sent what (#418). */
  | { kind: 'prompt'; text?: string | null }
  | { kind: 'toolStart' }
  /** `call`: which tool call ended, when the CLI says (see Ask.call). */
  | { kind: 'toolEnd'; call?: string }
  /** The CLI asks the user something (whether a person is asked now is the status rules' call: see hookStatus). */
  | { kind: 'ask'; ask: Ask }
  /**
   * The turn ended. `failed`: on an error (a rate limit, the server; not the sign-in), which ends it as Stop does but
   * is no request that worked: it says nothing of the CLI's sign-in.
   */
  | { kind: 'stop'; lastMessage: string | null; failed?: true }
  /** The turn ended because the CLI's sign-in was refused (expired, revoked, an invalid key): `message` is the CLI's. */
  | { kind: 'signIn'; message: string | null }
  | { kind: 'interrupt' }
  | { kind: 'compactStart'; trigger: string }
  | { kind: 'compactEnd' }
  | { kind: 'end' }
  | { kind: 'ignore' }

export interface NormalizedHook {
  event: HookEvent
  /** The provider's session id, when the hook names one. */
  sessionId: string | null
  /** Where the provider writes the transcript, when the hook says. */
  transcriptPath: string | null
  /** The permission mode the hook reports, when it reliably reflects the live mode. */
  mode: PermissionMode | null
  /** The reply for a PreToolUse-style hook that edits files: the files it will change (absolute or relative to cwd). */
  editedPaths: string[]
}

/** Details about a running session a provider reports outside hooks (Claude's status line, Codex's rollout). */
export interface LiveDetails {
  modelName?: string
  /** The model's id as the CLI reports it (to learn its default effort, observedDefaultEffort). */
  modelId?: string
  effort?: string
  costUsd?: number
  permissionMode?: PermissionMode
  planMode?: boolean
  planUsage?: PlanUsage | null
  /** The model's context window in tokens. */
  contextWindow?: number
  /** A turn ended because the CLI's sign-in was refused (Codex's rollout): the CLI's message (see HookEvent signIn). */
  signIn?: string
  /** When the CLI recorded that turn's end (ISO), when it says: one from before this launch (a resumed log) is history. */
  signInAt?: string
  /**
   * When a turn last ended on an interrupt the CLI sends no hook for (Copilot's `abort`, also when a person cancels its
   * permission dialog), as recorded (ISO): handled as an interrupt hook. One from before this launch is history.
   */
  interruptedAt?: string
}

/**
 * A background task an agent started (a command left running, a Monitor) or that ended, from its transcript.
 * `at` is when the line was written (ms); a task with `expiresAt` ends then if nothing says so sooner.
 */
export type BackgroundTaskEvent = { kind: 'start'; id: string; at: number; expiresAt?: number } | { kind: 'end'; id: string; at: number }

/** Where an image's data sits in a transcript: the line's byte range and the path to it inside the entry. */
export interface ImageLocation {
  offset: number
  length: number
  path: (number | string)[]
}

/** Incremental transcript → usage parser: feed it whole lines as the transcript grows, read the usage so far. */
export interface UsageParser {
  feed(text: string): void
  result(): SessionUsage
}

/** Incremental transcript → conversation parser (transcripts are append-only). */
export interface ConversationParserLike {
  readonly items: TranscriptItem[]
  readonly images: ImageLocation[]
  /** Bytes consumed, always at a line boundary. */
  offset: number
  feed(buf: Buffer): number
}

/** The answer to a PreToolUse file-lock check, in the provider's hook reply format. */
export type LockDecision = { kind: 'deny' | 'ask'; reason: string } | { kind: 'warn'; context: string }

export interface SkillRoots {
  /** User-level skills the CLI always loads (e.g. ~/.claude/skills). */
  machine: string[]
  /** Installed plugins, whose skills the CLI loads. */
  plugins: string | null
  /**
   * Folders inside a project the CLI loads skills from (e.g. .claude/skills), the one Hive creates a project's skills in
   * first; [] for none. Copilot reads several (.github/skills, .agents/skills and .claude/skills).
   */
  local: string[]
  /** Hive's own copies inside `local`, which aren't the project's skills (folder name prefix). */
  hiveCopyPrefix: string | null
}

/**
 * Everything Hive needs from a coding-agent CLI. One adapter per provider, registered in
 * providers/index.ts; the rest of Hive never checks which provider it is talking to.
 */
export interface ProviderAdapter {
  readonly id: ProviderId
  readonly descriptor: ProviderDescriptor

  // Installation
  locate(): Promise<AgentInstallInfo>
  latestVersion(): Promise<string | null>
  isNewer(latest: string, current: string): boolean
  installCommand(): CommandSpec
  updateCommand(executable: string): CommandSpec
  loginCommand(executable: string): CommandSpec
  /** A one-time setup task (Codex's Windows sandbox), when the provider has one. */
  setupCommand?(executable: string): CommandSpec
  /** The CLI's own home (its sign-in and config) as Hive's sessions get it: what a test copy notes beside the CLI (#368). */
  configHome?(): string
  /** What still keeps agents from running, given what locate() found. */
  readiness(info: AgentInstallInfo): ReadinessIssue[]
  /** Extra lines for Help → Copy Diagnostics (Codex: its Windows sandbox), with no paths or names in them. */
  diagnostics?(): string[]
  /** The CLI's own default model from its settings, if set. */
  configuredDefaultModel(): string | null
  /** Whether a model seen in a transcript is this provider's (to learn the CLI's default). */
  ownsModel(model: string): boolean
  /** Environment variables to remove from sessions: a parent session's identity when Hive runs inside one. */
  readonly envToStrip: string[]

  // Launch
  /** Prepares the launch (skills, MCP, hooks) and says what it delivered of each skill in ctx.skills, by name. */
  prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>>
  /** Where this launch's CLI reads a delivered Hive skill (its copy), for measuring what the session got. */
  skillCopyPath(ctx: LaunchContext, skill: string): string
  buildCommand(executable: string, ctx: LaunchContext): CommandSpec
  /** Something the user should know about this launch (a mode the CLI can't fully give there), shown once per agent while Hive runs. */
  launchNotice?(ctx: LaunchContext): { title: string; message: string } | null

  // Hooks and live details
  normalizeHook(body: Record<string, any>): NormalizedHook
  /**
   * For CLIs whose terminal title says when a person must act (Codex's "Action Required"): a test of a title, for
   * this version of the CLI. Null (or absent) when its title doesn't say: its hooks then tell Hive (see hookStatus).
   */
  titleAttention?(version: string | null): ((title: string) => boolean) | null
  lockReply(decision: LockDecision): Record<string, unknown>
  /** Claude Code's status-line JSON. */
  statusLine?(body: Record<string, any>): LiveDetails
  /**
   * How a launch's CLI will compact by itself, read from its command, environment and the CLI's settings files (never
   * changed), for the model it runs as (`models`: the id it resolves to, then the choice). Absent: Hive doesn't know.
   */
  autoCompact?(ctx: LaunchContext, cmd: CommandSpec, models: string[]): AutoCompactSetting
  /**
   * Details from lines appended to the session's transcript (Codex: model, preset, Plan mode, plan limits). `memo` is
   * the launch's own, kept between reads (and emptied when the reading starts again), for what a later line completes.
   */
  transcriptDetails?(appended: string, memo: Record<string, unknown>): LiveDetails
  /**
   * Background tasks started or ended in lines appended to the session's transcript (whole lines). `memo` is the
   * launch's own, kept between reads (and emptied when the reading starts again), for what a later line completes.
   */
  backgroundTasks?(appended: string, memo: Record<string, unknown>): BackgroundTaskEvent[]
  /**
   * The installed CLI's models and what each can do (#125), when it can say (null: couldn't, or an unexpected reply).
   * Asking may start the CLI briefly, but never a session, a prompt or a sign-in. env: the sessions' environment.
   */
  listModels?(executable: string, env: Record<string, string>): Promise<CatalogRead | null>
  /** The effort the CLI's own settings choose for every model, if any (Codex's model_reasoning_effort). */
  configuredDefaultEffort?(): string | null
  /** For liveModeSwitch 'menu': the keys that pick a mode in the CLI's menu. */
  modeMenuKeys?(target: PermissionMode): KeySteps
  /** The mode the CLI says it switched to, from its terminal output after a menu switch (null: not said yet). */
  modeFromOutput?(tail: string): PermissionMode | null
  /** Whether the CLI's screen shows it busy holding what was typed (as CommandSpec.busyScreen): a menu switch waits while it does. */
  busyScreen?(screen: string): boolean
  /** For providers with a Plan toggle: the key that turns it on or off. */
  readonly planToggleKey?: string
  /**
   * The permission mode shown in the terminal footer, from the terminal's rendered screen (its lines as text), and the
   * mode the session was launched in (for modes whose footers look the same).
   */
  footerMode?(screen: string, launched?: PermissionMode | null): PermissionMode | null
  /** Whether a running session can switch to a mode without restarting. */
  canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean
  /** Terminal output meaning a compaction Hive started was refused or failed (no hook comes). */
  readonly compactFailure: RegExp | null
  /**
   * Terminal output meaning the CLI is waiting for a prompt, for CLIs whose first hook only comes with the
   * first prompt (Codex creates its thread lazily): until then Hive shows the agent as ready from this.
   */
  readonly readyOutput?: RegExp

  // Transcripts
  transcriptPath(folder: string, sessionId: string, recorded?: string): Promise<string | null>
  /** Where to put a transcript restored from Hive's backup so the CLI can resume it; null if it can't be restored. */
  restorePath(folder: string, sessionId: string, recorded?: string): string | null
  listSessions(folder: string): Promise<ExternalSession[]>
  /** Whether a transcript (one of the CLI's, or Hive's copy of it) is a sub-session, from its first line; cached by mtime. */
  subSessionOf(path: string, sessionId: string): Promise<SubSession | null>
  /**
   * What the CLI keeps by a folder's path rather than in it (Claude Code: ~/.claude/projects/<path as name>/, its
   * transcripts and auto memory), for a folder that moved (#146). With apply, copied to the new path's name: never moved
   * or deleted, and a file already there with other content is kept. Null when it has nothing for `from`. Providers that
   * keep sessions by id (Codex) have none.
   */
  copyPathData?(from: string, to: string, apply: boolean): Promise<PathDataCopy | null>
  /** Output that means the CLI is asking the user something before it starts (e.g. whether to trust the folder). */
  readonly startupQuestion?: RegExp
  /**
   * How Hive ends the CLI as a person would, for CLIs that write what Hive reads only as they exit (Copilot's token
   * totals, #465): the keys it types, one every gapMs, before killing the CLI if it is still running after graceMs.
   * Without it, Stop kills the process.
   */
  readonly exitKeys?: { keys: string[]; gapMs: number; graceMs: number }
  parseUsage(text: string, sessionId: string): SessionUsage
  /** Reads a transcript's usage a piece at a time (whole lines), for transcripts that keep growing. */
  usageParser(sessionId: string): UsageParser
  conversationParser(projectPath: string): ConversationParserLike
  /** An image's data URL from the transcript line holding it. */
  imageData(line: Record<string, any>, loc: ImageLocation): string | null
  /** Heading for a Markdown export. */
  exportSubtitle(sessionId: string, project: string): string

  // Project files
  memorySources(projectPath: string): Promise<MemorySource[]>
  /** Files in the CLI's own folder Hive may show and edit (instructions, memory); false for anything else. */
  fileAllowed(path: string, write: boolean): boolean
  skillRoots(): SkillRoots
  /** MCP servers a project defines in the CLI's own config, which Hive leaves off until copied to the workspace. */
  projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>>

  /**
   * What to do about the CLI exiting before its session started, from the lines it printed last (escapes removed):
   * e.g. an argument it refused, a model it doesn't know, no sign-in. Null when it doesn't recognise the error.
   */
  startHint?(text: string): StartHint | null

  // Background sessions (capabilities.backgroundSessions)
  /** The CLI's background job named in what it printed when it refused to resume a session held there; null if none. */
  backgroundJobIn?(output: string): string | null
  /** Stops one of the CLI's background jobs (its conversation is kept). */
  stopBackgroundJob?(executable: string, jobId: string): Promise<void>
}

/** A CLI's model catalog as read (models.ts files of each adapter): its models, and the one it runs by default. */
export interface CatalogRead {
  models: CatalogModel[]
  defaultModel?: string
}

export type { TranscriptImageRef }
