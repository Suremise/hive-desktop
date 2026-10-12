/**
 * The developer console's capture (#366, #636): what each CLI sends Hive, next to what Hive made of it, kept in a
 * bounded ring per source while someone watches. Pure (no Node, no Electron), so the main process, the window and the
 * hive MCP server share it and it is unit tested.
 *
 * Redacted at capture: a payload is copied field by field, never passed through. Strings stay only where they are
 * identifiers or paths (a hook's name, a session id, a tool's name, a file path); text (prompts, messages, replies,
 * commands, titles, anything with spaces) becomes "<text: N chars>"; a field named like a secret is masked whatever it
 * holds, and anything kept that looks like a token or key is masked too (redact.ts). Including text is an opt-in of a
 * subscriber (the user's own recording, #638), never of an agent; secrets are masked even then.
 */
import type { ProviderId } from './types'
import { maskSecrets } from './redact'

/** Who sends the events: one agent's session (the Assistant's too), or Hive itself in a workspace. */
export type ConsoleSourceKind = 'session' | 'assistant' | 'hive'

/**
 * What an event is: a CLI's hook, status line, transcript records or terminal markers; a line Hive typed into it; its
 * launch and exit; or Hive's own work (Agent API calls, the hook server, watches, the merge slot, Progress).
 */
export const CONSOLE_KINDS = ['hook', 'statusline', 'transcript', 'terminal', 'input', 'launch', 'exit', 'api', 'hook-server', 'watch', 'merge-slot', 'progress'] as const
export type ConsoleKind = (typeof CONSOLE_KINDS)[number]

export interface ConsoleSource {
  /** Stable for an agent across its launches: `session:<project path, lower case>#<agent id>`; `hive:<workspace path, lower case>`. */
  id: string
  kind: ConsoleSourceKind
  /** "hive · HB6", "Hive Assistant", "Hive". */
  label: string
  workspacePath: string
  projectPath?: string
  project?: string
  agentId?: string
  agent?: string
  provider?: ProviderId
  /** Whether it is being captured now (someone watches it), and how many events its ring holds. */
  capturing: boolean
  events: number
}

/** One captured event: the raw payload (redacted) and what Hive made of it, in Hive's own words and fields. */
export interface ConsoleEvent {
  /** Increases across every source, so `since` works across sources and after a ring is dropped and made again. */
  seq: number
  at: string
  source: string
  kind: ConsoleKind
  /** The event's own name: a hook's ("PreToolUse"), an API route ("GET /v1/tasks"), a terminal marker ("title"). */
  name: string
  provider?: ProviderId
  /** One line: what came in and what Hive did ("PreToolUse (Edit) → toolStart; working"). Hive's words only. */
  summary: string
  raw?: unknown
  made?: unknown
  /** The event's size as JSON, which the ring's byte bound counts. */
  bytes: number
  /** The payload was too large and was cut down to its outline. */
  truncated?: true
}

/** What a capture point gives: the rest is filled in as it is kept. */
export interface CapturedEvent {
  kind: ConsoleKind
  name: string
  summary: string
  provider?: ProviderId
  raw?: unknown
  made?: unknown
}

/** A ring's bounds: by count and by bytes, whichever is reached first; the oldest events go. */
export const RING_MAX_EVENTS = 500
export const RING_MAX_BYTES = 1024 * 1024
/** One event at most: past this its payloads are cut to their outline. */
export const EVENT_MAX_BYTES = 32 * 1024

const sessionPrefix = 'session:'
const hivePrefix = 'hive:'
export const sessionSourceId = (projectPath: string, agentId: string): string => `${sessionPrefix}${projectPath.toLowerCase()}#${agentId}`
export const hiveSourceId = (workspacePath: string): string => `${hivePrefix}${workspacePath.toLowerCase()}`
export function parseSourceId(id: string): { kind: 'session'; projectPath: string; agentId: string } | { kind: 'hive'; workspacePath: string } | null {
  if (id.startsWith(hivePrefix) && id.length > hivePrefix.length) return { kind: 'hive', workspacePath: id.slice(hivePrefix.length) }
  if (!id.startsWith(sessionPrefix)) return null
  const at = id.lastIndexOf('#')
  if (at <= sessionPrefix.length || at === id.length - 1) return null
  return { kind: 'session', projectPath: id.slice(sessionPrefix.length, at), agentId: id.slice(at + 1) }
}

/**
 * Who reads the console through the Agent API (#366 decision 6): a project agent its own sessions only (by its own
 * token, never what a request says); the Assistant its workspace's sessions (its own included) and Hive's events there;
 * the workspace token and viewers any open workspace's. The window is the user's and reads every source of its own.
 */
export type ConsoleReader = { kind: 'agent'; projectPath: string; agentId: string } | { kind: 'assistant'; workspace: string } | { kind: 'all' }

const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Whether a reader may read a source. `workspaceOfProject` says which open workspace a session's folder is in (null: none). */
export function mayRead(reader: ConsoleReader, source: string, workspaceOfProject: (projectPath: string) => string | null): boolean {
  const s = parseSourceId(source)
  if (!s) return false
  if (reader.kind === 'all') return true
  if (reader.kind === 'agent') return s.kind === 'session' && samePath(s.projectPath, reader.projectPath) && s.agentId === reader.agentId
  if (s.kind === 'hive') return samePath(s.workspacePath, reader.workspace)
  const ws = workspaceOfProject(s.projectPath)
  return !!ws && samePath(ws, reader.workspace)
}

/** A source's ring: the newest events within its bounds (one larger than the whole ring isn't kept). */
export class ConsoleRing {
  private list: ConsoleEvent[] = []
  private size = 0
  constructor(
    readonly maxEvents = RING_MAX_EVENTS,
    readonly maxBytes = RING_MAX_BYTES
  ) {}
  push(e: ConsoleEvent): void {
    this.list.push(e)
    this.size += e.bytes
    while (this.list.length > this.maxEvents || (this.size > this.maxBytes && this.list.length > 0)) this.size -= this.list.shift()!.bytes
  }
  get count(): number {
    return this.list.length
  }
  get bytes(): number {
    return this.size
  }
  /** Events after `since` (a seq), oldest first, at most `limit` of the newest ones. */
  since(since = 0, limit = Infinity): ConsoleEvent[] {
    const after = this.list.filter((e) => e.seq > since)
    return limit < after.length ? after.slice(after.length - limit) : after
  }
  find(seq: number): ConsoleEvent | undefined {
    return this.list.find((e) => e.seq === seq)
  }
  all(): ConsoleEvent[] {
    return [...this.list]
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Fields whose whole subtree is a secret or a sign-in: masked whatever they hold (strings, numbers, objects), always.
 * Usage counts are spelt `input_tokens` and the like and are numbers outside such a subtree, so they aren't caught here.
 */
const SECRET_KEY = /(?:^|[_-])(?:token|access_token|refresh_token|id_token|secret|password|passwd|apikey|api_key|credentials?|cookies?|authorization|auth|oauth|login|signin|sign_in|device_code|user_code|verification_uri\w*|session_key|private_key|access_key|bearer|otp|code_verifier)(?:$|[_-])|^(?:token|secret|password|authorization|auth|cookie|credentials?|login|signIn|deviceCode|userCode|apiKey|accessToken|refreshToken)$/i
/** Fields whose whole subtree is text someone wrote (a person, the model, a CLI): every string in it is hidden unless text is included. */
const TEXT_KEY = /^(?:prompt|prompts|message|messages|last_assistant_message|lastMessage|lastReply|text|content|reason|title|summary|tool_response|tool_result|result|output|stdout|stderr|error|errors|description|question|answer|body|line|lines|screen|command|custom_instructions|todos|instructions|value|customTitle|subject|ask|asks|open|waitingOn|statusMessage)$/
/**
 * The only fields whose strings are kept (when they look like an identifier, a path or a time): Hive's own and the CLIs'
 * well-known names, ids, modes and paths. A string anywhere else is hidden, one word or many: an unknown CLI field is
 * text until it is listed here.
 */
const SAFE_KEYS = new Set([
  // Hooks, status lines and transcripts (Claude Code, Codex, Copilot).
  'hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'file_path', 'filePath', 'notebook_path', 'path', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'id', 'display_name', 'version', 'type', 'subtype', 'role', 'stop_reason', 'current_dir', 'project_dir', 'agent_type', 'turn_id', 'call_id', 'timestamp',
  // What Hive made of it, and its own events.
  'kind', 'status', 'actions', 'provider', 'mode', 'effort', 'modelId', 'modelName', 'plan', 'label', 'resetsAt', 'updatedAt', 'firedAt', 'state', 'outcome', 'method', 'route', 'query', 'branch', 'project', 'agent', 'agentId', 'agentName', 'waiting', 'name', 'switches', 'file', 'permissionDecision', 'footer', 'was', 'call'
])
/** A string kept under a safe field: an identifier, a version, a model id, an enum (no spaces). */
const IDENTIFIER = /^[\w.:@/+#=-]{1,120}$/
/** An absolute path on one line (folders are the user's own machine's: the console is local; recordings say more, #638). */
const PATH = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^\r\n]{0,400}$/
const ISO_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?$/

export interface RedactOptions {
  /** Keep text (cut to TEXT_MAX); secrets and sign-ins are still masked. Off by default. */
  includeText?: boolean
}
const TEXT_MAX = 2000
const MAX_DEPTH = 6
const MAX_ITEMS = 40
const MAX_KEYS = 60
/** A field's name, at most: a longer one is cut (a payload's keys are bounded like its values). */
const KEY_MAX = 64

const hidden = (s: string): string => `<text: ${s.length} chars>`
const keyOf = (k: string): string => (k.length > KEY_MAX ? `${k.slice(0, KEY_MAX)}…` : k)

/** Where a value sits: under a secret (masked), under text (strings hidden), or in plain fields (strings kept only where safe). */
type Context = 'secret' | 'text' | 'plain'

/** A redacted, bounded copy of a payload (see the top of this file). Never throws: what it can't copy it describes. */
export function redactPayload(value: unknown, opts: RedactOptions = {}): unknown {
  return copy(value, '', 'plain', 0, opts)
}

function copy(v: unknown, key: string, ctx: Context, depth: number, opts: RedactOptions): unknown {
  // A field's context follows everything under it: a secret's or a prompt's children are the secret's or the prompt's.
  if (ctx !== 'secret' && key && SECRET_KEY.test(key)) ctx = 'secret'
  else if (ctx === 'plain' && key && TEXT_KEY.test(key)) ctx = 'text'
  if (v === undefined) return undefined
  if (ctx === 'secret') return v === null || v === '' ? v : '<redacted>'
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'string') return redactString(v, key, ctx, opts)
  if (typeof v !== 'object') return `<${typeof v}>`
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? `<${v.length} items>` : '<object>'
  if (Array.isArray(v)) {
    // An array's items are judged by the field that holds them (prompts: [...] are text, switches: [...] are kept).
    const items = v.slice(0, MAX_ITEMS).map((x) => copy(x, key, ctx, depth + 1, opts))
    if (v.length > MAX_ITEMS) items.push(`<${v.length - MAX_ITEMS} more>`)
    return items
  }
  const out: Record<string, unknown> = {}
  const entries = Object.entries(v as Record<string, unknown>)
  for (const [k, x] of entries.slice(0, MAX_KEYS)) {
    const c = copy(x, k, ctx, depth + 1, opts)
    if (c !== undefined) out[keyOf(k)] = c
  }
  if (entries.length > MAX_KEYS) out['<more>'] = `${entries.length - MAX_KEYS} more fields`
  return out
}

function redactString(s: string, key: string, ctx: Context, opts: RedactOptions): string {
  if (!s) return s
  if (opts.includeText) return maskSecrets(s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s)
  if (ctx === 'plain' && SAFE_KEYS.has(key) && (IDENTIFIER.test(s) || PATH.test(s) || ISO_TIME.test(s))) return maskSecrets(s)
  return hidden(s)
}

/** A word for an event's name or a summary: kept when it is an identifier (a hook's or a tool's name), else said to be text. Never more than `max`. */
export function safeWord(v: unknown, max = 64): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v !== 'string' || !v) return ''
  return v.length <= max && IDENTIFIER.test(v) ? maskSecrets(v) : hidden(v)
}

/** A name of Hive's own (an agent's, a project's): kept, cut and on one line; secrets masked. */
export const hiveName = (v: unknown, max = 40): string => (typeof v === 'string' ? maskSecrets(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max)) : '')

/** An event's name and summary at most (characters). */
const NAME_MAX = 80
const SUMMARY_MAX = 300

/** An event as kept: its payloads redacted and bounded, its size counted, never over EVENT_MAX_BYTES. */
export function makeEvent(seq: number, at: string, source: string, c: CapturedEvent, opts: RedactOptions = {}): ConsoleEvent {
  const e: ConsoleEvent = { seq, at, source: source.slice(0, 600), kind: c.kind, name: hiveName(c.name, NAME_MAX), summary: hiveName(c.summary, SUMMARY_MAX), bytes: 0 }
  if (c.provider) e.provider = c.provider
  if (c.raw !== undefined) e.raw = redactPayload(c.raw, opts)
  if (c.made !== undefined) e.made = redactPayload(c.made, opts)
  e.bytes = jsonBytes(e)
  if (e.bytes > EVENT_MAX_BYTES) {
    if (e.raw !== undefined) e.raw = outline(e.raw)
    if (e.made !== undefined) e.made = outline(e.made)
    e.truncated = true
    e.bytes = 0
    e.bytes = jsonBytes(e)
  }
  // Still too large (its outline's field names): only that it was cut is kept.
  if (e.bytes > EVENT_MAX_BYTES) {
    if (e.raw !== undefined) e.raw = '<cut>'
    if (e.made !== undefined) e.made = '<cut>'
    e.bytes = 0
    e.bytes = jsonBytes(e)
  }
  return e
}

/** What a payload too large to keep was: its fields' names (bounded), or its length. */
function outline(v: unknown): unknown {
  if (Array.isArray(v)) return `<${v.length} items>`
  if (v && typeof v === 'object') return { '<cut>': `${jsonBytes(v)} bytes`, fields: Object.keys(v).slice(0, MAX_KEYS).map(keyOf) }
  return typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v
}

/** A value's size as JSON in UTF-8 bytes, without Buffer (the window has none): code points over 0x7f take 2–4. */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? ''
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0x7f) n += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1
  }
  return n
}
