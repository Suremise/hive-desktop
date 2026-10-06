import { basename } from 'path'
import type { SettingsPatch } from '../shared/api'
import type { EffortOption, FallbackModel, ModelPrice, ProjectConfig } from '../shared/types'
import { modelCaps } from '../shared/models'
import { projectProviderConfig, providerSettings } from '../shared/providers'
import { SETTINGS_CATALOG, checkSettingValue, effortTakes, settingDefault, settingEntry, settingKind, settingOptions, settingPatch, settingPath, settingValue, settingValueText, type SettingContext, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import type { SettingDetail, SettingRow } from '../shared/toolReplies'
import * as assistant from './assistantControl'
import { config } from './config'
import { providerService } from './providerService'
import { workspace } from './workspace'

/**
 * Hive's settings for the Agent API and the Hive Assistant's settings tools (#186): the catalog's entries with their
 * values, and a change made the way Settings and Project Settings make it (config.updateSettings and the table setters,
 * or the project's config under its lock). Who may change what is decided by the caller (settingsChange in
 * servers.ts), and checked again by its guard at the moment of the change.
 */

/** Why a settings call can't be done: an HTTP status and what to tell the caller. */
export class SettingRefused extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** The entry for an id, or 404 naming how to find one. */
export function entryOf(id: string): SettingEntry {
  const e = settingEntry(id)
  if (!e || e.action) throw new SettingRefused(404, `No setting "${id}": hive_list_settings lists them (query narrows it).`)
  return e
}

/**
 * The effort levels the effort picker offers for a setting: those of the model that would run (the setting's own
 * provider and, for a project, its model), else the provider's fallback list.
 */
function effortsFor(e: SettingEntry, project: ProjectConfig | null): EffortOption[] {
  const provider = e.provider ?? e.assistantProvider
  if (!provider) return []
  const s = config.settings
  const info = providerService.info(provider)
  const global = providerSettings(s, provider).defaultModel
  const own = e.scope === 'project' && project ? projectProviderConfig(project, provider).model : e.assistantProvider ? s.assistant?.providers?.[provider]?.model : ''
  const model = (own && own !== 'inherit' ? own : global) || info?.defaultModel || null
  return modelCaps(provider, model, info, s).efforts
}

/** What checking a value uses besides the catalog. */
const contextFor = (project: ProjectConfig | null): SettingContext => ({ efforts: (e) => effortsFor(e, project) })

/** What a setting takes, in words. */
function takesText(e: SettingEntry, project: ProjectConfig | null): string {
  const kind = settingKind(e)
  const inherit = e.scope === 'project' && e.inherits && (kind === 'number' || e.key === 'worktreeCopy') ? ', or null to inherit' : ''
  switch (kind) {
    case 'boolean':
      return 'true or false'
    case 'number':
      return `${e.min ?? '-∞'} to ${e.max ?? '∞'}${e.off ? `, or 0 for ${e.off}` : ''}${inherit}`
    case 'select':
      return `one of: ${(settingOptions(e) ?? []).map((o) => (o.value === '' ? '"" (default)' : o.value)).join(', ')}`
    case 'effort':
      return effortTakes(e, effortsFor(e, project))
    case 'table':
      return e.id === 'board.colors'
        ? "an object of column → #rrggbb colour (only those it names change), or null for Hive's colours"
        : e.key === 'prices'
          ? "the whole table: an object of model → {input, cachedInput, output, cacheWrite?} (USD per million tokens), or null for Hive's prices"
          : `the whole list: [{value, label${e.key === 'modelFallback' ? ', older?' : ''}}], or null for Hive's list`
    case 'text':
      return `text${inherit}`
    default:
      return e.readOnly ?? 'nothing through the tools'
  }
}

const RESTART_TEXT: Record<NonNullable<SettingEntry['restart']>, string> = {
  sessions: 'to sessions started afterwards (running agents show Restart session)',
  assistant: 'to the Assistant after it restarts'
}

const firstSentence = (s: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(s.trim())
  const first = m ? m[0] : s.trim()
  return first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first
}

/** A project's folder and config, for project settings (null without one). */
export async function projectOf(projectPath: string | null): Promise<{ path: string; name: string; config: ProjectConfig } | null> {
  if (!projectPath) return null
  return { path: projectPath, name: basename(projectPath), config: await workspace.projectConfig(projectPath) }
}

/**
 * The settings as rows: Hive's and the providers', and with a project its settings too (only then: their values are a
 * project's). `query` keeps those whose id, title, path or text has every word; `scope` one scope.
 */
export function settingRows(opts: { query?: string; scope?: SettingScope; project?: { config: ProjectConfig } | null }): SettingRow[] {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return SETTINGS_CATALOG.filter((e) => !e.action && (e.scope !== 'project' || !!opts.project) && (!opts.scope || e.scope === opts.scope))
    .filter((e) => {
      const text = `${e.id} ${settingPath(e)} ${e.desc} ${e.tip} ${e.helps ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .map((e) => {
      const value = settingValue(e, config.settings, opts.project?.config)
      const def = settingDefault(e)
      const changed = JSON.stringify(value) !== JSON.stringify(def)
      return { id: e.id, title: e.title, value: settingValueText(e, value), ...(changed ? { default: settingValueText(e, def) } : {}), desc: firstSentence(e.desc), ...(e.readOnly ? { readOnly: true as const } : {}) }
    })
}

/** One setting in full, with its value (a project's for a project setting; a table as it is). */
export function settingDetail(e: SettingEntry, project: { name: string; config: ProjectConfig } | null): SettingDetail {
  if (e.scope === 'project' && !project) throw new SettingRefused(400, `${e.id} is a project's setting: say which project.`)
  const cfg = e.scope === 'project' ? (project?.config ?? null) : null
  return {
    id: e.id,
    title: e.title,
    path: settingPath(e),
    scope: e.scope,
    ...(project && e.scope === 'project' ? { project: project.name } : {}),
    value: settingValueText(e, settingValue(e, config.settings, cfg), true),
    default: settingValueText(e, settingDefault(e), true),
    takes: takesText(e, cfg),
    desc: e.desc,
    ...(e.tip ? { tip: e.tip } : {}),
    ...(e.helps ? { helps: e.helps } : {}),
    ...(e.restart ? { restart: RESTART_TEXT[e.restart] } : {}),
    ...(e.readOnly ? { readOnly: e.readOnly } : {}),
    docs: e.docs
  }
}

/** When a change applies, in words (undefined: at once). */
export const restartText = (e: SettingEntry): string | undefined => (e.restart ? RESTART_TEXT[e.restart] : undefined)

/** Checks a value for a setting (a project's for a project setting), or refuses it with what it takes. */
export async function checkedValue(e: SettingEntry, raw: unknown, projectPath: string | null): Promise<unknown> {
  const checked = checkSettingValue(e, raw, contextFor(projectPath ? await workspace.projectConfig(projectPath) : null))
  if ('error' in checked) throw new SettingRefused(400, checked.error)
  return checked.value
}

/**
 * Sets a setting to a value as Settings or Project Settings would, and returns what it was and is now. `guard` runs at
 * the moment of the change, with the value as it is then (under the project's lock for a project's setting, or with no
 * wait before Hive's own settings change): it throws to refuse, so a permission withdrawn, or a value changed by
 * someone else, while the call waited is noticed. Never a sensitive setting: those stay the user's.
 */
export async function applySetting(e: SettingEntry, raw: unknown, projectPath: string | null, guard?: (current: unknown) => void): Promise<{ old: unknown; new: unknown }> {
  if (e.sensitive) throw new SettingRefused(403, e.readOnly ?? `${settingPath(e)} is the user's to change.`)
  const value = await checkedValue(e, raw, e.scope === 'project' ? projectPath : null)
  const change = settingPatch(e, value)
  if ('project' in change) {
    if (!projectPath) throw new SettingRefused(400, `${e.id} is a project's setting: say which project.`)
    let old: unknown
    const next = await workspace.mutateProjectConfig(projectPath, (cfg) => {
      old = settingValue(e, config.settings, cfg)
      guard?.(old)
      return change.project(cfg)
    })
    return { old, new: settingValue(e, config.settings, next) }
  }
  // Hive's own settings change at once, with nothing awaited between the guard and the change.
  const old = settingValue(e, config.settings)
  guard?.(old)
  if ('settings' in change) config.updateSettings(change.settings as SettingsPatch)
  else if ('prices' in change) config.setProviderPrices(change.prices.provider, change.prices.value as Record<string, ModelPrice>)
  else config.setProviderFallback(change.fallback.provider, change.fallback.kind, change.fallback.list as (FallbackModel | EffortOption)[] | null)
  return { old, new: settingValue(e, config.settings) }
}

/** Reverts in progress, by the change's action id: a second click while one runs is refused. */
const reverting = new Set<string>()

/**
 * The user's Revert on a setting the Assistant changed (its panel's list): sets it back to what it was, through the same
 * checked change, and lists that too. Refused once reverted, or when the setting has changed again since (the user
 * changes it in Settings then): both checked at the moment of the change, under the project's lock for a project's.
 */
export async function revertSetting(workspacePath: string, actionId: string): Promise<void> {
  const change = assistant.actions(workspacePath).find((a) => a.id === actionId)?.setting
  if (!change) throw new Error('That change is no longer listed.')
  if (reverting.has(actionId)) throw new Error('It is being reverted.')
  reverting.add(actionId)
  try {
    const e = entryOf(change.id)
    const guard = (current: unknown): void => {
      if (assistant.actions(workspacePath).some((a) => a.revertOf === actionId)) throw new Error('It has already been reverted.')
      if (JSON.stringify(current) !== JSON.stringify(change.new)) throw new Error(`${change.path} has changed since (it is ${settingValueText(e, current)} now): change it there.`)
    }
    await applySetting(e, change.old, change.project ?? null, guard)
    assistant.record(workspacePath, `You reverted ${change.path}${change.project ? ` in ${basename(change.project)}` : ''}: ${change.newText} → ${change.oldText}`, undefined, { revertOf: actionId })
  } finally {
    reverting.delete(actionId)
  }
}
