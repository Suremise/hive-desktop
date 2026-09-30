import { describe, expect, it } from 'vitest'
import { estimateCost, modelPrice } from '../src/shared/prices'

const usage = (provider: string, model: string) => ({ provider, model, inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, outputTokens: 100_000 })

describe('estimated cost', () => {
  it('prices Codex sessions from the table', () => {
    // gpt-6-luna: $0.10 input, $0.01 cached input, $0.50 output per million.
    expect(estimateCost({ ...usage('codex', 'gpt-6-luna'), cacheWriteTokens: 0 })).toBeCloseTo(0.1 + 0.02 + 0.05, 6)
  })
  it('knows Claude aliases, 1M suffixes and dated ids', () => {
    expect(modelPrice('claude-code', 'opus')?.input).toBe(4)
    expect(modelPrice('claude-code', 'claude-sonnet-5-5[1m]')?.cachedInput).toBe(0.2)
    expect(modelPrice('claude-code', 'claude-haiku-4-5-20251001')?.cacheWrite).toBe(1.25)
    expect(modelPrice('claude-code', 'claude-unknown-9')).toBeNull()
  })
  it("uses the user's prices over Hive's", () => {
    const settings = { providers: { codex: { prices: { 'gpt-6-luna': { input: 1, cachedInput: 0, output: 0 } } } } } as never
    expect(estimateCost({ ...usage('codex', 'gpt-6-luna'), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, settings)).toBeCloseTo(1, 6)
    expect(estimateCost(usage('codex', 'no-such-model'))).toBeNull()
  })
})
