import { SAFEGUARD_TOOLS, newStop, safeguardCodes, safeguardPattern, type SafeguardEvent, type SafeguardOverrides } from '../../../shared/safeguards'

/** What the reading keeps between reads (the launch's memo): the model the agent ran on, its last tool calls, the stops seen. */
interface Memo {
  model?: string
  tools?: string[]
  /** A stop has been seen in this transcript: a model change after it is the fallback. */
  stopped?: boolean
  /** The stops' identities seen (newStop). */
  ids?: string[]
  /** The last stop note's uuid: the notice for the model that follows it is the same stop. */
  noteUuid?: string
  /** The entry just read was a stop note, so the next one, if it is the notice for the model, is its pair. */
  afterNote?: boolean
  /** The model a fallback answered one response with (scope local): the session's own is unchanged. */
  local?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Claude Code's safeguard stops and model changes in transcript lines (2.1.296, #606).
 * - A stop it retries once writes a system note ("Opus 5.5's safeguards stopped the response above · …", matched by the
 *   named pattern SAFEGUARD_DEFAULTS.claudeNote so a reworded one can be caught by changing data) and, as the very next
 *   entry, a notice for the model (a user entry, isMeta, with `refusedMessageId`: the stopped response). The pair is one
 *   stop, by that adjacency or the notice's `parentUuid`; a notice alone is a stop by its own `refusedMessageId`.
 * - A flagged request answered by another model, or by none, is a system record (SAFEGUARD_DEFAULTS.claudeRecords:
 *   `model_refusal_fallback` with `originalModel`, `fallbackModel` and `scope`; `model_refusal_no_fallback`), a stop by
 *   its `requestId`, and for the session a switch the safeguard made (flagged). Claude Code may first have asked the user
 *   about it (its prompt, which Hive sees on screen): `asked`.
 * Each stop counts once by its identity, however close two are. Commands typed in it (/feedback about a stop, a
 * local_command entry), the person's own prompts and side conversations (subagents) never count. The model an assistant
 * message ran on (`message.model`) changing after a stop is the fallback too; Claude Code's own synthetic messages, and
 * a response another model answered alone (scope local), don't change it.
 */
export function claudeSafeguards(appended: string, memo: Record<string, unknown>, overrides?: SafeguardOverrides): SafeguardEvent[] {
  const m = memo as Memo
  const note = safeguardPattern('claudeNote', overrides)
  const records = safeguardCodes('claudeRecords', overrides)
  const out: SafeguardEvent[] = []
  const stop = (at: number, id: string | undefined, model = m.model, asked = false): boolean => {
    if (!newStop(m, id)) return false
    m.stopped = true
    out.push({ kind: 'stop', at, ...(model ? { model } : {}), tools: [...(m.tools ?? [])], ...(id ? { id } : {}), ...(asked ? { asked: true } : {}) })
    return true
  }
  for (const line of appended.split('\n')) {
    if (!line.trim()) continue
    // A note pairs only with the entry right after it.
    const afterNote = m.afterNote
    m.afterNote = false
    if (!line.includes('"assistant"') && !line.includes('refusedMessageId') && !line.includes('"system"')) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object' || o.isSidechain === true) continue
    const at = Date.parse(o.timestamp) || Date.now()
    if (o.type === 'assistant') {
      const model = o.message?.model
      if (typeof model !== 'string' || !model || model === '<synthetic>' || o.isApiErrorMessage) continue
      if (m.local && model === m.local) {
        // The one response another model answered: the session's model is unchanged.
      } else {
        m.local = undefined
        if (m.model && model !== m.model && m.stopped) out.push({ kind: 'switch', at, from: m.model, to: model })
        m.model = model
      }
      const content = o.message?.content
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === 'tool_use' && typeof c.name === 'string' && c.name) m.tools = [...(m.tools ?? []), c.name].slice(-SAFEGUARD_TOOLS)
      }
    } else if (o.type === 'system' && records.includes(o.subtype)) {
      // A fallback for another reason (capacity) isn't a safeguard's.
      if (o.subtype === 'model_refusal_fallback' && str(o.trigger) && o.trigger !== 'refusal' && o.apiRefusalCategory == null) continue
      const from = str(o.originalModel) ?? m.model
      const to = str(o.fallbackModel)
      // A record read again is neither another stop nor another switch.
      if (!stop(at, str(o.requestId) ?? str(o.refusedUserMessageUuid) ?? str(o.uuid), from, true) || !to || to === from) continue
      if (o.scope === 'local') m.local = to
      else {
        if (from) out.push({ kind: 'switch', at, from, to, flagged: true })
        m.model = to
        m.local = undefined
      }
    } else if (o.type === 'system') {
      if (o.subtype === 'local_command' || typeof o.content !== 'string' || o.content.trimStart().startsWith('<')) continue
      if (!note.test(o.content)) continue
      stop(at, str(o.uuid))
      m.noteUuid = str(o.uuid)
      m.afterNote = true
    } else if (o.type === 'user' && str(o.refusedMessageId)) {
      // The note's pair (the same stop, already counted by the note) or a stop of its own.
      if (afterNote || (str(o.parentUuid) && o.parentUuid === m.noteUuid)) newStop(m, o.refusedMessageId)
      else stop(at, o.refusedMessageId)
    }
  }
  return out
}
