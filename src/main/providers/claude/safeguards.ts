import { SAFEGUARD_TOOLS, safeguardPattern, type SafeguardEvent, type SafeguardOverrides } from '../../../shared/safeguards'

/** What the reading keeps between reads (the launch's memo): the model the agent ran on, its last tool calls, the last stop. */
interface Memo {
  model?: string
  tools?: string[]
  /** When the last stop was noted (ms): the same stop's other entry, a moment apart, isn't another. */
  stopAt?: number
  /** A stop has been seen in this transcript: a model change after it is the fallback. */
  stopped?: boolean
}

/** Two entries of one stop (the note and the notice for the model) are written together; this far apart, they're two. */
const SAME_STOP_MS = 10_000

/**
 * Claude Code's safeguard stops and model changes in transcript lines (2.1.296, #606). A stop writes a system note
 * ("Opus 5.5's safeguards stopped the response above · …") and a notice for the model (a user entry, isMeta, with
 * `refusedMessageId`); either is enough, and the pair counts once. The note is matched by the named pattern
 * (SAFEGUARD_DEFAULTS.claudeNote) so a reworded one can be caught by changing data, and the notice's own field catches it
 * whatever the wording. Commands typed in it (/feedback about a stop, a local_command entry) and the person's own prompts
 * never count. The model an assistant message ran on (`message.model`) changing after a stop is the fallback; side
 * conversations (subagents) and Claude Code's own synthetic messages run on other models and don't count.
 */
export function claudeSafeguards(appended: string, memo: Record<string, unknown>, overrides?: SafeguardOverrides): SafeguardEvent[] {
  const m = memo as Memo
  const note = safeguardPattern('claudeNote', overrides)
  const out: SafeguardEvent[] = []
  const stop = (at: number): void => {
    if (m.stopAt !== undefined && Math.abs(at - m.stopAt) < SAME_STOP_MS) return
    m.stopAt = at
    m.stopped = true
    out.push({ kind: 'stop', at, ...(m.model ? { model: m.model } : {}), tools: [...(m.tools ?? [])] })
  }
  for (const line of appended.split('\n')) {
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
      if (m.model && model !== m.model && m.stopped) out.push({ kind: 'switch', at, from: m.model, to: model })
      m.model = model
      const content = o.message?.content
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === 'tool_use' && typeof c.name === 'string' && c.name) m.tools = [...(m.tools ?? []), c.name].slice(-SAFEGUARD_TOOLS)
      }
    } else if (o.type === 'system') {
      if (o.subtype === 'local_command' || typeof o.content !== 'string' || o.content.trimStart().startsWith('<')) continue
      if (note.test(o.content)) stop(at)
    } else if (o.type === 'user' && typeof o.refusedMessageId === 'string' && o.refusedMessageId) {
      stop(at)
    }
  }
  return out
}
