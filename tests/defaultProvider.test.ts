// The default provider follows what's installed (#474): Automatic (the default) gives new agents the first provider
// turned on and installed, a default the user chose wins, and a project with no agents warns only about a provider
// the user chose, or when nothing is installed.
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, agentProvider, autoProvider, chosenDefaultProvider, defaultProviderLabel, defaultProviderWarning, projectDefaultProvider, providerWarnings, providersInUse, setInstalledCheck } from '../src/shared/providers'
import { DEFAULT_APP_CONFIG, DEFAULT_SETTINGS, mergeDefaults, migrateConfig } from '../src/shared/defaults'
import type { AppSettings, ProviderId } from '../src/shared/types'

const ALL = ['claude-code', 'codex', 'copilot']

/** Settings with these providers turned on and this default. */
function settings(on: string[], defaultProvider: string = AUTO_PROVIDER): AppSettings {
  const s = structuredClone(DEFAULT_SETTINGS)
  for (const id of ALL) s.providers[id] = { ...s.providers[id], enabled: on.includes(id) }
  s.defaultProvider = defaultProvider
  return s
}

/** These CLIs are installed, as Hive found them. */
function installed(ids: string[]): (id: ProviderId) => { found: boolean; checking?: boolean } {
  setInstalledCheck((id) => ids.includes(id))
  return (id) => ({ found: ids.includes(id) })
}

const INHERIT = { defaultProvider: 'inherit' }

afterEach(() => setInstalledCheck(() => false))

describe('Automatic', () => {
  it('is the default for a fresh install', () => {
    expect(DEFAULT_SETTINGS.defaultProvider).toBe(AUTO_PROVIDER)
    expect(chosenDefaultProvider(INHERIT, DEFAULT_SETTINGS)).toBeNull()
  })

  it('picks the first provider turned on and installed', () => {
    installed(['codex'])
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('codex')
    installed(['copilot'])
    expect(projectDefaultProvider(INHERIT, settings(['copilot']))).toBe('copilot')
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('copilot')
    // Claude Code first when it can run.
    installed(['claude-code', 'codex'])
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('claude-code')
    // Installed but turned off: not used.
    expect(projectDefaultProvider(INHERIT, settings(['codex']))).toBe('codex')
  })

  it('with nothing installed: the first turned on, else Claude Code', () => {
    installed([])
    expect(autoProvider(settings(['codex', 'copilot']))).toBe('codex')
    expect(autoProvider(settings([]))).toBe('claude-code')
  })

  it('says what it picks', () => {
    installed(['copilot'])
    expect(defaultProviderLabel(settings(ALL))).toBe('Automatic (GitHub Copilot)')
    expect(defaultProviderLabel(settings([]))).toBe('Automatic')
    expect(defaultProviderLabel(settings(ALL, 'codex'))).toBe('Codex')
  })
})

describe('a default the user chose', () => {
  it("wins over Automatic, Settings' or the project's own, even when it isn't installed", () => {
    installed(['copilot'])
    expect(projectDefaultProvider(INHERIT, settings(ALL, 'claude-code'))).toBe('claude-code')
    expect(projectDefaultProvider({ defaultProvider: 'codex' }, settings(ALL))).toBe('codex')
    expect(chosenDefaultProvider({ defaultProvider: 'codex' }, settings(ALL))).toBe('codex')
  })

  it("never moves an agent's own provider", () => {
    installed(['copilot'])
    expect(agentProvider({ provider: 'claude-code' }, INHERIT, settings(ALL))).toBe('claude-code')
    // An agent without one (the Assistant's) follows the default.
    expect(agentProvider({}, INHERIT, settings(ALL))).toBe('copilot')
  })
})

describe("a project's warning before it has agents", () => {
  it('names no CLI nobody chose: a Codex-only or Copilot-only install sees none', () => {
    expect(defaultProviderWarning(INHERIT, settings(['codex']), installed(['codex']))).toBeNull()
    expect(defaultProviderWarning(INHERIT, settings(['copilot']), installed(['copilot']))).toBeNull()
    // Claude Code turned on but missing is the providers banner's to say, not this.
    expect(defaultProviderWarning(INHERIT, settings(ALL), installed(['copilot']))).toBeNull()
  })

  it('warns when nothing is installed, or nothing is turned on', () => {
    expect(defaultProviderWarning(INHERIT, settings(ALL), installed([]))).toEqual({ text: 'No coding agent CLI is installed — Help → Agent Setup', fix: 'setup' })
    expect(defaultProviderWarning(INHERIT, settings([]), installed([]))).toEqual({ text: 'No coding agents are turned on — Settings → Providers', fix: 'providers' })
  })

  it('says nothing while Hive is still looking', () => {
    expect(defaultProviderWarning(INHERIT, settings(['codex']), () => ({ found: false, checking: true }))).toBeNull()
    expect(defaultProviderWarning(INHERIT, settings(['codex']), () => undefined)).toBeNull()
  })

  it('names a chosen default that is missing or turned off', () => {
    expect(defaultProviderWarning(INHERIT, settings(ALL, 'claude-code'), installed(['codex']))).toEqual({ text: "Claude Code isn't installed — Help → Agent Setup", fix: 'setup' })
    expect(defaultProviderWarning({ defaultProvider: 'codex' }, settings(['copilot']), installed(['copilot']))).toEqual({ text: 'Codex is turned off — Settings → Providers', fix: 'providers' })
    expect(defaultProviderWarning(INHERIT, settings(ALL, 'codex'), installed(['codex']))).toBeNull()
  })
})

describe('which providers Hive warns about (the banner, the status bar, Agent Setup opening)', () => {
  const ids = (w: ReturnType<typeof providerWarnings>) => w.providers.map((p) => p.id)

  it('not a provider only turned on: Automatic on Codex leaves a missing Claude Code alone', () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    const w = providerWarnings(s, info, providersInUse(s, [{ config: INHERIT, agents: [{ provider: 'codex' }] }]))
    expect(w).toMatchObject({ noneInstalled: false })
    expect(ids(w)).toEqual(['codex'])
    // Copilot-only the same.
    const c = providerWarnings(s, installed(['copilot']), providersInUse(s, []))
    expect(ids(c)).toEqual(['copilot'])
  })

  it("an agent's provider, a project's own default and a chosen default are in use", () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ config: INHERIT, agents: [{ provider: 'claude-code' }] }])))).toEqual(['claude-code', 'codex'])
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ config: { defaultProvider: 'copilot' }, agents: [] }])))).toEqual(['codex', 'copilot'])
    const chosen = settings(ALL, 'claude-code')
    expect(ids(providerWarnings(chosen, info, providersInUse(chosen, [])))).toEqual(['claude-code'])
  })

  it('one warning when nothing turned on is installed, none while still looking', () => {
    const s = settings(['claude-code', 'codex'])
    expect(providerWarnings(s, installed([]), providersInUse(s, []))).toEqual({ noneInstalled: true, providers: [] })
    expect(providerWarnings(s, () => ({ found: false, checking: true }), providersInUse(s, []))).toEqual({ noneInstalled: false, providers: [] })
    // At start, Claude Code not found while Codex is still being looked for: Automatic's pick isn't known, so no warning
    // (not Claude Code's).
    expect(providerWarnings(s, (id) => (id === 'codex' ? { found: false, checking: true } : { found: false }), providersInUse(s, []))).toEqual({ noneInstalled: false, providers: [] })
    expect(providerWarnings(settings([]), installed([]), new Set()).noneInstalled).toBe(false)
  })
})

describe('migration (config version 8)', () => {
  const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)

  it('turns the old saved default, Claude Code, into Automatic', () => {
    const c = load({ version: 7, settings: { defaultProvider: 'claude-code' } })
    expect(c.version).toBe(8)
    expect(c.settings.defaultProvider).toBe(AUTO_PROVIDER)
  })

  it('keeps a Codex or Copilot default, and a Claude Code one chosen since', () => {
    expect(load({ version: 7, settings: { defaultProvider: 'codex' } }).settings.defaultProvider).toBe('codex')
    expect(load({ version: 7, settings: { defaultProvider: 'copilot' } }).settings.defaultProvider).toBe('copilot')
    expect(load({ version: 8, settings: { defaultProvider: 'claude-code' } }).settings.defaultProvider).toBe('claude-code')
  })

  it('makes an unknown provider (a newer Hive wrote it) Automatic', () => {
    expect(load({ version: 8, settings: { defaultProvider: 'gemini' } }).settings.defaultProvider).toBe(AUTO_PROVIDER)
  })
})
