import type { CompactionEvent, DayUsage, SessionUsage, UsageTokens } from '../../../shared/types'
import { addTokens, emptyDay, localDay } from '../../../shared/usageDays'
import { CLAUDE_CODE } from '../../../shared/claude'

/** Claude Code stores transcripts under ~/.claude/projects/<encoded>, where every non-alphanumeric character becomes '-'. */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

interface UsageBlock {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

/** A request's usage and the local day it ran on. */
interface Request {
  u: UsageBlock
  day: string
}

const tokensOf = (u: UsageBlock): UsageTokens => ({
  inputTokens: u.input_tokens ?? 0,
  outputTokens: u.output_tokens ?? 0,
  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  cacheReadTokens: u.cache_read_input_tokens ?? 0
})

/**
 * Reads a Claude Code JSONL transcript into usage statistics, a piece at a time (transcripts only grow, so a
 * running session's is read from where it left off). Tolerant of unknown entry types and malformed lines: the
 * format belongs to Claude Code and may change.
 */
export class ClaudeUsageParser {
  private usage: SessionUsage
  // A single API response is written as several assistant entries (one per content block) that repeat
  // the same usage, so count each request once — the last entry for a request carries the final numbers.
  private byRequest = new Map<string, Request>()
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private saw1h = false
  /** Requests no cost report covers yet. */
  private uncovered = new Set<string>()
  /** Each cost report (Claude Code's running total, written now and then): its total and the requests it newly covers. */
  private reports: { total: number; keys: string[] }[] = []
  private prompts = new Map<string, number>()
  private compactionDays: string[] = []

  constructor(sessionId: string) {
    this.usage = {
      provider: CLAUDE_CODE,
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
      cacheTtlSeconds: 300,
      firstActivity: null,
      lastActivity: null,
      userMessages: 0,
      lastPrompt: null,
      costUsd: null,
      costEstimated: false
    }
  }

  /** Reads whole lines of the transcript (the next part of it). */
  feed(text: string): void {
    const usage = this.usage
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, any>
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      const ts: string | undefined = o.timestamp
      if (ts && !o.isSidechain) {
        if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
        if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
      }
      const day = localDay(ts) || localDay(usage.lastActivity)
      if (o.version && typeof o.version === 'string') usage.cliVersion = o.version

      switch (o.type) {
        case 'assistant': {
          const msg = o.message ?? {}
          const u: UsageBlock | undefined = msg.usage
          if (msg.model && msg.model !== '<synthetic>') usage.model = msg.model
          if (!u) break
          const key = o.requestId ?? msg.id ?? o.uuid ?? String(this.byRequest.size)
          const known = this.byRequest.get(key)
          this.byRequest.set(key, { u, day: known?.day || day })
          if (!known) this.uncovered.add(key)
          if (!o.isSidechain) {
            usage.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
          }
          if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) this.saw1h = true
          break
        }
        case 'user':
          if (!o.isSidechain && !o.isMeta && (typeof o.message?.content === 'string' || (Array.isArray(o.message?.content) && o.message.content.some((c: any) => c?.type === 'text')))) {
            usage.userMessages++
            this.prompts.set(day, (this.prompts.get(day) ?? 0) + 1)
          }
          break
        case 'system':
          if (o.subtype === 'compact_boundary') {
            const m = o.compactMetadata ?? {}
            const c: CompactionEvent = {
              timestamp: ts ?? '',
              trigger: m.trigger ?? 'unknown',
              preTokens: m.preTokens ?? 0,
              postTokens: m.postTokens ?? 0
            }
            usage.compactions.push(c)
            this.compactionDays.push(day)
            if (c.postTokens) usage.contextTokens = c.postTokens
          }
          break
        case 'custom-title':
          if (o.customTitle ?? o.title) this.customTitle = o.customTitle ?? o.title
          break
        case 'ai-title':
          if (o.aiTitle ?? o.title) this.aiTitle = o.aiTitle ?? o.title
          break
        case 'last-prompt':
          if (typeof o.lastPrompt === 'string') usage.lastPrompt = o.lastPrompt
          break
        case 'cost-state':
          if (typeof o.totalCostUSD === 'number') {
            usage.costUsd = o.totalCostUSD
            this.reports.push({ total: o.totalCostUSD, keys: [...this.uncovered] })
            this.uncovered.clear()
          }
          break
        case 'summary':
          if (o.summary && !this.aiTitle) this.aiTitle = o.summary
          break
      }
    }
  }

  /** The usage so far: a new object each time (the parser keeps reading). Day costs come later (withDayCosts). */
  result(): SessionUsage {
    const usage: SessionUsage = { ...this.usage, compactions: [...this.usage.compactions] }
    const days: Record<string, DayUsage> = {}
    const dayOf = (d: string): DayUsage => (days[d] ??= emptyDay())
    for (const r of this.byRequest.values()) {
      const t = tokensOf(r.u)
      addTokens(usage, t)
      const d = dayOf(r.day)
      addTokens(d, t)
      d.requests++
    }
    for (const [day, n] of this.prompts) dayOf(day).prompts += n
    for (const day of this.compactionDays) dayOf(day).compactions++
    delete days['']
    usage.days = days
    if (this.reports.length) {
      const unreported = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
      for (const key of this.uncovered) {
        const r = this.byRequest.get(key)
        if (r) addTokens(unreported, tokensOf(r.u))
      }
      if (Object.values(unreported).some((n) => n > 0)) usage.costUnreported = unreported
      let before = 0
      usage.costReports = this.reports.map((rep) => {
        const byDay: Record<string, UsageTokens> = {}
        for (const key of rep.keys) {
          const r = this.byRequest.get(key)
          if (!r) continue
          addTokens((byDay[r.day] ??= { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }), tokensOf(r.u))
        }
        const costUsd = Math.max(0, rep.total - before)
        before = rep.total
        return { costUsd, days: byDay }
      })
    }
    usage.requests = this.byRequest.size
    usage.title = this.customTitle ?? this.aiTitle
    usage.customTitle = this.customTitle
    usage.cacheTtlSeconds = this.saw1h ? 3600 : 300
    return usage
  }
}

/** Usage statistics for a whole Claude Code transcript (see ClaudeUsageParser). */
export function parseTranscript(text: string, sessionId: string): SessionUsage {
  const p = new ClaudeUsageParser(sessionId)
  p.feed(text)
  return p.result()
}
