/**
 * Hand-overs at a good moment (#1057): a long transcript's notice or footer queues one for an agent that is busy or on a
 * card of a running lane (shared/handOver.ts says when), and Hive does it here once that moment comes. The queue is the
 * agent's running session's (`handOverAfter`): it ends with that launch, and the window shows and cancels it.
 *
 * Looked at again whenever what decides it can change: the agent's status, the board (its card moves), the lanes and
 * the merge slots; and each minute for a slot that ran out quietly.
 */
import { basename } from 'path'
import { handOverDecision, handOverWaits, handOverWhen, HAND_OVER_TEXT } from '../shared/handOver'
import { tr } from '../shared/i18n'
import type { LaneInfo, LiveSessionState } from '../shared/types'
import { NotGiven } from './deliveries'
import { onHiveEvent, toast } from './events'
import { HiveError, shownError } from './hiveError'
import { getLane, laneOf, onLanesWritten } from './lanes'
import { createLogger, userText } from './logger'
import { readyFor } from './readiness'
import { HandOverMomentLost, sessions } from './sessions'
import { inWorkspace, workspaceOf } from './workspace'

const log = createLogger('handover')

const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`
/** Agents being looked at, or handed over, now: one at a time per agent. */
const doing = new Set<string>()
/** Agents something changed for while they were being looked at: looked at again once that is done. */
const again = new Set<string>()
/** Why each queued hand-over waits, as last logged: a line when it changes (what a test or Copy Diagnostics follows). */
const waitingFor = new Map<string, string>()

const isAssistant = (projectPath: string): boolean => {
  try {
    return workspaceOf(projectPath).isAssistantHome(projectPath)
  } catch {
    return false
  }
}

/** The running lane an agent is builder or reviewer of (the Assistant and a project no window has: none). */
async function runningLane(projectPath: string, agentId: string): Promise<LaneInfo | null> {
  if (isAssistant(projectPath)) return null
  return laneOf(workspaceOf(projectPath), basename(projectPath), agentId).catch(() => null)
}

/** Whether a hand-over asked for now waits for a good moment (the notice's choice of button). */
async function waits(projectPath: string, agentId: string, turnOver = false): Promise<boolean> {
  const st = sessions.liveFor(projectPath, agentId)
  // turnOver: as if its turn were over (a hand-over about to end its conversation): only the merge slot and the lane count.
  return handOverWaits(turnOver && st ? { ...st, status: 'finished', backgroundTasks: 0 } : st, !!(await runningLane(projectPath, agentId)))
}

/**
 * Queues a running agent's hand-over (the notice's or the footer's Hand Over After This Card, the ⋯ menu): after its
 * lane card when it is on one, else when its turn is next over. Done at once if that moment is now. Null: not running.
 */
export async function queueHandOver(projectPath: string, agentId: string): Promise<LiveSessionState['handOverAfter'] | null> {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st || st.status === 'stopped') return null
  if (st.handOverAfter) return st.handOverAfter
  const lane = await runningLane(projectPath, agentId)
  const after = { card: lane ? lane.current : null, lane: lane?.id ?? null, since: new Date().toISOString() }
  if (!sessions.setHandOverAfter(projectPath, agentId, st.runId, after)) return null
  const assistant = isAssistant(projectPath)
  const name = sessions.agentLabel(st)
  log.info(`${userText(name)}: hand-over queued${lane ? ` (lane ${lane.id}, card ${after.card ?? 'none'})` : ''}`)
  toast(
    'info',
    tr(HAND_OVER_TEXT.queued, { assistant: assistant ? 'yes' : 'no', agent: name }),
    tr(HAND_OVER_TEXT.queuedText, handOverWhen(after, assistant)),
    [{ label: tr(HAND_OVER_TEXT.cancel), command: 'session.cancelHandOverLater', args: [projectPath, agentId] }],
    projectPath
  )
  void check(projectPath, agentId)
  return after
}

/**
 * A long conversation's hand-over as the notice and the footer offer it, decided when clicked: Hand Over to… (`dialog`,
 * for the window to open) while the agent is idle and on no running lane, else queued (`queued`). Null: not running.
 */
export async function handOverLongConversation(projectPath: string, agentId: string): Promise<'dialog' | 'queued' | null> {
  if (!isAssistant(projectPath) && !(await waits(projectPath, agentId))) return 'dialog'
  return (await queueHandOver(projectPath, agentId)) ? 'queued' : null
}

/** Cancels a queued hand-over (one being done already carries on). */
export function cancelHandOver(projectPath: string, agentId: string): void {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st?.handOverAfter) return
  sessions.setHandOverAfter(projectPath, agentId, st.runId, null)
  waitingFor.delete(keyOf(projectPath, agentId))
  log.info(`${userText(sessions.agentLabel(st))}: queued hand-over cancelled`)
}

/** Whether an agent's queued hand-over is due, and if so does it. */
async function check(projectPath: string, agentId: string): Promise<void> {
  const key = keyOf(projectPath, agentId)
  if (doing.has(key)) {
    again.add(key)
    return
  }
  const st = sessions.liveFor(projectPath, agentId)
  const h = st?.handOverAfter
  if (!st || !h) return
  doing.add(key)
  try {
    // The lane it is on now (one it joined since counts), else the one it was queued on, as it is now.
    const lane = (await runningLane(projectPath, agentId)) ?? (h.lane ? await getLane(workspaceOf(projectPath), h.lane).catch(() => null) : null)
    // Again after the await: what it was queued on may have changed meanwhile.
    const now = sessions.liveFor(projectPath, agentId)
    if (now?.runId !== st.runId || !now.handOverAfter) return
    const d = handOverDecision(now, lane, (need) => readyFor(now, need))
    if ('wait' in d) {
      // Waiting for another card now: kept on the queue, so the notice's and the footer's words follow it.
      if (d.follow && (now.handOverAfter.lane !== d.follow.lane || now.handOverAfter.card !== d.follow.card)) {
        sessions.setHandOverAfter(projectPath, agentId, st.runId, { ...now.handOverAfter, ...d.follow })
        log.info(`${userText(sessions.agentLabel(now))}: queued hand-over now after card ${d.follow.card} (lane ${d.follow.lane})`)
      }
      // With the lane's card, so a move of the lane under the same reason is a line too.
      // i18n-ignore: a log line (English)
      const why = `${d.wait}${lane ? `, lane on #${lane.current ?? 'none'}` : ''}`
      if (waitingFor.get(key) !== why) log.info(`${userText(sessions.agentLabel(now))}: queued hand-over waits (${why})`)
      waitingFor.set(key, why)
      return
    }
    waitingFor.delete(key)
    const moment = d.do
    sessions.setHandOverAfter(projectPath, agentId, st.runId, null)
    const name = sessions.agentLabel(now)
    const ws = workspaceOf(projectPath)
    log.info(`${userText(name)}: handing over (${moment})`)
    try {
      if (isAssistant(projectPath)) await inWorkspace(ws, () => sessions.startAfresh(projectPath, agentId))
      else {
        // Still the moment it was, just before its conversation ends (#1057 round 3): its launch, no merge slot, and its lane
        // card through with the next not begun (readiness aside: it is told to stop once the handover is written).
        const stillSafe = async (): Promise<boolean> => {
          const cur = sessions.liveFor(projectPath, agentId)
          if (!cur || cur.runId !== st.runId) return false
          const l = (await runningLane(projectPath, agentId)) ?? (h.lane ? await getLane(ws, h.lane).catch(() => null) : null)
          const still = handOverDecision({ ...cur, handOverAfter: h }, l, () => true)
          return 'do' in still && still.do === moment
        }
        await inWorkspace(ws, () => sessions.handOver(projectPath, agentId, agentId, { handover: true }, moment, stillSafe))
      }
    } catch (e) {
      // The moment lost while it wrote its handover (the merge slot, the next card, a lane): queued again, and said so.
      if (e instanceof HandOverMomentLost && sessions.liveFor(projectPath, agentId)?.runId === st.runId) {
        sessions.setHandOverAfter(projectPath, agentId, st.runId, h)
        log.info(`${userText(name)}: the moment was lost while it wrote its handover; queued again`)
        toast('info', tr(HAND_OVER_TEXT.queued, { assistant: 'no', agent: name }), shownError(e), [{ label: tr(HAND_OVER_TEXT.cancel), command: 'session.cancelHandOverLater', args: [projectPath, agentId] }], projectPath)
        return
      }
      // Not given after all (it took a turn meanwhile, or is busy): queued again for its next good moment.
      if (e instanceof NotGiven || (e instanceof HiveError && e.kind === 'conflict' && sessions.liveFor(projectPath, agentId)?.runId === st.runId)) {
        sessions.setHandOverAfter(projectPath, agentId, st.runId, h)
        return
      }
      log.warn(`${userText(name)}: the queued hand-over failed`, e)
      toast('error', tr(HAND_OVER_TEXT.failed, { agent: name }), shownError(e), undefined, projectPath)
    }
  } finally {
    doing.delete(key)
    if (again.delete(key)) void check(projectPath, agentId)
  }
}

/** Every agent with a queued hand-over (all windows'), looked at again. */
function checkAll(): void {
  for (const st of sessions.liveStates()) if (st.handOverAfter) void check(st.projectPath, st.agentId)
}

let started = false

/** Follows what decides queued hand-overs. Once, at startup. */
export function startHandOverLater(): void {
  if (started) return
  started = true
  sessions.handOverWaits = waits
  onHiveEvent((e) => {
    if (e.type === 'session-status') {
      if (e.state.handOverAfter) void check(e.state.projectPath, e.state.agentId)
    } else if (e.type === 'tasks-changed' || e.type === 'merge-slots-changed' || e.type === 'lanes-changed') checkAll()
  })
  onLanesWritten(checkAll)
  const tick = setInterval(checkAll, 60_000)
  tick.unref?.()
}
