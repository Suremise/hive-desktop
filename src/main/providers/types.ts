import type { AgentInstallInfo, EffortLevel, McpServerDef, MemorySource, PermissionMode, PlanUsage, ProviderId, ReadinessIssue, SessionUsage, TranscriptImageRef, TranscriptItem } from '../../shared/types'
import type { ProviderDescriptor } from '../../shared/providers'

export interface LaunchSkill {
  name: string
  sourcePath: string
}

export interface LaunchContext {
  projectPath: string
  /** Which of the project's agents is launching; each gets its own launch folder. */
  agentId: string
  /** The provider's CLI, as found (providerService). */
  executable: string
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
}

export interface CommandSpec {
  file: string
  args: string[]
  env?: Record<string, string>
  /** Typed into the program once its interface is ready (e.g. Codex's /permissions menu for its sandbox setup). */
  keys?: KeySteps
  /** Output that means the program is ready for `keys`. */
  readyPattern?: RegExp
  /**
   * A window title (set by the program's OSC 0/2 sequences) that means it is busy: `keys` wait until it has been
   * idle for a moment, since a busy CLI queues what is typed instead of acting on it (Codex: "tab to queue message").
   */
  busyTitle?: RegExp
  /** True once the task has done its job, for a program that stays open afterwards (Codex after its sandbox setup): Hive then closes it. */
  done?: () => boolean
}

/** Keys typed into a CLI's own interface (a menu, a slash command), with pauses between them. */
export type KeySteps = { keys: string; waitMs?: number }[]

export interface ExternalSession {
  id: string
  transcriptPath: string
  modified: string
}

/** A provider's hook call, turned into what Hive tracks. */
export type HookEvent =
  | { kind: 'start'; source: string | null }
  | { kind: 'prompt' }
  | { kind: 'toolStart' }
  | { kind: 'toolEnd' }
  /** The agent waits for the user: a permission prompt or a question. */
  | { kind: 'needsInput'; message: string }
  | { kind: 'stop'; lastMessage: string | null }
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
  effort?: string
  costUsd?: number
  permissionMode?: PermissionMode
  planMode?: boolean
  planUsage?: PlanUsage | null
  /** The model's context window in tokens. */
  contextWindow?: number
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
  /** Folder inside a project the CLI loads skills from (e.g. .claude/skills). */
  local: string | null
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
  /** What still keeps agents from running, given what locate() found. */
  readiness(info: AgentInstallInfo): ReadinessIssue[]
  /** The CLI's own default model from its settings, if set. */
  configuredDefaultModel(): string | null
  /** Whether a model seen in a transcript is this provider's (to learn the CLI's default). */
  ownsModel(model: string): boolean
  /** Environment variables to remove from sessions: a parent session's identity when Hive runs inside one. */
  readonly envToStrip: string[]

  // Launch
  prepareLaunch(ctx: LaunchContext): Promise<void>
  buildCommand(executable: string, ctx: LaunchContext): CommandSpec

  // Hooks and live details
  normalizeHook(body: Record<string, any>): NormalizedHook
  lockReply(decision: LockDecision): Record<string, unknown>
  /** Claude Code's status-line JSON. */
  statusLine?(body: Record<string, any>): LiveDetails
  /** Details from lines appended to the session's transcript (Codex: model, preset, Plan mode, plan limits). */
  transcriptDetails?(appended: string): LiveDetails
  /** Background tasks started or ended in lines appended to the session's transcript (whole lines). */
  backgroundTasks?(appended: string): BackgroundTaskEvent[]
  /** For liveModeSwitch 'menu': the keys that pick a mode in the CLI's menu. */
  /** The models the installed CLI offers, when it can list them (null: couldn't). */
  listModels?(executable: string): Promise<{ value: string; label: string }[] | null>
  modeMenuKeys?(target: PermissionMode): KeySteps
  /** The mode the CLI says it switched to, from its terminal output after a menu switch (null: not said yet). */
  modeFromOutput?(tail: string): PermissionMode | null
  /** For providers with a Plan toggle: the key that turns it on or off. */
  readonly planToggleKey?: string
  /** The permission mode shown in the terminal footer, from output with control sequences replaced by spaces. */
  footerMode?(tail: string): PermissionMode | null
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
  /** Output that means the CLI is asking the user something before it starts (e.g. whether to trust the folder). */
  readonly startupQuestion?: RegExp
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

  // Background sessions (capabilities.backgroundSessions)
  /** The CLI's background job named in what it printed when it refused to resume a session held there; null if none. */
  backgroundJobIn?(output: string): string | null
  /** Stops one of the CLI's background jobs (its conversation is kept). */
  stopBackgroundJob?(executable: string, jobId: string): Promise<void>
}

export type { TranscriptImageRef }
