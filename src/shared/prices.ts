import type { AppSettings, ModelPrice, ProviderId, SessionUsage } from './types'
import { CLAUDE_CODE, baseModel } from './claude'
import { CODEX } from './codex'

/**
 * API prices Hive ships, in USD per million tokens, for estimating what a session would have cost at
 * API rates (the Overview's "≈ cost"). They are editable defaults, never fetched (#125): in Settings → <provider> → API
 * prices the user can change, add and remove models, and Reset to defaults; only their changes are stored, so a later
 * Hive's prices still reach models they never edited. Claude Code reports its own cost, so its table is only a fallback
 * for sessions without one.
 *
 * Sources (checked 30 Sep 2026): Anthropic's model table (Claude API docs; cache writes 1.25× input and
 * cache reads 0.1× input unless listed) and OpenAI's API pricing page (standard tier).
 */
const claude = (input: number, output: number, cachedInput = input / 10): ModelPrice => ({ input, output, cachedInput, cacheWrite: input * 1.25 })
const openai = (input: number, cachedInput: number, output: number, cacheWrite?: number): ModelPrice => ({ input, cachedInput, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) })

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
    // Codex's default from 0.160 (Oct 2026): OpenAI's model page (developers.openai.com/api/docs/models/gpt-6.1-sol),
    // checked 5 Oct 2026, with cache writes at $2.50 (Codex reports none today). Prompts over 272K input tokens cost
    // more (2× input and cached, 1.5× output); not modelled.
    'gpt-6.1-sol': openai(2, 0.1, 10, 2.5),
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

/** The price for a model: the user's override, else the shipped one (unless they removed it); null when unknown. */
export function modelPrice(provider: ProviderId, model: string | null | undefined, settings?: Pick<AppSettings, 'providers'> | null): ModelPrice | null {
  if (!model) return null
  const key = priceKey(provider, model)
  const ps = settings?.providers?.[provider]
  const own = ps?.prices ?? {}
  const removed = ps?.pricesRemoved ?? []
  return own[key] ?? own[model] ?? (removed.includes(key) ? null : (SHIPPED_PRICES[provider]?.[key] ?? null))
}

/** A provider's price table as Settings shows it: the shipped models not removed, then the user's own, each with its price. */
export function priceRows(provider: ProviderId, settings?: Pick<AppSettings, 'providers'> | null): { model: string; price: ModelPrice; shipped: boolean; edited: boolean }[] {
  const ps = settings?.providers?.[provider]
  const own = ps?.prices ?? {}
  const removed = new Set(ps?.pricesRemoved ?? [])
  const shipped = SHIPPED_PRICES[provider] ?? {}
  const models = [...Object.keys(shipped).filter((m) => !removed.has(m) || own[m]), ...Object.keys(own).filter((m) => !shipped[m])]
  return models.map((m) => ({ model: m, price: own[m] ?? shipped[m], shipped: !!shipped[m], edited: !!own[m] }))
}

/**
 * The model when Hive can't estimate its sessions' cost because it has no price for it (shipped or the user's), so the
 * cost shows as unknown rather than missing or $0; null when it has a price or there is no model to price.
 */
export function unpricedModel(provider: ProviderId, model: string | null | undefined, settings?: Pick<AppSettings, 'providers'> | null): string | null {
  return model && !modelPrice(provider, model, settings) ? model : null
}

/** What to say about a cost that is unknown because the model has no price: where to add one. */
export const unpricedText = (model: string, providerName: string): string =>
  `Hive has no API price for ${model}, so it can't estimate this session's cost. Add one in Settings → ${providerName} → API prices.`

/** A session's API-equivalent cost from its token counts; null when the model's price is unknown. */
export function estimateCost(usage: Pick<SessionUsage, 'provider' | 'model' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>, settings?: Pick<AppSettings, 'providers'> | null): number | null {
  const p = modelPrice(usage.provider, usage.model, settings)
  if (!p) return null
  const perM = (tokens: number, price: number): number => (tokens / 1_000_000) * price
  return perM(usage.inputTokens, p.input) + perM(usage.cacheReadTokens, p.cachedInput) + perM(usage.cacheWriteTokens, p.cacheWrite ?? p.input) + perM(usage.outputTokens, p.output)
}
