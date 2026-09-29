import type { CompactionEvent, RecacheEstimate, SessionUsage } from '../../shared/types'

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

/**
 * Parses a Claude Code JSONL transcript into usage statistics.
 * Tolerant of unknown entry types and malformed lines — the format belongs to Claude Code and may change.
 */
export function parseTranscript(text: string, sessionId: string): SessionUsage {
  const usage: SessionUsage = {
    sessionId,
    title: null,
    model: null,
    cliVersion: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    requests: 0,
    contextTokens: 0,
    compactions: [],
    cacheTtlSeconds: 300,
    firstActivity: null,
    lastActivity: null,
    userMessages: 0,
    lastPrompt: null,
    costUsd: null
  }
  // A single API response is written as several assistant entries (one per content block) that repeat
  // the same usage, so count each request once — the last entry for a request carries the final numbers.
  const byRequest = new Map<string, UsageBlock>()
  let customTitle: string | null = null
  let aiTitle: string | null = null
  let saw1h = false

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
    if (o.version && typeof o.version === 'string') usage.cliVersion = o.version

    switch (o.type) {
      case 'assistant': {
        const msg = o.message ?? {}
        const u: UsageBlock | undefined = msg.usage
        if (msg.model && msg.model !== '<synthetic>') usage.model = msg.model
        if (!u) break
        const key = o.requestId ?? msg.id ?? o.uuid ?? String(byRequest.size)
        byRequest.set(key, u)
        if (!o.isSidechain) {
          usage.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
        if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) saw1h = true
        break
      }
      case 'user':
        if (!o.isSidechain && !o.isMeta && typeof o.message?.content === 'string') usage.userMessages++
        else if (!o.isSidechain && Array.isArray(o.message?.content) && o.message.content.some((c: any) => c?.type === 'text')) usage.userMessages++
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
          if (c.postTokens) usage.contextTokens = c.postTokens
        }
        break
      case 'custom-title':
        if (o.customTitle ?? o.title) customTitle = o.customTitle ?? o.title
        break
      case 'ai-title':
        if (o.aiTitle ?? o.title) aiTitle = o.aiTitle ?? o.title
        break
      case 'last-prompt':
        if (typeof o.lastPrompt === 'string') usage.lastPrompt = o.lastPrompt
        break
      case 'cost-state':
        if (typeof o.totalCostUSD === 'number') usage.costUsd = o.totalCostUSD
        break
      case 'summary':
        if (o.summary && !aiTitle) aiTitle = o.summary
        break
    }
  }

  for (const u of byRequest.values()) {
    usage.inputTokens += u.input_tokens ?? 0
    usage.outputTokens += u.output_tokens ?? 0
    usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0
  }
  usage.requests = byRequest.size
  usage.title = customTitle ?? aiTitle
  usage.cacheTtlSeconds = saw1h ? 3600 : 300
  return usage
}

/** Estimates how many tokens resuming a session will write to the prompt cache. */
export function recacheEstimate(usage: SessionUsage, ttlOverride: 'auto' | '5m' | '1h', now = Date.now()): RecacheEstimate {
  const ttlSeconds = ttlOverride === '5m' ? 300 : ttlOverride === '1h' ? 3600 : usage.cacheTtlSeconds
  const last = usage.lastActivity ? Date.parse(usage.lastActivity) : 0
  const elapsed = last ? (now - last) / 1000 : Infinity
  const warm = elapsed < ttlSeconds
  return {
    tokens: usage.contextTokens,
    warm,
    secondsLeft: warm ? Math.max(0, Math.round(ttlSeconds - elapsed)) : 0,
    ttlSeconds
  }
}
