import { randomUUID, randomBytes } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'original-fs/promises'
import { existsSync, realpathSync } from 'original-fs'
import { typedText } from '../shared/terminalInput'
import { failedStart, type StartFailure } from '../shared/startFailure'
import { BrowserWindow, Notification, app, clipboard, shell } from 'electron'
import { ASSISTANT_DIR, ASSISTANT_NAME } from '../shared/assistant'
import { formatDateTime } from '../shared/dates'
import { assistantTools } from '../shared/assistantTools'
import { COMPACTING_MESSAGE, HIVE_DIR, agentPtyKey, assertSessionId, cliRename, formatBytes, isSessionId, projectAgents, resumeRecord, transcriptWarnLimit } from '../shared/defaults'
import { agentLaunchSettings, isProviderEnabled, modeAllowed, permissionLabel, providerDescriptor, providerSettings } from '../shared/providers'
import { resolvedModel } from '../shared/models'
import type {
  AutoCompactSetting,
  AgentDef,
  AgentInfo,
  EffortLevel,
  FileLockMode,
  KeptUsage,
  LiveSessionState,
  McpServerDef,
  PermissionMode,
  ProjectConfig,
  ProviderId,
  SessionBulkAction,
  SessionBulkResult,
  SessionListItem,
  SessionRecord,
  SessionSkipReason,
  SubSession,
  SessionStatus,
  SessionUsage,
  TaskWatchInfo
} from '../shared/types'
import { provider as providerAdapter, allProviders } from './providers'
import { recacheEstimate } from './providers/common'
import { estimateCost } from '../shared/prices'
import { withDayCosts } from '../shared/usageDays'
import type { Ask, HookEvent, LaunchContext, LaunchSkill, ProviderAdapter, SkillDelivery, UsageParser } from './providers/types'
import { providerService } from './providerService'
import { config } from './config'
import { emit, emitTo, toast } from './events'
import { presentWindow, showOsNotification, testNotifyLog, testQuiet } from './testQuiet'
import { hashText, heldOpen, isInUse, readJson, removePath, treeSignature, splitArgs, syncCopy, syncCopyLocked, syncCopyNow, trashAllOrNothing, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { applyStep, compactionOver, expireTasks, hookStep, idleAfter, titleStep, type HookStatusInput, type HookStep } from './hookStatus'
import { Compaction } from './compaction'
import { lastTitle } from './terminalTitle'
import { asksYou } from '../shared/inbox'
import { FinishBatcher, finishedNotice, noticeRoute, type FocusedHive, type NoticeRoute } from '../shared/bursts'
import { recordCards } from './cardSessions'
import { listMcp, toLaunchDef } from './mcp'
import { PTY_COLS, PTY_ROWS, childEnv, killPty, spawnPty, writePty } from './ptyHost'
import { TerminalScreen } from './terminalScreen'
import { withBinOnPath } from './progressReporters/shims'
import { hiveSkills, parseSkillFrontmatter, skillFor } from './skills'
import { GUIDANCE_REVISION, launchParts, launchRecord } from './guidance'
import { notificationIcon } from './paths'
import { reportPlanUsage } from './planUsage'
import { revisionOf } from './revisions'
import { metricsHandle, recordLaunch } from './metrics'
import { headerOf } from './revisions'
import { utf8Bytes } from '../shared/metrics'
import { inWorkspace, workspace, workspaceFor, workspaceOf } from './workspace'
import { endAgentToken, newAgentToken } from './agentTokens'
import { endHookToken, newHookToken } from './hookTokens'
import { beingRead, viewingWindows } from './transcriptReads'

const log = createLogger('sessions')

/** A handover in the shared notes: its path there, when it changed, and the session that wrote it (from its header). */
export interface HandoverRef {
  relPath: string
  modified: string
  session: string | null
}

export interface HiveMcpProvider {
  /** The hive MCP server for a project's sessions; with agentId, that agent's (its tools then say who is calling). */
  (projectPath: string, agentId?: string): McpServerDef | null
}

/** Minimum time between transcript backups while a turn is running. */
const BACKUP_INTERVAL_MS = 60_000
/** Minimum time between cost estimates while a turn is running (each parses the whole transcript). */
const COST_INTERVAL_MS = 30_000

interface LiveSession {
  state: LiveSessionState
  adapter: ProviderAdapter
  /** The transcript's modified time and size at the last look ("mtime:size"). */
  transcriptMtime: string
  /** Where the provider writes this session's transcript, once known (from a hook, or found by id). */
  transcriptPath?: string
  backupTimer?: NodeJS.Timeout
  /** When the transcript was last copied to .hive/sessions (see BACKUP_INTERVAL_MS). */
  lastBackupAt?: number
  /** The transcript's modified time and size when it was last backed up. */
  backupMtime?: string
  /** Launched without a model choice, so its transcript shows the CLI's default model. */
  defaultModel: boolean
  /**
   * Launched without an effort choice: the effort it first reports is the CLI's default for its model (the launch's
   * model, else the one it reports), learned for the footer (#125). Cleared once learned.
   */
  defaultEffort?: { model: string | null }
  /** How the CLI compacts by itself for a model it runs as (#242), read again when the session reports another model. */
  autoCompactFor?: (running?: string) => AutoCompactSetting
  /** Set while a compaction Hive asked for runs. */
  compacting?: Compaction
  /** Prompts the CLI has taken in this launch (UserPromptSubmit): a typed line is taken once this goes up (#376). */
  prompts?: number
  /** The user stopped it (e.g. during its worktree setup), so an early exit isn't reported as a failure. */
  stopRequested?: boolean
  /** Terminal output tail, to see the CLI ready or asking something at the start. */
  modeTail: string
  /** The mode it was launched in. */
  launchMode: PermissionMode | null
  /** The mode the settings asked for when it launched, or when the user last applied a settings change to it. */
  configuredMode: PermissionMode | null
  /** A settings change already offered to it, so the offer isn't repeated on every refresh. */
  offeredMode?: PermissionMode | null
  /** Launch in this mode instead of the configured one (Restart in mode). */
  modeOverride?: PermissionMode
  /** The session's display name, for recording it once the provider reports the session id. */
  name: string
  /** Bytes of the transcript already read for live details (providers with transcriptDetails). */
  detailsOffset?: number
  /** When the cost estimate was last worked out (providers that don't report cost). */
  costAt?: number
  /** Terminal output while a mode switch waits for the CLI's confirmation. */
  switchTail?: string
  /** The first task, for the launch's command line (cleared once launched). */
  initialPrompt?: string
  /** The CLI asked something before it started (e.g. whether to trust the folder): shown as waiting for the user. */
  askedAtStart?: boolean
  /** For a CLI whose terminal title says when a person must act (ProviderAdapter.titleAttention): its test, for this launch. */
  titleAttention?: (title: string) => boolean
  /** The title says a person must act now (as the status has it: applied in order with the hooks). */
  titleAsks?: boolean
  /** What the title said when last read, maybe not applied yet. */
  titleRead?: boolean
  /** The unfinished title sequence the last output ended with. */
  titleCarry?: string
  /** Asks its hooks reported that are still open, and the one it waits on (HookStatusInput). */
  open?: Ask[]
  waitingOn?: Ask | null
  /** Background tasks started in this launch that haven't ended: id → when it started, and when it expires. */
  tasks?: Map<string, { at: number; expiresAt?: number }>
  /** Tasks seen to end, so a start read late doesn't count one again. */
  tasksEnded?: Set<string>
  /** Bytes of the transcript already read for background tasks. */
  tasksOffset?: number
  /** What the adapter keeps between those reads (a call whose output comes later). */
  tasksMemo?: Record<string, unknown>
  /** The conversation already warned about for its transcript's size (once each). */
  sizeWarned?: string
  /** This launch resumes a conversation (a failed start's Retry resumes it again). */
  resumed?: boolean
  /** The Hive Assistant's mode (a persona id) its conversation was last given, started in or told: recorded with it. */
  mode?: string
  /** Prompts the CLI has reported submitted in this launch (UserPromptSubmit), for sendPrompt's confirm. */
  prompts?: number
}

export interface EffectiveSettings {
  provider: ProviderId
  skills: LaunchSkill[]
  skillHashes: Record<string, string>
  /** Hive skills nobody gets because their header can't be read (name → why): in the launch's problems. */
  skillProblems: Record<string, string>
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  use200kContext: boolean
  chime: boolean
}

/** Files read once for a whole session list (instead of once per session). */
/** An agent start in progress, before (or while) its process spawns. */
interface PendingStart {
  projectPath: string
  /** The session being resumed, if any. */
  resumeId?: string
  /** Set by a stop, workspace close or quit: the start gives up at its next check. */
  cancelled: boolean
  /** Settles when the start has finished or given up. */
  done: Promise<unknown>
}

export interface ListContext {
  records: SessionRecord[]
  cfg: ProjectConfig
}

/** A claim an agent holds on a file it edited, so another agent in the same folder doesn't edit it at the same time. */
interface FileLock {
  liveId: string
  at: number
  /** When it was claimed, in claim order (lockSeq): a turn's end releases only what was claimed before it. */
  seq: number
  path: string
}

/**
 * A file's identity for locks: its real path where it exists (a junction or link to it is the same file),
 * else its folder's real path and its name; lower case, as Windows paths are.
 */
function lockKey(abs: string): string {
  try {
    return realpathSync.native(abs).toLowerCase()
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs)).toLowerCase()
    } catch {
      return abs.toLowerCase()
    }
  }
}

/** What Hive types to tell an agent it may make the locked edits the user allowed. */
function goAheadPrompt(cwd: string, paths: string[]): string {
  const files = paths.map((p) => relative(cwd, p) || basename(p)).join(', ')
  return `The user allowed you to edit ${files} while the other agent works on ${paths.length > 1 ? 'them' : 'it'}. Go ahead with the ${paths.length > 1 ? 'edits' : 'edit'}.`
}

/** A lock is released when its agent's turn ends; this covers an agent that stalls without ending it. */
const LOCK_TTL_MS = 15 * 60_000

/**
 * Each transcript's usage, with the parser that read it: transcripts only grow, so a running session's is read
 * from where the last read stopped (a long session's transcript can be 100 MB) rather than from the start.
 */
interface UsageEntry {
  /** null once dropped (too many kept): the result stays, and a changed file is read again from the start. */
  parser: UsageParser | null
  sessionId: string
  provider: ProviderId
  /** Bytes read so far, at a line boundary. */
  offset: number
  size: number
  mtime: number
  /** The parser's result before costs, which follow the prices in the settings: what usage-cache.json keeps. */
  raw: SessionUsage | null
  /** Worked out from raw (with costs); null until asked for again after a change. */
  usage: SessionUsage | null
}
const usageCache = new Map<string, UsageEntry>()
/** Transcripts whose parsers are kept (each holds its session's request history); results are kept for more. */
const MAX_USAGE_PARSERS = 200
/** Transcripts whose results are kept, in memory and on disk (Settings → Sessions → Usage cache size). */
const maxUsageResults = (): number => Math.min(50000, Math.max(100, Number(config.settings.sessions.usageCacheSize) || 5000))
/** How much of a transcript is read at a time. */
const USAGE_CHUNK = 4 * 1024 * 1024

/**
 * usage-cache.json in the profile: each transcript's result (before costs) with the size and modified time it
 * had, so after a restart an unchanged transcript isn't read again. Derived and disposable: a missing, damaged or
 * older version's file is ignored (each Hive version starts afresh, as parsers change), and a transcript that
 * changed while Hive was closed is read again in full.
 */
interface UsageCacheFile {
  version: string
  entries: { path: string; sessionId: string; provider: ProviderId; size: number; mtime: number; usage: SessionUsage }[]
}
const usageCacheFile = (): string => join(app.getPath('userData'), 'usage-cache.json')

/** Drops the least recently used parsers beyond MAX_USAGE_PARSERS (their results stay), and results beyond the cache size. */
function trimUsageCache(): void {
  const maxResults = maxUsageResults()
  let parsers = 0
  for (const c of usageCache.values()) if (c.parser) parsers++
  for (const [k, c] of usageCache) {
    if (parsers <= MAX_USAGE_PARSERS && usageCache.size <= maxResults) break
    if (usageCache.size > maxResults) {
      usageCache.delete(k)
      if (c.parser) parsers--
    } else if (c.parser) {
      c.parser = null
      parsers--
    }
  }
}

/** Writes text to a session in small pieces, the way keystrokes arrive, rather than as one burst. */
async function typeInto(key: string, text: string, still: () => boolean = () => true): Promise<void> {
  const CHUNK = 8
  for (let i = 0; i < text.length; i += CHUNK) {
    // The agent stopped or restarted meanwhile: the rest mustn't reach the new process.
    if (!still()) throw new Error('The agent stopped before the prompt was sent.')
    writePty(key, text.slice(i, i + CHUNK))
    if (i + CHUNK < text.length) await new Promise((r) => setTimeout(r, 10))
  }
}

/** Runs a worktree's setup command in the agent's terminal (Windows: cmd.exe, elsewhere: sh). */
function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] }
}

const shownNotifications = new Set<Notification>()

/** A new session's automatic name: "<project> · <date>", with the agent's name when the project has several. */
function autoName(projectPath: string, agent: Pick<AgentDef, 'name'>, count: number): string {
  return `${basename(projectPath)}${count > 1 ? ` · ${agent.name}` : ''} · ${formatDateTime(new Date())}`
}

/** How long a background task counts as running at most (Settings → Agents), in minutes. */
const taskMinutes = (): number => Math.min(480, Math.max(10, Number(config.settings.agents.backgroundTaskMinutes) || 60))

const liveId = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** The provider a session record belongs to (records from before providers are Claude Code's). */
/** A CLI transcript changed this recently is still being written (a Codex guardian review, say): not archived or deleted yet. */
const SESSION_WRITING_MS = 5000

/** A session left alone by archive or delete, and why (SessionBulkResult's reasons). */
export class SessionInUse extends Error {
  constructor(
    readonly reason: SessionSkipReason,
    message: string
  ) {
    super(message)
  }
}


/** Runs a move of Hive's copies; a copy another program holds fails it as SessionInUse. */
async function inUseOnFail(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (isInUse(e)) throw new SessionInUse('in-use', 'Another program has its transcript open. Close it, then try again.')
    throw e
  }
}


/**
 * Renames done in order, undone in reverse when a later step fails (`undo`); `discardAside`, once all is done, removes
 * what was only set aside (names ending .previous or .archived: copies the new ones supersede).
 */
class Moves {
  private done: [string, string][] = []

  async move(from: string, to: string): Promise<void> {
    await rm(to, { force: true }).catch(() => undefined)
    await inUseOnFail(() => rename(from, to))
    this.done.push([from, to])
  }

  async undo(): Promise<void> {
    for (const [from, to] of this.done.reverse()) await rename(to, from).catch((e) => log.warn(`Couldn't move ${userText(to)} back`, e))
    this.done = []
  }

  async discardAside(): Promise<void> {
    for (const [, to] of this.done) if (/\.(previous|archived)$/.test(to)) await rm(to, { force: true }).catch(() => undefined)
    this.done = []
  }
}

const recordProvider = (rec: Pick<SessionRecord, 'agent'> | undefined): ProviderId => rec?.agent || 'claude-code'

/**
 * The delivered skills' sizes, for metrics, measured on each copy its CLI reads: its catalog entry (its SKILL.md's name
 * and description, from the header Hive reads anyway) and its bytes on disk (the bounded stat walk, no file read). A
 * copy that can't be measured (gone, unreadable, no header) is counted as unmeasured and left out of both sums, never
 * guessed as zero. Measuring never fails a launch.
 */
export async function deliveredSkillSizes(adapter: ProviderAdapter, ctx: LaunchContext, delivered: Record<string, SkillDelivery>): Promise<{ catalog: number; bytes: number; unmeasured: number }> {
  let catalog = 0
  let bytes = 0
  let unmeasured = 0
  for (const [name, d] of Object.entries(delivered)) {
    if (!d.revision) continue
    try {
      const copy = adapter.skillCopyPath(ctx, name)
      const head = await headerOf(join(copy, 'SKILL.md'), parseSkillFrontmatter)
      const size = await treeSignature(copy)
      // No header, or one that couldn't be read as a skill's (invalid YAML, a key twice, an unknown audience): unknown.
      if (!head || head.problem) throw new Error('no readable SKILL.md header')
      catalog += utf8Bytes(head.name ?? name) + utf8Bytes(head.description ?? '')
      bytes += size.bytes
    } catch {
      unmeasured++
    }
  }
  return { catalog, bytes, unmeasured }
}

/** Agents whose sign-in is refused at about the same time are told in one notice, this long after the first. */
const SIGNED_OUT_GATHER_MS = 3000
/** How often a CLI's sign-in is checked again while its agents wait for it (its own check, e.g. claude auth status). */
const SIGN_IN_RECHECK_MS = 60_000
/** The status message of an agent stopped by a refused sign-in once its CLI is signed in again (#309). */
const SIGNED_IN_AGAIN = 'Stopped while signed out'
/** What Resume (n) types into such an agent. */
const CARRY_ON_PROMPT = 'Your last turn stopped because your sign-in had expired. It is renewed now: carry on where you left off.'

class SessionManager {
  private live = new Map<string, LiveSession>()
  /**
   * CLIs whose sign-in was refused, until signed in again (#309): the user is told once per CLI and expiry (agents
   * stopping later only show it), and the CLI's own check runs again meanwhile, to notice the sign-in.
   */
  private signedOut = new Map<ProviderId, { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> }>()
  /** runId → liveId: hooks name their launch, so they reach the right agent even before the session id is known. */
  private runs = new Map<string, string>()
  /** The status each state was last sent with, so statusSince moves only when the status changes. */
  private statusSent = new WeakMap<LiveSessionState, SessionStatus>()
  private locks = new Map<string, FileLock>()
  /** "Ask me" locks for CLIs without an approval reply: `<liveId>|<path>` the user allowed, or was asked about. */
  /** Counts lock claims, approvals and questions, so they can be told apart from a turn's end in order. */
  private lockSeq = 0
  /** "Allow" given for an agent and file (`<liveId>|<lock key>`), and questions already asked, with their lockSeq. */
  private lockAllowed = new Map<string, number>()
  private lockAsked = new Map<string, number>()
  /** "Allow" given while the agent was still in its turn (`<liveId>|<lock key>` → the file's path): the go-ahead it gets when that turn ends. */
  private lockGoAhead = new Map<string, string>()
  /** Go-aheads put off while the user was typing in the agent's terminal: tried again when the pause ends. */
  private goAheadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  hookUrl = ''
  apiEnv: (projectPath: string, agentId: string) => Record<string, string> = () => ({})
  /** Hive's bin folder (hive-progress), first on each session's PATH; null until written, or when it couldn't be. */
  binDir: string | null = null
  hiveMcp: HiveMcpProvider = () => null
  /** Hive's guidance for agents (the hive MCP server's instructions), for providers that need it at launch. */
  hiveGuidance: (projectPath: string) => Promise<string> = async () => ''
  /** Before each Hive Assistant launch (its workspace gets a new Agent API token). */
  onAssistantLaunch: (projectPath: string) => Promise<void> = async () => undefined
  /** The user sent the Hive Assistant a message (a new turn). */
  onAssistantPrompt: (projectPath: string) => void = () => undefined
  /** The Hive Assistant's process ended (its token is revoked, its questions withdrawn). */
  onAssistantExit: (projectPath: string) => void = () => undefined
  /** When the user last typed in each terminal (by pty key), so nothing else types over them. */
  private userInput = new Map<string, { at: number; enter: boolean }>()
  /** The Hive Assistant's instructions for a launch (who it is, and its persona's), and the persona's name and id. */
  assistantInstructions: (projectPath: string, agent: AgentDef) => Promise<{ text: string; persona: string; personaId: string; personaText: string }> = async () => ({ text: '', persona: '', personaId: '', personaText: '' })
  /**
   * A Hive Assistant conversation was resumed in the mode `persona` (an id): main/assistantMode.ts tells it that mode
   * once it is idle, if the conversation was last given another (#334).
   */
  onAssistantResumed: (projectPath: string, runId: string, sessionId: string, persona: string) => void = () => undefined
  /** An agent's wake-on-change watch, if it has one (main/watches.ts sets this). */
  watchFor: (projectPath: string, agentId: string) => TaskWatchInfo | null = () => null

  /** The prompts an agent's CLI has taken in this launch, and the launch (#376: was a typed line taken?). Null when not running. */
  promptsTaken(projectPath: string, agentId: string): { runId: string; count: number } | null {
    const l = this.live.get(liveId(projectPath, agentId))
    return l?.state.runId ? { runId: l.state.runId, count: l.prompts ?? 0 } : null
  }

  /**
   * Presses Enter again in an agent whose typed line wasn't taken (#376: a CLI dropped the Enter, and the line stayed in
   * its prompt). Only in the same launch, while it is idle, and not while the user types there or Hive types into it.
   */
  submitAgain(projectPath: string, agentId: string, runId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    const key = this.key(projectPath, agentId)
    if (!l || l.state.runId !== runId || (l.state.status !== 'ready' && l.state.status !== 'finished') || this.userMayBeTyping(projectPath, agentId) || this.delivering.has(key)) return false
    writePty(key, '\r')
    return true
  }

  /** Marks (or clears) the cards an agent in a card loop left with no watch (#376): they show as stalled. */
  setNotWatching(projectPath: string, agentId: string, cards: number[] | null): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return
    const next = cards?.length ? cards : undefined
    if (JSON.stringify(l.state.notWatching) === JSON.stringify(next)) return
    l.state.notWatching = next
    this.emitState(l.state)
  }

  /** Tells the user once that an agent in a card loop is waiting with no watch (#376). */
  notifyNotWatching(projectPath: string, agentId: string, cards: number[]): void {
    const st = this.live.get(liveId(projectPath, agentId))?.state
    if (!st) return
    const label = this.label(st)
    const which = cards.map((n) => `#${n}`).join(', ')
    this.notify(projectPath, `${label} isn't watching ${which}`, `Its turn ended without a card watch, so nothing wakes it when ${cards.length === 1 ? 'the card changes' : 'they change'}. Show it and ask it to carry on.`, 'waiting', st.agentName, agentId)
  }

  /** A watch began or ended: the agent's status follows (watching, or finished again). */
  watchChanged(projectPath: string, agentId: string): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (l) this.emitState(l.state)
  }

  /** Called when an agent's launch ends (its exit, or a start given up): the merge slot releases its hold (#350). */
  readonly onLaunchEnded = new Set<(projectPath: string, agentId: string, runId: string) => void>()

  /** The agent's place at the merge slot, shown with its status (only for this launch: a newer one has its own). */
  setMergeSlotNote(projectPath: string, agentId: string, runId: string, text: string | null): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId || (l.state.mergeSlot ?? null) === text) return
    l.state.mergeSlot = text ?? undefined
    this.emitState(l.state)
  }

  private launchEnded(projectPath: string, agentId: string, runId: string): void {
    for (const f of this.onLaunchEnded) {
      try {
        f(projectPath, agentId, runId)
      } catch (e) {
        log.warn('after an agent stopped', e)
      }
    }
  }
  /** The project's newest handovers in the shared notes, newest first (at most `count`). */
  recentHandovers: (projectPath: string, count: number) => Promise<HandoverRef[]> = async () => []

  /** The project's newest handover, or null. */
  async latestHandover(projectPath: string): Promise<HandoverRef | null> {
    return (await this.recentHandovers(projectPath, 1))[0] ?? null
  }
  private exitWaiters = new Map<string, () => void>()
  /**
   * Agents being started (by liveId), so two starts at once can't both get through, and so stopping the
   * agent, closing its workspace or quitting can cancel a start that hasn't spawned its process yet.
   */
  private starting = new Map<string, PendingStart>()
  /** Hive is quitting: no new agent starts. */
  private shuttingDown = false
  /** The window showing a project (several windows each show one workspace). */
  private getWindow: (projectPath?: string) => BrowserWindow | null = () => null

  setWindowProvider(fn: (projectPath?: string) => BrowserWindow | null): void {
    this.getWindow = fn
  }

  /** The Hive window the user is using (visible, focused): where in-app banners go (#157). None while Hive is in the background. */
  private focusedHive: () => (FocusedHive & { win: BrowserWindow }) | null = () => null

  setFocusedWindowProvider(fn: () => (FocusedHive & { win: BrowserWindow }) | null): void {
    this.focusedHive = fn
  }

  key(projectPath: string, agentId: string): string {
    return agentPtyKey(projectPath, agentId)
  }

  /** The agent a call that names none means: the project's only agent. */
  async soleAgent(projectPath: string): Promise<string> {
    const agents = projectAgents(await workspace.projectConfig(projectPath))
    if (agents.length === 1) return agents[0].id
    throw new Error(agents.length ? 'This project has several agents: choose which one.' : 'This project has no agents yet. Add one first.')
  }

  liveCount(provider?: ProviderId): number {
    return provider ? [...this.live.values()].filter((l) => l.state.provider === provider).length : this.live.size
  }

  liveStates(): LiveSessionState[] {
    return [...this.live.values()].map((l) => l.state)
  }

  /** One agent's session; without agentId, the project's first running agent's. */
  liveFor(projectPath: string, agentId?: string): LiveSessionState | null {
    if (agentId) return this.live.get(liveId(projectPath, agentId))?.state ?? null
    return this.projectStates(projectPath)[0] ?? null
  }

  projectStates(projectPath: string): LiveSessionState[] {
    const prefix = `${projectPath.toLowerCase()}#`
    return [...this.live.entries()].filter(([k]) => k.startsWith(prefix)).map(([, l]) => l.state)
  }

  private async agentDef(projectPath: string, agentId: string): Promise<{ agent: AgentDef; cfg: ProjectConfig; count: number }> {
    const cfg = await workspace.projectConfig(projectPath)
    const agents = projectAgents(cfg)
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) throw new Error('That agent no longer exists.')
    return { agent, cfg, count: agents.length }
  }

  /** Resolves global + project settings (and the agent's own overrides) into what a session launches with. */
  async effective(projectPath: string, agent?: AgentDef): Promise<EffectiveSettings> {
    return inWorkspace(workspaceOf(projectPath), () => this.effectiveHere(projectPath, agent))
  }

  private async effectiveHere(projectPath: string, agent?: AgentDef): Promise<EffectiveSettings> {
    const s = config.settings
    const pc = await workspace.projectConfig(projectPath)
    const assistant = workspace.isAssistantHome(projectPath)
    // Every Hive skill for its audience (SKILL.md's metadata.audience) reaches the session: project agents get those for
    // agents, the Assistant those for it. There are no skill switches.
    // A skill whose header is broken or whose audience is unknown reaches nobody: the launch says why (its problems).
    const skills: LaunchSkill[] = []
    const skillHashes: Record<string, string> = {}
    const skillProblems: Record<string, string> = {}
    for (const sk of await hiveSkills()) {
      if (sk.problem) {
        skillProblems[sk.name] = sk.problem
        skillHashes[sk.name] = ''
      } else if (skillFor(sk.audience, assistant ? 'assistant' : 'agent')) {
        skills.push({ name: sk.name, sourcePath: sk.path })
        skillHashes[sk.name] = await revisionOf(sk.path).catch(() => '')
      }
    }
    const mcpDisabled = new Set(pc.mcp.disabled)
    const mcpServers: Record<string, McpServerDef> = {}
    for (const m of await listMcp()) {
      if (m.globallyEnabled && !mcpDisabled.has(m.name) && m.def) mcpServers[m.name] = toLaunchDef(m.def, workspace.mcpDir)
    }
    const hive = this.hiveMcp(projectPath, agent?.id)
    if (hive) mcpServers.hive = hive
    // The Assistant looks after the workspace with Hive's own tools, not the projects' MCP servers.
    if (assistant) for (const k of Object.keys(mcpServers)) if (k !== 'hive') delete mcpServers[k]

    const l = agentLaunchSettings(agent ?? projectAgents(pc)[0], pc, s)
    const extraArgs = l.extraArgs.flatMap((a) => splitArgs(a))
    const chime = pc.chime === 'inherit' ? s.notifications.chimeEnabled : pc.chime === 'on'
    return { provider: l.provider, skills, skillHashes, skillProblems, mcpServers, model: l.model, effort: l.effort, permissionMode: l.permissionMode, extraArgs, use200kContext: l.use200kContext, chime }
  }

  signature(e: EffectiveSettings): string {
    // The permission mode can be switched live (setPermissionMode), so it doesn't ask for a restart.
    const { chime: _c, skills: _s, permissionMode: _p, ...rest } = e
    return hashText(JSON.stringify(rest))
  }

  /** Every agent of a project with its running session, for ProjectInfo. */
  async liveInfo(projectPath: string, cfg: ProjectConfig): Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[] }> {
    const agents: AgentInfo[] = []
    const records = (await workspace.sessionsFile(projectPath)).sessions
    this.checkSubsOnce(projectPath, records)
    const openIds = new Set(this.projectStates(projectPath).map((s) => s.sessionId).filter(Boolean))
    const ids = new Set(projectAgents(cfg).map((a) => a.id))
    for (const a of projectAgents(cfg)) {
      const l = this.live.get(liveId(projectPath, a.id))
      let restartNeeded = false
      if (l && !l.state.settingUp) {
        try {
          const eff = await this.effective(projectPath, a)
          restartNeeded = this.signature(eff) !== l.state.launchSignature
          this.noticeModeSetting(l, eff.permissionMode)
        } catch {
          // Settings can't be read right now; don't nag.
        }
      }
      const provider = agentLaunchSettings(a, cfg, config.settings).provider
      // The Assistant's sessions ran in the workspace folder, not its home.
      const folder = workspace.isAssistantHome(projectPath) ? (workspaceOf(projectPath).path ?? projectPath) : projectPath
      const r = l ? null : resumeRecord(folder, a, records.filter((x) => recordProvider(x) === provider), openIds, ids)
      agents.push({ ...a, live: l?.state ?? null, restartNeeded, resume: r && { id: r.id, name: r.name, lastActiveAt: r.lastActiveAt, createdAt: r.createdAt, titleAtRename: r.titleAtRename } })
    }
    const primary = agents.find((a) => a.live)
    return { live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, agents }
  }

  private backupPath(projectPath: string, sessionId: string, archived = false): string {
    return join(projectPath, HIVE_DIR, archived ? 'archive' : 'sessions', `${assertSessionId(sessionId)}.jsonl`)
  }

  /** Works out usage again (e.g. after price changes, so estimates are recomputed); what was read is kept. */
  clearUsageCache(): void {
    for (const c of usageCache.values()) c.usage = null
  }

  /** Forgets every transcript's usage, in memory and on disk (Settings → Sessions → Clear): each is read again when needed. */
  async forgetUsageCache(): Promise<void> {
    await this.loadUsageCache()
    usageCache.clear()
    if (this.usageSaveTimer) clearTimeout(this.usageSaveTimer)
    this.usageSaveTimer = null
    await removePath(usageCacheFile()).catch((e) => log.warn('usage cache: could not delete it', e))
    log.info('usage cache cleared')
  }

  private usageCacheLoad: Promise<void> | null = null
  private usageSaveTimer: NodeJS.Timeout | null = null

  /** Reads usage-cache.json once, into the in-memory cache (results only: a changed transcript is read again in full). */
  private loadUsageCache(): Promise<void> {
    return (this.usageCacheLoad ??= (async () => {
      const file = await readJson<UsageCacheFile | null>(usageCacheFile(), null).catch(() => null)
      if (!file || file.version !== app.getVersion() || !Array.isArray(file.entries)) return
      for (const e of file.entries) {
        if (!e || typeof e.path !== 'string' || !e.usage || usageCache.has(e.path)) continue
        usageCache.set(e.path, { parser: null, sessionId: e.sessionId, provider: e.provider, offset: e.size, size: e.size, mtime: e.mtime, raw: e.usage, usage: null })
      }
      trimUsageCache()
      log.info(`usage cache: ${usageCache.size} transcript(s) from the last run`)
    })())
  }

  /** Writes usage-cache.json a few seconds after the last change (and at quit: flushUsageCache). */
  private scheduleUsageSave(): void {
    if (this.usageSaveTimer) return
    this.usageSaveTimer = setTimeout(() => void this.flushUsageCache(), 5000)
  }

  async flushUsageCache(): Promise<void> {
    if (!this.usageSaveTimer) return
    clearTimeout(this.usageSaveTimer)
    this.usageSaveTimer = null
    const entries: UsageCacheFile['entries'] = []
    for (const [path, c] of usageCache) if (c.raw) entries.push({ path, sessionId: c.sessionId, provider: c.provider, size: c.size, mtime: c.mtime, usage: c.raw })
    await writeJsonAtomic(usageCacheFile(), { version: app.getVersion(), entries } satisfies UsageCacheFile).catch((e) => log.warn('usage cache: could not save it', e))
  }

  /** A result with costs from the current prices: the provider's report, else (or on top) Hive's estimate, and each day's share. */
  private priced(raw: SessionUsage): SessionUsage {
    const usage = structuredClone(raw)
    // Providers that don't report a cost get Hive's estimate from their token counts (prices: Settings → provider).
    if (usage.costUsd === null) {
      const est = estimateCost(usage, config.settings)
      if (est !== null) Object.assign(usage, { costUsd: est, costEstimated: true })
    } else if (usage.costUnreported) {
      // The provider reports its cost only now and then: the tokens since get Hive's estimate on top.
      const est = estimateCost({ ...usage, ...usage.costUnreported }, config.settings)
      if (est) Object.assign(usage, { costUsd: usage.costUsd + est, costEstimated: true })
    }
    // Each day's share, for the Overview's periods.
    withDayCosts(usage, config.settings)
    return usage
  }

  /**
   * Where a session's transcript is: the provider knows (by folder, or by the path it reported), and a
   * worktree agent's sessions ran in its worktree. The session's own record comes first.
   */
  async providerTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<{ path: string; provider: ProviderId } | null> {
    const records = ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions
    const rec = records.find((s) => s.id === sessionId)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    const ids = rec ? [recordProvider(rec)] : live ? [live.provider] : allProviders().map((p) => p.id)
    const cfg = ctx?.cfg ?? (await workspace.projectConfig(projectPath))
    // Its own folder first, then every folder the host's sessions run in (sessionFolders, where list() finds them: a
    // sub-session started in a removed agent's worktree, or the Assistant's workspace folder).
    const folders = [rec?.cwd, ...this.sessionFolders(projectPath, records, cfg)].filter((f): f is string => !!f)
    const unique = [...new Map(folders.map((f) => [resolve(f).toLowerCase(), f])).values()]
    for (const id of ids) {
      let adapter: ProviderAdapter
      try {
        adapter = providerAdapter(id)
      } catch {
        continue
      }
      for (const f of unique) {
        const t = await adapter.transcriptPath(f, sessionId, rec?.transcriptPath)
        if (t) return { path: t, provider: id }
      }
    }
    return null
  }

  async start(projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string }): Promise<LiveSessionState> {
    this.assertStartsAllowed(projectPath)
    projectPath = workspace.assertSessionHost(projectPath)
    if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
    const agentId = opts.agentId || (await this.soleAgent(projectPath))
    // Again after the await, with nothing awaited before the start is reserved: a fence raised meanwhile holds.
    this.assertStartsAllowed(projectPath)
    const id = liveId(projectPath, agentId)
    // Checked and reserved before anything is awaited: a double click, or the UI and the Agent API at
    // once, must not start the agent twice (the second start would orphan the first process).
    if (this.live.has(id) || this.starting.has(id)) throw new Error('This agent is already running or starting. Stop it first.')
    // Two terminals on one conversation would both append to its transcript.
    if (opts.resumeId && [...this.starting.values()].some((p) => p.resumeId === opts.resumeId)) throw new Error('This conversation is already being opened in another agent.')
    if (opts.resumeId && this.cleaning.has(`${projectPath.toLowerCase()}|${opts.resumeId.toLowerCase()}`)) throw new Error("Hive is archiving, deleting or cleaning up this session's files. Try again in a moment.")
    const pending: PendingStart = { projectPath, resumeId: opts.resumeId, cancelled: false, done: Promise.resolve() }
    this.starting.set(id, pending)
    const run = this.startReserved(projectPath, agentId, id, opts)
    pending.done = run.catch(() => undefined)
    try {
      return await run
    } finally {
      this.starting.delete(id)
    }
  }

  /**
   * Refuses a start while Hive quits, while the project's workspace is closing or switching, or while a fence holds the
   * project (it is being removed, or a template is replacing its agents), or while its workspace's move is being repaired.
   */
  private assertStartsAllowed(projectPath: string): void {
    if (this.shuttingDown || workspaceFor(projectPath)?.closing) throw new Error("Hive is stopping this workspace's agents, so none can start now.")
    if (workspaceFor(projectPath)?.repairingMove) throw new Error('Hive is repairing this moved workspace: start the agent when Repair has finished.')
    const why = this.fenced.get(resolve(projectPath).toLowerCase())?.at(-1)
    if (why) throw new Error(`${why}, so its agents can't start now.`)
  }

  /** Projects (lower-cased paths) whose agents may not start, and why (one entry for each fence on it). */
  private fenced = new Map<string, string[]>()

  /**
   * Keeps the project's agents from starting until the function returned is called: nothing may run in it while it is
   * being removed, or while a template replaces its agents (#126). Fences can overlap; each lifts its own.
   */
  fenceStarts(projectPath: string, why = 'This project is being removed'): () => void {
    const key = resolve(projectPath).toLowerCase()
    this.fenced.set(key, [...(this.fenced.get(key) ?? []), why])
    let lifted = false
    return () => {
      if (lifted) return
      lifted = true
      const rest = [...(this.fenced.get(key) ?? [])]
      rest.splice(rest.indexOf(why), 1)
      if (rest.length) this.fenced.set(key, rest)
      else this.fenced.delete(key)
    }
  }

  /** Whether this agent has a start in progress (not yet in liveStates). */
  startingFor(projectPath: string, agentId: string): boolean {
    return this.starting.has(liveId(resolve(projectPath), agentId))
  }

  /** Projects with an agent starting (not yet in liveStates). */
  pendingStarts(): string[] {
    return [...this.starting.values()].map((p) => p.projectPath)
  }

  /** Throws if the start was cancelled while it awaited something (the agent stopped, its workspace closed). */
  private assertStarting(id: string): void {
    if (this.starting.get(id)?.cancelled) throw new Error('The agent was stopped before it had started.')
  }

  private async startReserved(projectPath: string, agentId: string, id: string, opts: { resumeId?: string; name?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string }): Promise<LiveSessionState> {
    const { agent, cfg, count } = await this.agentDef(projectPath, agentId)
    this.assertStarting(id)
    if (this.live.has(id)) throw new Error(count > 1 ? `${agent.name} is already running. Stop it first.` : 'A session is already running for this project. Stop it first.')
    const holder = opts.resumeId ? this.projectStates(projectPath).find((s) => s.sessionId === opts.resumeId) : undefined
    if (holder) throw new Error(`This conversation is already open in ${holder.agentName ?? 'another agent'}. An agent can only resume a session no other agent is running.`)
    const providerId = agentLaunchSettings(agent, cfg, config.settings).provider
    const adapter = providerAdapter(providerId)
    const name = adapter.descriptor.name
    if (!isProviderEnabled(config.settings, providerId)) throw new Error(`${name} is turned off. Turn it on in Settings → Providers to run ${agent.name}.`)
    const info = providerService.info(providerId)
    if (!info.found || !info.path) throw new Error(`${name} is required to run ${agent.name}. Install it from Help → Agent Setup.`)
    await workspace.ensureProject(projectPath)
    // The Assistant works in the workspace folder, where it can read every project.
    const assistant = workspace.isAssistantHome(projectPath)
    const cwd = assistant ? workspaceOf(projectPath).path! : (agent.worktree?.path ?? projectPath)
    if (!existsSync(cwd)) throw new Error(`${agent.name}'s worktree folder is missing: ${cwd}. Start ${agent.name} from its pane to recreate the worktree on its branch (Repair… if the workspace moved), or remove the agent.`)

    const existing = opts.resumeId ? (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === opts.resumeId) : undefined
    this.assertStarting(id)
    if (existing?.archived) throw new Error('This session is archived. Unarchive it before resuming.')
    // A sub-session (a Codex guardian review, say) is not a conversation: never resumed (#239).
    const sub = opts.resumeId ? (existing ? await this.recordSub(projectPath, existing) : (await adapter.listSessions(cwd).catch(() => [])).find((e) => e.id === opts.resumeId)?.sub) : undefined
    if (sub) throw new Error(`That session is a ${sub.kind} ${name} ran for another session, not a conversation: it can't be resumed.`)
    this.assertStarting(id)
    if (opts.resumeId && existing && recordProvider(existing) !== providerId) {
      throw new Error(`This conversation ran in ${providerDescriptor(recordProvider(existing)).name}, and ${agent.name} runs ${name}. Conversations can't move between providers: continue it with a handover instead.`)
    }
    if (opts.resumeId && existing && (existing.cwd ?? projectPath).toLowerCase() !== cwd.toLowerCase()) {
      throw new Error(`This session ran in ${existing.cwd ?? projectPath}. Resume it with the agent that works in that folder.`)
    }
    // Providers that choose their own session id report it once started (see the start hook).
    const sessionId = opts.resumeId ?? (adapter.descriptor.capabilities.fixedSessionId ? randomUUID() : '')

    const persona = assistant ? (await this.assistantInstructions(projectPath, agent).catch(() => null))?.persona : undefined
    // A /rename in the CLI since the session was last named in Hive is the newer name: Hive takes it, and so passes
    // it back with --name rather than its own.
    let adopted: string | null = null
    if (opts.resumeId && existing && (!opts.name?.trim() || opts.name.trim() === existing.name)) {
      const usage = await this.usage(projectPath, opts.resumeId).catch(() => null)
      adopted = cliRename({ ...existing, usage }, assistant ? ASSISTANT_NAME : basename(projectPath))
      if (adopted) {
        await workspace.upsertSession(projectPath, { id: existing.id, name: adopted, titleAtRename: adopted })
        log.info(`Session ${existing.id} takes the name ${userText(adopted)} it was given in the CLI`)
      }
    }
    const sessionName = adopted || opts.name?.trim() || existing?.name || (assistant ? `${ASSISTANT_NAME}${persona ? ` · ${persona}` : ''} · ${formatDateTime(new Date())}` : autoName(projectPath, agent, count))
    const key = this.key(projectPath, agentId)
    const runId = randomBytes(12).toString('hex')
    const state: LiveSessionState = {
      provider: providerId,
      runId,
      projectPath,
      agentId,
      agentName: agent.name,
      cwd,
      sessionId,
      sessionName,
      titleAtRename: adopted ?? (existing ? existing.titleAtRename : opts.name?.trim() ? null : undefined),
      status: 'starting',
      startedAt: new Date().toISOString(),
      launchSignature: '',
      unseen: false
    }
    this.live.set(id, { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, modeOverride: opts.permissionMode, name: sessionName, transcriptPath: existing?.transcriptPath, initialPrompt: opts.prompt?.trim() || undefined, resumed: !!opts.resumeId })
    this.runs.set(runId, id)

    const setup = cfg.worktreeSetup.trim()
    if (agent.worktree && agent.needsSetup && setup && !opts.skipSetup) {
      // The worktree's setup command runs in the agent's terminal first, then the agent starts there.
      state.settingUp = true
      state.statusMessage = `Setting up the worktree: ${setup}`
      const sh = shellCommand(setup)
      try {
        // The same last check as before an agent's own launch.
        if (this.starting.get(id)?.cancelled || this.shuttingDown || workspaceFor(projectPath)?.closing) throw new Error('The agent was stopped before it had started.')
        spawnPty(key, {
          file: sh.file,
          args: sh.args,
          cwd,
          env: childEnv(),
          quietExit: true,
          onExit: (code) => void this.afterSetup(projectPath, agentId, code, { sessionId, name: sessionName, resume: !!opts.resumeId })
        })
      } catch (e) {
        this.forget(id)
        throw e
      }
      this.emitState(state)
      workspaceOf(projectPath).scheduleRefresh()
      return state
    }
    try {
      await this.launch(projectPath, agent, { sessionId, name: sessionName, resume: !!opts.resumeId })
    } catch (e) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...state, status: 'stopped' } })
      throw e
    }
    return state
  }

  private forget(id: string): void {
    const l = this.live.get(id)
    if (l) {
      this.runs.delete(l.state.runId)
      endHookToken(l.state.runId)
    }
    // An Assistant that didn't start: the token made for this launch stops working too.
    if (l && basename(l.state.projectPath) === ASSISTANT_DIR) this.onAssistantExit(l.state.projectPath)
    else if (l) endAgentToken(l.state.projectPath, l.state.agentId, l.state.runId)
    if (l) this.launchEnded(l.state.projectPath, l.state.agentId, l.state.runId)
    this.live.delete(id)
    // A start given up before its process spawned has no exit to wait for.
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
  }

  private async afterSetup(projectPath: string, agentId: string, code: number, launch: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    let agent: AgentDef | undefined
    try {
      agent = (await this.agentDef(projectPath, agentId)).agent
    } catch {
      // Removed while setting up.
    }
    if (code !== 0 || !agent || l.stopRequested) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', settingUp: false } })
      if (agent && !l.stopRequested) toast('error', `${basename(projectPath)} · ${agent.name}: setup failed`, `The setup command exited with code ${code}. Its output is in the agent's terminal. Fix it and start the agent again, or start it without setup.`, undefined, projectPath)
      workspaceOf(projectPath).scheduleRefresh()
      return
    }
    await workspace.updateAgent(projectPath, agentId, { needsSetup: false }).catch(() => undefined)
    l.state.settingUp = false
    l.state.statusMessage = undefined
    try {
      await this.launch(projectPath, { ...agent, needsSetup: false }, launch)
    } catch (e) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped' } })
      toast('error', `Could not start ${agent.name}`, (e as Error).message, undefined, projectPath)
    }
  }

  /** Starts the agent's CLI for an agent whose live entry already exists. */
  private async launch(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agent.id)
    const l = this.live.get(id)!
    const { state, adapter } = l
    const cwd = state.cwd
    // Performance metrics for this launch go to the workspace it started in (none, if that closes meanwhile).
    const metrics = metricsHandle(workspaceOf(projectPath))
    const { sessionId } = opts
    const info = providerService.info(adapter.id)
    if (!info.path) throw new Error(`${adapter.descriptor.name} is required to run sessions.`)

    let resume = opts.resume
    if (resume) {
      const recorded = l.transcriptPath
      if (!(await adapter.transcriptPath(cwd, sessionId, recorded))) {
        // The provider has deleted it: put Hive's backup back where the provider looks for it.
        const backup = this.backupPath(projectPath, sessionId)
        const dest = adapter.restorePath(cwd, sessionId, recorded)
        if (dest && existsSync(backup)) {
          await mkdir(dirname(dest), { recursive: true })
          await copyFile(backup, dest)
          log.info(`Restored transcript for ${sessionId} from Hive backup`)
        }
      }
      // A session restarted before anything was typed has no transcript: start it fresh under the same id
      // where the provider allows choosing it, else as a new session.
      resume = !!(await adapter.transcriptPath(cwd, sessionId, recorded))
      if (!resume) {
        log.info(`No transcript for ${sessionId}; starting it fresh instead of resuming`)
        if (!adapter.descriptor.capabilities.fixedSessionId) state.sessionId = ''
      }
    }

    const eff = await this.effective(projectPath, agent)
    l.configuredMode = eff.permissionMode
    let mode = eff.permissionMode
    if (l.modeOverride && modeAllowed(adapter.id, l.modeOverride, config.settings)) mode = l.modeOverride
    l.launchMode = mode
    state.permissionMode = mode ?? undefined
    // Its own Agent API token for this launch, which confines its board calls to its project (the Assistant has its own).
    if (!workspace.isAssistantHome(projectPath)) await newAgentToken({ workspace: workspaceOf(projectPath).path!, projectPath, agentId: agent.id }, state.runId)
    const assistantText = workspace.isAssistantHome(projectPath) ? await this.assistantInstructions(projectPath, agent).catch(() => null) : null
    // A new conversation starts in its mode; a resumed one is told it if it was last given another (below).
    l.mode = !resume ? assistantText?.personaId || undefined : undefined
    // This launch's own hook token (#345): in its environment for HTTP hooks, in a file outside the project for hook commands.
    const hookAuth = await newHookToken(state.runId)
    const ctx = {
      projectPath,
      agentId: agent.id,
      executable: info.path,
      cliVersion: info.version,
      cwd,
      workspacePath: workspaceOf(projectPath).path!,
      runId: state.runId,
      sessionId: state.sessionId,
      resume,
      name: opts.name,
      skills: eff.skills,
      mcpServers: eff.mcpServers,
      model: eff.model,
      effort: eff.effort,
      permissionMode: mode,
      extraArgs: eff.extraArgs,
      use200kContext: eff.use200kContext,
      hookUrl: `${this.hookUrl}?run=${state.runId}`,
      hookAuthFile: hookAuth.file,
      privateDir: hookAuth.dir,
      guidance: await this.hiveGuidance(projectPath).catch(() => ''),
      instructions: assistantText?.text,
      trustedHiveTools: workspace.isAssistantHome(projectPath) ? assistantTools(config.settings.assistant?.control, config.settings.assistant?.changeSettings === true) : undefined,
      initialPrompt: l.initialPrompt,
      allowBackgroundSessions: providerSettings(config.settings, adapter.id).allowBackgroundSessions,
      env: withBinOnPath(childEnv({
        HIVE_HOOK_TOKEN: hookAuth.token,
        HIVE_PROJECT: basename(projectPath),
        HIVE_PROJECT_PATH: projectPath,
        HIVE_WORKSPACE: workspaceOf(projectPath).path!,
        HIVE_RUN_ID: state.runId,
        ...(state.sessionId ? { HIVE_SESSION_ID: state.sessionId } : {}),
        HIVE_AGENT: agent.name,
        HIVE_PROVIDER: adapter.id,
        // Not for the Assistant: it reaches the API through its hive tools, with its own token.
        ...(workspace.isAssistantHome(projectPath) ? {} : this.apiEnv(projectPath, agent.id))
      }), this.binDir)
    }
    const delivered = await adapter.prepareLaunch(ctx)
    // What the session got, measured on the copies its CLI reads (not their sources: a kept old copy is what it reads).
    const deliveredSizes = await deliveredSkillSizes(adapter, ctx, delivered).catch(() => ({ catalog: 0, bytes: 0, unmeasured: Object.values(delivered).filter((d) => d.revision).length }))
    if (workspace.isAssistantHome(projectPath)) await this.onAssistantLaunch(projectPath)
    // Checked after the last await, just before spawning: stopped, its workspace closed or switched, or the
    // provider turned off while this launch was being prepared, it must not start a process.
    if (l.stopRequested || this.live.get(id) !== l || this.starting.get(id)?.cancelled || !workspaceFor(projectPath) || this.shuttingDown || workspaceFor(projectPath)?.closing) throw new Error('The agent was stopped before it had started.')
    if (!isProviderEnabled(config.settings, adapter.id)) throw new Error(`${adapter.descriptor.name} was turned off while ${agent.name} was starting.`)
    const cmd = adapter.buildCommand(info.path, ctx)
    // Where it compacts by itself (#242): for the model it runs as, the choice's (an alias resolved) or the CLI's default.
    const chosenModel = eff.model || info.defaultModel || ''
    // Once the session reports the model it runs, that model alone: another model's window isn't its own.
    const modelsFor = (running?: string): string[] => (running ? [running] : [chosenModel && resolvedModel(info, chosenModel), chosenModel].filter((m): m is string => !!m))
    l.autoCompactFor = adapter.autoCompact ? (running) => adapter.autoCompact!(ctx, cmd, modelsFor(running)) : undefined
    state.autoCompact = l.autoCompactFor?.()
    l.titleAttention = adapter.titleAttention?.(info.version) ?? undefined
    // What it was given: Hive's guidance revision and each skill as delivered (the Agent API's project status shows
    // them). A skill not delivered as asked (kept old copy, failed copy) leaves it needing a restart.
    const notGiven = Object.fromEntries(Object.entries(eff.skillProblems).map(([name, why]) => [name, { revision: null, problem: `nobody gets it: ${why}`, lasting: true as const }]))
    const record = launchRecord(eff.skillHashes, { ...delivered, ...notGiven })
    state.launchSignature = this.signature({ ...eff, skillHashes: record.settled })
    state.launched = { guidance: GUIDANCE_REVISION, skills: record.skills, ...(record.problems ? { problems: record.problems } : {}) }
    // Performance metrics: what Hive gave this session, exact sizes. The session contract once (whichever way the
    // provider gets it); the skills that reached it, measured on their copies; the ones asked for that didn't.
    const given = Object.keys(record.skills)
    const parts = launchParts(ctx.guidance, workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent', basename(projectPath), assistantText)
    recordLaunch(metrics, workspace.isAssistantHome(projectPath) ? null : basename(projectPath), {
      provider: adapter.id,
      role: workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent',
      ...parts,
      skills: given.length,
      skillCatalogBytes: deliveredSizes.catalog,
      skillBytes: deliveredSizes.bytes,
      skillsNotDelivered: Object.keys(eff.skillHashes).length - given.length,
      skillsUnmeasured: deliveredSizes.unmeasured
    })
    l.defaultModel = !eff.model
    l.defaultEffort = eff.effort ? undefined : { model: eff.model }

    // The footer is read from the rendered screen: a CLI may redraw only the characters that changed.
    const screen = l.adapter.footerMode ? new TerminalScreen(PTY_COLS, PTY_ROWS) : null
    const proc = spawnPty(this.key(projectPath, agent.id), {
      file: cmd.file,
      args: cmd.args,
      cwd,
      env: cmd.env ?? ctx.env,
      // After a worktree's setup command, its output stays at the top of the terminal.
      continueBuffer: true,
      onData: (data) => {
        if (l.switchTail !== undefined) l.switchTail = (l.switchTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
        // The CLI refusing or failing a compaction Hive asked for sends no hook ("Not enough messages to compact.").
        this.live.get(id)?.compacting?.terminal(data)
        screen?.write(data, () => this.readFooterMode(l, screen))
        this.watchTitle(id, data)
        this.watchReadyOutput(id, data)
      },
      onResize: (cols, rows) => screen?.resize(cols, rows),
      onExit: (code, output) => {
        screen?.dispose()
        void this.onExit(projectPath, agent.id, state.runId, code, output)
      }
    })
    state.pid = proc.pid
    l.initialPrompt = undefined
    l.backupTimer = setInterval(() => void this.backup(projectPath, agent.id), 5000)
    // The process runs now: failing to record it (a full disk) must not leave it untracked.
    if (state.sessionId) await this.recordSession(projectPath, agent, l).catch((e) => log.warn(`${userText(this.label(state))}: could not record session ${state.sessionId}`, e))
    if (resume && state.sessionId && assistantText?.personaId) this.onAssistantResumed(projectPath, state.runId, state.sessionId, assistantText.personaId)

    // Launched as active: starting a session implies working on the project.
    if (!workspace.isAssistantHome(projectPath) && !workspaceOf(projectPath).activeNames().includes(basename(projectPath))) workspace.setActive(projectPath, true)
    this.emitState(state)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /** Records the running session in sessions.json and as the agent's session to resume. */
  private async recordSession(projectPath: string, agent: Pick<AgentDef, 'id' | 'name' | 'worktree'>, l: LiveSession): Promise<void> {
    const { state } = l
    const sessionId = state.sessionId
    // Images pasted before the provider named the session wait in the launch's folder: move them to the session's.
    const early = join(projectPath, HIVE_DIR, 'images', `run-${state.runId}`)
    if (existsSync(early)) {
      const dest = join(projectPath, HIVE_DIR, 'images', sessionId)
      await mkdir(dest, { recursive: true }).catch(() => undefined)
      for (const f of await readdir(early).catch(() => [] as string[])) await rename(join(early, f), join(dest, f)).catch((e) => log.warn(`Could not move ${userText(f)}`, e))
      await rm(early, { recursive: true, force: true }).catch(() => undefined)
    }
    await workspace.upsertSession(projectPath, {
      id: sessionId,
      agent: state.provider,
      name: l.name,
      ...(state.titleAtRename !== undefined ? { titleAtRename: state.titleAtRename } : {}),
      lastActiveAt: new Date().toISOString(),
      // The agent running it now; a session can move between agents that share a folder. Its name too, for once it's gone.
      agentId: agent.id,
      agentName: agent.name,
      // The Assistant's mode its conversation was last given (a resumed one's is unknown until it is told: assistantMode.ts).
      ...(l.mode ? { persona: l.mode } : {}),
      // Providers that choose their own ids file transcripts by date, not folder: remember where.
      ...(l.transcriptPath && !l.adapter.descriptor.capabilities.fixedSessionId ? { transcriptPath: l.transcriptPath } : {}),
      // Where it ran, when not the project folder (a worktree, or the Assistant's workspace folder).
      ...(state.cwd.toLowerCase() !== projectPath.toLowerCase() ? { cwd: state.cwd } : {}),
      ...(agent.worktree ? { branch: agent.worktree.branch } : {})
    })
    await workspace.updateAgent(projectPath, agent.id, { lastSessionId: sessionId }).catch(() => undefined)
    // The card it was started on (or already has in Doing).
    await recordCards(workspaceOf(projectPath), projectPath, agent.id, sessionId).catch((e) => log.warn(`Could not record the cards of session ${sessionId}`, e))
    for (const other of projectAgents(await workspace.projectConfig(projectPath))) {
      if (other.id !== agent.id && other.lastSessionId === sessionId) await workspace.updateAgent(projectPath, other.id, { lastSessionId: undefined }).catch(() => undefined)
    }
  }

  /** Stops one agent's session, or every agent of the project when agentId is omitted. */
  stop(projectPath: string, agentId?: string): void {
    const agents = agentId ? [agentId] : this.projectStates(projectPath).map((s) => s.agentId)
    for (const a of agents) {
      const l = this.live.get(liveId(projectPath, a))
      if (l) l.stopRequested = true
      killPty(this.key(projectPath, a))
    }
    // Starts still being prepared (no process yet) give up at their next check.
    for (const [k, p] of this.starting) if (p.projectPath.toLowerCase() === projectPath.toLowerCase() && (!agentId || k === liveId(projectPath, agentId))) p.cancelled = true
  }

  /** Stops every running agent of one provider (e.g. when the provider is turned off). */
  stopProvider(provider: ProviderId): void {
    for (const l of [...this.live.values()]) if (l.state.provider === provider) this.stop(l.state.projectPath, l.state.agentId)
  }

  stopAll(): void {
    for (const l of this.live.values()) killPty(this.key(l.state.projectPath, l.state.agentId))
  }

  /**
   * Stops every session and waits until each has been through onExit (final transcript backup,
   * session list update), or until the timeout, so quitting never loses the last messages or hangs.
   */
  async stopAllAndWait(timeoutMs = 3000): Promise<void> {
    this.shuttingDown = true
    return this.stopWhereAndWait(() => true, timeoutMs)
  }

  /**
   * Stops the sessions matching `which` (e.g. one window's workspace) and waits for them as stopAllAndWait
   * does. Starts in progress for matching projects are cancelled and waited for too.
   */
  async stopWhereAndWait(which: (s: { projectPath: string }) => boolean, timeoutMs = 3000): Promise<void> {
    const pending = [...this.starting.values()].filter((p) => which(p))
    for (const p of pending) p.cancelled = true
    const chosen = [...this.live.entries()].filter(([, l]) => which(l.state))
    const waits = chosen.map(([k]) => k).map(
      (k) =>
        new Promise<void>((res) => {
          const previous = this.exitWaiters.get(k)
          this.exitWaiters.set(k, () => {
            previous?.()
            res()
          })
        })
    )
    for (const [, l] of chosen) {
      l.stopRequested = true
      killPty(this.key(l.state.projectPath, l.state.agentId))
    }
    await Promise.race([Promise.all([...waits, ...pending.map((p) => p.done)]), new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /**
   * Compacts a session's conversation now (the CLI's /compact), optionally with focus instructions.
   * Only while the agent is idle: while it works the command would queue or interrupt, and while it
   * waits on a prompt the text would land in that prompt. Ctrl+U first clears anything half-typed.
   */
  async compact(projectPath: string, focus?: string, agentId?: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    agentId ||= await this.soleAgent(projectPath)
    const id = liveId(projectPath, agentId)
    const key = this.key(projectPath, agentId)
    const check = (l: LiveSession | undefined): LiveSession => {
      if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
      if (l.compacting) throw new Error('This session is already compacting.')
      if (this.delivering.has(key)) throw new Error('Hive is already typing a prompt into this agent; it is busy.')
      // Watching its cards (its turn has ended) may compact: the watch stays.
      if (l.state.status !== 'ready' && l.state.status !== 'finished' && l.state.status !== 'watching') {
        throw new Error(l.state.status === 'waiting' ? 'The agent is waiting for your answer. Compact after it has finished.' : 'The agent is busy. Compact once it has finished.')
      }
      return l
    }
    const l = check(this.live.get(id))
    const src = await this.liveTranscript(l)
    const before = src ? ((await this.usageFor(src, l.state.sessionId, l.state.provider))?.compactions.length ?? 0) : 0
    // Again: a second Compact or a prompt may have come meanwhile (one at a time, only while idle).
    if (this.live.get(id) !== l) throw new Error('No session is running for this agent.')
    check(l)
    // Reserved while Hive types the command (a long focus takes a while), so nothing else is typed or compacted
    // meanwhile; Compaction's limits run from its submission.
    const release = (): void => {
      if (l.compacting !== c) return
      l.compacting = undefined
      // A session that has exited stays stopped.
      if (this.live.get(id) === l && applyStep(l.state, compactionOver(l.state))) this.emitState(l.state)
    }
    const c: Compaction = new Compaction(before, l.adapter.compactFailure, release)
    l.compacting = c
    l.state.status = 'working'
    l.state.statusMessage = COMPACTING_MESSAGE
    this.emitState(l.state)
    this.delivering.add(key)
    const runId = l.state.runId
    // The agent stopped or restarted meanwhile: the rest mustn't reach the new process.
    const same = (): boolean => this.live.get(id) === l && l.state.runId === runId && l.compacting === c
    const pause = async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
      if (!same()) throw new Error('The agent stopped before Compact was sent.')
    }
    try {
      writePty(key, '\x15')
      await pause(150)
      const text = l.adapter.descriptor.capabilities.compactFocus ? (focus ?? '').replace(/\s+/g, ' ').trim() : ''
      // Written in one go, a long line counts as a paste, and pasted input is sent as a message even when
      // it starts with "/compact". So type the command on its own, then the focus in small pieces.
      writePty(key, '/compact')
      await pause(150)
      if (text) await typeInto(key, ` ${text}`, same)
      await pause(150)
      writePty(key, '\r')
      c.submitted()
    } catch (e) {
      c.end()
      release()
      throw e
    } finally {
      this.delivering.delete(key)
    }
  }

  /**
   * For CLIs whose terminal title says when a person must act (Codex): whether it says so changes the status
   * (titleStep). Before the session has started, its question at start is the startup's to show.
   */
  private watchTitle(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l?.titleAttention) return
    const { title, carry } = lastTitle(l.titleCarry ?? '', data)
    l.titleCarry = carry
    if (title === null) return
    const asks = l.titleAttention(title)
    if (asks === !!l.titleRead) return
    l.titleRead = asks
    // After the hooks that came before it: they are answered at once and handled one at a time, so a slow one (the
    // first records the session) holds back a prompt and an ask that came before the title (#254).
    const runId = l.state.runId
    void this.inHookOrder(runId, () => {
      const now = this.live.get(id)
      if (!now || now.state.runId !== runId || asks === !!now.titleAsks) return
      const step = now.state.status === 'starting' || now.askedAtStart ? null : titleStep(asks, this.statusInput(now))
      now.titleAsks = asks
      if (step) this.carryOut(id, now, step, 'title')
    }).catch((e) => log.warn('title: could not apply it', e))
  }

  /** For CLIs whose first hook waits for the first prompt: the prompt showing in the terminal means ready. */
  private watchReadyOutput(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l || (l.state.status !== 'starting' && !l.askedAtStart) || (!l.adapter.readyOutput && !l.adapter.startupQuestion)) return
    l.modeTail = (l.modeTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).slice(-600)
    const text = l.modeTail.replace(/\s+/g, ' ')
    const asked = l.adapter.startupQuestion?.exec(text)
    if (l.state.status === 'starting' && asked) {
      l.askedAtStart = true
      l.modeTail = ''
      l.state.status = 'waiting'
      l.state.unseen = true
      l.state.statusMessage = asked[0].includes('trust') ? 'Asks whether to trust this folder' : 'Asks something before it starts'
      this.notify(l.state.projectPath, `${this.label(l.state)} needs your input`, l.state.statusMessage, 'waiting', undefined, l.state.agentId)
      this.emitState(l.state)
    } else if (l.adapter.readyOutput?.test(text)) {
      this.startupAnswered(l)
      l.state.status = 'ready'
      this.emitState(l.state)
    }
  }

  /** The question before the start was answered: the agent is starting again. */
  private startupAnswered(l: LiveSession): void {
    if (!l.askedAtStart) return
    l.askedAtStart = false
    l.state.statusMessage = undefined
  }

  /** Reads the mode from the CLI's footer on its screen as it redraws, so a mode change in the terminal shows in Hive at once. */
  private readFooterMode(l: LiveSession, screen: TerminalScreen): void {
    if (this.live.get(liveId(l.state.projectPath, l.state.agentId)) !== l || !l.adapter.footerMode) return
    const mode = l.adapter.footerMode(screen.text())
    if (mode && (mode !== l.state.permissionMode || mode !== l.state.modeObserved)) {
      l.state.permissionMode = l.state.modeObserved = mode
      this.emitState(l.state)
    }
  }

  /**
   * Switches a running agent's permission mode the way you would by hand (Claude Code: Shift+Tab in its
   * terminal until the footer shows the mode). Not while it is asking a question (the keys could change
   * the answer). Modes the provider can't switch to live need a restart (restartInMode).
   */
  async setPermissionMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<{ ok: boolean; restart?: boolean; message?: string }> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    const st = l.state
    const p = st.provider
    const name = l.adapter.descriptor.name
    if (st.permissionMode === mode) return { ok: true }
    if (!modeAllowed(p, mode, config.settings)) throw new Error(`${permissionLabel(p, mode)} is turned off in Settings → ${name}.`)
    const how = l.adapter.descriptor.capabilities.liveModeSwitch
    if (how === 'none' || !l.adapter.canSwitchLive(mode, st.permissionMode, l.launchMode)) {
      return { ok: false, restart: true, message: `${permissionLabel(p, mode)} can't be switched to inside a running session. Restart the session in that mode; the conversation continues.` }
    }
    if (st.status === 'waiting') throw new Error('The agent is asking you something. Answer it first, then switch the mode.')
    if (st.status === 'starting') throw new Error('The session is still starting. Try again in a moment.')
    const key = this.key(projectPath, agentId)
    if (how === 'menu' && l.adapter.modeMenuKeys) {
      // The CLI's own menu (Codex: /permissions). Only while idle: typed into a working agent it would queue.
      if (st.status === 'working') throw new Error(`${name} is working. Switch the mode once it has finished.`)
      const before = st.permissionMode
      st.modeSwitching = mode
      l.switchTail = ''
      this.emitState(st)
      for (const step of l.adapter.modeMenuKeys(mode)) {
        writePty(key, step.keys)
        await new Promise((r) => setTimeout(r, step.waitMs ?? 60))
      }
      // The CLI records the new settings in its transcript at once: read them back rather than assume.
      const src = await this.liveTranscript(l)
      if (!src || !l.adapter.transcriptDetails) {
        // Nothing to read yet (no message sent): shown as asked; the first turn's settings correct it.
        st.modeSwitching = undefined
        st.permissionMode = mode
        this.emitState(st)
        return { ok: true }
      }
      for (let t = Date.now(); Date.now() - t < 12_000; ) {
        const s = await stat(src).catch(() => null)
        if (s) await this.readDetails(l, src, s.size)
        if (st.permissionMode === mode) break
        // The CLI's own confirmation in the terminal comes first (the transcript record a few seconds later).
        const said = l.adapter.modeFromOutput?.(l.switchTail ?? '')
        if (said) {
          st.permissionMode = said
          if (said === mode) break
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      l.switchTail = undefined
      st.modeSwitching = undefined
      if (st.permissionMode !== mode) {
        st.permissionMode = before
        this.emitState(st)
        log.warn(`${userText(this.label(st))}: ${name} didn't confirm switching to ${mode}`)
        return { ok: false, message: `${name} didn't confirm switching to ${permissionLabel(p, mode)}. Check its terminal, or use /permissions there.` }
      }
      this.emitState(st)
      log.info(`${userText(this.label(st))}: switched to ${mode} with the mode menu (confirmed)`)
      return { ok: true }
    }
    const seen = new Set<PermissionMode>()
    for (let i = 0; i < 8; i++) {
      const before = st.permissionMode
      if (before) seen.add(before)
      writePty(key, '\x1b[Z')
      const t = Date.now()
      // The footer redraw that shows the new mode can take a few seconds on a busy machine or just after the start.
      while (Date.now() - t < 4000 && st.permissionMode === before) await new Promise((r) => setTimeout(r, 50))
      if (st.permissionMode === mode) {
        log.info(`${userText(this.label(st))}: switched to ${mode}`)
        return { ok: true }
      }
      if (st.permissionMode === before) break
      // Back round to a mode already seen: the target isn't in this session's cycle.
      if (st.permissionMode && seen.has(st.permissionMode)) break
    }
    log.warn(`${userText(this.label(st))}: ${name} didn't reach ${mode} with Shift+Tab (now ${st.permissionMode ?? 'unknown'})`)
    return { ok: false, restart: true, message: `${name} didn't offer ${permissionLabel(p, mode)} with Shift+Tab (it is now in ${st.permissionMode ? permissionLabel(p, st.permissionMode) : 'an unknown mode'}). Restart the session in that mode instead.` }
  }

  /** Waits for an agent's live status to satisfy `test`, or gives up after `ms`. */
  private async waitStatus(projectPath: string, agentId: string, test: (s: LiveSessionState | null) => boolean, ms: number): Promise<LiveSessionState | null> {
    const t = Date.now()
    for (;;) {
      const st = this.live.get(liveId(projectPath, agentId))?.state ?? null
      if (test(st)) return st
      if (Date.now() - t > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /** The user typed in a terminal (Hive's own typing goes through sendPrompt, not here). */
  noteUserInput(key: string, data: string): void {
    // xterm's own replies (focus in/out, cursor reports, colour queries) aren't typing.
    const typed = typedText(data)
    if (typed) this.userInput.set(key, { at: Date.now(), enter: typed.endsWith('\r') })
  }

  /** Whether the user may still be writing in an agent's terminal (Settings → Assistant → Pause after you type). */
  userMayBeTyping(projectPath: string, agentId: string): boolean {
    const u = this.userInput.get(this.key(projectPath, agentId))
    if (!u) return false
    const s = config.settings.assistant
    if (u.enter && (s?.enterEndsPause ?? true)) return false
    return Date.now() - u.at < (s?.typingPause ?? 15) * 1000
  }

  /**
   * The run `runId` of the Hive Assistant was told its mode `persona` (an id): its conversation records it, so a resume
   * tells it again only after another switch (#334).
   */
  async modeGiven(projectPath: string, agentId: string, runId: string, persona: string): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId) return
    l.mode = persona
    if (l.state.sessionId) await workspace.upsertSession(projectPath, { id: l.state.sessionId, persona })
  }

  /** When the user last typed in an agent's terminal (ms since the epoch), or 0. */
  userTypedAt(projectPath: string, agentId: string): number {
    return this.userInput.get(this.key(projectPath, agentId))?.at ?? 0
  }

  /** Files an agent holds a lock on (it is editing them this turn). */
  locksFor(projectPath: string, agentId: string): string[] {
    const id = liveId(projectPath, agentId)
    return [...this.locks.values()].filter((x) => x.liveId === id).map((x) => x.path)
  }

  /** Types a message into an agent's terminal and sends it. */
  /** Agents Hive is typing a prompt into (one at a time each). */
  private delivering = new Set<string>()

  /**
   * Types a prompt into an agent and sends it, on one line (a new line would send it early in the CLI).
   * Refused while another is being typed there; stops if the agent stops or restarts meanwhile. `guard` throws if the
   * prompt mustn't go in any more (the agent got busy, the user typed there): it is checked before the input is
   * cleared, before each part is typed and before it is sent. Stopped part-way, what Hive typed is cleared again,
   * unless the user has typed since (their input stays).
   */
  async sendPrompt(projectPath: string, agentId: string, text: string, guard?: () => void, opts: { confirm?: boolean } = {}): Promise<void> {
    const key = this.key(projectPath, agentId)
    const l = this.live.get(liveId(projectPath, agentId))
    const runId = l?.state.runId
    if (this.delivering.has(key)) throw new Error('Hive is already typing a prompt into this agent; it is busy.')
    this.delivering.add(key)
    const same = (): boolean => !!runId && this.live.get(liveId(projectPath, agentId))?.state.runId === runId
    const check = (): void => {
      if (!same()) throw new Error('The agent stopped before the prompt was sent.')
      guard?.()
    }
    const since = Date.now()
    let typed = false
    try {
      check()
      writePty(key, '\x15')
      await new Promise((r) => setTimeout(r, 150))
      check()
      typed = true
      await typeInto(key, text.replace(/\s+/g, ' ').trim(), () => (check(), true))
      await new Promise((r) => setTimeout(r, 300))
      check()
      const before = l?.prompts ?? 0
      writePty(key, '\r')
      // confirm: until the CLI reports the prompt submitted. One just resumed and still drawing its conversation can
      // drop the Enter, or take it as a new line (#334): Enter again, which an empty prompt ignores. Still not
      // reported (a CLI that doesn't report prompts), it counts as sent: typing it again could send it twice.
      const taken = (): boolean => (l?.prompts ?? 0) !== before || !same()
      for (let i = 0; opts.confirm && i < 3; i++) {
        const t = Date.now()
        while (!taken() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 100))
        if (taken()) break
        if (i === 2) {
          log.warn(`${userText(this.label(l!.state))}: the CLI didn't report Hive's prompt submitted`)
          break
        }
        // Never an Enter that would send what the user has begun typing, or into a session that got busy.
        if (this.userTypedAt(projectPath, agentId) >= since) break
        try {
          check()
        } catch {
          break
        }
        writePty(key, '\r')
      }
    } catch (e) {
      if (typed && same() && this.userTypedAt(projectPath, agentId) < since) writePty(key, '\x15')
      throw e
    } finally {
      this.delivering.delete(key)
    }
  }

  /**
   * Hands one agent's work over to another (any provider): the source writes a handover with Hive's
   * hive_create_handover tool, then the target starts and picks it up with hive_read_latest_handover.
   * Conversations can't move between providers; a handover carries the work instead.
   */
  async handOver(projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    // To itself: the agent carries on in a new conversation (a long transcript made short again).
    const self = fromAgentId === toAgentId
    if (!this.hiveMcp(projectPath)) throw new Error('Handing over needs Hive\'s tools in sessions: turn on "Provide Hive tools to sessions" in Settings → Agent API.')
    const { agent: to } = await this.agentDef(projectPath, toAgentId)
    const { agent: from } = await this.agentDef(projectPath, fromAgentId)
    const source = this.live.get(liveId(projectPath, fromAgentId))?.state ?? null
    const fromSession = source?.sessionId || from.lastSessionId || ''
    // The handover the target reads, by name: a newer one appearing meanwhile isn't the one meant.
    let handover = ''
    if (opts.handover) {
      if (!source) throw new Error(`${from.name} isn't running. Resume it to write a handover, or hand over the latest handover.`)
      if (source.status !== 'ready' && source.status !== 'finished') throw new Error(`${from.name} is busy. Hand over once it has finished.`)
      // Proof, not status: the target starts only once a handover newer than this one exists, written in the
      // source's own conversation (its header's Session, which Hive writes), not by another agent meanwhile.
      // Among the newest few, since another agent may write one after the source does.
      const known = new Map((await this.recentHandovers(projectPath, 20)).map((h) => [h.relPath, h.modified]))
      const want = source.sessionId
      const isNew = (h: HandoverRef): boolean => (!known.has(h.relPath) || h.modified > known.get(h.relPath)!) && (!want || h.session === want)
      toast('info', `${from.name} is writing a handover`, self ? 'It continues from it in a new conversation when it\'s done.' : `${to.name} continues from it when it's done.`, undefined, projectPath)
      await this.sendPrompt(
        projectPath,
        fromAgentId,
        `Please write a handover of this work with the hive_create_handover tool, so that ${self ? 'you can continue it in a new conversation' : `another agent (${to.name}) can continue it`}: the goal, what is done, decisions made and why, the current state, open problems and the next steps. Then stop.`
      )
      const t0 = Date.now()
      let idleSince = 0
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const h = (await this.recentHandovers(projectPath, 10).catch(() => [] as HandoverRef[])).find(isNew)
        if (h) {
          handover = h.relPath
          break
        }
        const st = this.live.get(liveId(projectPath, fromAgentId))?.state
        if (!st) throw new Error(`${from.name} stopped before writing a handover.`)
        if (st.status === 'waiting') throw new Error(`${from.name} is asking you something before it can write the handover. Answer it, then hand over again without a new handover.`)
        // Finished without one (the file can land a moment after the turn ends): give it 20 seconds.
        idleSince = st.status === 'finished' || st.status === 'ready' ? idleSince || Date.now() : 0
        if (idleSince && Date.now() - idleSince > 20_000 && Date.now() - t0 > 30_000) throw new Error(`${from.name} finished without writing a handover. Ask it to write one, then hand over again without a new handover.`)
        if (Date.now() - t0 > 15 * 60_000) throw new Error(`${from.name} didn't write its handover in 15 minutes.`)
      }
    }
    if (!handover) {
      handover = (await this.latestHandover(projectPath))?.relPath ?? ''
      if (!handover) throw new Error(`There is no handover for ${basename(projectPath)} yet. Hand over with a new handover instead.`)
    }
    // To itself: its conversation ends here (it stays in the Sessions tab), and a new one starts below.
    if (self && this.live.has(liveId(projectPath, fromAgentId))) {
      await this.stopWhereAndWait((s) => s.projectPath.toLowerCase() === projectPath.toLowerCase() && (s as { agentId?: string }).agentId === fromAgentId, 15_000)
      if (this.live.has(liveId(projectPath, fromAgentId))) throw new Error(`${from.name} didn't stop. Stop it, then start it and ask it to read the handover "${handover}".`)
    }
    // The target: started fresh when idle, or given the message in its running session.
    let target = this.live.get(liveId(projectPath, toAgentId))?.state ?? null
    if (target && target.status !== 'ready' && target.status !== 'finished') throw new Error(`${to.name} is busy. Hand over once it has finished.`)
    if (!target) {
      await this.start(projectPath, { agentId: toAgentId })
      // Minutes, not seconds: the CLI may first ask something (e.g. whether to trust the folder).
      target = await this.waitStatus(projectPath, toAgentId, (s) => !s || s.status === 'ready', 5 * 60_000).catch(() => null)
      if (!target) throw new Error(`${to.name} didn't become ready. Answer any question in its terminal, then hand over again without a new handover.`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    await this.sendPrompt(projectPath, toAgentId, `Read the handover "${handover}" with the hive_read_shared_note tool and continue the work from it. It was written by ${self ? 'you, in your previous conversation' : from.name}.`)
    // Link the sessions once the target's id is known (Codex reports it with the first prompt).
    const linked = await this.waitStatus(projectPath, toAgentId, (s) => !s || !!s.sessionId, 60_000).catch(() => null)
    if (linked?.sessionId && fromSession) await workspace.upsertSession(projectPath, { id: linked.sessionId, handedOverFrom: fromSession }).catch(() => undefined)
  }

  /** Turns a running agent's Plan mode on or off (providers where it is a toggle, e.g. Codex's Shift+Tab). */
  async setPlanMode(projectPath: string, agentId: string, on: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.settingUp) throw new Error('No session is running for this agent.')
    if (!l.adapter.planToggleKey) throw new Error(`${l.adapter.descriptor.name} has no Plan mode toggle.`)
    if (l.state.status === 'waiting') throw new Error('The agent is asking you something. Answer it first.')
    if (!!l.state.planMode === on) return
    writePty(this.key(projectPath, agentId), l.adapter.planToggleKey)
    l.state.planMode = on
    this.emitState(l.state)
  }

  /** Stops the agent and resumes the same conversation in another permission mode. */
  async restartInMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) throw new Error('No session is running for this agent.')
    const { sessionId, sessionName } = l.state
    // A session nobody has typed in yet has no conversation (its transcript, if any, holds no messages,
    // and the CLI answers "no conversation found" to --resume): start a new one in the mode instead.
    const usage = sessionId ? await this.usage(projectPath, sessionId).catch(() => null) : null
    const resumable = !!sessionId && (usage?.userMessages ?? 0) > 0
    const previous = this.exitWaiters.get(id)
    const exited = new Promise<void>((res) =>
      this.exitWaiters.set(id, () => {
        previous?.()
        res()
      })
    )
    this.stop(projectPath, agentId)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    await this.start(projectPath, { resumeId: resumable ? sessionId : undefined, name: sessionName, agentId, permissionMode: mode })
  }

  // A changed mode setting applies to new sessions; for running ones, Hive offers to switch them now.
  private modeOffers = new Map<string, { label: string; mode: string }>()
  private modeOfferTimer: NodeJS.Timeout | null = null

  private noticeModeSetting(l: LiveSession, mode: PermissionMode | null): void {
    if (!mode || mode === l.configuredMode || mode === l.offeredMode) return
    if (mode === l.state.permissionMode) {
      // Already in it (switched by hand): nothing to offer.
      l.configuredMode = mode
      return
    }
    l.offeredMode = mode
    this.modeOffers.set(liveId(l.state.projectPath, l.state.agentId), { label: this.label(l.state), mode: permissionLabel(l.state.provider, mode) })
    if (this.modeOfferTimer) clearTimeout(this.modeOfferTimer)
    this.modeOfferTimer = setTimeout(() => {
      this.modeOfferTimer = null
      const offers = [...this.modeOffers.values()]
      this.modeOffers.clear()
      if (!offers.length) return
      const modes = [...new Set(offers.map((o) => o.mode))]
      const who = offers.length === 1 ? offers[0].label : `${offers.length} running agents (${offers.map((o) => o.label).join(', ')})`
      toast(
        'info',
        `Permission mode changed to ${modes.join(' / ')}`,
        `Switch ${who} now? Otherwise the new mode applies from ${offers.length === 1 ? 'its' : 'their'} next session.`,
        [{ label: 'Switch Now', command: 'session.applyPermissionModes' }]
      )
    }, 400)
  }

  /** "Switch Now": moves every running agent whose settings now say another mode into that mode. */
  async applyModeSettings(): Promise<{ switched: string[]; skipped: string[] }> {
    const switched: string[] = []
    const skipped: string[] = []
    for (const l of [...this.live.values()]) {
      const st = l.state
      if (st.settingUp) continue
      const { agent } = await this.agentDef(st.projectPath, st.agentId).catch(() => ({ agent: null }))
      if (!agent) continue
      const mode = (await this.effective(st.projectPath, agent)).permissionMode
      if (!mode || mode === l.configuredMode) continue
      l.configuredMode = mode
      if (mode === st.permissionMode) continue
      try {
        const r = await this.setPermissionMode(st.projectPath, st.agentId, mode)
        if (r.ok) switched.push(`${this.label(st)} → ${permissionLabel(st.provider, mode)}`)
        else skipped.push(`${this.label(st)}: ${r.message}`)
      } catch (e) {
        skipped.push(`${this.label(st)}: ${(e as Error).message}`)
      }
    }
    return { switched, skipped }
  }

  /** Stops the CLI's background job holding a conversation, then resumes the conversation in this agent. */
  async stopBackgroundAndResume(projectPath: string, agentId: string, jobId: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const { agent, cfg } = await this.agentDef(projectPath, agentId)
    const adapter = providerAdapter(agentLaunchSettings(agent, cfg, config.settings).provider)
    const info = providerService.info(adapter.id)
    if (!adapter.stopBackgroundJob || !info.path) throw new Error(`${adapter.descriptor.name} can't stop background sessions.`)
    await adapter.stopBackgroundJob(info.path, jobId)
    // The job lets go of the conversation as it exits.
    await new Promise((r) => setTimeout(r, 1500))
    await this.start(projectPath, { agentId, resumeId: sessionId })
  }

  /** Sessions that would be interrupted by quitting: an agent is working or waiting on a prompt. */
  busyStates(): LiveSessionState[] {
    // A watching agent is in the middle of its work (waiting on cards it will carry on with): busy too.
    return this.liveStates().filter((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'background' || s.status === 'watching')
  }

  private async onExit(projectPath: string, agentId: string, runId: string, code: number, output = ''): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    const sessionId = l?.state.sessionId ?? ''
    // The CLI refused to open a conversation it is running as a background job (e.g. Claude Code's agent view):
    // say so, and offer to stop that job and resume here.
    const job = l && !l.stopRequested && sessionId ? l.adapter.backgroundJobIn?.(output) : null
    if (l && job) {
      toast(
        'warning',
        `${this.label(l.state)}: the session is running in the background`,
        `${l.adapter.descriptor.name} moved this conversation into its background service (job ${job}), so it can't be opened here until that job is stopped. The conversation is kept.`,
        [{ label: 'Stop It and Resume', command: 'session.stopBackgroundAndResume', args: [projectPath, agentId, job, sessionId] }],
        projectPath
      )
    }
    // Exited before its session started, and nobody stopped it: a failed start, whose reason the pane shows.
    const failure: StartFailure | undefined = l
      ? failedStart(
          { status: l.state.status, settingUp: l.state.settingUp, stopRequested: !!l.stopRequested || this.shuttingDown, backgroundJob: !!job, resumed: !!l.resumed },
          code,
          output,
          { name: l.adapter.descriptor.name, startHint: l.adapter.startHint?.bind(l.adapter) }
        )
      : undefined
    if (failure) log.warn(`${userText(this.label(l!.state))}: exited with code ${code} before it started: ${userText(failure.reason.replace(/\n/g, ' | '))}`)
    if (l) {
      if (l.backupTimer) clearInterval(l.backupTimer)
      l.compacting?.end()
      await this.backup(projectPath, agentId, true).catch(() => undefined)
      // Its CLI has exited: its transcript is finished (archiving it at once is fine, inUse).
      this.noteExit(l.state.sessionId)
      this.live.delete(id)
    }
    this.runs.delete(runId)
    // Its hook token ends with it: hooks of an ended launch were ignored anyway (findLaunch).
    endHookToken(runId)
    this.releaseLocks(id)
    // Even when its workspace has just closed.
    if (basename(projectPath) === ASSISTANT_DIR) this.onAssistantExit(projectPath)
    else endAgentToken(projectPath, agentId, runId)
    this.launchEnded(projectPath, agentId, runId)
    if (sessionId) {
      if (await this.anyTranscript(projectPath, sessionId)) {
        await workspace.upsertSession(projectPath, { id: sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
      } else {
        // Nothing was ever said (e.g. closed at the login screen) — there is nothing to resume.
        await workspace
          .mutateSessions(projectPath, (f) => {
            f.sessions = f.sessions.filter((s) => s.id !== sessionId)
          })
          .catch(() => undefined)
      }
    }
    emit({ type: 'session-exit', projectPath, agentId, sessionId, exitCode: code, ...(failure ? { failure } : {}) })
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
    emit({
      type: 'session-status',
      state: { provider: l?.state.provider ?? '', runId, projectPath, agentId, cwd: l?.state.cwd ?? projectPath, sessionId, status: 'stopped', startedAt: l?.state.startedAt ?? '', launchSignature: '', unseen: false }
    })
    workspaceOf(projectPath).scheduleRefresh()
  }

  /** The running session's transcript, once the provider has written one. */
  private async liveTranscript(l: LiveSession): Promise<string | null> {
    if (!l.state.sessionId) return null
    if (l.transcriptPath && existsSync(l.transcriptPath)) return l.transcriptPath
    const t = await l.adapter.transcriptPath(l.state.cwd, l.state.sessionId, l.transcriptPath)
    if (t) l.transcriptPath = t
    return t
  }

  /**
   * Windows is shutting down or signing out: backs up every running session's transcript before returning, as its
   * callbacks don't wait for a Promise. Only the bytes: usage, details and cost wait for the next start. Best effort
   * within `budgetMs` in all (syncCopyNow says how closely): `incomplete` ran out of time part way, `skipped` were
   * not tried (no transcript found yet, or no time left). Their backups are as of the last ordinary one, or a little
   * further.
   */
  backupAllNow(budgetMs: number): { saved: number; incomplete: number; skipped: number; failed: number } {
    const done = { saved: 0, incomplete: 0, skipped: 0, failed: 0 }
    if (!config.settings.sessions.backupTranscripts) return done
    const deadline = Date.now() + budgetMs
    for (const l of this.live.values()) {
      const src = l.transcriptPath
      if (!l.state.sessionId || !src || Date.now() >= deadline) {
        done.skipped++
        continue
      }
      try {
        if (syncCopyNow(src, this.backupPath(l.state.projectPath, l.state.sessionId), deadline)) {
          l.lastBackupAt = Date.now()
          done.saved++
        } else done.incomplete++
      } catch (e) {
        log.warn('backup at shutdown failed', e)
        done.failed++
      }
    }
    return done
  }

  /** After the PC wakes up: read each running session's transcript again (usage, background tasks, plan usage) and report its state. */
  refreshAfterResume(): void {
    for (const l of this.live.values()) {
      void this.backup(l.state.projectPath, l.state.agentId, true)
        .catch(() => undefined)
        .finally(() => this.emitState(l.state))
    }
  }

  /** Copies the live transcript into <project>/.hive/sessions so it survives the CLI's own cleanup. */
  private async backup(projectPath: string, agentId: string, force = false): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return
    // Tasks that expire or run past the limit end without a word in the transcript.
    this.settleBackground(l, false)
    const sessionId = l.state.sessionId
    const src = await this.liveTranscript(l)
    if (!src) return
    const s = await stat(src).catch(() => null)
    if (!s) return
    this.noteTranscriptSize(l, s.size)
    // The size too: Windows can report a file's old modified time while another process keeps appending to it.
    const mtime = `${s.mtimeMs}:${s.size}`
    const backups = config.settings.sessions.backupTranscripts
    // Nothing new, and the backup (if any) has everything: nothing to do.
    if (!force && l.transcriptMtime === mtime && (!backups || l.backupMtime === mtime)) return
    if (force || l.transcriptMtime !== mtime) await this.transcriptChanged(l, projectPath, agentId, src, s.size, force)
    l.transcriptMtime = mtime
    if (!backups) return
    // While the agent works, at most once a minute (a change held back is copied at a later look); the end of each
    // turn (Stop) and the session's exit force one, so nothing is left out. Only what the transcript gained is written.
    if (!force && l.lastBackupAt && Date.now() - l.lastBackupAt < BACKUP_INTERVAL_MS) return
    try {
      await syncCopy(src, this.backupPath(projectPath, sessionId))
      l.lastBackupAt = Date.now()
      l.backupMtime = mtime
    } catch (e) {
      // Tried again at the next look, whether or not the transcript changes.
      log.warn('backup failed', e)
    }
  }

  /** What follows from the live transcript growing: status, usage, details, compaction, cost. */
  private async transcriptChanged(l: LiveSession, projectPath: string, agentId: string, src: string, size: number, force: boolean): Promise<void> {
    const sessionId = l.state.sessionId
    // Fallback if hooks never arrive: a transcript means the session is up.
    if (l.state.status === 'starting') {
      l.state.status = 'ready'
      this.emitState(l.state)
    }
    emit({ type: 'usage-changed', projectPath, sessionId })
    await this.readDetails(l, src, size)
    this.settleBackground(l, await this.readBackground(l, src, size))
    if (l.compacting) {
      // Fallback if the compaction hooks never arrive: a new compaction in the transcript.
      const u = await this.usageFor(src, sessionId, l.state.provider)
      if (u) l.compacting?.transcript(u.compactions.length)
    }
    if (l.defaultModel) {
      const usage = await this.usageFor(src, sessionId, l.state.provider)
      if (usage?.model) {
        providerService.observeDefaultModel(l.state.provider, usage.model)
        l.defaultModel = false
      }
    }
    // The estimate re-reads the whole transcript: every 30 seconds while the agent works, and at each turn's end.
    if (!l.adapter.descriptor.capabilities.reportsCost && (force || Date.now() - (l.costAt ?? 0) > COST_INTERVAL_MS)) {
      l.costAt = Date.now()
      const usage = await this.usageFor(src, sessionId, l.state.provider)
      if (usage?.costUsd != null && (usage.costUsd !== l.state.costUsd || !l.state.costEstimated)) {
        Object.assign(l.state, { costUsd: usage.costUsd, costEstimated: usage.costEstimated })
        this.emitState(l.state)
      }
    }
  }

  /** Live details from what the provider appended to its transcript since the last look (Codex). */
  private async readDetails(l: LiveSession, path: string, size: number): Promise<void> {
    if (!l.adapter.transcriptDetails) return
    const from = l.detailsOffset ?? 0
    if (size <= from) {
      if (size < from) l.detailsOffset = 0
      return
    }
    // The tail is enough: details only ever need the latest records.
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8', 0, bytesRead)
      const end = text.lastIndexOf('\n')
      if (end < 0) return
      l.detailsOffset = start + Buffer.byteLength(text.slice(0, end + 1))
      this.applyDetails(l, l.adapter.transcriptDetails(text.slice(0, end + 1)))
    } finally {
      await fh.close()
    }
  }

  /**
   * Background tasks started or ended in what the transcript gained since the last look (providers that report
   * them). Only this launch's count: tasks from before it ended with the CLI. True if one ended.
   */
  private async readBackground(l: LiveSession, path: string, size: number): Promise<boolean> {
    if (!l.adapter.backgroundTasks) return false
    const from = l.tasksOffset ?? 0
    if (size <= from) {
      if (size < from) {
        l.tasksOffset = 0
        l.tasksMemo = undefined
      }
      return false
    }
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const fh = await open(path, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      text = buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
    const end = text.lastIndexOf('\n')
    if (end < 0) return false
    l.tasksOffset = start + Buffer.byteLength(text.slice(0, end + 1))
    const since = Date.parse(l.state.startedAt) - 5000
    const tasks = (l.tasks ??= new Map())
    const ended = (l.tasksEnded ??= new Set())
    let woke = false
    for (const ev of l.adapter.backgroundTasks(text.slice(0, end + 1), (l.tasksMemo ??= {}))) {
      if (ev.at < since) continue
      if (ev.kind === 'start') {
        if (!ended.has(ev.id)) tasks.set(ev.id, { at: ev.at, expiresAt: ev.expiresAt })
        continue
      }
      if (tasks.delete(ev.id)) woke = true
      ended.add(ev.id)
      if (ended.size > 500) ended.delete(ended.values().next().value!)
    }
    return woke
  }

  /** Reads the transcript for background tasks now (at a turn's end, before choosing between finished and background). */
  private async refreshBackground(l: LiveSession): Promise<void> {
    const src = await this.liveTranscript(l).catch(() => null)
    const s = src ? await stat(src).catch(() => null) : null
    if (src && s) await this.readBackground(l, src, s.size).catch((e) => log.warn('background tasks: read failed', e))
  }

  /** Drops tasks past their expiry or the time limit and updates the count. True if the limit dropped one. */
  private sweepTasks(l: LiveSession): boolean {
    const minutes = taskMinutes()
    const dropped = l.tasks ? expireTasks(l.tasks, Date.now(), minutes) : []
    for (const id of dropped) log.info(`${userText(this.label(l.state))}: stopped counting background task ${id} after ${minutes} minutes`)
    l.state.backgroundTasks = l.tasks?.size || undefined
    return dropped.length > 0
  }

  /** The status a turn's end (or an interruption) leaves: background while tasks will start the agent again. */
  private idleStatus(l: LiveSession, idle: 'finished' | 'ready'): SessionStatus {
    return idleAfter({ backgroundWakes: l.adapter.descriptor.capabilities.backgroundWakes, tasks: l.tasks?.size ?? 0 }, idle)
  }

  /**
   * After the background tasks changed: the count, and the status of an agent whose turn has ended. When the last
   * task ends, a CLI that is told starts a new turn (working); one that runs out of time leaves the agent finished.
   */
  private settleBackground(l: LiveSession, woke: boolean): void {
    const st = l.state
    const before = st.backgroundTasks
    const dropped = this.sweepTasks(l)
    let changed = before !== st.backgroundTasks
    if (l.adapter.descriptor.capabilities.backgroundWakes) {
      if (st.status === 'background' && !l.tasks?.size) {
        if (woke) st.status = 'working'
        else {
          st.status = 'finished'
          st.statusMessage = dropped ? `Stopped counting its background tasks after ${taskMinutes()} minutes` : undefined
          st.unseen = true
          this.notify(st.projectPath, `${this.label(st)} finished`, st.statusMessage ?? 'Its background tasks have ended.', 'finished', st.agentName)
        }
        changed = true
      } else if (st.status === 'finished' && l.tasks?.size) {
        // A task the turn started, read after its end was handled.
        st.status = 'background'
        st.unseen = false
        changed = true
      }
    }
    if (changed) this.emitState(st)
  }

  /** Forgets the background tasks (the CLI moved to another conversation, or the session ended). */
  private clearTasks(l: LiveSession): void {
    l.tasks?.clear()
    l.tasksEnded?.clear()
    l.tasksOffset = 0
    l.tasksMemo = undefined
    l.state.backgroundTasks = undefined
  }

  /**
   * The running conversation's transcript size, for the footer (shown in 0.1 MB steps), and a warning once it
   * passes Settings → Sessions → Warn when a transcript is over: a long one slows the CLI and Hive, and only a
   * new conversation (a handover) makes it short again, since compacting keeps the whole history in the file.
   */
  private noteTranscriptSize(l: LiveSession, bytes: number): void {
    const st = l.state
    const step = (b: number | undefined): number => (b === undefined ? -1 : Math.floor(b / (100 * 1024)))
    const changed = step(st.transcriptBytes) !== step(bytes)
    st.transcriptBytes = bytes
    if (changed) this.emitState(st)
    const project = workspaceOf(st.projectPath).info()?.projects.find((x) => x.path.toLowerCase() === st.projectPath.toLowerCase())
    const limitMB = transcriptWarnLimit(project?.config, Number(config.settings.sessions.transcriptWarnMB) || 0)
    if (!limitMB || bytes < limitMB * 1024 * 1024 || !st.sessionId || l.sizeWarned === st.sessionId) return
    l.sizeWarned = st.sessionId
    const label = this.label(st)
    const assistant = workspace.isAssistantHome(st.projectPath)
    const advice = assistant
      ? 'Start a new conversation (⋯ → New Conversation) to keep things quick.'
      : 'Hand it over to a new conversation (Hand Over to…) to keep things quick. Compacting doesn\'t shrink the file.'
    log.info(`${userText(label)}: transcript is ${formatBytes(bytes)}, over ${limitMB} MB`)
    toast('warning', `${label}: long conversation`, `Its transcript is ${formatBytes(bytes)}, which slows down the CLI and Hive. ${advice}`, assistant ? undefined : [{ label: 'Hand Over to…', command: 'session.handOverTo', args: [st.projectPath, st.agentId] }], st.projectPath)
    this.notify(st.projectPath, `${label}: long conversation`, `Its transcript is ${formatBytes(bytes)}. ${advice}`, 'notice')
  }

  private emitState(state: LiveSessionState): void {
    // A wake-on-change watch (#128): an agent whose turn has ended waits on its cards (watching), never idle; without
    // the watch, it is just finished again (not newly: nothing to look at, nothing to notify).
    const watch = this.watchFor(state.projectPath, state.agentId)
    state.watch = watch ?? undefined
    if (watch && (state.status === 'ready' || state.status === 'finished')) {
      state.status = 'watching'
      state.unseen = false
    } else if (!watch && state.status === 'watching') state.status = 'finished'
    // Working or watching again: no longer waiting with no watch (#376).
    if (state.status !== 'ready' && state.status !== 'finished') state.notWatching = undefined
    if (this.statusSent.get(state) !== state.status) {
      this.statusSent.set(state, state.status)
      state.statusSince = new Date().toISOString()
    }
    emit({ type: 'session-status', state: { ...state } })
  }

  /** A CLI refused an agent's sign-in: told once for this expiry, with every agent it has stopped by then. */
  private signInLost(provider: ProviderId): void {
    if (this.signedOut.has(provider)) return
    const out: { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> } = {}
    this.signedOut.set(provider, out)
    out.gather = setTimeout(() => this.tellSignedOut(provider), SIGNED_OUT_GATHER_MS)
    // Agent Setup shows it signed out, and the next check that finds it signed in again ends this (providerService).
    void providerService.refresh(provider, false).catch(() => undefined)
    out.recheck = setInterval(() => {
      // Kept until it is shown signed in again: only when no agent it stopped runs any more (they exited) is there
      // nothing left to tell or carry on, and it ends quietly. An agent trying again (working) still counts.
      if (!this.liveStates().some((s) => s.provider === provider && s.signIn)) return void this.endSignedOut(provider)
      void providerService.refresh(provider, false).catch(() => undefined)
    }, SIGN_IN_RECHECK_MS)
  }

  private tellSignedOut(provider: ProviderId): void {
    const waiting = this.liveStates().filter((s) => s.provider === provider && s.status === 'signin')
    if (!waiting.length) return
    const d = providerAdapter(provider).descriptor
    const first = waiting[0]
    const title = waiting.length === 1 ? `${this.label(first)} needs you to sign in to ${d.name}` : `${waiting.length} agents need you to sign in to ${d.name}`
    log.info(`${d.name}: sign-in refused for ${waiting.length} agent(s)`)
    this.notify(first.projectPath, title, `${d.name}'s sign-in has expired. ${d.signInHelp}`, 'waiting', undefined, first.agentId)
  }

  private endSignedOut(provider: ProviderId): boolean {
    const out = this.signedOut.get(provider)
    if (!out) return false
    clearTimeout(out.gather)
    clearInterval(out.recheck)
    this.signedOut.delete(provider)
    return true
  }

  /**
   * The CLI is signed in again (an agent of it works, its check says so, its Sign in task ended well): agents it
   * stopped are idle again, and Resume (n) carries them on (they keep LiveSessionState.signIn until they do).
   */
  signedInAgain(provider: ProviderId, checked = false): void {
    if (!this.endSignedOut(provider)) return
    // Agent Setup (and its banner) learn it too, unless its own check is what said so.
    if (!checked) void providerService.refresh(provider, false).catch(() => undefined)
    const stopped = this.liveStates().filter((s) => s.provider === provider && s.status === 'signin')
    for (const st of stopped) {
      st.status = 'ready'
      st.statusMessage = SIGNED_IN_AGAIN
      this.emitState(st)
    }
    const name = providerAdapter(provider).descriptor.name
    log.info(`${name}: signed in again; ${stopped.length} agent(s) stopped meanwhile`)
    if (stopped.length) toast('info', `Signed in to ${name} again`, `${stopped.length === 1 ? `${this.label(stopped[0])} stopped` : `${stopped.length} agents stopped`} while it was signed out: Resume in the project's header carries ${stopped.length === 1 ? 'it' : 'them'} on.`, undefined, stopped[0].projectPath)
  }

  /**
   * Types a short "carry on" into an agent whose turn a refused sign-in stopped (Resume (n), #309): only while it is
   * still idle and hasn't carried on by itself.
   */
  async carryOn(projectPath: string, agentId: string): Promise<void> {
    const stalled = (): LiveSessionState | null => {
      const st = this.liveFor(projectPath, agentId)
      return st?.signIn && (st.status === 'ready' || st.status === 'finished' || st.status === 'signin') ? st : null
    }
    if (!stalled()) throw new Error('It has already carried on.')
    await this.sendPrompt(projectPath, agentId, CARRY_ON_PROMPT, () => {
      if (!stalled()) throw new Error('It carried on by itself.')
    })
  }

  /** The launch a hook call belongs to: named by its run id, else (older launch folders) by session id. */
  private findLaunch(runId: string | null, sessionId: unknown): [string, LiveSession] | null {
    if (runId) {
      const id = this.runs.get(runId)
      const l = id ? this.live.get(id) : undefined
      return id && l && !l.state.settingUp ? [id, l] : null
    }
    if (typeof sessionId !== 'string' || !sessionId) return null
    for (const e of this.live.entries()) if (e[1].state.sessionId === sessionId && !e[1].state.settingUp) return e
    return null
  }

  /** "hive" for a project with one agent, "hive · Agent 2" when it has several. */
  private label(st: LiveSessionState): string {
    if (workspace.isAssistantHome(st.projectPath)) return ASSISTANT_NAME
    const project = basename(st.projectPath)
    const count = workspaceOf(st.projectPath).info()?.projects.find((p) => p.path.toLowerCase() === st.projectPath.toLowerCase())?.agents.length ?? 1
    return count > 1 ? `${project} · ${st.agentName ?? 'Agent'}` : project
  }

  /** A provider's status report (Claude Code's status line): the session's model, effort and cost, and the plan's limits. */
  handleStatusLine(runId: string | null, body: Record<string, any>): void {
    const found = this.findLaunch(runId, body.session_id)
    if (!found?.[1].adapter.statusLine) return
    const l = found[1]
    this.applyDetails(l, l.adapter.statusLine!(body))
  }

  private applyDetails(l: LiveSession, d: ReturnType<NonNullable<ProviderAdapter['statusLine']>>): void {
    // The session's log says a turn ended on a refused sign-in (Codex, which sends no hook then): as a hook would, in
    // order with the launch's hooks.
    // A conversation's log read from its start (a resumed one) may end on an older refusal: only this launch's count.
    const refused = d.signIn && !(d.signInAt && Date.parse(d.signInAt) < Date.parse(l.state.startedAt)) ? d.signIn : null
    if (refused) {
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) === l) this.carryOut(id, l, hookStep({ kind: 'signIn', message: refused }, this.statusInput(l)), 'transcript', { kind: 'signIn', message: refused })
      })
    }
    if (d.planUsage) reportPlanUsage(l.state.provider, d.planUsage)
    const learn = l.defaultEffort
    const learnModel = d.modelId ?? learn?.model
    if (learn && d.effort && learnModel) {
      providerService.observeDefaultEffort(l.state.provider, learnModel, d.effort)
      l.defaultEffort = undefined
    }
    const st = l.state
    // Running another model than expected: its own auto-compact window, if its settings give it one (#242).
    const autoCompact = d.modelId && d.modelId !== st.modelId && l.autoCompactFor ? l.autoCompactFor(d.modelId) : st.autoCompact
    const next = { autoCompact, effort: d.effort ?? st.effort, modelName: d.modelName ?? st.modelName, modelId: d.modelId ?? st.modelId, costUsd: d.costUsd ?? st.costUsd, planMode: d.planMode ?? st.planMode, permissionMode: d.permissionMode ?? st.permissionMode, contextWindow: d.contextWindow ?? st.contextWindow }
    if (
      next.effort === st.effort &&
      next.modelName === st.modelName &&
      next.modelId === st.modelId &&
      JSON.stringify(next.autoCompact) === JSON.stringify(st.autoCompact) &&
      next.costUsd === st.costUsd &&
      next.planMode === st.planMode &&
      next.permissionMode === st.permissionMode &&
      (!d.permissionMode || d.permissionMode === st.modeObserved) &&
      next.contextWindow === st.contextWindow
    )
      return
    const windowChanged = next.contextWindow !== st.contextWindow
    Object.assign(st, next)
    if (d.permissionMode) st.modeObserved = d.permissionMode
    this.emitState(st)
    // Usage shown in the renderer carries the window: have it read again.
    if (windowChanged && st.sessionId) emit({ type: 'usage-changed', projectPath: st.projectPath, sessionId: st.sessionId })
  }

  // -------------------------------------------------------------------------
  // File locks
  // -------------------------------------------------------------------------

  private lockMode(projectPath: string): FileLockMode {
    const p = workspaceOf(projectPath).info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
    const own = p?.config.fileLocks
    return own && own !== 'inherit' ? own : config.settings.agents.fileLocks
  }

  /**
   * The reply to a hook that is about to edit files (PreToolUse). The first agent to edit a file claims
   * it; another agent's edit of the same file is then blocked, sent to the user, or allowed with a
   * warning, depending on the lock mode. Claims are released when the holder's turn ends. Returns the
   * hook's reply, or null to let the edit go ahead as usual.
   */
  preToolUse(runId: string | null, body: Record<string, any>): Record<string, unknown> | null {
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return null
    const [id, l] = found
    const hook = l.adapter.normalizeHook(body)
    if (hook.event.kind !== 'toolStart' || !hook.editedPaths.length) return null
    const mode = this.lockMode(l.state.projectPath)
    const base = typeof body.cwd === 'string' && body.cwd ? body.cwd : l.state.cwd
    const files = hook.editedPaths.map((f) => resolve(isAbsolute(f) ? f : join(base, f)))
    if (mode === 'off') return this.editAccepted(id, files, null)
    const now = Date.now()
    for (const abs of files) {
      const held = this.locks.get(lockKey(abs))
      const holder = held && held.liveId !== id ? this.live.get(held.liveId) : undefined
      if (!holder || now - held!.at >= LOCK_TTL_MS) continue
      const rel = relative(holder.state.cwd, abs) || basename(abs)
      const who = holder.state.agentName ?? 'Another agent'
      log.info(`Lock: ${userText(l.state.agentName)} → ${userText(rel)} held by ${userText(who)} (${mode})`)
      if (mode === 'warn') {
        return this.editAccepted(id, files, l.adapter.lockReply({ kind: 'warn', context: `Note: ${who} is also editing ${rel} right now. Check the file's current content before changing it, and keep your edit small.` }))
      }
      if (mode === 'ask' && !l.adapter.descriptor.capabilities.lockAsk) {
        // The CLI can't show its own approval for this, so Hive asks the user and the agent waits.
        const key = `${id}|${lockKey(abs)}`
        if (this.lockAllowed.has(key)) continue
        if (!this.lockAsked.has(key)) {
          this.lockAsked.set(key, ++this.lockSeq)
          toast('warning', `${this.label(l.state)} wants to edit ${rel}`, `${who} is editing it right now. Allow ${l.state.agentName ?? 'the agent'} to edit it too?`, [{ label: 'Allow', command: 'session.allowLockedEdit', args: [l.state.projectPath, l.state.agentId, abs] }], l.state.projectPath)
        }
        return l.adapter.lockReply({
          kind: 'deny',
          reason: `${who} is editing ${rel} right now (Hive file lock). Hive has asked the user whether you may edit it too. Stop and wait: don't work around this. When the user says go ahead, try the edit again.`
        })
      }
      const reason = `${who} is editing ${rel} right now (Hive file lock). Work on something else, or wait until ${who} has finished its task, then try again.`
      return l.adapter.lockReply({ kind: mode === 'ask' ? 'ask' : 'deny', reason })
    }
    let fresh = false
    for (const abs of files) {
      const key = lockKey(abs)
      const held = this.locks.get(key)
      if (!held || held.liveId !== id) fresh = true
      this.locks.set(key, { liveId: id, at: now, seq: ++this.lockSeq, path: abs })
    }
    if (fresh) this.publishLocks(id)
    return this.editAccepted(id, files, null)
  }

  /**
   * An edit going ahead (every file in it): the files need no go-ahead any more, whoever held them meanwhile (the
   * holder may have finished before the retry). Returns `reply`.
   */
  private editAccepted<T>(id: string, files: string[], reply: T): T {
    for (const abs of files) this.lockGoAhead.delete(`${id}|${lockKey(abs)}`)
    return reply
  }

  /**
   * "Allow" on an "Ask me" lock notification: lets the agent edit the file, and tells it to go ahead (sendGoAheads):
   * now if it is idle, else when its turn ends (the toast shows while the blocked agent is still replying, and that
   * turn's end would otherwise drop the allowance with nothing typed).
   */
  async allowLockedEdit(projectPath: string, agentId: string, path: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    const key = `${id}|${lockKey(resolve(path))}`
    this.lockAllowed.set(key, ++this.lockSeq)
    this.lockGoAhead.set(key, path)
    this.sendGoAheads(id, l)
  }

  /**
   * Types one go-ahead for the agent's allowed files, as any prompt Hive types on its own is: only while it is idle and
   * the user isn't writing in its terminal (Pause after you type), checked again until Enter, so the user's input is
   * never added to or sent. The files are allowed again for the turn it starts. Not typed, they wait: for the pause
   * to end, or the next turn's end (the user's own prompt, or a wake, went first; the files stay allowed for it).
   */
  private sendGoAheads(id: string, l: LiveSession): void {
    const { projectPath, agentId } = l.state
    const keys = [...this.lockGoAhead.keys()].filter((k) => k.startsWith(`${id}|`))
    const idle = (): boolean => l.state.status === 'ready' || l.state.status === 'finished'
    if (!keys.length || !idle() || this.live.get(id) !== l) return
    if (this.userMayBeTyping(projectPath, agentId)) return this.goAheadLater(id, l)
    const paths = keys.map((k) => this.lockGoAhead.get(k)!)
    for (const k of keys) this.lockAllowed.set(k, ++this.lockSeq)
    // This delivery's go-aheads, still wanted: an interrupt, the edit going ahead, or the session ending or moving
    // (dropGoAheads, editAccepted) cancels it, even part-way.
    const current = (): boolean => this.live.get(id) === l && keys.every((k, i) => this.lockGoAhead.get(k) === paths[i])
    const allowed = (): void => {
      if (!current()) throw new Error('The go-ahead was cancelled.')
      if (!idle()) throw new Error('The agent started working before the go-ahead was typed.')
      if (this.userMayBeTyping(projectPath, agentId)) throw new Error('The user is typing there.')
    }
    this.sendPrompt(projectPath, agentId, goAheadPrompt(l.state.cwd, paths), allowed).then(
      () => keys.forEach((k, i) => this.lockGoAhead.get(k) === paths[i] && this.lockGoAhead.delete(k)),
      (e: Error) => {
        log.info(`${userText(this.label(l.state))}: go-ahead for a locked edit put off: ${e.message}`)
        if (current() && this.userMayBeTyping(projectPath, agentId)) this.goAheadLater(id, l)
      }
    )
  }

  /** Tries the go-ahead again once the user's typing pause is over. */
  private goAheadLater(id: string, l: LiveSession): void {
    if (this.goAheadTimers.has(id)) return
    const u = this.userInput.get(this.key(l.state.projectPath, l.state.agentId))
    const wait = Math.max(500, (u?.at ?? 0) + (config.settings.assistant?.typingPause ?? 15) * 1000 - Date.now() + 200)
    this.goAheadTimers.set(
      id,
      setTimeout(() => {
        this.goAheadTimers.delete(id)
        this.sendGoAheads(id, l)
      }, wait)
    )
  }

  /**
   * Releases an agent's file locks, approvals and questions: all of them, or (`before`, a lockSeq) those from
   * before then, so a turn's end handled late keeps what the next turn has claimed since.
   */
  private releaseLocks(id: string, before = Infinity): void {
    for (const map of [this.lockAllowed, this.lockAsked]) {
      for (const [k, seq] of map) if (k.startsWith(`${id}|`) && seq <= before) map.delete(k)
    }
    // A go-ahead waits for the turn's end, so only releasing everything (the session ended or moved) drops it.
    if (before === Infinity) this.dropGoAheads(id)
    let changed = false
    for (const [k, v] of this.locks) {
      if (v.liveId === id && v.seq <= before) {
        this.locks.delete(k)
        changed = true
      }
    }
    if (changed) this.publishLocks(id)
  }

  private dropGoAheads(id: string): void {
    for (const k of this.lockGoAhead.keys()) if (k.startsWith(`${id}|`)) this.lockGoAhead.delete(k)
    clearTimeout(this.goAheadTimers.get(id))
    this.goAheadTimers.delete(id)
  }

  private publishLocks(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    const files: string[] = []
    for (const v of this.locks.values()) if (v.liveId === id) files.push(relative(l.state.cwd, v.path).replace(/\\/g, '/'))
    l.state.lockedFiles = files.length ? files : undefined
    this.emitState(l.state)
  }

  /** Each launch's hooks (and its title's changes: watchTitle), handled one at a time in the order they came. */
  private hookQueues = new Map<string, Promise<void>>()

  /**
   * Handles a hook call from an agent's CLI (already answered; see preToolUse). One launch's hooks run in
   * order: an older one that awaits (recording the session) must not land after a newer one's status.
   */
  handleHook(runId: string | null, body: Record<string, any>): Promise<void> {
    // A turn's end releases only the locks claimed before it arrived: PreToolUse claims them at once, outside this queue.
    const arrived = this.lockSeq
    return this.inHookOrder(runId ?? `session:${String(body.session_id ?? '')}`, () => this.handleHookNow(runId, body, arrived))
  }

  /** Runs `fn` after what is queued for the launch (its hooks, its title), in the order they came. */
  private inHookOrder(key: string, fn: () => Promise<void> | void): Promise<void> {
    const run = (this.hookQueues.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => undefined)
    this.hookQueues.set(key, tail)
    void tail.then(() => {
      if (this.hookQueues.get(key) === tail) this.hookQueues.delete(key)
    })
    return run
  }

  private async handleHookNow(runId: string | null, body: Record<string, any>, arrived: number): Promise<void> {
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return
    const [id, l] = found
    const st = l.state
    const hook = l.adapter.normalizeHook(body)
    const label = this.label(st)
    // The user started or opened another conversation in the CLI (/clear, /new, /resume): follow it. Only a
    // prompt switches, since helpers the CLI runs for itself (subagents) can report other session ids.
    if (hook.event.kind === 'prompt' && st.sessionId && hook.sessionId && hook.sessionId !== st.sessionId && isSessionId(hook.sessionId)) {
      await this.switchSession(l, hook.sessionId, hook.transcriptPath)
    } else if (hook.transcriptPath && hook.transcriptPath !== l.transcriptPath) l.transcriptPath = hook.transcriptPath
    // Providers that choose their own session id report it here (the first hook of the launch).
    if (!st.sessionId && hook.sessionId) {
      try {
        st.sessionId = assertSessionId(hook.sessionId)
        const { agent } = await this.agentDef(st.projectPath, st.agentId)
        await this.recordSession(st.projectPath, agent, l)
        this.emitState(st)
        workspaceOf(st.projectPath).scheduleRefresh()
      } catch (e) {
        log.warn(`${userText(label)}: could not record session ${hook.sessionId}`, e)
      }
    }
    if (hook.mode && (hook.mode !== st.permissionMode || hook.mode !== st.modeObserved)) {
      st.permissionMode = st.modeObserved = hook.mode
      this.emitState(st)
    }
    const ev = hook.event
    // Hooks are handled in order, so the next one waits for this read: a turn's end counts the tasks it started.
    if (ev.kind === 'stop') {
      await this.refreshBackground(l)
      this.sweepTasks(l)
    }
    this.carryOut(id, l, hookStep(ev, this.statusInput(l)), String(body.hook_event_name ?? ''), ev, arrived)
  }

  /** What the status rules need to know of a running agent. */
  private statusInput(l: LiveSession): HookStatusInput {
    const st = l.state
    return {
      status: st.status,
      statusMessage: st.statusMessage,
      askedAtStart: !!l.askedAtStart,
      compacting: l.compacting ? (l.compacting.started ? 'started' : 'requested') : null,
      backgroundWakes: l.adapter.descriptor.capabilities.backgroundWakes,
      tasks: l.tasks?.size ?? 0,
      attention: l.titleAttention ? 'title' : 'hooks',
      reviewed: !!l.adapter.descriptor.permissionModes.find((m) => m.value === st.permissionMode)?.reviewed,
      titleAsks: !!l.titleAsks,
      open: l.open ?? [],
      waitingOn: l.waitingOn ?? null,
      question: !!st.question,
      reviewing: !!st.review
    }
  }

  /**
   * Carries out a status step (from a hook, or the CLI's title: `cause` says which, for the log): its actions,
   * then its status, message and question.
   */
  private carryOut(id: string, l: LiveSession, step: HookStep, cause: string, ev: HookEvent | null = null, arrived = this.lockSeq): void {
    const st = l.state
    const label = this.label(st)
    // A request that worked (a tool call, a turn that ended well). Not a prompt (sent, not yet answered), an interrupt
    // or a turn that failed on something else (a rate limit): none of those shows the CLI is signed in.
    const worked = ev?.kind === 'toolStart' || ev?.kind === 'toolEnd' || (ev?.kind === 'stop' && !ev.failed)
    // An agent a refused sign-in stopped tries again (its own prompt, Resume's) and doesn't get through (interrupted, or
    // failed on something else) while the sign-in is still expired: it needs sign-in again, not told as finished.
    if (st.signIn && this.signedOut.has(st.provider) && (ev?.kind === 'interrupt' || (ev?.kind === 'stop' && ev.failed)))
      step = { ...step, next: 'signin', message: null, actions: step.actions.filter((a) => a !== 'notifyFinished') }
    if (step.open !== undefined) l.open = step.open
    if (step.waitingOn !== undefined) l.waitingOn = step.waitingOn
    for (const action of step.actions) {
      switch (action) {
        case 'answered':
          this.startupAnswered(l)
          break
        case 'prompted':
          l.prompts = (l.prompts ?? 0) + 1
          if (workspace.isAssistantHome(st.projectPath)) this.onAssistantPrompt(st.projectPath)
          break
        case 'compactBegan':
          l.compacting?.begin()
          break
        case 'compactEnded':
          l.compacting?.end()
          l.compacting = undefined
          break
        case 'autoCompact':
          // Compaction Hive started is already shown as "Compacting…".
          toast('info', `${label}: compacting conversation`, `${l.adapter.descriptor.name} is summarising the context to free up space.`, undefined, st.projectPath)
          break
        case 'notifyWaiting':
          this.notify(st.projectPath, `${label} needs your input`, step.message || 'Waiting for your input', 'waiting', undefined, st.agentId)
          break
        case 'notifyQuestion':
          this.notify(st.projectPath, `${label} has a question for you`, step.question || 'It carries on working meanwhile.', 'waiting', undefined, st.agentId)
          break
        case 'notifyFinished':
          // Watching its cards isn't finished: nothing for the user to look at.
          if (this.watchFor(st.projectPath, st.agentId)) break
          this.notify(st.projectPath, `${label} finished`, (ev?.kind === 'stop' && ev.lastMessage?.slice(0, 180)) || 'The agent has finished its task.', 'finished', st.agentName)
          break
        case 'releaseLocks':
          this.releaseLocks(id, arrived)
          break
        case 'releaseAllLocks':
          this.releaseLocks(id)
          break
        case 'clearTasks':
          this.clearTasks(l)
          break
        case 'signedOut':
          st.signIn = { message: (ev?.kind === 'signIn' && ev.message?.slice(0, 500)) || `${l.adapter.descriptor.name} isn't signed in.`, since: new Date().toISOString() }
          this.signInLost(st.provider)
          break
        case 'turnEnded':
          // Not awaited: a prompt arriving meanwhile must not be overwritten by this older Stop.
          if (st.sessionId) void workspace.upsertSession(st.projectPath, { id: st.sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
          void this.backup(st.projectPath, st.agentId, true)
          break
      }
    }
    // An agent stopped by a refused sign-in has carried on once a request of its own works (it keeps its mark through a
    // retry that doesn't, so Resume (n) still counts it).
    const carriedOn = !!st.signIn && worked
    if (carriedOn) st.signIn = undefined
    const needed = asksYou(st)
    // A turn's end is reported even when the status stays (its background task count may have changed).
    if (applyStep(st, step) || step.actions.includes('turnEnded') || carriedOn) this.emitState(st)
    // The CLI is signed in again, for its other agents too (this one's status is already set).
    if (worked) this.signedInAgain(st.provider)
    // A turn's end types the go-ahead for an Allow given during it; an interrupt (the user stopping it) drops it.
    if (step.actions.includes('turnEnded')) this.sendGoAheads(id, l)
    else if (step.actions.includes('releaseLocks')) this.dropGoAheads(id)
    // Why you were told an agent needs you, and when it no longer does (Help → Copy Diagnostics): never what was asked.
    const told = step.actions.includes('notifyWaiting') ? 'waits for you' : step.actions.includes('notifyQuestion') ? 'asks a question' : needed && !asksYou(st) ? 'no longer needs you' : null
    if (told) log.debug(`${userText(label)}: ${told} (${cause})`)
  }

  /** Moves a running agent to the conversation the CLI switched to: the old one is backed up, the new one recorded. */
  private async switchSession(l: LiveSession, sessionId: string, transcriptPath: string | null): Promise<void> {
    const st = l.state
    const old = st.sessionId
    await this.backup(st.projectPath, st.agentId, true).catch(() => undefined)
    await workspace.upsertSession(st.projectPath, { id: old, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
    log.info(`${userText(this.label(st))}: the CLI moved from session ${old} to ${sessionId}`)
    try {
      const { agent, count } = await this.agentDef(st.projectPath, st.agentId)
      const existing = (await workspace.sessionsFile(st.projectPath)).sessions.find((s) => s.id === sessionId)
      st.sessionId = sessionId
      l.name = existing?.name || autoName(st.projectPath, agent, count)
      st.sessionName = l.name
      st.titleAtRename = existing?.titleAtRename
      l.transcriptPath = transcriptPath ?? existing?.transcriptPath
      l.transcriptMtime = ''
      l.detailsOffset = 0
      st.transcriptBytes = undefined
      this.clearTasks(l)
      l.lastBackupAt = undefined
      st.costUsd = undefined
      st.costEstimated = undefined
      this.releaseLocks(liveId(st.projectPath, st.agentId))
      await this.recordSession(st.projectPath, agent, l)
    } catch (e) {
      log.warn(`${userText(this.label(st))}: could not record session ${sessionId}`, e)
    }
    this.emitState(st)
    workspaceOf(st.projectPath).scheduleRefresh()
  }

  /**
   * Tells the user (and for finished/waiting, the chime): a banner in the Hive window they are using, else a Windows
   * notification (route()). A notice is a warning that needs no sound.
   */
  private notify(projectPath: string, title: string, body: string, kind: 'finished' | 'waiting' | 'notice', agentName?: string, agentId?: string): void {
    if (kind !== 'notice') {
      // The window plays at most one chime every 2 seconds, so agents finishing together chime once.
      void this.effective(projectPath)
        .then((eff) => {
          if (!eff.chime) return
          // A quiet test copy records the chime and the window counts it without playing a sound.
          testNotifyLog({ kind: 'chime', projectPath })
          emit({ type: 'chime', projectPath, ...(testQuiet() ? { silent: true } : {}) })
        })
        .catch((e) => log.warn('chime: settings unavailable', e))
    }
    if (this.route(projectPath, kind) === 'none') return
    // Finishes that come together are told in one notice ("3 agents finished in hive"); a question is told at once.
    if (kind === 'finished') {
      const assistant = workspace.isAssistantHome(projectPath)
      this.finishes.add({ projectPath, project: assistant ? ASSISTANT_NAME : basename(projectPath), agent: assistant ? ASSISTANT_NAME : (agentName ?? 'Agent'), title, body })
      return
    }
    this.deliver(projectPath, title, body, kind, agentId)
  }

  /** Where a notice about this project goes now: the settings, and the Hive window the user is using (noticeRoute). */
  private route(projectPath: string, kind: 'finished' | 'waiting' | 'notice'): NoticeRoute {
    return noticeRoute(config.settings.notifications, kind, this.focusedHive(), { workspacePath: workspaceOf(projectPath)?.path ?? null, projectPath })
  }

  /** A banner in the focused window, or a Windows notification, as route() says now. */
  private deliver(projectPath: string, title: string, body: string, kind: 'finished' | 'waiting' | 'notice', agentId?: string): void {
    const route = this.route(projectPath, kind)
    if (route === 'windows') return this.showNotification(projectPath, title, body)
    const at = this.focusedHive()
    if (route !== 'banner' || !at) return
    emitTo(at.win, { type: 'notice', notice: { id: randomUUID(), kind, title, body, projectPath, ...(agentId ? { agentId } : {}) } })
  }

  /**
   * Finishes collected by `finishes`, in one notice: those that may still be told (notifications turned off
   * meanwhile, or left out by the banner scope), counted and opened from what is left, as a banner or a Windows
   * notification as things are when it is shown.
   */
  private readonly finishes = new FinishBatcher((all) => {
    const items = all.filter((i) => this.route(i.projectPath, 'finished') !== 'none')
    if (!items.length) return
    const { title, body } = finishedNotice(items)
    this.deliver(items[0].projectPath, title, body, 'finished')
  })

  /** A Windows notification; clicking it shows the project (the first one's, for finishes in several). */
  private showNotification(projectPath: string, title: string, body: string): void {
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, silent: true, icon: notificationIcon() })
    // Keep a reference: a garbage-collected Notification no longer delivers its click.
    shownNotifications.add(note)
    if (shownNotifications.size > 50) shownNotifications.delete(shownNotifications.values().next().value!)
    note.on('click', () => {
      shownNotifications.delete(note)
      const w = this.getWindow(projectPath)
      if (w) {
        presentWindow(w)
        emitTo(w, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
      }
    })
    if (!showOsNotification(note, title, body)) shownNotifications.delete(note)
  }

  /** The window showed these agents (all of the project's when none are named). */
  markSeen(projectPath: string, agentIds?: string[]): void {
    for (const st of this.projectStates(projectPath)) {
      if (st.unseen && (!agentIds || agentIds.includes(st.agentId))) {
        st.unseen = false
        this.emitState(st)
      }
    }
  }

  /** A transcript's usage, read incrementally. Reads of one transcript take turns, so no line is fed twice. */
  private usageFor(path: string, sessionId: string, provider: ProviderId): Promise<SessionUsage | null> {
    return withFileLock(`${path}#usage`, () => this.usageForNow(path, sessionId, provider))
  }

  private async usageForNow(path: string, sessionId: string, provider: ProviderId): Promise<SessionUsage | null> {
    try {
      await this.loadUsageCache()
      const s = await stat(path)
      let c = usageCache.get(path)
      // Most recently used last: the oldest go first when there are too many.
      if (c) {
        usageCache.delete(path)
        usageCache.set(path, c)
      }
      if (c && c.mtime === s.mtimeMs && c.size === s.size && c.sessionId === sessionId && c.provider === provider) {
        if (c.usage) return c.usage
        // Unchanged since it was read (in this run, or one before: usage-cache.json): priced again, not read.
        if (c.raw) return (c.usage = this.priced(c.raw))
      }
      // A file that shrank or was rewritten (or is now another session's), or whose parser was dropped, is read again from the start.
      if (c && (!c.parser || c.sessionId !== sessionId || c.provider !== provider || s.size < c.offset || (s.size === c.size && s.mtimeMs !== c.mtime))) c = undefined
      if (!c) {
        c = { parser: providerAdapter(provider).usageParser(sessionId), sessionId, provider, offset: 0, size: 0, mtime: 0, raw: null, usage: null }
        usageCache.set(path, c)
        trimUsageCache()
      }
      const parser = c.parser!
      if (s.size > c.offset) {
        const fh = await open(path, 'r')
        try {
          // In pieces, so a long transcript read for the first time doesn't take its whole size in memory at once.
          let chunk = USAGE_CHUNK
          while (c.offset < s.size) {
            const buf = Buffer.alloc(Math.min(chunk, s.size - c.offset))
            const { bytesRead } = await fh.read(buf, 0, buf.length, c.offset)
            // Whole lines only: a line still being written is read next time.
            const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
            if (end < 0) {
              // One line longer than the piece (a large image or tool output): read a bigger piece.
              if (bytesRead === buf.length && c.offset + bytesRead < s.size) {
                chunk *= 2
                continue
              }
              break
            }
            parser.feed(buf.subarray(0, end + 1).toString('utf8'))
            c.offset += end + 1
            if (bytesRead < buf.length) break
          }
        } finally {
          await fh.close()
        }
      }
      c.size = s.size
      c.mtime = s.mtimeMs
      c.raw = parser.result()
      this.checkUnderstood(provider, c.raw, s.size)
      c.usage = this.priced(c.raw)
      this.scheduleUsageSave()
      return c.usage
    } catch {
      return null
    }
  }

  /** Providers and versions already warned about (see checkUnderstood). */
  private warnedFormats = new Set<string>()

  /**
   * A large transcript in which Hive found no requests at all most likely means the CLI changed its
   * format: say so once per provider version, rather than quietly showing zeros.
   */
  private checkUnderstood(provider: ProviderId, usage: SessionUsage, size: number): void {
    if (usage.requests > 0 || size < 200_000) return
    const key = `${provider}|${usage.cliVersion ?? '?'}`
    if (this.warnedFormats.has(key)) return
    this.warnedFormats.add(key)
    const name = providerDescriptor(provider).name
    log.warn(`${name} ${usage.cliVersion ?? ''}: a ${Math.round(size / 1024)} KB transcript showed no usage (${usage.sessionId})`)
    toast('warning', `Hive may not fully understand this ${name} version`, `A ${name}${usage.cliVersion ? ` ${usage.cliVersion}` : ''} session with activity showed no token use, so the Overview and costs may be incomplete. A Hive update will fix it.`)
  }

  /**
   * Saves an image for the running session under <project>/.hive/images/<sessionId> and returns
   * its path, which is pasted into the terminal so the transcript records which image was sent.
   * Takes the clipboard image when no source file is given; returns null if there is none.
   */
  async saveImage(projectPath: string, sourceFile?: string, agentId?: string): Promise<string | null> {
    projectPath = workspace.assertSessionHost(projectPath)
    agentId ||= await this.soleAgent(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) throw new Error('No session is running for this agent.')
    let png: Buffer | null = null
    // A file given by the window (a drop, Insert into Session) must be an image, from the workspace or pasted/dropped from outside it.
    if (sourceFile && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(sourceFile)) throw new Error('Only images can be added to a session this way.')
    if (!sourceFile) {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return null
      png = Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())
    }
    // Until the provider reports the session id, images go in a folder named after the launch.
    const dir = join(projectPath, HIVE_DIR, 'images', l.state.sessionId || `run-${l.state.runId}`)
    await mkdir(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    const ext = sourceFile ? extname(sourceFile).toLowerCase() : '.png'
    let dest = join(dir, `${stamp}${ext}`)
    for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stamp}-${i}${ext}`)
    if (png) await writeFile(dest, png)
    else await copyFile(sourceFile!, dest)
    return dest
  }

  /** The provider's transcript, or Hive's backup (active or archived) when the provider no longer has it. */
  async anyTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<string | null> {
    const t = await this.providerTranscript(projectPath, sessionId, ctx)
    if (t) return t.path
    for (const archived of [false, true]) {
      const b = this.backupPath(projectPath, sessionId, archived)
      if (existsSync(b)) return b
    }
    return null
  }

  /** The provider a session of this project belongs to. */
  async sessionProvider(projectPath: string, sessionId: string, ctx?: ListContext): Promise<ProviderId> {
    const rec = (ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions).find((s) => s.id === sessionId)
    if (rec) return recordProvider(rec)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    if (live) return live.provider
    return (await this.providerTranscript(projectPath, sessionId, ctx))?.provider ?? 'claude-code'
  }

  async usage(projectPath: string, sessionId: string, ctx?: ListContext): Promise<SessionUsage | null> {
    assertSessionId(sessionId)
    const p = await this.anyTranscript(projectPath, sessionId, ctx)
    // No transcript left: what it used when Clean Up removed Hive's backup.
    if (!p) return (ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions).find((s) => s.id === sessionId)?.keptUsage ?? null
    const usage = await this.usageFor(p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx))
    // A transcript without the context window (Claude Code's): the running session's status line has it.
    if (usage && !usage.contextWindow) {
      const window = [...this.live.values()].find((l) => l.state.sessionId === sessionId)?.state.contextWindow
      if (window) return { ...usage, contextWindow: window }
    }
    return usage
  }

  async list(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    // Read once for the whole list, not once per session.
    const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath) }
    const ttl = config.settings.sessions.cacheTtl
    const items: SessionListItem[] = []
    // Deleted sessions stay hidden, though the CLI still has their transcripts.
    const known = new Set([...file.sessions.map((s) => s.id), ...(file.deleted ?? [])])
    // Records from before sub-sessions were told apart (a guardian review adopted then): found now, and kept on them.
    const found = new Map<string, SubSession>()
    for (const rec of file.sessions) {
      const provider = recordProvider(rec)
      let hasTranscript = false
      try {
        hasTranscript = !!(await providerAdapter(provider).transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath))
      } catch {
        // A provider this version doesn't know.
      }
      const hasBackup = existsSync(this.backupPath(projectPath, rec.id)) || existsSync(this.backupPath(projectPath, rec.id, true))
      const usage = await this.usage(projectPath, rec.id, ctx)
      const { keptUsage: _kept, ...fields } = rec
      const sub = rec.sub ?? (await this.recordSub(projectPath, rec))
      if (sub && !rec.sub) found.set(rec.id, sub)
      items.push({
        ...fields,
        ...(sub ? { sub } : {}),
        provider,
        source: 'hive',
        title: usage?.title ?? null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript,
        hasBackup,
        usage,
        recache: usage && providerDescriptor(provider).capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null
      })
    }
    if (found.size) await this.keepSubs(projectPath, found)
    // Sessions started outside Hive in the project folder; and from the other folders its sessions ran in (agents'
    // worktrees, the Assistant's workspace folder), only the sub-sessions of sessions listed here.
    const folders = this.sessionFolders(projectPath, file.sessions, ctx.cfg)
    for (const adapter of allProviders()) {
      for (const [i, folder] of folders.entries()) {
        for (const ext of await adapter.listSessions(folder).catch(() => [])) {
          if (known.has(ext.id) || (i > 0 && !(ext.sub?.parentId && items.some((x) => x.id === ext.sub!.parentId)))) continue
          known.add(ext.id)
          const usage = await this.usageFor(ext.transcriptPath, ext.id, adapter.id)
          if (!usage || usage.requests === 0) continue
          items.push({
            id: ext.id,
            provider: adapter.id,
            source: 'external',
            title: usage.title,
            lastActivity: usage.lastActivity ?? ext.modified,
            hasTranscript: true,
            hasBackup: false,
            usage,
            recache: adapter.descriptor.capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null,
            ...(ext.sub ? { sub: ext.sub } : {})
          })
        }
      }
    }
    return items.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  }

  /**
   * The folders a session host's sessions run in: the project folder first, then its agents' worktrees and the folders
   * its sessions recorded (the Assistant's: the workspace folder), each once.
   */
  private sessionFolders(projectPath: string, records: SessionRecord[], cfg: ProjectConfig): string[] {
    const out = new Map<string, string>([[resolve(projectPath).toLowerCase(), projectPath]])
    const add = (f: string | null | undefined): void => {
      if (f && !out.has(resolve(f).toLowerCase())) out.set(resolve(f).toLowerCase(), f)
    }
    if (workspace.isAssistantHome(projectPath)) add(workspaceOf(projectPath).path)
    for (const a of projectAgents(cfg)) add(a.worktree?.path)
    for (const r of records) add(r.cwd)
    return [...out.values()]
  }

  /** Whether one of Hive's records is a sub-session, from its transcript's first line (the CLI's, else Hive's copy). */
  private async recordSub(projectPath: string, rec: SessionRecord): Promise<SubSession | null> {
    if (rec.sub) return rec.sub
    try {
      const adapter = providerAdapter(recordProvider(rec))
      const path = (await adapter.transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath).catch(() => null)) ?? this.backupFiles(projectPath, rec.id)[0]
      return path ? await adapter.subSessionOf(path, rec.id) : null
    } catch {
      return null
    }
  }

  /** Keeps sub-sessions found on their records, so resume targets (liveInfo) never pick one. */
  private async keepSubs(projectPath: string, found: Map<string, SubSession>): Promise<void> {
    await workspace
      .mutateSessions(projectPath, (f) => {
        for (const r of f.sessions) if (!r.sub && found.has(r.id)) r.sub = found.get(r.id)
      })
      .catch((e) => log.warn(`Keeping sub-sessions in ${userText(projectPath)}`, e))
  }

  /** Projects whose records were checked for sub-sessions this run (once each: liveInfo asks often). */
  private subsChecked = new Set<string>()

  /** Checks a project's records for sub-sessions once per run, in the background, and keeps what it finds. */
  private checkSubsOnce(projectPath: string, records: SessionRecord[]): void {
    const k = projectPath.toLowerCase()
    if (this.subsChecked.has(k)) return
    this.subsChecked.add(k)
    void (async () => {
      const found = new Map<string, SubSession>()
      for (const r of records) {
        if (r.sub) continue
        const sub = await this.recordSub(projectPath, r)
        if (sub) found.set(r.id, sub)
      }
      if (!found.size) return
      await this.keepSubs(projectPath, found)
      workspaceOf(projectPath).scheduleRefresh()
    })().catch((e) => log.warn(`Checking ${userText(projectPath)}'s sessions for sub-sessions`, e))
  }

  /**
   * Archives or unarchives one of Hive's sessions (its backup moves to or from .hive/archive), all or nothing: with the
   * session reserved (nothing reads, resumes or moves it meanwhile) and nothing having it in use (assertFree), the new
   * archive is built aside, then each copy is moved; a failure at any step (a copy another program holds, the record
   * not saved) moves everything back, and the record changes only once the files have.
   */
  async archive(projectPath: string, sessionId: string, archived: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    if (!(await workspace.sessionsFile(projectPath)).sessions.some((s) => s.id === sessionId)) throw new Error('Only sessions Hive keeps can be archived: adopt it first.')
    const action = archived ? 'archive' : 'unarchive'
    const active = this.backupPath(projectPath, sessionId)
    const arch = this.backupPath(projectPath, sessionId, true)
    await this.whileReserved(projectPath, sessionId, async () => {
      await this.assertFree(projectPath, sessionId, action)
      await mkdir(dirname(arch), { recursive: true })
      await mkdir(dirname(active), { recursive: true })
      const src = archived ? await this.providerTranscript(projectPath, sessionId) : null
      // Both copies locked (always the archive's first), so no backup or other move runs into the middle of this one.
      await withFileLock(arch, () =>
        withFileLock(active, async () => {
          this.assertNotLive(sessionId, action)
          const moves = new Moves()
          // The archive, built aside: the backup brought up to date from the CLI's transcript, so it is complete.
          const fresh = src ? `${arch}.archiving` : null
          try {
            if (fresh && src) {
              await rm(fresh, { force: true })
              if (existsSync(active)) await inUseOnFail(() => copyFile(active, fresh))
              await inUseOnFail(() => syncCopyLocked(src.path, fresh))
            }
            if (archived) {
              if (existsSync(arch)) await moves.move(arch, `${arch}.previous`)
              if (fresh) {
                await moves.move(fresh, arch)
                if (existsSync(active)) await moves.move(active, `${active}.archived`)
              } else if (existsSync(active)) await moves.move(active, arch)
            } else if (existsSync(arch)) {
              if (existsSync(active)) await moves.move(active, `${active}.previous`)
              await moves.move(arch, active)
            }
            await workspace.upsertSession(projectPath, { id: sessionId, archived })
          } catch (e) {
            await moves.undo()
            if (fresh) await rm(fresh, { force: true }).catch(() => undefined)
            throw e
          }
          // Done: what was set aside is superseded (the archive holds all of it).
          await moves.discardAside()
        })
      )
    })
  }

  /** The session is running, or an agent is starting on it, in any project and window. */
  liveAnywhere(sessionId: string): boolean {
    const id = sessionId.toLowerCase()
    return [...this.live.values()].some((l) => l.state.sessionId?.toLowerCase() === id) || [...this.starting.values()].some((p) => p.resumeId?.toLowerCase() === id)
  }

  private assertNotLive(sessionId: string, action: string): void {
    if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', `Stop the session before you ${action} it.`)
  }

  /** When Hive saw each session's CLI exit (its own sessions): their transcripts are finished. At most 500, the oldest go. */
  private exitedAt = new Map<string, number>()

  private noteExit(sessionId: string | undefined): void {
    if (!sessionId) return
    this.exitedAt.delete(sessionId)
    this.exitedAt.set(sessionId, Date.now())
    if (this.exitedAt.size > 500) this.exitedAt.delete(this.exitedAt.keys().next().value!)
  }

  /**
   * Why a session's files can't be archived or deleted now, or null. Run with the session reserved, so no read,
   * resume or other move can start after it: it is running or starting (in any window); Hive is reading its transcript
   * (a search, an export, the viewer loading it); its transcript is open in a Sessions view, in any window (the window
   * asking closes its own first, and says so); another program holds the CLI's transcript open (checked by opening it to
   * read, never changing it); or (`writing`) its CLI is still writing it: changed in the last SESSION_WRITING_MS and
   * not since Hive saw that CLI exit (a session started outside Hive, or a Codex guardian review, still going). A copy
   * of Hive's another program holds is found when it is moved (inUseOnFail).
   */
  private async inUse(projectPath: string, sessionId: string, opts: { writing: boolean }): Promise<SessionInUse | null> {
    if (this.liveAnywhere(sessionId)) return new SessionInUse('live', 'It is running. Stop it first.')
    if (beingRead(projectPath, sessionId)) return new SessionInUse('reading', 'Hive is reading its transcript (an export or a search). Try again in a moment.')
    if (viewingWindows(projectPath, sessionId).length) return new SessionInUse('open', 'Its transcript is open in Hive. Close it, then try again.')
    const t = await this.providerTranscript(projectPath, sessionId).catch(() => null)
    if (!t) return null
    if (await heldOpen(t.path)) return new SessionInUse('in-use', 'Another program has its transcript open. Close it, then try again.')
    if (!opts.writing) return null
    const s = await stat(t.path).catch(() => null)
    if (s && Date.now() - s.mtimeMs < SESSION_WRITING_MS && !((this.exitedAt.get(sessionId) ?? 0) >= s.mtimeMs)) {
      return new SessionInUse('in-use', 'Its CLI is still writing its transcript. Try again in a moment.')
    }
    return null
  }

  private async assertFree(projectPath: string, sessionId: string, action: string): Promise<void> {
    // Unarchiving moves only Hive's copy back: the CLI still writing its own transcript doesn't matter to it.
    const why = await this.inUse(projectPath, sessionId, { writing: action !== 'unarchive' })
    if (why?.reason === 'live') throw new SessionInUse('live', `Stop the session before you ${action} it.`)
    if (why) throw why
  }

  /**
   * Archives, unarchives or deletes several sessions (a branch of the Sessions tab). Each is all or nothing, with the
   * same checks as one at a time; those in use, running, open in another window or started outside Hive (nothing of
   * Hive's to archive) are skipped and listed with why. The CLIs' own transcripts are never touched.
   */
  async bulk(projectPath: string, action: SessionBulkAction, sessionIds: string[]): Promise<SessionBulkResult> {
    projectPath = workspace.assertSessionHost(projectPath)
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') throw new Error(`Unknown action: ${String(action)}`)
    if (!Array.isArray(sessionIds)) throw new Error('sessionIds: a list of session ids')
    const out: SessionBulkResult = { done: [], skipped: [] }
    for (const id of [...new Set(sessionIds)]) {
      if (!isSessionId(id)) {
        out.skipped.push({ id: String(id), reason: 'failed', message: 'Not a session id.' })
        continue
      }
      try {
        if (action === 'delete') await this.deleteOne(projectPath, id)
        else if (!(await workspace.sessionsFile(projectPath)).sessions.some((s) => s.id === id)) {
          out.skipped.push({ id, reason: 'external' })
          continue
        } else await this.archive(projectPath, id, action === 'archive')
        out.done.push(id)
      } catch (e) {
        out.skipped.push(e instanceof SessionInUse ? { id, reason: e.reason } : { id, reason: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    }
    log.info(`Sessions: ${action} ${out.done.length}, skipped ${out.skipped.length} (${[...new Set(out.skipped.map((s) => s.reason))].join(', ') || 'none'}) in ${userText(projectPath)}`)
    workspaceOf(projectPath).scheduleRefresh()
    return out
  }

  /** Hive's copies of a session's transcript that exist (the active backup, the archived one). */
  backupFiles(projectPath: string, sessionId: string): string[] {
    return [false, true].map((archived) => this.backupPath(projectPath, sessionId, archived)).filter((b) => existsSync(b))
  }

  /**
   * Sessions reserved while their files move (`project|id`, lower-cased): Clean Up… removing them, or an archive or
   * delete. None of them starts, resumes or has its transcript read meanwhile.
   */
  private cleaning = new Set<string>()

  /** Archiving, deleting or Clean Up has the session's files (transcripts aren't read meanwhile). */
  reserved(projectPath: string, sessionId: string): boolean {
    return this.cleaning.has(`${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`)
  }

  /** The session is running, or an agent is starting on it. */
  private sessionOpen(projectPath: string, sessionId: string): boolean {
    const id = sessionId.toLowerCase()
    return this.projectStates(projectPath).some((s) => s.sessionId.toLowerCase() === id) || [...this.starting.values()].some((p) => p.projectPath.toLowerCase() === projectPath.toLowerCase() && p.resumeId?.toLowerCase() === id)
  }

  /**
   * Runs fn (Clean Up… removing a session's files, or its image folder) with the session reserved: it isn't running
   * or starting now, and start() refuses to resume it until fn is done, so no session crosses the removal.
   */
  async whileCleaning<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const k = `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`
    if (this.cleaning.has(k)) throw new Error("Clean Up is already removing this session's files.")
    if (this.sessionOpen(projectPath, sessionId)) throw new Error('The session is running.')
    this.cleaning.add(k)
    try {
      return await fn()
    } finally {
      this.cleaning.delete(k)
    }
  }

  /**
   * Runs fn with the session reserved and not running (in any window): removing its images. Nothing resumes it, or
   * archives or deletes it, until fn is done, so it can't start pasting while its images go.
   */
  whileStopped<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.whileReserved(projectPath, sessionId, async () => {
      if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', 'It is running, and may paste more images. Stop it first.')
      return fn()
    })
  }

  /** Runs fn (an archive or delete) with the session reserved, as whileCleaning; one already reserved is in use. */
  private async whileReserved<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const k = `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`
    if (this.cleaning.has(k)) throw new SessionInUse('in-use', 'Hive is already archiving, deleting or cleaning up this session.')
    this.cleaning.add(k)
    try {
      return await fn()
    } finally {
      this.cleaning.delete(k)
    }
  }

  /** Runs fn with both of a session's backups locked (the archive's first, as archive() does), so no backup or move runs into it. */
  private withBackupsLocked<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.backupPath(projectPath, sessionId, true), () => withFileLock(this.backupPath(projectPath, sessionId), fn))
  }

  /**
   * For Clean Up…, with the session's backups locked: it is still archived and not running, and `expected` (what the
   * preview listed) are exactly its copies. Otherwise it changed since the preview and nothing of it goes.
   */
  private async assertCleanable(projectPath: string, sessionId: string, expected: string[]): Promise<void> {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    if (!rec?.archived) throw new Error('The session is no longer archived.')
    if (this.sessionOpen(projectPath, sessionId)) throw new Error('The session is running.')
    const want = new Set(expected.map((e) => e.toLowerCase()))
    const has = this.backupFiles(projectPath, sessionId).map((b) => b.toLowerCase())
    if (has.length !== want.size || !has.every((b) => want.has(b))) throw new Error("The session's copies changed since the preview.")
  }

  /**
   * Moves Hive's backups of an archived session the CLI still has to the Recycle Bin (Clean Up…), keeping what it
   * used on its record so totals still count it once the CLI's transcript goes too. `expected` is what the preview
   * listed. Nothing goes unless the session is unchanged since (assertCleanable, again right before the files go) and
   * what it used was read and saved; the session can't be resumed meanwhile (whileCleaning).
   */
  async removeBackups(projectPath: string, sessionId: string, expected: string[]): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    await this.whileCleaning(projectPath, sessionId, () =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        await this.assertCleanable(projectPath, sessionId, expected)
        if (!(await this.providerTranscript(projectPath, sessionId))) throw new Error("The CLI no longer has this session's transcript.")
        const used = await this.usage(projectPath, sessionId).catch(() => null)
        if (!used) throw new Error("Hive couldn't read what the session used, so its backups are kept.")
        await workspace.upsertSession(projectPath, { id: sessionId, keptUsage: { ...used, lastPrompt: null, costUnreported: undefined } })
        await this.assertCleanable(projectPath, sessionId, expected)
        for (const b of this.backupFiles(projectPath, sessionId)) await shell.trashItem(b)
      })
    )
    log.info(`Clean Up: removed the backups of session ${sessionId} in ${userText(projectPath)}`)
  }

  /**
   * Deletes a session from Hive: its record and Hive's copies of the transcript (to the Recycle Bin). The CLI's
   * own transcript is left alone (Hive doesn't change the CLIs' files), so Hive remembers the id to keep it hidden.
   * Clean Up… passes `expected`, the copies its preview listed (see removeBackups).
   */
  async delete(projectPath: string, sessionId: string, expected?: string[]): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    await this.deleteOne(projectPath, sessionId, expected)
    log.info(`Deleted session ${sessionId} in ${userText(projectPath)}`)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /**
   * delete() without its log line and refresh (bulk() does those once). All or nothing: with the session reserved and
   * nothing having it in use (assertFree; running checked again with its copies locked), Hive's copies go to the
   * Recycle Bin and the record goes with trashAllOrNothing: if a copy fails to go, or the record can't be saved, the
   * copies already gone are put back (a copy stays in the Recycle Bin).
   */
  private async deleteOne(projectPath: string, sessionId: string, expected?: string[]): Promise<void> {
    assertSessionId(sessionId)
    const remove = (): Promise<void> =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        // Clean Up… (a session whose only copies are Hive's): only as the preview listed it, and only once what it used is saved.
        if (expected) {
          await this.assertCleanable(projectPath, sessionId, expected)
          if (await this.providerTranscript(projectPath, sessionId)) throw new Error("The CLI has this session's transcript again.")
        } else await this.assertFree(projectPath, sessionId, 'delete')
        // What it used stays in the project's totals: read, and saved on its record, before its copies go, so the
        // totals survive a failure partway (a record without a transcript counts its keptUsage).
        const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
        const used = rec ? await this.usage(projectPath, sessionId).catch(() => null) : null
        if (expected && !used) throw new Error("Hive couldn't read what the session used, so it is kept.")
        const usage = used && { ...used, lastPrompt: null, costUnreported: undefined }
        if (rec && usage) await workspace.upsertSession(projectPath, { id: sessionId, keptUsage: usage })
        if (expected) await this.assertCleanable(projectPath, sessionId, expected)
        const kept: KeptUsage | null = rec && usage ? { id: sessionId, provider: recordProvider(rec), agentId: rec.agentId, cwd: rec.cwd, name: rec.name, usage } : null
        this.assertNotLive(sessionId, 'delete')
        const files = this.backupFiles(projectPath, sessionId)
        await inUseOnFail(() =>
          trashAllOrNothing(
            files,
            (b) => shell.trashItem(b),
            () =>
              workspace.mutateSessions(projectPath, (f) => {
                f.sessions = f.sessions.filter((s) => s.id !== sessionId)
                if (!f.deleted?.includes(sessionId)) f.deleted = [...(f.deleted ?? []), sessionId]
                if (kept) f.deletedUsage = [...(f.deletedUsage ?? []).filter((k) => k.id !== sessionId), kept]
              })
          )
        )
      })
    await (expected ? this.whileCleaning(projectPath, sessionId, remove) : this.whileReserved(projectPath, sessionId, remove))
    for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
      if (a.lastSessionId === sessionId) await workspace.updateAgent(projectPath, a.id, { lastSessionId: undefined }).catch(() => undefined)
    }
  }

  /**
   * Hive's sessions of a project (and deleted ones' kept usage) with only what totals need, for the Workspace
   * Overview. Lighter than list(): no sessions started outside Hive, no transcript or backup checks, and usage
   * comes from the usage cache (a transcript is read only where it grew since it was last read).
   */
  async usageItems(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath) }
    const items: SessionListItem[] = []
    for (const rec of file.sessions) {
      const usage = await this.usage(projectPath, rec.id, ctx).catch(() => null)
      items.push({
        id: rec.id,
        provider: recordProvider(rec),
        source: 'hive',
        agentId: rec.agentId,
        cwd: rec.cwd,
        archived: rec.archived,
        title: null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript: !!usage,
        hasBackup: false,
        usage: usage && { ...usage, lastPrompt: null, title: null },
        recache: null
      })
    }
    return [...items, ...(await this.keptUsage(projectPath))]
  }

  /** Deleted sessions' usage, as list items for totals (never shown in the session lists). */
  async keptUsage(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    return ((await workspace.sessionsFile(projectPath)).deletedUsage ?? []).map((k) => ({
      id: k.id,
      provider: k.provider,
      source: 'hive' as const,
      agentId: k.agentId,
      cwd: k.cwd,
      name: k.name,
      archived: true,
      deleted: true,
      title: null,
      lastActivity: k.usage.lastActivity,
      hasTranscript: false,
      hasBackup: false,
      usage: k.usage,
      recache: null
    }))
  }

  async rename(projectPath: string, sessionId: string, name: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    // The CLI's name now: a /rename after this one changes it, and then wins (sessionLabel).
    const titleAtRename = (await this.usage(projectPath, sessionId).catch(() => null))?.customTitle ?? null
    await workspace.upsertSession(projectPath, { id: sessionId, name: name.trim(), titleAtRename })
    const l = [...this.live.values()].find((x) => x.state.sessionId === sessionId && x.state.projectPath.toLowerCase() === projectPath.toLowerCase())
    if (l) {
      // Also the name its record is written with when the CLI starts the session again (a compaction, say).
      l.name = name.trim()
      const live = l.state
      live.sessionName = name.trim()
      live.titleAtRename = titleAtRename
      this.emitState(live)
    }
  }

  async adopt(projectPath: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    const src = await this.providerTranscript(projectPath, sessionId)
    const provider = src?.provider ?? 'claude-code'
    const usage = src ? await this.usageFor(src.path, sessionId, provider) : null
    // A sub-session (a Codex guardian review, say) stays one: never an agent's session to resume.
    const sub = src ? (await providerAdapter(provider).listSessions(projectPath).catch(() => [])).find((e) => e.id === sessionId)?.sub : undefined
    await workspace.upsertSession(projectPath, {
      ...(sub ? { sub } : {}),
      id: sessionId,
      agent: provider,
      name: usage?.title ?? `Adopted session ${sessionId.slice(0, 8)}`,
      titleAtRename: usage?.customTitle ?? null,
      createdAt: usage?.firstActivity ?? new Date().toISOString(),
      lastActiveAt: usage?.lastActivity ?? new Date().toISOString(),
      ...(src && !providerDescriptor(provider).capabilities.fixedSessionId ? { transcriptPath: src.path } : {})
    })
    if (src && config.settings.sessions.backupTranscripts) await syncCopy(src.path, this.backupPath(projectPath, sessionId)).catch(() => undefined)
  }
}

export const sessions = new SessionManager()
