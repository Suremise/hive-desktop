import { app } from 'electron'
import type { DeliveryNeed } from '../shared/deliveries'
import { createLogger, userText } from './logger'
import { readyFor } from './readiness'
import { sessions } from './sessions'

/**
 * The writer of Hive's lines into an agent's terminal (#649: what the delivery service types with, moved out of
 * watches.ts): one line at a time per agent, only while it can take one (readiness.ts), nobody types there and no line of
 * Hive's waits to be taken; checked before each piece and before Enter; then confirmed taken (#376, #430). It holds
 * sessions' composer reservation (`sendPrompt`'s), which the CLI controls (compaction) take too. The delivery service
 * (deliveries.ts) is its only caller for lines of Hive's own.
 */

// Its log lines are the wakes' as they always were (e2e suites read them).
const log = createLogger('watches')

/** How long a typed line has to be taken (the CLI starts a turn) before Enter is pressed again, once (#376). */
const TAKE_MS = 10_000
/** For unit tests: how long a typed line has to be taken (TAKE_MS). */
export const testHooks: { takeMs?: number } = {}
/** TAKE_MS, or a unit test's, or an unpackaged test build's (HIVE_TEST_WAKE_TAKE_MS). */
function takeMs(): number {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_WAKE_TAKE_MS) : NaN
  return testHooks.takeMs ?? (Number.isFinite(v) && v >= 0 ? v : TAKE_MS)
}

const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * What the writer is doing in the background: the confirmations that a typed line was taken. `settled()` resolves once
 * none is left (watches' and loop wakes' settled() wait for it too, #570).
 */
const inFlight = new Set<Promise<unknown>>()
function inBackground(what: string, work: Promise<unknown>): void {
  const p = work.catch((e) => log.warn(what, e))
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}
export async function settled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}
export const inFlightNow = (): boolean => inFlight.size > 0

/** Agents Hive is typing a line into now (one at a time each). */
const writing = new Set<string>()

/** Whether an agent has a line of Hive's being made that goes first (watches.ts: a fired watch whose line isn't made yet). */
let lineComing: (projectPath: string, agentId: string) => boolean = () => false
export function onLineComing(fn: (projectPath: string, agentId: string) => boolean): void {
  lineComing = fn
}

/**
 * Whether a line of Hive's could be typed into an agent now (typeLine's own conditions, before it asks what is wanted):
 * it can take one (`need`), nobody types there, no earlier line is waiting there, no line is being typed and none of a
 * watch's is being made. Null when it could; else why not, as the reply of a call that wanted it now says it.
 */
export function whyNoLine(projectPath: string, agentId: string, need: DeliveryNeed = 'idle'): string | null {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st) return "it isn't running"
  if (writing.has(agentKey(projectPath, agentId))) return 'Hive is already typing a line into it'
  if (!readyFor(st, need)) return st.status === 'watching' ? 'it is waiting on cards, and takes no new work until it is woken' : `it is ${st.status}`
  if (sessions.userMayBeTyping(projectPath, agentId)) return 'the user has just typed in its terminal and may still be writing there'
  if (sessions.lineWaiting(projectPath, agentId)) return "its CLI hasn't taken the line Hive typed before"
  if (lineComing(projectPath, agentId)) return "a watch's wake goes first"
  return null
}
export const canTypeLine = (projectPath: string, agentId: string, need: DeliveryNeed = 'idle'): boolean => whyNoLine(projectPath, agentId, need) === null

/**
 * What a typed line carries, for its confirmation (#530, #647): `still`, whether it may still be submitted, asked before
 * Enter is pressed again; `withdrawn` when it may not and the line was cleared instead (or left, the user's draft in it);
 * `confirming` with the launch and prompt count it was typed at while the confirmation runs, and `settled` once that has
 * ended; `taken` once its CLI took it (#650: not a receipt, the doorbell carries no text), never for a launch that ended first;
 * `lost` when that launch ended (or another began) before its CLI took it.
 */
export interface RideCheck {
  still: () => boolean
  /** `left`: the line is still in its prompt (the user's draft is in it, or it couldn't be cleared). */
  withdrawn: (left: boolean) => void
  confirming?: (before: { runId: string; count: number }) => void
  settled?: () => void
  taken?: () => void
  lost?: () => void
}

/**
 * Types a line of Hive's into an agent: only while it can take one (`need`), nobody types there, no earlier line is
 * waiting there; one at a time per agent; checked to be taken (#376). `wanted` is asked again before every piece and
 * before Enter. Whether it was typed (false: try again later).
 */
export async function typeLine(projectPath: string, agentId: string, line: string, wanted: () => boolean, opts: { ride?: RideCheck; need?: DeliveryNeed } = {}): Promise<boolean> {
  const key = agentKey(projectPath, agentId)
  const need = opts.need ?? 'idle'
  if (!canTypeLine(projectPath, agentId, need) || !wanted()) return false
  writing.add(key)
  try {
    // What the CLI had taken just before this line's Enter (#376): sampled by the writer's last check, after what it
    // carries was saved as offered (#647: a prompt of the user's taken while that save was slow isn't this line's), so a
    // confirmation never takes an earlier prompt for this one.
    let before: { runId: string; count: number } | null = null
    await sessions.sendPrompt(projectPath, agentId, line, () => {
      if (!wanted()) throw new Error('It is no longer wanted.')
      if (!readyFor(sessions.liveFor(projectPath, agentId), need)) throw new Error('The agent got busy.')
      if (sessions.userMayBeTyping(projectPath, agentId)) throw new Error('The user is typing there.')
      before = sessions.promptsTaken(projectPath, agentId)
    })
    log.info(`Woke ${userText(agentId)}: ${userText(line.slice(0, 80))}`)
    if (before) inBackground('checking a wake was taken', confirmTaken(projectPath, agentId, before, line, opts.ride))
    return true
  } catch (e) {
    log.info(`Wake for ${userText(agentId)} put off: ${(e as Error).message}`)
    return false
  } finally {
    writing.delete(key)
  }
}

/**
 * Whether a typed line was taken (#376): the CLI started a turn for it (UserPromptSubmit). On 7 Oct a Codex reviewer's
 * wake stayed in its prompt, unsent, for hours, while its watch had ended. Not taken in time, Enter is pressed again,
 * once; still not taken, it is logged, and the agent's cards show as stalled when its loop is checked (loopCheck.ts).
 */
export async function confirmTaken(projectPath: string, agentId: string, before: { runId: string; count: number }, line: string, ride?: RideCheck): Promise<boolean> {
  // Nothing more is typed into it while this runs, however long (#430): released when it ends (taken, or marked).
  const release = sessions.holdForConfirm(projectPath, agentId, before.runId)
  ride?.confirming?.(before)
  confirmsRunning++
  try {
    const r = await confirming(projectPath, agentId, before, line, ride)
    if (r === 'taken') ride?.taken?.()
    else if (r === 'gone') ride?.lost?.()
    return r === 'taken' || r === 'gone'
  } finally {
    confirmsRunning--
    ride?.settled?.()
    release?.()
  }
}
let confirmsRunning = 0
/** How many typed lines are being checked for being taken now: tests wait for none, after which no Enter comes. */
export const confirmsInFlight = (): number => confirmsRunning

async function confirming(projectPath: string, agentId: string, before: { runId: string; count: number }, line: string, ride?: RideCheck): Promise<'taken' | 'gone' | 'withdrawn' | 'kept' | false> {
  const t0 = Date.now()
  const taken = (): 'taken' | 'gone' | false => {
    const now = sessions.promptsTaken(projectPath, agentId)
    // Another launch (or none): what was typed has gone with the old one, untaken.
    if (!now || now.runId !== before.runId) return 'gone'
    if (now.count <= before.count) return false
    // Each wake's outcome in the log (#430): typed (Woke …), taken and how soon, Enter again, not taken.
    log.info(`The wake typed into ${userText(agentId)} was taken after ${Date.now() - t0} ms`)
    return 'taken'
  }
  const waitTaken = async (): Promise<'taken' | 'gone' | false> => {
    const end = Date.now() + takeMs()
    while (Date.now() < end) {
      const t = taken()
      if (t) return t
      await new Promise((r) => setTimeout(r, 250))
    }
    return taken()
  }
  const first = await waitTaken()
  if (first) return first
  // Enter again, once, when that is safe (the same launch, idle, nobody typing there, Hive not typing): waited for a
  // while rather than given up at once (#430). Never a third Enter.
  let retried = false
  let withheld = false
  for (const end = Date.now() + 6 * takeMs(); ; ) {
    const t = taken()
    if (t) return t
    // What the line carries may no longer be sent (#530: its sender's Control turned down, its session ended; #647:
    // expired, cancelled, the agent in another conversation): never submitted by this Enter. The line is cleared when
    // that is safe (as an Enter would be).
    if (ride && !ride.still()) {
      withheld = true
      // The user has typed into it since (round 3 finding): their draft, not Hive's line to clear or offer for Enter.
      if (sessions.userTypedOverLine(projectPath, agentId)) {
        ride.withdrawn(true)
        log.info(`Left the line typed into ${userText(agentId)} as it is: what rode it may no longer be sent, and the user has typed there since`)
        return 'kept'
      }
      if (sessions.clearTyped(projectPath, agentId, before.runId)) {
        ride.withdrawn(false)
        log.info(`Cleared the line typed into ${userText(agentId)}: what rode it may no longer be sent`)
        return 'withdrawn'
      }
    } else if (sessions.submitAgain(projectPath, agentId, before.runId)) {
      retried = true
      break
    }
    if (Date.now() >= end) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (retried) {
    log.warn(`The wake typed into ${userText(agentId)} wasn't taken: pressed Enter again`)
    const again = await waitTaken()
    if (again) return again
    log.warn(`The wake typed into ${userText(agentId)} still wasn't taken: it may be waiting in its prompt`)
  } else log.warn(`The wake typed into ${userText(agentId)} wasn't taken, and Enter couldn't be pressed again (${withheld ? 'what rode it may no longer be sent, and the line could not be cleared' : 'busy, or the user typing there'})`)
  // What it carries may no longer be sent and it couldn't be cleared: never offered for Enter (the user isn't asked to
  // send it).
  if (withheld) {
    ride!.withdrawn(true)
    return 'kept'
  }
  // Shown in its pane, the user told once, and nothing more typed into it until it is taken (#430).
  sessions.lineNotTaken(projectPath, agentId, before.runId, line, retried)
  return false
}
