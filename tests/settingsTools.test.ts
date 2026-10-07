// The Assistant's settings tools (#186) on a provider's prices (#315): null puts back Hive's prices as Settings' Reset to
// defaults does, the shipped models removed from the table too; a table keeps them removed; Revert puts the removed list
// back with the overrides, and is refused when it changed since.
import { describe, expect, it } from 'vitest'
import { config } from '../src/main/config'
import * as assistant from '../src/main/assistantControl'
import { applySetting, revertSetting } from '../src/main/settingsTools'
import { settingChangeTexts, settingEntry } from '../src/shared/settingsCatalog'

const prices = settingEntry('codex.prices')!
const mine = { 'gpt-7': { input: 1, cachedInput: 0.1, output: 5 } }
const WS = 'C:\\hive-test\\settings-tools-ws'

/** Runs with Codex's price table set to `own` overrides and `removed` shipped models, then puts the settings back. */
async function withPrices(own: Record<string, unknown>, removed: string[], fn: () => Promise<void>): Promise<void> {
  const was = structuredClone(config.settings.providers)
  try {
    config.setProviderPrices('codex', own as never, removed)
    await fn()
  } finally {
    config.settings.providers = was
  }
}

/** Lists a change as the Agent API does, for Revert. */
function listed(r: Awaited<ReturnType<typeof applySetting>>) {
  const { oldText, newText } = settingChangeTexts(prices, r.old, r.new, r.removed)
  return assistant.record(WS, `Changed prices: ${oldText} → ${newText}`, undefined, { setting: { id: prices.id, path: 'Settings → Codex → API prices', old: r.old, new: r.new, ...(r.removed ? { removed: r.removed } : {}), oldText, newText } })
}

describe("the settings tools on a provider's prices", () => {
  it('null puts back the shipped models removed from the table, and says so', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      const r = await applySetting(prices, null, null)
      expect(r).toEqual({ old: mine, new: {}, removed: { old: ['gpt-5.5'], new: [] } })
      expect(config.settings.providers.codex.prices).toEqual({})
      expect('pricesRemoved' in config.settings.providers.codex).toBe(false)
      expect(settingChangeTexts(prices, r.old, r.new, r.removed)).toEqual({ oldText: 'gpt-7: {"input":1,"cachedInput":0.1,"output":5}, gpt-5.5: removed', newText: "gpt-7: (none), gpt-5.5: Hive's price" })
    })
  })

  it('…even with no overrides, when only a removed model differs', async () => {
    await withPrices({}, ['gpt-5.5'], async () => {
      const r = await applySetting(prices, null, null)
      expect(r.removed).toEqual({ old: ['gpt-5.5'], new: [] })
      expect(settingChangeTexts(prices, r.old, r.new, r.removed)).toEqual({ oldText: 'gpt-5.5: removed', newText: "gpt-5.5: Hive's price" })
    })
  })

  it('a table, even an empty one, keeps the removed models', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      expect((await applySetting(prices, { 'gpt-8': { input: 2, cachedInput: 0.2, output: 8 } }, null)).removed).toBeUndefined()
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
      expect((await applySetting(prices, {}, null)).removed).toBeUndefined()
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
    })
  })

  it('Revert of a reset puts back the overrides and the removed models', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      const action = listed(await applySetting(prices, null, null))
      await revertSetting(WS, action.id)
      expect(config.settings.providers.codex.prices).toEqual(mine)
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
    })
  })

  it('…and is refused when the removed models changed since, keeping them', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      const action = listed(await applySetting(prices, null, null))
      config.setProviderPrices('codex', {}, ['gpt-5.4'])
      await expect(revertSetting(WS, action.id)).rejects.toThrow(/has changed since/)
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.4'])
    })
  })

  it("Revert of a table edit leaves the removed models as they are then", async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      const action = listed(await applySetting(prices, {}, null))
      await revertSetting(WS, action.id)
      expect(config.settings.providers.codex.prices).toEqual(mine)
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
    })
  })
})
