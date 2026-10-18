/**
 * The Assistant's state view (#1032): what Hive gives the Assistant at each session start and after each compaction
 * (Claude Code sends SessionStart then too), while its journal is on. The board, lanes and agents in brief, what waits
 * on the user, and the few journal entries relevant now, within a hard budget, so its context stays small (#989's
 * decision). Pure: main gathers the input (main/startView.ts). Agent-facing, so English.
 */

import { utf8Bytes as bytes } from './metrics'

/** The view's most, in UTF-8 bytes: about 2,200 tokens at four bytes a token (#989: ~2–3k tokens). */
export const START_VIEW_MAX_BYTES = 9000

/** How long a card's title and an entry's summary may be in a line. */
const TITLE = 90
const SUMMARY = 160
const REASON = 120

export interface ViewCard {
  number: number
  title: string
  column: string
  project: string
  agent: string | null
  reviewer: string | null
  blocked: string | null
}

export interface ViewLane {
  project: string
  builder: string
  reviewer: string | null
  current: number | null
  state: string
  pausedOn: number | null
}

export interface ViewAgent {
  project: string
  name: string
  status: string
  /** What it asks the user, when it waits on them. */
  asking?: string | null
}

export interface ViewEntry {
  id: number
  at: string
  kind: string
  project: string | null
  summary: string
  importance: number
}

export interface StartViewInput {
  now: Date
  /** Why the session started: startup, resume, clear or compact (Claude Code's SessionStart source). */
  source: string | null
  /** Each project's cards per column (Todo, Doing, Review, Passed). */
  counts: { project: string; columns: Record<string, number> }[]
  /** Cards in Doing and Review. */
  active: ViewCard[]
  /** Cards blocked on a question (any column but Done). */
  blocked: ViewCard[]
  lanes: ViewLane[]
  /** Agents running (stopped ones are left out). */
  agents: ViewAgent[]
  journal: {
    /** Recent decisions and plans. */
    decisions: ViewEntry[]
    incidents: ViewEntry[]
    /** Entries linked to cards in Doing or Review (none of the above). */
    onCards: ViewEntry[]
    /** The last week with entries but no digest ("2026-W41"), or null. */
    digestDue: string | null
  }
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}


const COLUMN: Record<string, string> = { todo: 'Todo', doing: 'Doing', review: 'Review', passed: 'Passed', hold: 'On hold', done: 'Done' }
const columnName = (c: string): string => COLUMN[c] ?? c

const cardLine = (c: ViewCard): string => `- #${c.number} ${columnName(c.column)} · ${c.project}${c.agent ? ` · ${c.agent}` : ''}${c.reviewer ? `, reviewed by ${c.reviewer}` : ''}: ${clip(c.title, TITLE)}`

const entryLine = (e: ViewEntry): string => `- #${e.id} ${e.at.slice(0, 10)} ${e.kind}${e.project ? ` (${e.project})` : ''}${e.importance >= 2 ? ' !' : ''}: ${clip(e.summary, SUMMARY)}`

const laneLine = (l: ViewLane): string => `- ${l.builder}${l.reviewer ? `/${l.reviewer}` : ''} (${l.project}): ${l.state === 'paused' && l.pausedOn ? `paused on #${l.pausedOn}` : l.current ? `on #${l.current}, ${l.state}` : l.state}`

interface Section {
  title: string
  lines: string[]
  /** Said in place of the lines that don't fit. */
  more: string
}

/**
 * The view as text, never over START_VIEW_MAX_BYTES. Sections are given room in order of how much they matter (what
 * waits on the user, decisions and plans, the work in hand…), each line whole or not at all, with a count of what was
 * left out; they are shown in reading order.
 */
export function startView(v: StartViewInput): string {
  const when = `${v.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const why = v.source === 'compact' ? 'after a compaction' : v.source === 'resume' ? 'on resuming' : 'at session start'
  const head = `[Hive] Where things stand, ${why} (${when}): a snapshot from the board, lanes, agents and your journal. Check the live state before acting on it.`
  const foot = 'More with hive_journal_recall (small first; hive_journal_entry for one in full): the journal skill says how.'

  const waiting = [
    ...v.blocked.map((c) => `- #${c.number} (${c.project}, ${columnName(c.column)}${c.agent ? `, ${c.agent}` : ''}) blocked: ${clip(c.blocked ?? '', REASON)}`),
    ...v.agents.filter((a) => a.status === 'waiting' || a.status === 'signin').map((a) => `- ${a.name} (${a.project}) ${a.status === 'signin' ? 'needs signing in' : 'waits for the user'}${a.asking ? `: ${clip(a.asking, REASON)}` : ''}`)
  ]
  const byProject = new Map<string, ViewAgent[]>()
  for (const a of v.agents) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a])
  const agents = [...byProject].map(([p, list]) => `- ${p}: ${list.map((a) => `${a.name} ${a.status}`).join(', ')}`)
  const board = v.counts.map((p) => {
    const parts = ['doing', 'review', 'passed', 'todo'].filter((c) => p.columns[c]).map((c) => `${p.columns[c]} ${columnName(c)}`)
    return `- ${p.project}: ${parts.length ? parts.join(', ') : 'no open cards'}`
  })
  const digest = v.journal.digestDue ? [`- ${v.journal.digestDue} has entries but no digest: write one (kind digest, digestOf "${v.journal.digestDue}"; the journal skill).`] : []

  const S = {
    waiting: { title: 'Waiting on the user:', lines: waiting, more: 'hive_list_tasks and hive_list_projects' },
    decisions: { title: 'Journal: recent decisions and plans:', lines: v.journal.decisions.map(entryLine), more: 'hive_journal_recall kinds decision, plan' },
    active: { title: 'Cards in Doing and Review:', lines: v.active.map(cardLine), more: 'hive_list_tasks' },
    onCards: { title: 'Journal: on the cards in hand:', lines: v.journal.onCards.map(entryLine), more: 'hive_journal_recall with link card' },
    incidents: { title: 'Journal: recent incidents:', lines: v.journal.incidents.map(entryLine), more: 'hive_journal_recall kinds incident' },
    lanes: { title: 'Lanes running:', lines: v.lanes.map(laneLine), more: 'hive_lane list' },
    agents: { title: 'Agents running:', lines: agents.length ? agents : ['- none'], more: 'hive_list_projects' },
    board: { title: 'Board:', lines: board, more: 'hive_list_tasks' },
    digest: { title: 'Weekly digest:', lines: digest, more: '' }
  } satisfies Record<string, Section>
  const priority: (keyof typeof S)[] = ['waiting', 'decisions', 'active', 'digest', 'onCards', 'incidents', 'lanes', 'agents', 'board']
  const order: (keyof typeof S)[] = ['waiting', 'active', 'lanes', 'agents', 'board', 'decisions', 'onCards', 'incidents', 'digest']

  let room = START_VIEW_MAX_BYTES - bytes(head) - bytes(foot) - 2
  const kept = new Map<keyof typeof S, string[]>()
  for (const k of priority) {
    const s = S[k]
    if (!s.lines.length) continue
    const out: string[] = []
    // The section's title, and room for its "more" line should a line not fit.
    const moreLine = (n: number): string => `- (${n} more: ${s.more})`
    let used = bytes(s.title) + 1
    const reserve = bytes(moreLine(s.lines.length)) + 1
    if (used + reserve > room) continue
    for (const [i, line] of s.lines.entries()) {
      const last = i === s.lines.length - 1
      const cost = bytes(line) + 1
      if (used + cost + (last ? 0 : reserve) > room) {
        out.push(moreLine(s.lines.length - i))
        used += bytes(out.at(-1)!) + 1
        break
      }
      out.push(line)
      used += cost
    }
    if (!out.length) continue
    kept.set(k, out)
    room -= used
  }
  const body = order.filter((k) => kept.has(k)).flatMap((k) => [S[k].title, ...kept.get(k)!])
  return [head, ...body, foot].join('\n')
}
