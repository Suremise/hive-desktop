import type { TestedCli } from './types'

/**
 * The CLI versions this Hive release was tested with (#365), in words, for Agent Setup, Copy Diagnostics and the
 * Agent API: the versions side by side, and a note when the installed one isn't the tested one. Calm on purpose: a
 * newer CLI usually works, so nothing is blocked.
 */

/** "Tested with 2.1.287 · installed 2.1.290" (the installed version unknown: "installed version unknown"). */
export function testedSummary(t: TestedCli, installed: string | null): string {
  return `Tested with ${t.version} · ${installed && t.installed !== 'unknown' ? `installed ${installed}` : 'installed version unknown'}`
}

/** What to make of the installed version against the tested one; null when they are the same. */
export function testedNote(t: TestedCli): string | null {
  switch (t.installed) {
    case 'same':
      return null
    case 'newer':
      return 'This version came out after this Hive release was tested. Most updates work; if something behaves oddly, report it (Copy Diagnostics).'
    case 'older':
      return 'Older than tested; consider updating.'
    case 'unknown':
      return "Hive couldn't tell which version is installed, so it can't compare it with the tested one."
  }
}

/** The installed version against the tested one, in a few words (diagnostics, the Agent API). */
export const testedComparison = (t: TestedCli): string => (t.installed === 'same' ? 'the tested version' : t.installed === 'unknown' ? 'version unknown' : `${t.installed} than tested`)
