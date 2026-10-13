/**
 * A CLI's permission mode read from its footer on screen (#696): one pattern per mode, each an advanced setting
 * (`<provider>.footer.<key>`, src/shared/advanced.ts) whose default is the provider's table here. The main process
 * passes the values in from the adapters (`advanced.pattern()`); the defaults are for code that has none (tests).
 */
import type { PermissionMode } from './types'

/** One mode's footer: its advanced setting's key and title, and the default pattern. */
export interface FooterModeDef {
  mode: PermissionMode
  /** The setting is "<provider>.footer.<key>". */
  key: string
  /** The mode's name, for the setting's title. */
  label: string
  pattern: string
}

/** Each mode with the pattern that finds its footer. */
export type FooterPatterns = ReadonlyArray<readonly [PermissionMode, RegExp]>

export const footerPatterns = (defs: readonly FooterModeDef[], flags: string): FooterPatterns => defs.map((d) => [d.mode, new RegExp(d.pattern, flags)] as const)

const global = new WeakMap<RegExp, RegExp>()
/** A pattern that finds every match: the setting's own when it is global, else a copy kept with it. */
function everyMatch(re: RegExp): RegExp {
  if (re.global) return re
  let g = global.get(re)
  if (!g) global.set(re, (g = new RegExp(re.source, `${re.flags}g`)))
  return g
}

/** The mode whose footer is found last on screen (a redrawn footer leaves the old one above it); null when none is. */
export function lastFooterMode(text: string, patterns: FooterPatterns): PermissionMode | null {
  let best: PermissionMode | null = null
  let at = -1
  for (const [mode, re] of patterns)
    for (const m of text.matchAll(everyMatch(re)))
      if (m.index > at) {
        at = m.index
        best = mode
      }
  return best
}
