import { msg } from './i18n/msg'
import type { Tr } from './tasks'

/** A process an agent's launch started (its job's, #507), as listed to the user. */
export interface AgentProcess {
  pid: number
  /** Its executable's file name (node.exe). */
  name: string
  /** What it runs, short: the executable without .exe and its arguments, paths cut to their last part (node serve.js --port 8080). */
  label: string
  /** When it started (a Windows FILETIME, as text): with its pid, which process it is, kept across Hive's restart (#614). */
  created?: string
}

/** What an agent's stopped launches left running. No processes: nothing (any more). */
export interface AgentLeftovers {
  projectPath: string
  agentId: string
  agentName: string
  processes: AgentProcess[]
  /** Processes running beyond those listed. */
  more: number
  /** When the earliest of them was found left running (ISO). */
  since: string
}

/** What to do with the processes an agent leaves running when it stops (Settings → Agents). */
export type LeftoverProcessMode = 'ask' | 'end'
export const LEFTOVER_PROCESS_MODES: readonly LeftoverProcessMode[] = ['ask', 'end']

const MAX_LABEL = 80

/** The arguments of a Windows command line, as CommandLineToArgvW splits them (quotes kept out, enough for a label). */
function splitCommandLine(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let any = false
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted
      any = true
    } else if (!quoted && /\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

/** A path's last part: C:\a\b\serve.js is serve.js. Anything else as it is. */
const lastPart = (arg: string): string => (/^(?:[A-Za-z]:)?[\\/]/.test(arg) || /^[A-Za-z]:/.test(arg) ? (arg.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? arg) : arg)

/** A process as the user recognises it: `node npm-cli.js run serve`, `tail -f capture-1.log`. */
export function processLabel(name: string, commandLine: string): string {
  const exe = name.replace(/\.exe$/i, '')
  // The executable unquoted, with spaces in its path (C:\Program Files\Git\usr\bin\tail.exe -f x): up to its name.
  let line = commandLine.trim()
  const at = line.startsWith('"') ? -1 : line.toLowerCase().indexOf(name.toLowerCase())
  if (at >= 0 && /^(\s|$)/.test(line.slice(at + name.length))) line = `x${line.slice(at + name.length)}`
  const args = splitCommandLine(line).slice(1).map((a) => (a.includes(' ') ? `"${lastPart(a)}"` : lastPart(a)))
  const label = [exe, ...args].join(' ').replace(/\s+/g, ' ').trim()
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/** "2 processes": a count with its noun; in the window's language with tr (#799), else English (main's notices, until theirs are converted). */
export const processCount = (n: number, tr?: Tr): string =>
  tr ? tr(msg({ id: 'panes.processes.count', defaultMessage: '{n, plural, one {# process} other {# processes}}', description: 'How many processes an agent left running ("2 processes").' }), { n }) : `${n} process${n === 1 ? '' : 'es'}` // i18n-ignore: English for main's notices (the window passes tr)

/** The leftovers in a line: "node serve.js, 4 × tail -f …" (each label once, with how many share it), at most `max` labels. */
export function leftoversSummary(l: Pick<AgentLeftovers, 'processes' | 'more'>, max = 4, tr?: Tr): string {
  const counts = new Map<string, number>()
  for (const p of l.processes) counts.set(p.label, (counts.get(p.label) ?? 0) + 1)
  const labels = [...counts].map(([label, n]) => (n > 1 ? `${n} × ${label}` : label))
  const rest = labels.length - max
  const shown = labels.slice(0, max).join(', ')
  const extra = (rest > 0 ? l.processes.length - [...counts.values()].slice(0, max).reduce((a, b) => a + b, 0) : 0) + l.more
  if (extra <= 0) return shown
  if (tr) return tr(msg({ id: 'panes.processes.andMore', defaultMessage: '{shown} and {n, plural, one {# process} other {# processes}} more', description: 'The processes an agent left running, cut short: the first few ({shown}: "node serve.js, 4 × tail -f") and how many more.' }), { shown, n: extra })
  return `${shown} and ${processCount(extra)} more` // i18n-ignore: English for main's notices (the window passes tr)
}
