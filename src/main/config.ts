import { app } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync } from 'fs'
import { DEFAULT_APP_CONFIG, mergeDefaults, migrateConfig, withLegacySettings } from '../shared/defaults'
import type { AppConfig, AppSettings, EffortOption, FallbackModel, ModelPrice, ProviderSettings } from '../shared/types'
import type { SettingsPatch } from '../shared/api'
import { readKeptJsonSync, writeKeptJson } from './fsutil'
import { createLogger } from './logger'

const log = createLogger('config')

/** App-level configuration stored in %APPDATA%/Hive/config.json. */
class ConfigStore {
  private data: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
  private saveTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(s: AppSettings, prev: AppSettings) => void>()
  /** The file on disk is from an older Hive (config version 1): keep a copy before the first save replaces it. */
  private backupBeforeSave = false

  get path(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  /** Where a config from an older version is copied before this version first saves over it. */
  get backupPath(): string {
    return join(app.getPath('userData'), 'config.v1-backup.json')
  }

  load(): void {
    // A damaged file is set aside and its last good copy (.bak) used; only with neither does Hive start fresh.
    const raw = readKeptJsonSync<Record<string, any> | null>(this.path, null)
    if (!raw || typeof raw !== 'object') {
      this.data = structuredClone(DEFAULT_APP_CONFIG)
    } else {
      this.backupBeforeSave = (raw.version ?? 1) < DEFAULT_APP_CONFIG.version
      this.data = migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    }
    // Tests (unpackaged builds): no tip card over what a suite clicks, unless its profile turns tips on.
    if (!app.isPackaged && process.env.HIVE_TEST_TIPS === 'off' && raw?.settings?.general?.showTips === undefined) this.data.settings.general.showTips = false
  }

  get(): AppConfig {
    return this.data
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  update(mutator: (c: AppConfig) => void): void {
    mutator(this.data)
    this.scheduleSave()
  }

  updateSettings(patch: SettingsPatch): AppSettings {
    const prev = structuredClone(this.data.settings)
    this.data.settings = mergeDefaults(this.data.settings, patch)
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /** Sets, removes (null) or resets (undefined) one shortcut; the deep merge in updateSettings can't delete a key. */
  setKeybinding(commandId: string, key: string | null | undefined): AppSettings {
    const prev = structuredClone(this.data.settings)
    const next = { ...this.data.settings.keybindings }
    if (key === undefined) delete next[commandId]
    else next[commandId] = key
    this.data.settings = { ...this.data.settings, keybindings: next }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /**
   * Replaces one provider's price overrides (the deep merge in updateSettings can't delete a model), and which shipped
   * prices are removed from its table (absent: kept as they are; [] restores them all).
   */
  setProviderPrices(provider: string, prices: Record<string, ModelPrice>, removed?: string[]): AppSettings {
    const prev = structuredClone(this.data.settings)
    const clean: Record<string, ModelPrice> = {}
    for (const [model, p] of Object.entries(prices ?? {})) {
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
      if (!p || !ok(p.input) || !ok(p.cachedInput) || !ok(p.output)) continue
      clean[model] = { input: p.input, cachedInput: p.cachedInput, output: p.output, ...(ok(p.cacheWrite) ? { cacheWrite: p.cacheWrite } : {}) }
    }
    const current = { ...this.data.settings.providers[provider], prices: clean }
    if (removed !== undefined) {
      const gone = [...new Set((Array.isArray(removed) ? removed : []).filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))]
      if (gone.length) current.pricesRemoved = gone
      else delete current.pricesRemoved
    }
    this.data.settings = { ...this.data.settings, providers: { ...this.data.settings.providers, [provider]: current } }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /**
   * Replaces one provider's fallback list of models or effort levels (#125), as the user edited it; null (or an empty
   * list) goes back to Hive's defaults, which then follow Hive's updates. Entries without a value are dropped, and a
   * value given twice keeps its first entry.
   */
  setProviderFallback(provider: string, kind: 'models' | 'efforts', list: (FallbackModel | EffortOption)[] | null): AppSettings {
    const prev = structuredClone(this.data.settings)
    const key = kind === 'models' ? 'modelFallback' : 'effortFallback'
    const seen = new Set<string>()
    const clean: (FallbackModel | EffortOption)[] = []
    for (const e of Array.isArray(list) ? list : []) {
      const value = typeof e?.value === 'string' ? e.value.trim() : ''
      if (!value || seen.has(value.toLowerCase())) continue
      seen.add(value.toLowerCase())
      const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : value
      clean.push(kind === 'models' && (e as FallbackModel).older ? { value, label, older: true } : { value, label })
    }
    const current: ProviderSettings = { ...this.data.settings.providers[provider] }
    if (clean.length) (current as unknown as Record<string, unknown>)[key] = clean
    else delete current[key]
    this.data.settings = { ...this.data.settings, providers: { ...this.data.settings.providers, [provider]: current } }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  resetSettings(section?: keyof AppSettings): AppSettings {
    const prev = structuredClone(this.data.settings)
    if (section) (this.data.settings as unknown as Record<string, unknown>)[section] = structuredClone(DEFAULT_APP_CONFIG.settings[section])
    else this.data.settings = structuredClone(DEFAULT_APP_CONFIG.settings)
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  onSettingsChanged(listener: (s: AppSettings, prev: AppSettings) => void): void {
    this.listeners.add(listener)
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 300)
  }

  /** The save in progress: saves run one after another, so an older one can't land after a newer one. */
  private saving: Promise<void> = Promise.resolve()

  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    // Each save writes the settings as they are when its turn comes.
    this.saving = this.saving.then(() => this.write())
    return this.saving
  }

  private async write(): Promise<void> {
    try {
      if (this.backupBeforeSave) {
        this.backupBeforeSave = false
        if (existsSync(this.path) && !existsSync(this.backupPath)) {
          copyFileSync(this.path, this.backupPath)
          log.info(`Saved the previous version's settings to ${this.backupPath}`)
        }
      }
      // Claude Code's settings are also written where 0.1.x reads them, so going back keeps them.
      await writeKeptJson(this.path, withLegacySettings(this.data))
    } catch (e) {
      log.error('Failed to save config', e)
    }
  }
}

export const config = new ConfigStore()
