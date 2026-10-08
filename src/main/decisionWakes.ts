import { app } from 'electron'
import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import type { LiveSessionState } from '../shared/types'
import { cardReadsBy, newDecisionsOn } from './decisionNotices'
import { onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { noteOnCard } from './tasks'
import { confirmTaken } from './watches'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Decisions reach an agent waiting for the user (#401). An agent asks the user, and its turn ends; the user answers
 * elsewhere (through the Assistant), and the answer is recorded on its card as decisions (#357). An agent waiting makes no
 * tool calls, so the flag in its next reply never comes: Hive types one line into it, as a card watch's wake is typed
 * (#376, #430: taken, or marked), when its turn has ended (ready or finished: not working, not on background tasks, not
 * watching, whose wake tells it, and never into a question or permission prompt it shows), the user isn't typing there
 * and no line of Hive's waits to be taken. Decisions landing together are told together: after a short settle. What a
 * line told isn't told again (in memory); the card's history says whom Hive told. The Assistant's own cards aren't its:
 * project agents only. A line worked out is typed only while it is still true: until Enter, nothing on the board changed
 * and the agent read no card since (else it is worked out again later); one refused is tried again after a settle.
 */

const log = createLogger('decisions')

/** How long after a board change (or a turn's end) Hive waits before telling, so decisions recorded together are told together. */
const SETTLE_MS = 15_000
/** However the board keeps changing, it tells at most this long after the first change it waits on. */
const SETTLE_MAX_MS = 60_000
export const testHooks: { settleMs?: number } = {}
const settleMs = (): number => {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_DECISION_SETTLE_MS) : NaN
  return testHooks.settleMs ?? (Number.isFinite(v) && v >= 0 ? v : SETTLE_MS)
}

/** What each agent was told, per card: the newest decision a line covered (ms). Bounded. */
const told = new Map<string, Map<number, number>>()
const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`
/** Agents being told now (one line at a time each). */
const telling = new Set<string>()

/** Board changes per workspace (this run): a line worked out before one may be out of date (reassigned, a decision removed). */
const boardGen = new Map<string, number>()
const genOf = (ws: WorkspaceService): number => boardGen.get((ws.path ?? '').toLowerCase()) ?? 0
// Counted from the start, whether or not decision lines are wired in (initDecisionWakes), so tests see it too.
onHiveEvent((e) => {
  if (e.type === 'tasks-changed') boardGen.set(e.workspacePath.toLowerCase(), (boardGen.get(e.workspacePath.toLowerCase()) ?? 0) + 1)
})

/**
 * Agents with a line put off (the user typing, a line of Hive's waiting, the board changing as it was typed): tried
 * again after each settle (one timer per agent), however long the barrier lasts, until it is told, or nothing is new to
 * it any more, or it stops being ready (working, a prompt shown, its session ended: the end of its next turn checks
 * again). Logged once per spell.
 */
const pending = new Set<string>()
/** A line stopped because what it says may have changed: worked out again at once, up to this many times. */
const STALE_TRIES = 3
class Stale extends Error {}
function later(ws: WorkspaceService, projectPath: string, agentId: string): void {
  const key = keyOf(projectPath, agentId)
  pending.add(key)
  if (pending.size > 500) pending.delete(pending.values().next().value!)
  settle(`agent:${key}`, () => void tell(ws, projectPath, agentId).catch((e) => log.warn('telling of decisions', e)))
}

/** Whether an agent may be told now: its turn has ended, nobody types there, no line of Hive's waits. */
const ready = (st: LiveSessionState | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished')

/** The line: "[Hive] #392 has 4 new decisions from the user: read them (hive_read_task) and carry on." */
export function decisionLine(cards: Map<number, { count: number }>): string {
  const parts = [...cards].map(([n, d]) => `#${n} has ${d.count} new decision${d.count === 1 ? '' : 's'}`)
  const them = parts.length === 1 && [...cards.values()][0].count === 1 ? 'it' : 'them'
  return `[Hive] ${parts.join(', ')} from the user: read ${them} (hive_read_task) and carry on from where you asked.`
}

/** Tells one agent of the decisions new to it, if it may be told now. */
async function tell(ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> {
  const key = keyOf(projectPath, agentId)
  if (telling.has(key) || ws.isAssistantHome(projectPath)) return
  // Not ready (working, on background tasks, watching, a prompt shown, stopped): the end of its turn checks again. Its
  // workspace closed: nothing to tell it from.
  if (!ready(sessions.liveFor(projectPath, agentId)) || !openWorkspaces().includes(ws)) {
    pending.delete(key)
    return
  }
  const agent = { projectPath, agentId }
  telling.add(key)
  try {
    const def = projectAgents(await ws.projectConfig(projectPath)).find((a) => a.id === agentId)
    if (!def) {
      pending.delete(key)
      return
    }
    const self = `${def.name} (${basename(projectPath)})`
    let cards: Awaited<ReturnType<typeof newDecisionsOn>>
    let line: string
    let before: ReturnType<typeof sessions.promptsTaken>
    for (let attempt = 0; ; attempt++) {
      // What the line is worked out from: the board and the agent's reads as they are now.
      const gen = genOf(ws)
      const reads = cardReadsBy(agent)
      cards = await newDecisionsOn(ws, agent, self, told.get(key))
      if (!cards.size) {
        pending.delete(key)
        return
      }
      line = decisionLine(cards)
      // Still true, and still the moment: checked before typing, before each piece of it and before Enter.
      const stillSo = (): void => {
        if (!openWorkspaces().includes(ws)) throw new Error('Its workspace was closed.')
        if (genOf(ws) !== gen) throw new Stale('The board changed.')
        if (cardReadsBy(agent) !== reads) throw new Stale('It read a card.')
        if (!ready(sessions.liveFor(projectPath, agentId))) throw new Error('The agent got busy.')
        if (sessions.userMayBeTyping(projectPath, agentId)) throw new Error('The user is typing there.')
        if (sessions.lineWaiting(projectPath, agentId)) throw new Error("A line Hive typed there isn't taken yet.")
      }
      before = sessions.promptsTaken(projectPath, agentId)
      try {
        stillSo()
        await sessions.sendPrompt(projectPath, agentId, line, stillSo)
        break
      } catch (e) {
        // The board changed or it read a card as the line was typed (often only the file watcher's echo of a change
        // already counted): worked out again at once, a few times. Anything else: after another settle. Nothing told.
        if (e instanceof Stale && attempt < STALE_TRIES) continue
        if (!pending.has(key)) log.info(`Telling ${userText(self)} of new decisions put off until it can be: ${(e as Error).message}`)
        later(ws, projectPath, agentId)
        return
      }
    }
    pending.delete(key)
    const known = told.get(key) ?? new Map<number, number>()
    for (const [n, d] of cards) known.set(n, Math.max(known.get(n) ?? 0, d.latest))
    told.delete(key)
    told.set(key, known)
    if (told.size > 500) told.delete(told.keys().next().value!)
    log.info(`Told ${userText(self)} of new decisions on ${[...cards.keys()].map((n) => `#${n}`).join(', ')}`)
    if (before) void confirmTaken(projectPath, agentId, before, line).catch((e) => log.warn('checking a line was taken', e))
    // Noted before the next agent is told (tellAll), so these board changes don't stop its line part-way.
    await Promise.all([...cards].map(([n, d]) => noteOnCard(n, `Told ${self} of ${d.count} new decision${d.count === 1 ? '' : 's'}`, ws).catch((e) => log.warn(`noting on #${n} that decisions were told`, e))))
  } finally {
    telling.delete(key)
  }
}

/** Every running project agent of a workspace that may be told. */
async function tellAll(ws: WorkspaceService): Promise<void> {
  for (const st of sessions.liveStates()) if (workspaceFor(st.projectPath) === ws && ready(st)) await tell(ws, st.projectPath, st.agentId)
}

/** A settle per workspace (and per agent at its turn's end): reset by each change, never past SETTLE_MAX_MS. */
const settling = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
function settle(key: string, fn: () => void): void {
  const had = settling.get(key)
  const since = had?.since ?? Date.now()
  if (had) clearTimeout(had.timer)
  const wait = Math.max(0, Math.min(settleMs(), since + SETTLE_MAX_MS - Date.now()))
  const timer = setTimeout(() => {
    settling.delete(key)
    fn()
  }, wait)
  timer.unref?.()
  settling.set(key, { timer, since })
}

let started = false
/** Wires decision lines into the board's and sessions' events (once, at start). */
export function initDecisionWakes(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) settle(`ws:${e.workspacePath.toLowerCase()}`, () => void tellAll(ws).catch((err) => log.warn('telling of decisions', err)))
    } else if (e.type === 'session-status' && ready(e.state)) {
      // Its turn ended: decisions recorded while it worked (and not read since) reach it now.
      const { projectPath, agentId } = e.state
      const ws = workspaceFor(projectPath)
      if (ws && !ws.isAssistantHome(projectPath)) settle(`agent:${keyOf(projectPath, agentId)}`, () => void tell(ws, projectPath, agentId).catch((err) => log.warn('telling of decisions', err)))
    }
  })
}

/** Checks now (what a settled change does): for tests. */
export const tellNow = (ws: WorkspaceService, projectPath: string, agentId: string): Promise<void> => tell(ws, projectPath, agentId)
