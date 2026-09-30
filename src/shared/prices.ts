import type { AppSettings, ModelPrice, ProviderId, SessionUsage } from './types'
import { CLAUDE_CODE, baseModel } from './claude'
import { CODEX } from './codex'

/**
 * API prices Hive ships, in USD per million tokens, for estimating what a session would have cost at
 * API rates (the Overview's "≈ cost"). Users can override any model in Settings → <provider> → Prices.
 * Claude Code reports its own cost, so its table is only a fallback for sessions without one.
 *
 * Sources (checked 30 Sep 2026): Anthropic's model table (Claude API docs; cache writes 1.25× input and
 * cache reads 0.1× input unless listed) and OpenAI's API pricing page (standard tier).
 */
const claude = (input: number, output: number, cachedInput = input / 10): ModelPrice => ({ input, output, cachedInput, cacheWrite: input * 1.25 })
const openai = (input: number, cachedInput: number, output: number): ModelPrice => ({ input, cachedInput, output })

export const PRICES_CHECKED = '2026-09-30'

export const SHIPPED_PRICES: Record<ProviderId, Record<string, ModelPrice>> = {
  [CLAUDE_CODE]: {
    'claude-fable-5-1': claude(10, 50, 0.25),
    'claude-fable-5': claude(10, 50),
    'claude-opus-5-5': claude(4, 20, 0.2),
    'claude-opus-5': claude(5, 25),
    'claude-opus-4-8': claude(5, 25),
    'claude-opus-4-7': claude(5, 25),
    'claude-opus-4-6': claude(5, 25),
    'claude-sonnet-5-5': claude(2, 10, 0.2),
    'claude-sonnet-5': claude(2, 10),
    'claude-sonnet-4-6': claude(3, 15),
    'claude-haiku-4-5': claude(1, 5)
  },
  [CODEX]: {
    'gpt-6-astra': openai(10, 1, 50),
    'gpt-6-sol': openai(2, 0.2, 10),
    'gpt-6-luna': openai(0.1, 0.01, 0.5),
    'gpt-5.6-sol': openai(4, 0.4, 20),
    'gpt-5.6-terra': openai(2, 0.2, 12),
    'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
    'gpt-5.5': openai(5, 0.5, 30),
    'gpt-5.3-codex': openai(1.75, 0.175, 14)
  }
}

/** Claude Code's aliases, and the dated ids its transcripts show, map to the table's ids. */
const CLAUDE_ALIASES: Record<string, string> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' }

function priceKey(provider: ProviderId, model: string): string {
  const m = model.trim().toLowerCase()
  if (provider !== CLAUDE_CODE) return m
  const base = baseModel(m)
  return CLAUDE_ALIASES[base] ?? base.replace(/-\d{8}$/, '')
}

/** The price for a model: the user's override, else the shipped one; null when unknown. */
export function modelPrice(provider: ProviderId, model: string | null | undefined, settings?: Pick<AppSettings, 'providers'> | null): ModelPrice | null {
  if (!model) return null
  const key = priceKey(provider, model)
  const own = settings?.providers?.[provider]?.prices ?? {}
  return own[key] ?? own[model] ?? SHIPPED_PRICES[provider]?.[key] ?? null
}

/** A session's API-equivalent cost from its token counts; null when the model's price is unknown. */
export function estimateCost(usage: Pick<SessionUsage, 'provider' | 'model' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>, settings?: Pick<AppSettings, 'providers'> | null): number | null {
  const p = modelPrice(usage.provider, usage.model, settings)
  if (!p) return null
  const perM = (tokens: number, price: number): number => (tokens / 1_000_000) * price
  return perM(usage.inputTokens, p.input) + perM(usage.cacheReadTokens, p.cachedInput) + perM(usage.cacheWriteTokens, p.cacheWrite ?? p.input) + perM(usage.outputTokens, p.output)
}
