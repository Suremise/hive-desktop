import { SAFEGUARD_TOOLS, safeguardCodes, type SafeguardEvent, type SafeguardOverrides } from '../../../shared/safeguards'

/** What the reading keeps between reads (the launch's memo): the model the agent runs on, its last tool calls, the last stop. */
interface Memo {
  model?: string
  tools?: string[]
  stopAt?: number
  /** The model a reroute moved the agent to: a turn on another one is the agent back on its own (a reroute is per request). */
  rerouted?: string
}

/** A turn's error and its end report one stop: this far apart, they're two. */
const SAME_STOP_MS = 10_000

/** The error kind of Codex's structured error info: a code ("cyber_policy") or an object keyed by it. */
function errorKind(info: unknown): string | null {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null
  return null
}

/**
 * Codex's safeguards in rollout lines (#606), as Codex 0.160 names them (in its protocol; not seen in a real rollout
 * yet): a request it flags is rerouted to another model (event_msg `model_reroute`, with from_model, to_model and a
 * reason, SAFEGUARD_DEFAULTS.codexReroute), and a turn its usage policy stops ends with an error whose
 * `codex_error_info` names the policy (SAFEGUARD_DEFAULTS.codexStop), in an `error` event, the turn's end, or both.
 * A reroute is a stop on the model it left and a switch the safeguard made (flagged).
 */
export function codexSafeguards(appended: string, memo: Record<string, unknown>, overrides?: SafeguardOverrides): SafeguardEvent[] {
  const m = memo as Memo
  const reroute = safeguardCodes('codexReroute', overrides)
  const stops = safeguardCodes('codexStop', overrides)
  const out: SafeguardEvent[] = []
  const stop = (at: number, model = m.model): void => {
    if (m.stopAt !== undefined && Math.abs(at - m.stopAt) < SAME_STOP_MS) return
    m.stopAt = at
    out.push({ kind: 'stop', at, ...(model ? { model } : {}), tools: [...(m.tools ?? [])] })
  }
  const tool = (name: string): void => {
    m.tools = [...(m.tools ?? []), name].slice(-SAFEGUARD_TOOLS)
  }
  for (const line of appended.split('\n')) {
    if (!line.trim()) continue
    let r: { timestamp?: string; type?: string; payload?: Record<string, any> }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const p = r?.payload
    if (!p || typeof p !== 'object') continue
    const at = Date.parse(r.timestamp ?? '') || Date.now()
    if (r.type === 'turn_context' && typeof p.model === 'string') {
      if (m.rerouted && p.model !== m.rerouted) out.push({ kind: 'switch', at, from: m.rerouted, to: p.model })
      m.rerouted = undefined
      m.model = p.model
    } else if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const name = String(p.name ?? 'tool')
        tool(/exec_command|shell|local_shell/.test(name) ? 'Shell' : name === 'apply_patch' ? 'Edit' : name)
      } else if (p.type === 'local_shell_call') tool('Shell')
      else if (p.type === 'web_search_call') tool('WebSearch')
    } else if (r.type === 'event_msg') {
      if (p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') m.model = p.thread_settings.model
      else if (p.type === 'model_reroute' && typeof p.to_model === 'string' && reroute.includes(String(p.reason ?? ''))) {
        const from = typeof p.from_model === 'string' && p.from_model ? p.from_model : m.model
        stop(at, from)
        if (from && from !== p.to_model) out.push({ kind: 'switch', at, from, to: p.to_model, flagged: true })
        m.model = p.to_model
        m.rerouted = p.to_model
      } else if (p.type === 'error' || p.type === 'task_complete') {
        const info = p.type === 'error' ? p.codex_error_info : p.error?.codex_error_info
        const kind = errorKind(info)
        if (kind && stops.includes(kind)) stop(at)
      }
    }
  }
  return out
}
