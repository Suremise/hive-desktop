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

/** A list joined as a language joins it (fmt.list's shape): passed in with tr, as this module can't load the i18n runtime. */
export type ListWords = (items: readonly string[], type?: 'conjunction' | 'unit') => string

/** Lists in Hive's English, as the Agent API and agents read them: "A, B and C". */
const englishList: ListWords = (items, type = 'conjunction') => new Intl.ListFormat('en-GB', { type, style: type === 'unit' ? 'short' : 'long' }).format(items)

/**
 * The leftovers in a line: "node serve.js, 4 × tail -f …" (each label once, with how many share it), at most `max` labels,
 * then how many more. In the window's language with its tr and list (fmt.list), else English.
 */
export function leftoversSummary(l: Pick<AgentLeftovers, 'processes' | 'more'>, max = 4, words?: { tr: Tr; list: ListWords }): string {
  const counts = [...l.processes.reduce((m, p) => m.set(p.label, (m.get(p.label) ?? 0) + 1), new Map<string, number>())]
  const shown = counts.slice(0, max)
  const extra = l.processes.length - shown.reduce((a, [, n]) => a + n, 0) + l.more
  const tr = words?.tr
  const labels = shown.map(([label, n]) => (n < 2 ? label : tr ? tr(msg({ id: 'session.leftovers.times', defaultMessage: '{n, number} × {label}', description: 'A process an agent left running, in a list of them, when several run the same command: how many, and the command ({label}: "tail -f capture.log").' }), { n, label }) : `${n} × ${label}`)) // i18n-ignore: English for agents and the Agent API (the window passes tr)
  const list = words?.list ?? englishList
  if (extra <= 0) return list(labels, 'unit')
  const more = tr ? tr(msg({ id: 'session.leftovers.more', defaultMessage: '{n, plural, one {# more process} other {# more processes}}', description: 'The last item of a list of the processes an agent left running, after the first few: how many more there are. Hive joins it to the list ("node serve.js, 2 × tail -f capture.log and 3 more processes").' }), { n: extra }) : `${extra} more ${extra === 1 ? 'process' : 'processes'}` // i18n-ignore: English for agents and the Agent API (the window passes tr)
  return list([...labels, more])
}
