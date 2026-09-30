import type { CompactionEvent, PlanLimit, PlanUsage, SessionUsage, TranscriptImageRef, TranscriptItem, TranscriptTool } from '../../../shared/types'
import { CODEX } from '../../../shared/codex'
import { firstLine, shortPath, toolLabel, type NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation, LiveDetails } from '../types'

/**
 * Codex's rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl): one JSON record per
 * line, {timestamp, ordinal, type, payload}. Types seen with Codex 0.159: session_meta, turn_context,
 * world_state, response_item (message, reasoning, function_call(_output), custom_tool_call(_output),
 * web_search_call), event_msg (task_started, token_count, thread_settings_applied, turn_aborted,
 * task_complete, item_completed…), token_usage_record and compacted. The format belongs to Codex and
 * may change, so anything unrecognised is ignored.
 */

type Rec = { timestamp?: string; type?: string; payload?: Record<string, any> }

function parseLine(line: string): Rec | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** Text of a message's content parts (input_text / output_text). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (typeof c?.text === 'string' && String(c?.type ?? 'text').endsWith('text') ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Messages Codex adds for the model (environment, AGENTS.md, skills, instructions), not typed by the user. */
function isContextMessage(text: string): boolean {
  const t = text.trimStart()
  return /^<(environment_context|user_instructions|skills_instructions|permissions instructions|collaboration_mode|turn_aborted|subagent)/i.test(t) || t.startsWith('# AGENTS.md') || t.startsWith('<INSTRUCTIONS>')
}

/** Rate limits from a token_count record, as plan usage. */
export function rolloutPlanUsage(rateLimits: Record<string, any> | null | undefined, now: string): PlanUsage | null {
  if (!rateLimits || typeof rateLimits !== 'object') return null
  const limits: PlanLimit[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const w = rateLimits[key]
    if (!w || typeof w.used_percent !== 'number') continue
    const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : null
    const label = minutes === 300 ? '5-hour' : minutes === 10080 ? 'weekly' : minutes ? `${Math.round(minutes / 60)}-hour` : key
    const resets = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : typeof w.resets_in_seconds === 'number' ? new Date(Date.parse(now) + w.resets_in_seconds * 1000).toISOString() : null
    limits.push({ id: minutes ? `w${minutes}` : key, label, windowMinutes: minutes, usedPercent: Math.max(0, Math.min(100, w.used_percent)), resetsAt: resets })
  }
  if (!limits.length) return null
  return { provider: CODEX, plan: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null, limits, updatedAt: now }
}

/** The preset a thread_settings_applied record describes (see CODEX_PERMISSION_MODES). */
export function presetFromSettings(ts: Record<string, any>): string | null {
  const approval = ts.approval_policy
  const reviewer = ts.approvals_reviewer
  const fs = ts.permission_profile?.file_system
  const entries: any[] = Array.isArray(fs?.entries) ? fs.entries : []
  const writes = entries.some((e) => e?.access === 'write' || e?.access === 'read-write' || e?.access === 'readwrite')
  if (fs?.type === 'unrestricted' || ts.sandbox_mode === 'danger-full-access' || ts.permission_profile?.type === 'disabled') return 'full-access'
  if (reviewer === 'auto_review' || reviewer === 'guardian') return 'approve-for-me'
  if (approval === 'never' && !fs) return null
  if (writes || ts.sandbox_mode === 'workspace-write') return 'ask'
  if (fs?.type === 'restricted') return 'read-only'
  return null
}

/** Session details from appended rollout lines: model, effort, plan mode, preset and plan limits. */
export function rolloutDetails(text: string): LiveDetails {
  const out: LiveDetails = {}
  for (const line of text.split('\n')) {
    const r = parseLine(line)
    const p = r?.payload
    if (!p) continue
    if (r.type === 'event_msg' && p.type === 'token_count') {
      const u = rolloutPlanUsage(p.rate_limits, r.timestamp ?? new Date().toISOString())
      if (u) out.planUsage = u
    } else if (r.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const ts = p.thread_settings ?? {}
      if (typeof ts.model === 'string') out.modelName = ts.model
      const effort = ts.collaboration_mode?.settings?.reasoning_effort ?? ts.reasoning_effort
      if (typeof effort === 'string') out.effort = effort
      if (typeof ts.collaboration_mode?.mode === 'string') out.planMode = ts.collaboration_mode.mode === 'plan'
      const preset = presetFromSettings(ts)
      if (preset) out.permissionMode = preset
    } else if (r.type === 'event_msg' && p.type === 'task_started' && typeof p.collaboration_mode_kind === 'string') {
      out.planMode = p.collaboration_mode_kind === 'plan'
    } else if (r.type === 'turn_context') {
      if (typeof p.model === 'string') out.modelName = p.model
      if (typeof p.effort === 'string') out.effort = p.effort
    }
  }
  return out
}

/** Usage statistics for a Codex rollout (the Overview, the Sessions list and the Agent API). */
export function parseRollout(text: string, sessionId: string, title: string | null = null): SessionUsage {
  const usage: SessionUsage = {
    provider: CODEX,
    sessionId,
    title,
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
    costEstimated: false
  }
  let pending: CompactionEvent | null = null
  let turnHasPrompt = false
  for (const line of text.split('\n')) {
    const r = parseLine(line)
    if (!r) continue
    const ts = r.timestamp
    if (ts) {
      if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
      if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
    }
    const p = r.payload ?? {}
    if (r.type === 'session_meta') {
      if (typeof p.cli_version === 'string') usage.cliVersion = p.cli_version
    } else if (r.type === 'turn_context') {
      if (typeof p.model === 'string') usage.model = p.model
    } else if (r.type === 'event_msg' && p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') {
      usage.model = p.thread_settings.model
    } else if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = p.info.total_token_usage ?? {}
      const last = p.info.last_token_usage ?? {}
      const cached = total.cached_input_tokens ?? 0
      usage.inputTokens = Math.max(0, (total.input_tokens ?? 0) - cached)
      usage.cacheReadTokens = cached
      usage.outputTokens = total.output_tokens ?? 0
      usage.reasoningTokens = total.reasoning_output_tokens ?? 0
      if (typeof p.info.model_context_window === 'number') usage.contextWindow = p.info.model_context_window
      const lastTokens = (last.input_tokens ?? 0) + (last.output_tokens ?? 0)
      // Codex repeats the totals with an empty last request (e.g. right after compacting): not a request.
      if (lastTokens > 0) {
        usage.contextTokens = lastTokens
        usage.requests++
        if (pending) {
          pending.postTokens = lastTokens
          pending = null
        }
      }
    } else if (r.type === 'event_msg' && p.type === 'task_started') {
      turnHasPrompt = false
      if (typeof p.model_context_window === 'number') usage.contextWindow = p.model_context_window
    } else if (r.type === 'event_msg' && (p.type === 'user_message' || (p.type === 'item_completed' && p.item?.type === 'UserMessage'))) {
      // Older Codex writes user_message; 0.159 writes item_completed with a UserMessage item.
      usage.userMessages++
      turnHasPrompt = true
      const said = typeof p.message === 'string' ? p.message : contentText(p.item?.content)
      if (said) usage.lastPrompt = said
    } else if (r.type === 'compacted') {
      // Codex doesn't record the trigger: /compact runs as a turn of its own, without a prompt.
      pending = { timestamp: ts ?? '', trigger: turnHasPrompt ? 'auto' : 'manual', preTokens: usage.contextTokens, postTokens: 0 }
      usage.compactions.push(pending)
    }
  }
  return usage
}

const PATCH_FILE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm

/** The files an apply_patch patch touches (both sides of a move). */
export function patchPaths(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(PATCH_FILE)) out.push(m[2].trim())
  return [...new Set(out)]
}

/** The patch in a code-mode script that only applies one (tools.apply_patch("…")); null for anything else. */
export function scriptPatch(script: string): string | null {
  // The patch is a string literal: passed straight to apply_patch, or first kept in a variable.
  if (!/tools\.apply_patch\(/.test(script)) return null
  for (const m of script.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!m[0].includes('*** Begin Patch')) continue
    try {
      const patch = JSON.parse(m[0])
      if (typeof patch === 'string') return patch
    } catch {
      // Not a JSON-style string: try the next one.
    }
  }
  return null
}

/** Codex's transcript parser: the same items as Claude Code's, from rollout records. */
export class CodexConversationParser implements ConversationParserLike {
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
      this.line(buf.toString('utf8', start, nl), this.offset + start, nl - start)
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  private tool(callId: string, name: string, input: string, summary: string, ts: string | null): void {
    const tool: TranscriptTool = { toolUseId: callId, name: toolLabel(name), summary, input, result: null, isError: false, images: [] }
    this.tools.set(callId, tool)
    this.push({ kind: 'tool', timestamp: ts, tool })
  }

  private line(text: string, offset: number, length: number): void {
    const r = parseLine(text)
    if (!r) return
    const ts = r.timestamp ?? null
    const p = r.payload ?? {}
    if (r.type === 'response_item') {
      switch (p.type) {
        case 'message': {
          const t = contentText(p.content)
          if (p.role === 'assistant') {
            if (t.trim()) this.push({ kind: 'assistant', timestamp: ts, text: t })
          } else if (p.role === 'user') {
            const images: TranscriptImageRef[] = []
            if (Array.isArray(p.content)) {
              p.content.forEach((c: any, i: number) => {
                if (c?.type === 'input_image') {
                  this.images.push({ offset, length, path: ['payload', 'content', i] })
                  images.push({ id: this.images.length - 1, path: null })
                }
              })
            }
            if ((t.trim() && !isContextMessage(t)) || images.length) this.push({ kind: 'user', timestamp: ts, text: t, images })
          }
          break
        }
        case 'reasoning': {
          const t = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? '').filter(Boolean).join('\n\n') : ''
          if (t.trim()) this.push({ kind: 'thinking', timestamp: ts, text: t })
          break
        }
        case 'function_call': {
          let args: Record<string, unknown> = {}
          try {
            args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments ?? {}
          } catch {
            args = { arguments: String(p.arguments ?? '') }
          }
          const name = String(p.name ?? 'tool')
          const shell = /exec_command|shell|local_shell/.test(name)
          const cmd = Array.isArray(args.command) ? (args.command as string[]).join(' ') : ((args.cmd ?? args.command) as string | undefined)
          const input = shell && typeof cmd === 'string' ? cmd : JSON.stringify(args, null, 2)
          const summary = shell ? firstLine(cmd) : firstLine(Object.values(args).find((v) => typeof v === 'string'))
          this.tool(String(p.call_id ?? ''), shell ? 'Shell' : name, input, summary.slice(0, 200), ts)
          break
        }
        case 'custom_tool_call': {
          const input = String(p.input ?? '')
          const name = String(p.name ?? 'tool')
          // Code mode: the model runs a script ("exec") that calls tools, e.g. tools.apply_patch("…").
          const scripted = name === 'exec' ? scriptPatch(input) : null
          const patch = name === 'apply_patch' ? input : scripted
          if (patch !== null) {
            this.tool(String(p.call_id ?? ''), 'Edit', patch, patchPaths(patch).map((f) => shortPath(f, this.root)).join(', ').slice(0, 200), ts)
          } else this.tool(String(p.call_id ?? ''), name === 'exec' ? 'Script' : name, input, firstLine(input).slice(0, 200), ts)
          break
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const tool = this.tools.get(String(p.call_id ?? ''))
          if (!tool) break
          const out =
            typeof p.output === 'string'
              ? p.output
              : Array.isArray(p.output)
                ? p.output.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
                : typeof p.output?.content === 'string'
                  ? p.output.content
                  : JSON.stringify(p.output ?? '')
          tool.result = out
          tool.isError = /Process exited with code [1-9]|^error/i.test(out) || p.output?.success === false
          break
        }
        case 'web_search_call': {
          const q = p.action?.query ?? p.query ?? ''
          this.tool(String(p.id ?? `web-${this.items.length}`), 'WebSearch', String(q), firstLine(q), ts)
          break
        }
      }
    } else if (r.type === 'compacted') {
      const summary = typeof p.message === 'string' ? p.message : null
      this.push({ kind: 'compaction', timestamp: ts, trigger: 'auto', preTokens: 0, postTokens: 0, nextRequestTokens: null, summary })
    } else if (r.type === 'event_msg') {
      if (p.type === 'turn_aborted') this.push({ kind: 'notice', timestamp: ts, text: p.reason === 'interrupted' ? 'Interrupted by you' : `Turn ended: ${p.reason ?? 'aborted'}`, level: 'info' })
      else if (p.type === 'error' && typeof p.message === 'string') this.push({ kind: 'notice', timestamp: ts, text: p.message, level: 'error' })
    }
  }
}

/** An input_image's data URL, from the line holding it. */
export function codexImageData(entry: Record<string, any>, loc: ImageLocation): string | null {
  let v: any = entry
  for (const k of loc.path) v = v?.[k]
  const url = v?.image_url ?? v?.url
  return typeof url === 'string' && url.startsWith('data:') ? url : null
}
