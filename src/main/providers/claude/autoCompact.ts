import { join } from 'path'
import { readFileSync } from 'original-fs'
import type { AutoCompactSetting } from '../../../shared/types'

/**
 * Where Claude Code compacts by itself, as its settings say (#242; code.claude.com/docs/en/model-config, "Context window
 * and auto-compaction"; env-vars), read at launch without changing anything: DISABLE_COMPACT or DISABLE_AUTO_COMPACT
 * turning it off, else a settings file doing so (`autoCompactEnabled: false`, unless DISABLE_AUTO_COMPACT is set off),
 * else CLAUDE_CODE_AUTO_COMPACT_WINDOW (over everything), else --autocompact (over every
 * settings file), else the highest settings scope that sets a window, its `modelSettings.<model>.autoCompactWindow`
 * first, then its `autoCompactWindow`; "auto" means the window tuned for the model. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * can only bring it earlier.
 */

const MIN_WINDOW = 100_000
const MAX_WINDOW = 1_000_000

const clamp = (n: number): number => Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(n)))

/** A window as the flag or a setting gives it: 200000, "500k", "1M", "200" (thousands), or "auto". Null when it isn't one. */
export function parseWindow(v: unknown): number | 'auto' | null {
  // A setting's number is a token count; the thousands shorthand is the flag's.
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? clamp(v) : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^auto$/i.test(s)) return 'auto'
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (m[2]) return clamp(n * (/m/i.test(m[2]) ? 1_000_000 : 1000))
  return clamp(n >= 100 && n <= 1000 ? n * 1000 : n)
}

/** The variable takes only a plain count: "500k" reads as 500 and clamps to the minimum, as Claude Code does. */
function envWindow(v: string | undefined): number | null {
  const n = v === undefined ? NaN : parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? clamp(n) : null
}

/** A model id without what doesn't change the model (a "[1m]" suffix, a date, case). */
const modelKey = (m: string): string => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

/** A settings file, highest precedence first: what it is called in the tooltip and what it holds (null: none, or unreadable). */
export interface SettingsScope {
  label: string
  json: unknown
}

/** One settings file's window for the model (its modelSettings first), or undefined when it sets none. */
function scopeWindow(json: unknown, models: string[]): { value: number | 'auto'; key: string } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const o = json as Record<string, unknown>
  const per = o.modelSettings && typeof o.modelSettings === 'object' ? (o.modelSettings as Record<string, unknown>) : null
  if (per) {
    // The models in their order (the first is the one that runs, when known); for each, an entry of its exact name before
    // other spellings of it (a date, "[1m]", case), those in name order: never the file's order.
    for (const want of models) {
      const exact = Object.keys(per).find((n) => n.toLowerCase() === want.trim().toLowerCase())
      const names = [...(exact ? [exact] : []), ...Object.keys(per).filter((n) => n !== exact && modelKey(n) === modelKey(want)).sort()]
      for (const name of names) {
        const v = per[name]
        const w = v && typeof v === 'object' ? parseWindow((v as Record<string, unknown>).autoCompactWindow) : null
        if (w !== null) return { value: w, key: `modelSettings › ${name} › autoCompactWindow` }
      }
    }
  }
  const w = parseWindow(o.autoCompactWindow)
  return w !== null ? { value: w, key: 'autoCompactWindow' } : undefined
}

/** An on/off variable as Claude Code reads it: on for 1, true, yes, on; off for 0, false, no, off (any case); else unset. */
function envSwitch(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase()
  if (!s) return undefined
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return undefined
}

/**
 * The auto-compaction a launch gets: from its environment and arguments (what Hive passes), the settings files
 * (`scopes`, highest first) and the models it runs as (`models`, first first: the model the session reports once it
 * does; until then the id the choice resolves to, then the choice). DISABLE_COMPACT (all compaction) and
 * DISABLE_AUTO_COMPACT turn it off over everything; DISABLE_AUTO_COMPACT set off overrides `autoCompactEnabled` too.
 */
export function autoCompactOf(args: readonly string[], env: Record<string, string | undefined>, scopes: readonly SettingsScope[], models: readonly string[]): AutoCompactSetting {
  const pct = parseInt(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? '', 10)
  const percent = Number.isFinite(pct) && pct >= 1 && pct <= 100 ? { percent: pct } : {}
  const pctOnly = 'percent' in percent ? 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' : null
  if (envSwitch(env.DISABLE_COMPACT)) return { window: 'off', source: 'DISABLE_COMPACT' }
  const disableAuto = envSwitch(env.DISABLE_AUTO_COMPACT)
  if (disableAuto) return { window: 'off', source: 'DISABLE_AUTO_COMPACT' }
  for (const s of disableAuto === false ? [] : scopes) {
    const enabled = s.json && typeof s.json === 'object' ? (s.json as Record<string, unknown>).autoCompactEnabled : undefined
    if (enabled === false) return { window: 'off', source: `autoCompactEnabled: false in ${s.label}` }
    if (enabled === true) break
  }
  const fromEnv = envWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (fromEnv !== null) return { window: fromEnv, source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', ...percent }
  let flag: string | undefined
  args.forEach((a, i) => {
    if (a === '--autocompact') flag = args[i + 1]
    else if (a.startsWith('--autocompact=')) flag = a.slice('--autocompact='.length)
  })
  const fromFlag = parseWindow(flag)
  if (fromFlag === 'auto') return { window: null, source: '--autocompact auto', ...percent }
  if (fromFlag !== null) return { window: fromFlag, source: '--autocompact', ...percent }
  const ids = models.filter(Boolean)
  for (const s of scopes) {
    const w = scopeWindow(s.json, ids)
    if (!w) continue
    return w.value === 'auto' ? { window: null, source: `${w.key}: "auto" in ${s.label}`, ...percent } : { window: w.value, source: `${w.key} in ${s.label}`, ...percent }
  }
  return { window: null, source: pctOnly, ...percent }
}

/** A settings file's JSON, or null (missing, unreadable, not JSON). */
function readSettings(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The settings scopes Claude Code reads for a session, highest first: managed (Windows), the folder's
 * .claude/settings.local.json and .claude/settings.json, then the user's settings in its config folder.
 */
export function settingsScopes(cwd: string, configDir: string): SettingsScope[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  return [
    { label: 'managed settings', json: readSettings(join(programFiles, 'ClaudeCode', 'managed-settings.json')) },
    { label: "the project's .claude/settings.local.json", json: readSettings(join(cwd, '.claude', 'settings.local.json')) },
    { label: "the project's .claude/settings.json", json: readSettings(join(cwd, '.claude', 'settings.json')) },
    { label: "Claude Code's settings.json", json: readSettings(join(configDir, 'settings.json')) }
  ]
}
