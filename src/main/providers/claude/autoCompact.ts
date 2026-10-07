import { isAbsolute, join } from 'path'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'original-fs'
import type { AutoCompactSetting } from '../../../shared/types'

/**
 * Where Claude Code compacts by itself, as its settings say (#242; code.claude.com/docs/en/model-config, "Context window
 * and auto-compaction"; env-vars), read at launch without changing anything: DISABLE_COMPACT or DISABLE_AUTO_COMPACT
 * turning it off, else a settings file doing so (`autoCompactEnabled: false`, unless DISABLE_AUTO_COMPACT is set off),
 * else CLAUDE_CODE_AUTO_COMPACT_WINDOW (over everything), else --autocompact (over every
 * settings file), else the highest settings scope that sets a window, its `modelSettings.<model>.autoCompactWindow`
 * first, then its `autoCompactWindow`; "auto" means the window tuned for the model. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * can only bring it earlier.
 *
 * The variables are read from the environment Claude Code ends up with: the launch's, with each settings scope's `env`
 * block over it, the higher scope winning (#273). Checked with Claude Code 2.1.291 in a test home: a settings file's
 * `env` beats the launch environment; the project's beats the user's; a `--settings` file or inline JSON beats the
 * project's; and of several `--settings` flags only the last is read. Managed settings are the highest scope (the
 * documented order: managed, command line, local, project, user). Policies Hive can't read (Windows registry policies,
 * an organisation's server-managed settings) could still change it, so a default is labelled an estimate.
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
  /** Why Hive can't tell what it gives (it couldn't read it, or can't tell whether Claude Code does), after its label (#333). */
  unsure?: string
}

/** What a default is labelled with: what Hive can't read could still change it (#273). */
export const UNREAD_SOURCES = "an estimate: managed policies Hive can't read, such as Windows registry policies or your organisation's server-managed settings, could change it"

/**
 * The environment a session ends up with: the launch's, with each scope's `env` block over it (the lowest scope first,
 * so the highest wins), and for each variable a settings file set, which one.
 */
export function effectiveEnv(env: Record<string, string | undefined>, scopes: readonly SettingsScope[]): { env: Record<string, string | undefined>; from: Record<string, string> } {
  const out: Record<string, string | undefined> = { ...env }
  const from: Record<string, string> = {}
  for (const s of [...scopes].reverse()) {
    const block = s.json && typeof s.json === 'object' ? (s.json as Record<string, unknown>).env : undefined
    if (!block || typeof block !== 'object') continue
    for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
      if (v === null || v === undefined || typeof v === 'object') continue
      out[k] = String(v)
      from[k] = s.label
    }
  }
  return { env: out, from }
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
export function autoCompactOf(args: readonly string[], launchEnv: Record<string, string | undefined>, scopes: readonly SettingsScope[], models: readonly string[]): AutoCompactSetting {
  // What a scope Hive can't be sure of holds could change any answer (its env block is over the launch's): an estimate (#333).
  const unsure = scopes.filter((s) => s.unsure).map((s) => `${s.label} ${s.unsure}`).join('; ')
  const result = autoCompactRead(args, launchEnv, scopes, models)
  if (!unsure) return result
  return { ...result, estimate: result.estimate ? `${result.estimate}; and ${unsure}` : `an estimate: ${unsure}` }
}

function autoCompactRead(args: readonly string[], launchEnv: Record<string, string | undefined>, scopes: readonly SettingsScope[], models: readonly string[]): AutoCompactSetting {
  // The variables as Claude Code reads them: a settings file's env block over the launch environment.
  const { env, from } = effectiveEnv(launchEnv, scopes)
  const named = (k: string): string => (from[k] ? `${k} (env in ${from[k]})` : k)
  const pct = parseInt(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? '', 10)
  const percent = Number.isFinite(pct) && pct >= 1 && pct <= 100 ? { percent: pct } : {}
  const pctOnly = 'percent' in percent ? named('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE') : null
  if (envSwitch(env.DISABLE_COMPACT)) return { window: 'off', source: named('DISABLE_COMPACT') }
  const disableAuto = envSwitch(env.DISABLE_AUTO_COMPACT)
  if (disableAuto) return { window: 'off', source: named('DISABLE_AUTO_COMPACT') }
  for (const s of disableAuto === false ? [] : scopes) {
    const enabled = s.json && typeof s.json === 'object' ? (s.json as Record<string, unknown>).autoCompactEnabled : undefined
    if (enabled === false) return { window: 'off', source: `autoCompactEnabled: false in ${s.label}` }
    if (enabled === true) break
  }
  const fromEnv = envWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (fromEnv !== null) return { window: fromEnv, source: named('CLAUDE_CODE_AUTO_COMPACT_WINDOW'), ...percent }
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
  // Nothing Hive can read sets it: Claude Code's default, as far as Hive can tell.
  return { window: null, source: pctOnly, ...percent, estimate: UNREAD_SOURCES }
}

/** The most of a settings file Claude Code reads: it refuses a larger `--settings` (2.1.292: "exceeds the 2MiB limit"). */
export const SETTINGS_FILE_LIMIT = 2 * 1024 * 1024

/** How much of a settings file is read at a time. */
export const SETTINGS_READ_CHUNK = 64 * 1024

/**
 * A settings file's JSON, null when it's missing or isn't JSON (Claude Code skips such a file too); `unsure` when Hive
 * couldn't read it: not a regular file, over the limit or unreadable (#333). Opened only after a stat says it's a
 * regular file within the limit, so a device name, a pipe or a huge file never holds up the main process; then the
 * opened file is checked again and read to its end, a chunk at a time and never past a byte over the limit, since it
 * may have been replaced or grown since the stat.
 */
function readSettings(file: string): { json: unknown; unsure?: string } {
  const unread = (why: string): { json: null; unsure: string } => ({ json: null, unsure: `couldn't be read (${why})` })
  let fd: number | null = null
  try {
    const st = statSync(file, { throwIfNoEntry: false })
    if (!st) return { json: null }
    if (!st.isFile()) return unread("it isn't a file")
    if (st.size > SETTINGS_FILE_LIMIT) return unread("it's over Claude Code's 2 MiB limit")
    fd = openSync(file, 'r')
    if (!fstatSync(fd).isFile()) return unread("it isn't a file")
    const chunks: Buffer[] = []
    let n = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(SETTINGS_READ_CHUNK, SETTINGS_FILE_LIMIT + 1 - n))
      const got = readSync(fd, chunk, 0, chunk.length, null)
      if (!got) break
      chunks.push(chunk.subarray(0, got))
      n += got
      if (n > SETTINGS_FILE_LIMIT) return unread("it's over Claude Code's 2 MiB limit")
    }
    try {
      return { json: JSON.parse(Buffer.concat(chunks, n).toString('utf8').replace(/^\uFEFF/, '')) }
    } catch {
      return { json: null }
    }
  } catch (e) {
    return unread((e as NodeJS.ErrnoException).code ?? (e as Error).message)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The value of the last `--settings` (or `--settings=`) in arguments, trimmed: '' when it was given none (`--settings` at
 * the end, `--settings=`, an empty value), null without one (#361).
 */
export function settingsArgValue(args: readonly string[]): string | null {
  let value: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') value = args[i + 1] ?? ''
    else if (args[i].startsWith('--settings=')) value = args[i].slice('--settings='.length)
  }
  return value?.trim() ?? null
}

/** The value of the last `--settings` (or `--settings=`) in arguments, trimmed; undefined without one or without a value. */
export function lastSettingsArg(args: readonly string[]): string | undefined {
  return settingsArgValue(args) || undefined
}

/**
 * The command line's settings: the last `--settings` in the user's arguments (Claude Code reads only the last), a file
 * (relative to the session's folder) or inline JSON; null without one.
 */
export function cliSettings(args: readonly string[], cwd: string): SettingsScope | null {
  const v = lastSettingsArg(args)
  if (!v) return null
  if (v.startsWith('{')) {
    try {
      return { label: '--settings', json: JSON.parse(v) }
    } catch {
      return { label: '--settings', json: null }
    }
  }
  return { label: `--settings ${v}`, ...readSettings(isAbsolute(v) ? v : join(cwd, v)) }
}

/** The settings files `--setting-sources` can name. */
const SOURCES = ['user', 'project', 'local'] as const
type SettingSource = (typeof SOURCES)[number]

/**
 * The settings files Claude Code reads for the user's arguments besides managed settings and `--settings`, which it
 * always reads (#333; checked with Claude Code 2.1.292 in a test home): `--restricted` reads none of them, whatever
 * else is given; else the last `--setting-sources` (either form), a comma-separated list of `user`, `project` and
 * `local`, its names trimmed (an empty value reads none); null without either (all of them). A list Claude Code would
 * refuse (another name, an empty entry, a missing value: it doesn't start) is `invalid`, all of them kept.
 */
export function settingSources(args: readonly string[]): { sources: ReadonlySet<SettingSource> | null; invalid?: string } {
  if (args.includes('--restricted')) return { sources: new Set() }
  let value: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--setting-sources') value = args[i + 1] ?? null
    else if (args[i].startsWith('--setting-sources=')) value = args[i].slice('--setting-sources='.length)
    // A missing value (the last argument): Claude Code refuses it.
    if (args[i] === '--setting-sources' && i === args.length - 1) return { sources: null, invalid: '' }
  }
  if (value === null) return { sources: null }
  if (!value.trim()) return { sources: new Set() }
  const names = value.split(',').map((n) => n.trim())
  if (names.some((n) => !(SOURCES as readonly string[]).includes(n))) return { sources: null, invalid: value }
  return { sources: new Set(names as SettingSource[]) }
}

/** Arguments with which Hive can't tell which settings files Claude Code reads (they leave out customizations). */
const UNSURE_MODES = ['--safe-mode', '--bare']

/**
 * The settings scopes Claude Code reads for a session, highest first: managed (Windows), the command line's (the last
 * `--settings` in the user's arguments), the folder's .claude/settings.local.json and .claude/settings.json, then the
 * user's settings in its config folder; the last three only as far as `--setting-sources` and `--restricted` allow
 * (settingSources). Arguments that leave Hive unsure what it reads come last, as scopes holding nothing.
 */
export function settingsScopes(cwd: string, configDir: string, args: readonly string[] = []): SettingsScope[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const cli = cliSettings(args, cwd)
  const { sources, invalid } = settingSources(args)
  const reads = (s: SettingSource): boolean => !sources || sources.has(s)
  const file = (label: string, path: string): SettingsScope => ({ label, ...readSettings(path) })
  return [
    file('managed settings', join(programFiles, 'ClaudeCode', 'managed-settings.json')),
    ...(cli ? [cli] : []),
    ...(reads('local') ? [file("the project's .claude/settings.local.json", join(cwd, '.claude', 'settings.local.json'))] : []),
    ...(reads('project') ? [file("the project's .claude/settings.json", join(cwd, '.claude', 'settings.json'))] : []),
    ...(reads('user') ? [file("Claude Code's settings.json", join(configDir, 'settings.json'))] : []),
    ...(invalid !== undefined ? [{ label: `--setting-sources ${invalid}`.trim(), json: null, unsure: "isn't a list Claude Code takes (user, project, local)" }] : []),
    ...UNSURE_MODES.filter((m) => args.includes(m)).map((m) => ({ label: m, json: null, unsure: 'may stop Claude Code reading some settings files' }))
  ]
}
