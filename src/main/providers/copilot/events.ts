import { readdir, readFile, stat } from 'original-fs/promises'
import { join, resolve } from 'path'
import type { DayUsage, SessionUsage, TranscriptItem, TranscriptTool, UsageTokens } from '../../../shared/types'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { isSessionId } from '../../../shared/defaults'
import { formatToolInput } from '../claude/conversation'
import { firstLine, shortPath, type NewItem } from '../conversation'
import type { ConversationParserLike, ExternalSession, ImageLocation, LiveDetails } from '../types'

/**
 * The Copilot CLI's sessions (COPILOT_HOME/session-state/<id>/): events.jsonl holds one JSON event per line,
 * {type, data, id, timestamp, parentId}, and workspace.yaml the session's folder, branch, name and dates. Types seen
 * with Copilot CLI 1.0.93: session.start, session.resume, session.model_change, session.auto_mode_resolved,
 * session.permissions_changed, session.usage_checkpoint, session.error, session.shutdown, user.message, system.message,
 * assistant.turn_start/turn_end, assistant.message (with toolRequests), tool.execution_start/execution_complete,
 * permission.requested/completed, human_response.recorded, abort, hook.start/end and model.* (the CLI's own utility
 * calls on small models: titles, Auto's routing). The format belongs to the CLI and may change, so anything
 * unrecognised is ignored.
 */

/** The provider id (COPILOT in shared/copilot.ts). */
const PROVIDER = 'copilot'

type Ev = { type?: string; data?: Record<string, any>; timestamp?: string }

function parseLine(line: string): Ev | null {
  if (!line.trim()) return null
  try {
    const r = JSON.parse(line)
    return r && typeof r === 'object' ? r : null
  } catch {
    return null
  }
}

/** AI credits are counted in nano-AIU (1e9 a credit) and a credit is $0.01. */
export const nanoAiuToUsd = (nano: number): number => nano / 1e11

/** A model id that names a model, not the CLI's choice ("auto"). */
const realModel = (m: unknown): string | null => (typeof m === 'string' && m && m !== 'auto' ? m : null)

/**
 * The CLI's message when an error means its sign-in was refused or is missing (#309), else null: a session.error the
 * CLI marks as authentication, or one of its sign-in messages ("Please use /login to sign in to use Copilot", a 401).
 * Not seen in the spike (an invalid token falls back to the stored login), so this only knows the messages.
 */
export function signInRefused(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { errorType?: unknown; message?: unknown }
  const message = typeof d.message === 'string' ? d.message : ''
  if (typeof d.errorType === 'string' && /^auth/i.test(d.errorType)) return message || 'Copilot isn’t signed in.'
  return /please use \/login|sign in to use copilot|not (?:signed|logged) in|\b401\b|bad credentials/i.test(message) ? message : null
}

/**
 * Session details from appended events: model, effort, the credits used so far and the premium requests (running
 * totals), a refused sign-in, and when the user last interrupted a turn (`interruptedAt`, the last abort's timestamp: no
 * hook fires for it).
 */
export function eventsDetails(text: string): LiveDetails {
  // interruptedAt is in LiveDetails once the adapter (#450) is in; premiumRequests is Copilot's own (CopilotSessionUsage).
  const out: LiveDetails & { interruptedAt?: string; premiumRequests?: number } = {}
  for (const line of text.split('\n')) {
    const r = parseLine(line)
    const d = r?.data
    if (!d) continue
    switch (r.type) {
      case 'session.start':
      case 'session.resume': {
        const m = realModel(d.selectedModel)
        if (m) out.modelName = out.modelId = m
        break
      }
      case 'session.model_change': {
        const m = realModel(d.newModel)
        if (m) out.modelName = out.modelId = m
        if (typeof d.reasoningEffort === 'string') out.effort = d.reasoningEffort
        break
      }
      case 'session.auto_mode_resolved': {
        const m = realModel(d.chosenModel)
        if (m) out.modelName = out.modelId = m
        break
      }
      case 'assistant.message': {
        const m = realModel(d.model)
        if (m) out.modelName = out.modelId = m
        // The agent carrying on after a refused sign-in.
        delete out.signIn
        delete out.signInAt
        break
      }
      case 'session.usage_checkpoint':
      case 'session.shutdown':
        if (typeof d.totalNanoAiu === 'number') out.costUsd = nanoAiuToUsd(d.totalNanoAiu)
        if (typeof d.totalPremiumRequests === 'number') out.premiumRequests = d.totalPremiumRequests
        break
      case 'abort':
        if (typeof r.timestamp === 'string') out.interruptedAt = r.timestamp
        break
      case 'session.error': {
        const refused = signInRefused(d)
        if (refused) {
          out.signIn = refused
          if (typeof r.timestamp === 'string') out.signInAt = r.timestamp
          else delete out.signInAt
        }
        break
      }
    }
  }
  return out
}

/** The tokens of a session.shutdown's modelMetrics, added up over its models (the CLI's input counts the cache too). */
function shutdownTokens(metrics: unknown): UsageTokens & { reasoningTokens: number } {
  const t = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  if (!metrics || typeof metrics !== 'object') return t
  for (const m of Object.values(metrics as Record<string, any>)) {
    const u = m?.usage ?? {}
    const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
    const read = num(u.cacheReadTokens)
    const write = num(u.cacheWriteTokens)
    const fresh = typeof m?.tokenDetails?.input?.tokenCount === 'number' ? num(m.tokenDetails.input.tokenCount) : Math.max(0, num(u.inputTokens) - read - write)
    t.inputTokens += fresh
    t.cacheReadTokens += read
    t.cacheWriteTokens += write
    t.outputTokens += num(u.outputTokens)
    t.reasoningTokens += num(u.reasoningTokens)
  }
  return t
}

const ZERO: UsageTokens = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
const tokenSum = (t: UsageTokens): number => t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens

/**
 * A Copilot session's usage: SessionUsage, plus `premiumRequests`, the CLI's running count of premium requests (the
 * billing unit of plans from before AI credits; null until the CLI reports it). It isn't `requests`, which counts model
 * calls (one per assistant.message) as for the other providers.
 */
export type CopilotSessionUsage = SessionUsage & { premiumRequests: number | null }

/**
 * Usage statistics for a Copilot session (the Overview, the Sessions list and the Agent API), read a piece at a time
 * (events.jsonl only grows; a resumed session appends to it). The CLI writes running totals: the credits used after
 * each turn (session.usage_checkpoint) and the tokens by model when it exits (session.shutdown), so tokens appear
 * once a launch ends, while the cost, requests (one per assistant.message), prompts and the context are live.
 */
export class CopilotUsageParser {
  private usage: CopilotSessionUsage
  private days: Record<string, DayUsage> = {}
  /** The last running totals seen, to count each day's increase. */
  private lastTokens: UsageTokens = { ...ZERO }
  private lastNano = 0
  /** Credits charged by day (nano-AIU); set once the CLI reports a total at all, even 0, which is then the cost. */
  private charged: Record<string, number> | null = null
  private checkpointContext = false

  constructor(sessionId: string) {
    this.usage = {
      provider: PROVIDER,
      sessionId,
      title: null,
      model: null,
      cliVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
      reasoningTokens: 0,
      contextTokens: 0,
      contextWindow: null,
      compactions: [],
      cacheTtlSeconds: 0,
      firstActivity: null,
      lastActivity: null,
      userMessages: 0,
      lastPrompt: null,
      costUsd: null,
      costEstimated: false,
      premiumRequests: null
    }
  }

  private dayKey(ts: string | undefined): string {
    return localDay(ts) || localDay(this.usage.lastActivity)
  }

  private day(ts: string | undefined): DayUsage | null {
    const d = this.dayKey(ts)
    return d ? (this.days[d] ??= emptyDay()) : null
  }

  /**
   * The running totals of credits and premium requests (a checkpoint's or the exit's). The credits' increase since the
   * last total goes to its day (a lower total starts again).
   */
  private totals(d: Record<string, any>, ts: string | undefined): void {
    if (typeof d.totalPremiumRequests === 'number' && d.totalPremiumRequests >= 0) this.usage.premiumRequests = d.totalPremiumRequests
    const nano = d.totalNanoAiu
    if (typeof nano !== 'number' || nano < 0) return
    const grew = nano >= this.lastNano ? nano - this.lastNano : nano
    this.lastNano = nano
    this.usage.costUsd = nanoAiuToUsd(nano)
    this.charged ??= {}
    const day = this.dayKey(ts)
    if (day) this.charged[day] = (this.charged[day] ?? 0) + grew
  }

  /** Reads whole lines of events.jsonl (the next part of it). */
  feed(text: string): void {
    const usage = this.usage
    for (const line of text.split('\n')) {
      const r = parseLine(line)
      if (!r) continue
      const ts = r.timestamp
      if (ts) {
        if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
        if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
      }
      const d = r.data ?? {}
      switch (r.type) {
        case 'session.start':
          if (typeof d.copilotVersion === 'string') usage.cliVersion = d.copilotVersion
          usage.model = realModel(d.selectedModel) ?? usage.model
          break
        case 'session.resume':
          usage.model = realModel(d.selectedModel) ?? usage.model
          break
        case 'session.model_change':
          usage.model = realModel(d.newModel) ?? usage.model
          break
        case 'session.auto_mode_resolved':
          usage.model = realModel(d.chosenModel) ?? usage.model
          break
        case 'user.message': {
          usage.userMessages++
          const day = this.day(ts)
          if (day) day.prompts++
          if (typeof d.content === 'string' && d.content) usage.lastPrompt = d.content
          break
        }
        case 'assistant.message': {
          // One model call each (a turn with tools has several).
          usage.requests++
          const day = this.day(ts)
          if (day) day.requests++
          usage.model = realModel(d.model) ?? usage.model
          break
        }
        case 'session.usage_checkpoint': {
          this.totals(d, ts)
          // The last call's prompt for the model in use: the context now.
          for (const c of Array.isArray(d.promptCacheBreakState) ? d.promptCacheBreakState : []) {
            const m = c?.models?.[c?.lastActiveModel]
            if (c?.conversation === 'main' && typeof m?.prompt_tokens === 'number') {
              usage.contextTokens = usage.contextInputTokens = m.prompt_tokens
              this.checkpointContext = true
            }
          }
          const ttl = Array.isArray(d.modelCacheState) ? d.modelCacheState.find((s: any) => typeof s?.cacheTtlSeconds === 'number') : null
          if (ttl) usage.cacheTtlSeconds = ttl.cacheTtlSeconds
          break
        }
        case 'session.shutdown': {
          this.totals(d, ts)
          const t = shutdownTokens(d.modelMetrics)
          // Totals for the whole session (a resumed one's include the earlier launches): the day gets the increase.
          const day = this.day(ts)
          if (day) {
            const grew = (now: number, before: number): number => (now >= before ? now - before : now)
            day.inputTokens += grew(t.inputTokens, this.lastTokens.inputTokens)
            day.outputTokens += grew(t.outputTokens, this.lastTokens.outputTokens)
            day.cacheReadTokens += grew(t.cacheReadTokens, this.lastTokens.cacheReadTokens)
            day.cacheWriteTokens += grew(t.cacheWriteTokens, this.lastTokens.cacheWriteTokens)
          }
          this.lastTokens = { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheWriteTokens: t.cacheWriteTokens, cacheReadTokens: t.cacheReadTokens }
          Object.assign(usage, this.lastTokens)
          usage.reasoningTokens = t.reasoningTokens
          usage.model = realModel(d.currentModel) ?? usage.model
          // Without checkpoints (a provider of the user's own reports no credits), the CLI's own count of the context.
          if (!this.checkpointContext && typeof d.currentTokens === 'number') usage.contextTokens = usage.contextInputTokens = d.currentTokens
          break
        }
      }
    }
  }

  /** The usage so far: a new object each time (the parser keeps reading). Day costs come later (withDayCosts). */
  result(title: string | null = null): CopilotSessionUsage {
    const days: Record<string, DayUsage> = {}
    for (const [k, d] of Object.entries(this.days)) days[k] = { ...d }
    const charged = this.charged
    if (charged) for (const k of Object.keys(charged)) days[k] ??= emptyDay()
    // Once the CLI reports credits, they are the cost, also 0 (a model of the user's own): each day gets what was charged
    // on it, never an estimate. The CLI charges by turn but gives tokens only at exit, possibly on another day, so each
    // day's report covers all its tokens (a day charged before it has any counts as one token).
    const costReports = charged
      ? Object.entries(days).map(([k, d]) => {
          const t: UsageTokens = { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheWriteTokens: d.cacheWriteTokens, cacheReadTokens: d.cacheReadTokens }
          const nano = charged[k] ?? 0
          return { costUsd: nanoAiuToUsd(nano), days: { [k]: tokenSum(t) > 0 || !nano ? t : { ...ZERO, inputTokens: 1 } } }
        })
      : []
    return { ...this.usage, title, customTitle: title, compactions: [], days, ...(costReports.length ? { costReports } : {}) }
  }
}

/** Usage statistics for a whole events.jsonl (see CopilotUsageParser). */
export function parseEvents(text: string, sessionId: string, title: string | null = null): CopilotSessionUsage {
  const p = new CopilotUsageParser(sessionId)
  p.feed(text)
  return p.result(title)
}

/** How the Sessions tab shows Copilot's tools: Claude Code's names where they do the same. */
const TOOL_NAMES: Record<string, string> = {
  powershell: 'PowerShell',
  bash: 'Bash',
  view: 'Read',
  edit: 'Edit',
  create: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  ask_user: 'Question',
  task: 'Agent'
}

/** One line describing a tool call, e.g. the command's description or the file it edits. */
function toolSummary(name: string, args: Record<string, unknown>, root: string | null): string {
  switch (name) {
    case 'powershell':
    case 'bash':
      return firstLine(args.description) || firstLine(args.command)
    case 'view':
    case 'edit':
    case 'create':
      return shortPath(args.path, root)
    case 'grep':
    case 'glob':
      return [firstLine(args.pattern), args.path ? `in ${shortPath(args.path, root)}` : ''].filter(Boolean).join(' ')
    case 'web_fetch':
      return firstLine(args.url)
    case 'ask_user':
      return firstLine(args.message) || firstLine(args.question)
    case 'task':
      return firstLine(args.description) || firstLine(args.prompt)
  }
  return firstLine(Object.values(args).find((v) => typeof v === 'string' && v.trim())).slice(0, 200)
}

/** Copilot's transcript parser: the same items as Claude Code's, from events.jsonl. */
export class CopilotConversationParser implements ConversationParserLike {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  offset = 0
  private tools = new Map<string, TranscriptTool>()
  private root: string | null

  constructor(projectPath: string | null = null) {
    this.root = projectPath
  }

  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      this.line(buf.toString('utf8', start, nl))
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  /** A tool call, from the assistant's request or (when that is missing) its start. */
  private tool(t: Record<string, any>, ts: string | null): void {
    const callId = String(t.toolCallId ?? '')
    if (!callId || this.tools.has(callId)) return
    const raw = String(t.name ?? t.toolName ?? 'tool')
    const args: Record<string, unknown> = t.arguments && typeof t.arguments === 'object' ? t.arguments : {}
    // MCP tools are named "<server>-<tool>"; the event names both.
    const mcp = typeof t.mcpServerName === 'string' && typeof t.mcpToolName === 'string'
    const name = mcp ? `${t.mcpServerName} · ${t.mcpToolName}` : (TOOL_NAMES[raw] ?? raw)
    const tool: TranscriptTool = { toolUseId: callId, name, summary: toolSummary(raw, args, this.root).slice(0, 200), input: formatToolInput(name, args), result: null, isError: false, images: [] }
    this.tools.set(callId, tool)
    this.push({ kind: 'tool', timestamp: ts, tool })
  }

  private line(text: string): void {
    const r = parseLine(text)
    if (!r) return
    const ts = r.timestamp ?? null
    const d = r.data ?? {}
    switch (r.type) {
      case 'user.message':
        // content is what the user typed; transformedContent adds what the CLI gives the model (the date…).
        if (typeof d.content === 'string' && d.content.trim()) this.push({ kind: 'user', timestamp: ts, text: d.content, images: [] })
        break
      case 'assistant.message': {
        if (typeof d.reasoningText === 'string' && d.reasoningText.trim()) this.push({ kind: 'thinking', timestamp: ts, text: d.reasoningText })
        if (typeof d.content === 'string' && d.content.trim()) this.push({ kind: 'assistant', timestamp: ts, text: d.content })
        for (const t of Array.isArray(d.toolRequests) ? d.toolRequests : []) if (t && typeof t === 'object') this.tool(t, ts)
        break
      }
      case 'tool.execution_start':
        this.tool(d, ts)
        break
      case 'tool.execution_complete': {
        const tool = this.tools.get(String(d.toolCallId ?? ''))
        if (!tool) break
        const res = d.result ?? {}
        // detailedContent is what the CLI shows (an edit's diff); content what the model got.
        const out = typeof res.detailedContent === 'string' && res.detailedContent.trim() ? res.detailedContent : typeof res.content === 'string' ? res.content : ''
        tool.isError = d.success === false
        tool.result = tool.isError && typeof d.error?.message === 'string' ? d.error.message : out
        break
      }
      case 'permission.completed': {
        // A refused or cancelled permission prompt: the tool never ran, so this is its result.
        const kind = String(d.result?.kind ?? '')
        const tool = this.tools.get(String(d.toolCallId ?? ''))
        if (!tool || tool.result !== null || !kind || kind === 'approved') break
        const reason = typeof d.result?.reason === 'string' ? d.result.reason : ''
        tool.result = `${kind === 'cancelled' ? 'Cancelled' : 'Denied'}${reason ? `: ${reason}` : ''}`
        tool.isError = true
        break
      }
      case 'abort':
        this.push({ kind: 'notice', timestamp: ts, text: d.reason === 'user_initiated' ? 'Interrupted by you' : `Turn ended: ${d.reason ?? 'aborted'}`, level: 'info' })
        break
      case 'session.resume':
        this.push({ kind: 'notice', timestamp: ts, text: 'Session resumed', level: 'info' })
        break
      case 'session.error':
        if (typeof d.message === 'string' && d.message) this.push({ kind: 'notice', timestamp: ts, text: d.message, level: 'error' })
        break
    }
  }
}

/** An image's data URL from the event holding it. The spike saw no images in events.jsonl, so the parser records none. */
export function copilotImageData(entry: Record<string, any>, loc: ImageLocation): string | null {
  let v: any = entry
  for (const k of loc.path) v = v?.[k]
  if (typeof v === 'string') return v.startsWith('data:') ? v : null
  const url = v?.url ?? v?.image_url
  if (typeof url === 'string' && url.startsWith('data:')) return url
  return typeof v?.data === 'string' && typeof v?.mimeType === 'string' && v.mimeType.startsWith('image/') ? `data:${v.mimeType};base64,${v.data}` : null
}

/** What a session's workspace.yaml says (absent fields are null). */
export interface CopilotWorkspace {
  id: string
  cwd: string
  gitRoot: string | null
  branch: string | null
  /** The session's name: the user's (userNamed) or one the CLI made up from the first prompt. */
  name: string | null
  userNamed: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** A YAML scalar as the CLI writes them: plain, 'single' ('' for a quote) or "double" quoted. */
function yamlScalar(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

/** A session's workspace.yaml: flat "key: value" lines (anything nested or unknown is ignored); null without its id and folder. */
export function workspaceInfo(text: string): CopilotWorkspace | null {
  const f: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+):(?:\s+(.*))?$/.exec(line)
    if (m && m[2] !== undefined && !/^[|>]/.test(m[2])) f[m[1]] = yamlScalar(m[2])
  }
  const str = (k: string): string | null => (f[k] ? f[k] : null)
  if (!f.id || !f.cwd) return null
  return { id: f.id, cwd: f.cwd, gitRoot: str('git_root'), branch: str('branch'), name: str('name'), userNamed: f.user_named === 'true', createdAt: str('created_at'), updatedAt: str('updated_at') }
}

/** Where a session's events.jsonl is. */
export function copilotEventsPath(home: string, sessionId: string): string {
  return join(home, 'session-state', sessionId, 'events.jsonl')
}

/**
 * workspace.yaml files read, by path, kept while their modification time and size stay the same (a session list reads
 * every session's). At most `max`: the least recently used goes first, so deleted sessions and old homes drop out.
 */
export class WorkspaceCache {
  private entries = new Map<string, { mtime: number; size: number; ws: CopilotWorkspace | null }>()

  constructor(readonly max = 2000) {}

  get size(): number {
    return this.entries.size
  }

  async read(path: string): Promise<CopilotWorkspace | null> {
    try {
      const s = await stat(path)
      const c = this.entries.get(path)
      this.entries.delete(path)
      if (c && c.mtime === s.mtimeMs && c.size === s.size) {
        this.entries.set(path, c)
        return c.ws
      }
      const ws = workspaceInfo(await readFile(path, 'utf8'))
      this.entries.set(path, { mtime: s.mtimeMs, size: s.size, ws })
      for (const old of this.entries.keys()) {
        if (this.entries.size <= this.max) break
        this.entries.delete(old)
      }
      return ws
    } catch {
      this.entries.delete(path)
      return null
    }
  }
}

const workspaces = new WorkspaceCache()

/** A session's workspace.yaml, or null when it has none (or it can't be read). */
export async function readWorkspace(home: string, sessionId: string): Promise<CopilotWorkspace | null> {
  if (!isSessionId(sessionId)) return null
  return workspaces.read(join(home, 'session-state', sessionId, 'workspace.yaml'))
}

/**
 * The sessions the CLI keeps for a folder (its workspace.yaml's cwd), newest change first: those with a conversation
 * (an events.jsonl with something in it; the CLI makes a folder for every launch, also one that ends before a prompt).
 */
export async function listCopilotSessions(home: string, folder: string): Promise<ExternalSession[]> {
  const want = resolve(folder).toLowerCase()
  let ids: string[]
  try {
    ids = (await readdir(join(home, 'session-state'), { withFileTypes: true })).filter((e) => e.isDirectory() && isSessionId(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const out: ExternalSession[] = []
  for (const id of ids) {
    const ws = await readWorkspace(home, id)
    if (!ws || resolve(ws.cwd).toLowerCase() !== want) continue
    const path = copilotEventsPath(home, id)
    const s = await stat(path).catch(() => null)
    if (s && s.size > 0) out.push({ id, transcriptPath: path, modified: s.mtime.toISOString() })
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified))
}
