/**
 * Developer console recordings as files (#366 decision 5, #638): the JSON Lines a recording is written in, turning a
 * recording into a fixture (tests/fixtures/console/), comparing what a CLI sends now with a fixture (the contract tests),
 * and the part of a recording Copy Diagnostics attaches. No imports, so plain Node runs it as it is
 * (scripts/consoleFixture.mjs, the contract suites), and Hive and the unit tests share it.
 */

/** The recording file's format, in its first line. */
export const RECORDING_FORMAT = 1

/** A recording's first line: what was recorded, with which Hive and CLIs, and whether text is in it. */
export interface RecordingHeader {
  type: 'recording'
  format: number
  hive: string
  startedAt: string
  source: { kind: string; label: string; provider?: string }
  /** Prompt and reply text kept (the user's opt-in for this recording); secrets are masked either way. */
  text: boolean
  /** Each coding agent's CLI as installed when it started, and the version this Hive release was tested with. */
  clis: { provider: string; version: string | null; tested: string | null }[]
}

/** One event as the console captured it (`ConsoleEvent`), a line each. */
export interface RecordedEvent {
  type: 'event'
  seq: number
  at: string
  source?: string
  kind: string
  name: string
  provider?: string
  summary: string
  raw?: unknown
  made?: unknown
  bytes?: number
  truncated?: true
}

/** A recording's last line, once it stopped: why, and how many events it holds and lost. */
export interface RecordingEnd {
  type: 'end'
  at: string
  events: number
  dropped: number
  reason: 'stopped' | 'closed' | 'workspace' | 'limit'
}

export interface Recording {
  header: RecordingHeader | null
  events: RecordedEvent[]
  end: RecordingEnd | null
  /** Lines that weren't JSON or no known type (a recording cut short as Hive quit ends mid-line). */
  bad: number
}

export function parseRecording(text: string): Recording {
  const out: Recording = { header: null, events: [], end: null, bad: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let v: { type?: unknown }
    try {
      v = JSON.parse(line)
    } catch {
      out.bad++
      continue
    }
    if (v?.type === 'recording' && !out.header) out.header = v as RecordingHeader
    else if (v?.type === 'event') out.events.push(v as RecordedEvent)
    else if (v?.type === 'end') out.end = v as RecordingEnd
    else out.bad++
  }
  return out
}

// --- Fixtures

/** A recording made into a test fixture: what the CLI sent and what Hive made of it, with no machine's paths. */
export interface ConsoleFixture {
  format: number
  provider: string | null
  /** The CLI's version it was recorded with. */
  cli: string | null
  hive: string
  recordedAt: string
  events: FixtureEvent[]
}

export interface FixtureEvent {
  kind: string
  name: string
  raw?: unknown
  made?: unknown
}

/** What a fixture keeps: what the CLI sends and Hive's reading of it, not Hive's own work (API calls, lines it typed). */
export const FIXTURE_KINDS: readonly string[] = ['hook', 'statusline', 'transcript', 'terminal', 'launch', 'exit']

/** An absolute path (a drive, a UNC share, or a POSIX root) as a whole string. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/

/** Every absolute path in a value becomes "<path>": a fixture is committed, and paths name the machine and its user. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return ABSOLUTE_PATH.test(v) ? '<path>' : v
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
  return v
}

/**
 * A recording as a fixture: its events of the kinds a fixture keeps, in order, without times, sequence numbers or paths.
 * A recording with text is refused: fixtures are committed, and text is the user's.
 */
export function recordingToFixture(text: string): ConsoleFixture {
  const r = parseRecording(text)
  if (!r.header) throw new Error('Not a developer console recording: its first line should be the recording header.')
  if (r.header.text) throw new Error('This recording includes prompt and reply text, so it can’t become a fixture: record again without text.')
  const provider = r.header.source.provider ?? r.events.find((e) => e.provider)?.provider ?? null
  const events = r.events.filter((e) => FIXTURE_KINDS.includes(e.kind)).map((e) => ({ kind: e.kind, name: e.name, ...(e.raw !== undefined ? { raw: scrub(e.raw) } : {}), ...(e.made !== undefined ? { made: scrub(e.made) } : {}) }))
  if (!events.length) throw new Error('The recording has no events from a CLI to make a fixture of.')
  return {
    format: RECORDING_FORMAT,
    provider,
    cli: r.header.clis.find((c) => c.provider === provider)?.version ?? null,
    hive: r.header.hive,
    recordedAt: r.header.startedAt,
    events
  }
}

// --- Contract tests

/** What changed between a fixture and what a CLI sends now: a change breaks the contract, something new is only flagged. */
export interface ContractFinding {
  level: 'change' | 'new'
  /** "hook PreToolUse". */
  event: string
  what: string
}

/** The kinds whose arrival is part of the contract: a hook that stops arriving is a change. The others vary with timing. */
export const CONTRACT_KINDS: readonly string[] = ['hook']
/**
 * The kinds whose fields are part of it: a hook's or status line's field gone or retyped is a change. A transcript read
 * holds whichever records were newest then, and a terminal marker is Hive's own reading of the screen, so theirs vary.
 */
export const SHAPE_KINDS: readonly string[] = ['hook', 'statusline', 'launch', 'exit']

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** A value's field paths and their types ("tool_input.file_path" → "string"; a list's items under "[]"), merged over values. */
export function shapeOf(values: unknown[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (path: string, v: unknown): void => {
    const t = typeOf(v)
    if (path) out.set(path, (out.get(path) ?? new Set()).add(t))
    if (t === 'array') for (const x of v as unknown[]) add(`${path}[]`, x)
    else if (t === 'object') for (const [k, x] of Object.entries(v as object)) add(path ? `${path}.${k}` : k, x)
  }
  for (const v of values) if (v !== undefined) add('', v)
  return out
}

/** How Hive read each event of a group: a hook's event kind ("toolStart"), the status it set. */
function readings(events: FixtureEvent[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) {
    const kind = (e.made as { event?: { kind?: unknown } } | undefined)?.event?.kind
    if (typeof kind === 'string') out.add(kind)
  }
  return out
}

const groupBy = (events: FixtureEvent[]): Map<string, FixtureEvent[]> => {
  const out = new Map<string, FixtureEvent[]>()
  for (const e of events) {
    const k = `${e.kind} ${e.name}`
    out.set(k, [...(out.get(k) ?? []), e])
  }
  return out
}

/** A field path's parent: "" for a top-level field, "a" for "a.b" and "a[]", "a[]" for "a[].b". */
const parentOf = (path: string): string => path.replace(/(?:^|\.)[^.[\]]+$|\[\]$/, '')

/**
 * Compares what a CLI sends now (`live`, a fixture made from a new recording) with a recorded fixture. Per event (its
 * kind and name): a hook that no longer arrives (CONTRACT_KINDS), a field gone or of another type (SHAPE_KINDS), or Hive
 * reading it as something else is a change; a new event or field is flagged as new. A field gone with a new one beside
 * it, of the same type, is named as a possible rename.
 */
export function compareContract(fixture: ConsoleFixture, live: ConsoleFixture): ContractFinding[] {
  const findings: ContractFinding[] = []
  const before = groupBy(fixture.events)
  const now = groupBy(live.events)
  for (const [event, was] of before) {
    const is = now.get(event)
    if (!is) {
      if (CONTRACT_KINDS.includes(was[0].kind)) findings.push({ level: 'change', event, what: 'no longer arrives' })
      continue
    }
    if (!SHAPE_KINDS.includes(was[0].kind)) continue
    const a = shapeOf(was.map((e) => e.raw))
    const b = shapeOf(is.map((e) => e.raw))
    const gone = [...a.keys()].filter((p) => !b.has(p))
    const added = [...b.keys()].filter((p) => !a.has(p))
    for (const p of gone) {
      const twin = added.find((q) => parentOf(q) === parentOf(p) && [...a.get(p)!].join() === [...b.get(q)!].join())
      findings.push({ level: 'change', event, what: `field ${p} is gone${twin ? ` (renamed to ${twin}?)` : ''}` })
    }
    for (const p of added) findings.push({ level: 'new', event, what: `field ${p} is new` })
    for (const [p, types] of a) {
      const t = b.get(p)
      if (!t) continue
      const lost = [...types].filter((x) => !t.has(x))
      // A field that was always null or absent and now has a value is new information, not a break.
      if (lost.length && !(lost.length === 1 && lost[0] === 'null')) findings.push({ level: 'change', event, what: `field ${p} was ${[...types].join(' or ')}, now ${[...t].join(' or ')}` })
    }
    const ra = readings(was)
    const rb = readings(is)
    const unread = [...ra].filter((x) => !rb.has(x))
    if (unread.length) findings.push({ level: 'change', event, what: `Hive reads it as ${[...rb].join(' or ') || 'nothing'} now, not ${[...ra].join(' or ')}` })
  }
  for (const [event] of now) if (!before.has(event)) findings.push({ level: 'new', event, what: 'arrives now, and is not in the fixture' })
  return findings
}

// --- Copy Diagnostics

/** At most this much of a recording goes into Copy Diagnostics: its newest events. */
export const DIAGNOSTIC_LINES = 200
export const DIAGNOSTIC_BYTES = 64 * 1024

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]))
  return v
}

/**
 * The part of a recording Copy Diagnostics attaches: a line about it and its newest events (within DIAGNOSTIC_LINES and
 * DIAGNOSTIC_BYTES), every string passed through `redact` (paths, names, secrets). Null for a recording with text, which
 * is never attached.
 */
export function diagnosticRecording(text: string, redact: (s: string) => string): { summary: string; lines: string[] } | null {
  const r = parseRecording(text)
  if (!r.header || r.header.text) return null
  const lines: string[] = []
  let bytes = 0
  for (let i = r.events.length - 1; i >= 0 && lines.length < DIAGNOSTIC_LINES; i--) {
    const line = JSON.stringify(mapStrings(r.events[i], redact))
    if (bytes + line.length > DIAGNOSTIC_BYTES) break
    bytes += line.length
    lines.unshift(line)
  }
  const h = r.header
  const clis = h.clis.filter((c) => c.version).map((c) => `${c.provider} ${c.version}${c.tested ? ` (tested with ${c.tested})` : ''}`)
  const end = r.end ? `${r.end.events} events, ended (${r.end.reason})${r.end.dropped ? `, ${r.end.dropped} lost` : ''}` : `${r.events.length} events, not ended`
  const summary = redact(`${h.source.kind} source${h.source.provider ? ` (${h.source.provider})` : ''}, started ${h.startedAt}, Hive ${h.hive}; ${end}; CLIs: ${clis.join(', ') || 'none found'}; redacted; the newest ${lines.length}`)
  return { summary, lines }
}
