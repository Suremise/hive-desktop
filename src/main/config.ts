import { app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { DEFAULT_APP_CONFIG, mergeDefaults, migrateConfig } from '../shared/defaults'
import type { AppConfig, AppSettings } from '../shared/types'
import type { SettingsPatch } from '../shared/api'
import { writeJsonAtomic } from './fsutil'
import { createLogger } from './logger'

const log = createLogger('config')

/** App-level configuration stored in %APPDATA%/Hive/config.json. */
class ConfigStore {
  private data: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
  private saveTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(s: AppSettings, prev: AppSettings) => void>()

  get path(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      this.data = migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw))
    } catch {
      this.data = structuredClone(DEFAULT_APP_CONFIG)
    }
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

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      await writeJsonAtomic(this.path, this.data)
    } catch (e) {
      log.error('Failed to save config', e)
    }
  }
}

export const config = new ConfigStore()
