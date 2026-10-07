import { isAbsolute, join } from 'path'
import { readFile } from 'original-fs/promises'
import { lastSettingsArg } from './autoCompact'

/**
 * A `--settings` in the user's own arguments (#330). Claude Code reads only the last `--settings` it is given (checked
 * with 2.1.291 in a test home), so the user's would replace Hive's launch settings and with them every hook and the
 * status line. Instead Hive reads the user's settings, merges them into its own launch file and passes that alone.
 */

/** The user's arguments without any `--settings` (Hive's one launch settings file carries what it held). */
export function withoutSettingsArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') i++
    else if (!args[i].startsWith('--settings=')) out.push(args[i])
  }
  return out
}

/**
 * The settings of the last `--settings` in the user's arguments: inline JSON or a file (relative to the session's folder),
 * as an object; null without one. Throws, saying which argument, when Claude Code would have refused it too (a missing
 * file: "Settings file not found"), when it isn't a settings object, or when it would turn Hive's hooks off in a way a
 * merge can't undo (disableAllHooks, an HTTP hook allowlist that isn't a list), rather than launching without what it
 * asked for or without Hive's hooks.
 */
export async function userSettings(args: readonly string[], cwd: string): Promise<Record<string, unknown> | null> {
  const v = lastSettingsArg(args)
  if (!v) return null
  // Claude Code takes a value that parses as JSON as inline settings, and anything else as a file's path.
  let json: unknown
  let inline = false
  if (v.startsWith('{')) {
    try {
      json = JSON.parse(v)
      inline = true
    } catch {
      // not JSON: a file's name, as Claude Code reads it
    }
  }
  const what = inline ? 'The --settings in Extra arguments' : `The settings file ${v} (--settings in Extra arguments)`
  if (!inline) {
    const file = isAbsolute(v) ? v : join(cwd, v)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (e) {
      throw new Error(`${what} can't be read: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : (e as Error).message}. Fix it or remove it in Agent Settings or Settings → Claude Code.`, { cause: e })
    }
    try {
      json = JSON.parse(text.replace(/^﻿/, ''))
    } catch (e) {
      throw new Error(`${what} isn't valid JSON (${(e as Error).message}). Fix it or remove it in Agent Settings or Settings → Claude Code.`, { cause: e })
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${what} isn't a settings object ({ … }). Fix it or remove it in Agent Settings or Settings → Claude Code.`)
  // It would turn off Hive's hooks and status line with the user's (Claude Code 2.1.292): Hive can't keep both.
  if ((json as Record<string, unknown>).disableAllHooks === true) throw new Error(`${what} turns off all hooks (disableAllHooks), which Hive needs for the agent's status, file locks and status line. Remove it in Agent Settings or Settings → Claude Code.`)
  // A list's entries are added to (mergeLaunchSettings); anything else in its place blocks Hive's hooks (2.1.292).
  for (const key of HOOK_ALLOWLISTS) {
    if (key in json && !Array.isArray((json as Record<string, unknown>)[key])) throw new Error(`${what} sets ${key} to something other than a list, which stops Hive's hooks reaching it. Make it a list ([ … ]) or remove it in Agent Settings or Settings → Claude Code.`)
  }
  return json as Record<string, unknown>
}

/** Allowlists for HTTP hooks, which Claude Code takes whole from the highest settings file that sets one. */
const HOOK_ALLOWLISTS = ['allowedHttpHookUrls', 'httpHookAllowedEnvVars'] as const

/** What Hive's own hooks need from the settings: the URL its HTTP hooks post to and the variable their header reads. */
export interface HiveHookNeeds {
  url: string
  envVar: string
}

/**
 * Hive's launch settings with the user's merged in: every setting of theirs, and their hooks added to Hive's for each
 * event (Hive's first). Hive's status line wins, since a session has one and Hive's reports its context, cost and
 * limits. Their allowlists for HTTP hooks gain what Hive's hooks need, since Claude Code takes such a list whole from
 * the highest file that sets one, and without it blocks Hive's hooks (`allowedHttpHookUrls`) or sends them without
 * the token (`httpHookAllowedEnvVars`); checked with 2.1.292. Managed settings, above this file, still apply.
 */
export function mergeLaunchSettings(hive: { hooks: Record<string, unknown[]>; statusLine: unknown }, user: Record<string, unknown> | null, needs: HiveHookNeeds): Record<string, unknown> {
  if (!user) return { ...hive }
  const theirs = user.hooks && typeof user.hooks === 'object' && !Array.isArray(user.hooks) ? (user.hooks as Record<string, unknown>) : {}
  const hooks: Record<string, unknown[]> = { ...hive.hooks }
  for (const [ev, groups] of Object.entries(theirs)) {
    if (Array.isArray(groups)) hooks[ev] = [...(hooks[ev] ?? []), ...groups]
  }
  const out: Record<string, unknown> = { ...user, hooks, statusLine: hive.statusLine }
  const allowing = (key: (typeof HOOK_ALLOWLISTS)[number], entry: string): void => {
    const list = user[key]
    if (Array.isArray(list) && !list.includes(entry)) out[key] = [...list, entry]
  }
  allowing('allowedHttpHookUrls', needs.url)
  allowing('httpHookAllowedEnvVars', needs.envVar)
  return out
}
