/**
 * A CLI's safety classifier stopping an agent's response, or the model it runs on changing after one (#606): Opus 5.5's
 * safeguards stopped one of HB3's responses and asked whether to switch to Opus 4.8, and with the fallback set to switch
 * by itself an agent carries on with another model unsaid. Hive shows when, on which model, and the names of the agent's
 * last few tool calls before it (to tell a false positive from an agent drifting into risky work), never the stopped
 * content (the CLI withholds it anyway) nor the calls' input.
 */

/**
 * What Hive spots safeguards by, as named defaults in one place (data, not code), so Settings → Advanced (#367) can make
 * each overridable without changing the detection. Patterns are a case-insensitive regular expression's source; lists
 * are the CLI's own codes. Each adapter reads the ones for its CLI (safeguardPattern, safeguardCodes).
 */
export const SAFEGUARD_DEFAULTS = {
  /**
   * Claude Code's transcript note when its safety classifier stops a response (2.1.296: a system entry, "Opus 5.5's
   * safeguards stopped the response above · continuing once with that noted", and the notice it adds for the model,
   * "Your response above was stopped by a safety classifier…").
   */
  claudeNote: String.raw`\bsafeguards?\b.{0,60}\bstopped\b|\bstopped by a safety classifier\b`,
  /**
   * Claude Code's records of a request its safeguards flagged (system entries, by subtype): answered by another model
   * (`model_refusal_fallback`, saying which, and whether for the session or that response only), or by none.
   */
  claudeRecords: ['model_refusal_fallback', 'model_refusal_no_fallback'],
  /**
   * Claude Code's question while it asks about a flagged message (2.1.296: "…'s safeguards flagged this message. Switch to
   * Opus 4.8 and keep going whenever this happens?", header "Model switch"), told by its two numbered choices while the
   * dialog is open ("1. Switch automatically", "2. Stay on Opus 5.5"): an answered one shows only the answer, and the
   * words "safeguards" or "safety classifier" elsewhere on screen never match.
   */
  claudePrompt: String.raw`^(?=[\s\S]*\b\d\.\s*Switch automatically\b)(?=[\s\S]*\b\d\.\s*Stay on\b)`,
  /** Why Codex reroutes a request to another model (its rollout's model_reroute event: the request was flagged). */
  codexReroute: ['high_risk_cyber_activity'],
  /** Codex's error kinds (codex_error_info) for a turn its usage policy stopped. */
  codexStop: ['cyber_policy', 'bio_policy']
} as const

export type SafeguardPatternName = { [K in keyof typeof SAFEGUARD_DEFAULTS]: (typeof SAFEGUARD_DEFAULTS)[K] extends string ? K : never }[keyof typeof SAFEGUARD_DEFAULTS]
export type SafeguardCodesName = Exclude<keyof typeof SAFEGUARD_DEFAULTS, SafeguardPatternName>

/** Overrides of the defaults (#367's Advanced settings, once they exist): a pattern's source, or a list of codes. */
export type SafeguardOverrides = Partial<Record<SafeguardPatternName, string> & Record<SafeguardCodesName, string[]>>

/** A named pattern as a regular expression: the override when it compiles, else the default. */
export function safeguardPattern(name: SafeguardPatternName, overrides?: SafeguardOverrides): RegExp {
  const own = overrides?.[name]
  if (typeof own === 'string' && own.trim()) {
    try {
      return new RegExp(own, 'i')
    } catch {
      // A broken override never stops detection: the default stands.
    }
  }
  return new RegExp(SAFEGUARD_DEFAULTS[name], 'i')
}

/** A named list of codes: the override when it has any, else the default. */
export function safeguardCodes(name: SafeguardCodesName, overrides?: SafeguardOverrides): readonly string[] {
  const own = overrides?.[name]
  return Array.isArray(own) && own.some((c) => typeof c === 'string' && c) ? own.filter((c) => typeof c === 'string' && c) : SAFEGUARD_DEFAULTS[name]
}

/** How many of the agent's last tool calls (their names) a stop keeps. */
export const SAFEGUARD_TOOLS = 5

/** How many stops' identities a detector's memo keeps, so a record read again (or its pair) isn't another stop. */
export const SAFEGUARD_IDS = 50

/** Whether a stop is new by its identity (the memo's `ids`), keeping it if so. A stop with none is always new. */
export function newStop(memo: { ids?: string[] }, id: string | undefined): boolean {
  if (!id) return true
  if (memo.ids?.includes(id)) return false
  memo.ids = [...(memo.ids ?? []), id].slice(-SAFEGUARD_IDS)
  return true
}

/** The names of the last tool calls a detector's memo holds (each keeps them as `tools`), for a stop Hive sees elsewhere. */
export function memoTools(memo: Record<string, unknown> | undefined): string[] {
  const t = memo?.tools
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string').slice(-SAFEGUARD_TOOLS) : []
}

/** The model a detector's memo last saw the agent run on (each keeps it as `model`), when it has one. */
export function memoModel(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.model === 'string' && memo.model ? memo.model : undefined
}

/**
 * What a provider's transcript says of its safeguards, read as the transcript grows (ProviderAdapter.safeguards):
 * a response stopped (`model`: the one it ran on; `tools`: the names of the agent's last calls before it), or the
 * model the agent runs on changing after a stop (`flagged`: the CLI says the change is the safeguard's own, as Codex's
 * reroute does). `at`: when the CLI wrote it (ms). A stop's `id` is what the CLI identifies the stopped request by,
 * when it does: each detector counts a stop once by it, however close two stops are. `asked`: the CLI's record of a
 * stop it may have asked the user about first (Claude Code's `model_refusal_fallback`), so a stop Hive saw on screen
 * (the prompt) and this record of it count once.
 */
export type SafeguardEvent = { kind: 'stop'; at: number; model?: string; tools: string[]; id?: string; asked?: boolean } | { kind: 'switch'; at: number; from: string; to: string; flagged?: boolean }

/** An agent's safeguard stops this launch, as its state shows them (LiveSessionState.safeguard). */
export interface SafeguardNote {
  /** When the CLI's safety classifier last stopped a response (ISO). */
  at: string
  /** The model it stopped, when the CLI says. */
  model?: string
  /** The names of the agent's last few tool calls before it, oldest first: never their input, nor what was stopped. */
  tools: string[]
  /** Stops this launch. */
  stops: number
  /** The model it has run on since a stop, when that changed (the CLI's fallback, by itself or chosen): from, to and when. */
  switched?: { from: string; to: string; at: string }
  /** It waits on its CLI's prompt about the stop (Claude Code asks whether to switch models). */
  prompt?: boolean
  /** That prompt was answered and no turn runs: idle after a safeguard stop, until it is given something to do. */
  idle?: boolean
  /** The switch hasn't been looked at (its pane not on screen since): it stays in the attention inbox until then. */
  unseen?: boolean
}

/**
 * The note after a safeguard event. A stop is counted (each is another: the detectors and the screen check tell one seen
 * twice by its identity, never by how close in time) and replaces the last one's time, model and tools; a switch away
 * from the model a stop was on is kept (unseen, for the inbox), and one back to it is over (the switch is undone).
 * `null`: nothing to change (a switch with no stop before it this launch, or the same as already noted).
 */
export function noteSafeguard(note: SafeguardNote | undefined, ev: SafeguardEvent): SafeguardNote | null {
  const iso = new Date(ev.at).toISOString()
  if (ev.kind === 'stop') {
    const out: SafeguardNote = { at: iso, tools: ev.tools.slice(-SAFEGUARD_TOOLS), stops: (note?.stops ?? 0) + 1 }
    if (ev.model) out.model = ev.model
    // A switch noted earlier stands until the model changes back: it is the model the agent still runs on.
    if (note?.switched) out.switched = note.switched
    if (note?.unseen) out.unseen = true
    // So does a prompt about it still waiting (only an answer ends it).
    if (note?.prompt) out.prompt = true
    return out
  }
  if (!note && !ev.flagged) return null
  const base: SafeguardNote = note ?? { at: iso, model: ev.from, tools: [], stops: 0 }
  const original = base.switched?.from ?? base.model ?? ev.from
  if (ev.to === original) {
    if (!base.switched) return null
    const { switched: _s, unseen: _u, ...rest } = base
    return rest
  }
  if (base.switched?.to === ev.to) return null
  return { ...base, switched: { from: original, to: ev.to, at: iso }, unseen: true }
}

/** "15:12" in the viewer's time, for a note's sentences. */
export function safeguardTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "its last tool calls: Bash, Edit, Bash", or '' with none. */
export function safeguardToolsText(note: Pick<SafeguardNote, 'tools'>): string {
  return note.tools.length ? `its last tool calls: ${note.tools.join(', ')}` : ''
}

/**
 * The note in a sentence or two for a pane, a notification or the inbox (`label`: the CLI's model names): what happened
 * and when, the model it runs on now, and what the agent was doing just before. Only names, never content.
 */
export function safeguardText(note: SafeguardNote, label: (model: string) => string = (m) => m): string {
  const parts: string[] = []
  const stops = note.stops > 1 ? ` (${note.stops} this session)` : ''
  if (note.stops > 0) parts.push(`A safety classifier stopped a response${note.model ? ` on ${label(note.model)}` : ''} at ${safeguardTime(note.at)}${stops}.`)
  if (note.switched) parts.push(`It now runs on ${label(note.switched.to)} instead of ${label(note.switched.from)} (since ${safeguardTime(note.switched.at)}).`)
  if (note.prompt) parts.push('Its CLI asks what to do about it.')
  else if (note.idle) parts.push('Idle after the stop: give it a nudge.')
  const tools = safeguardToolsText(note)
  if (tools && note.stops > 0) parts.push(`Before it, ${tools}.`)
  return parts.join(' ')
}

/** Adds a read's stops to a session's count by model (SessionUsage.safeguards; '' when the CLI didn't say the model). */
export function countSafeguards(by: Record<string, number>, events: readonly SafeguardEvent[]): void {
  for (const ev of events) if (ev.kind === 'stop') by[ev.model ?? ''] = (by[ev.model ?? ''] ?? 0) + 1
}

/**
 * A stop Hive saw only on the CLI's screen (its prompt about one), kept on the session's record so Performance counts it
 * (SessionRecord.screenStops): HB3's left no transcript entry. `matched`: the transcript recorded it after all (by this
 * identity), so the transcript's count has it.
 */
export interface ScreenStop {
  at: string
  model?: string
  matched?: string
}

/** A session's stops by model with those seen only on screen added (SessionUsage.safeguards). */
export function withScreenStops(by: Record<string, number> | undefined, screen: readonly ScreenStop[] | undefined): Record<string, number> | undefined {
  const own = (screen ?? []).filter((s) => !s.matched)
  if (!own.length) return by
  const out = { ...(by ?? {}) }
  for (const s of own) out[s.model ?? ''] = (out[s.model ?? ''] ?? 0) + 1
  return out
}
