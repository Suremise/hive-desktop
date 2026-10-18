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
import { sessions } from './sessions'
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
async function waits(projectPath: string, agentId: string): Promise<boolean> {
  const st = sessions.liveFor(projectPath, agentId)
  return handOverWaits(st, !!(await runningLane(projectPath, agentId)))
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
    const lane = h.lane ? await getLane(workspaceOf(projectPath), h.lane).catch(() => null) : null
    // Again after the await: what it was queued on may have changed meanwhile.
    const now = sessions.liveFor(projectPath, agentId)
    if (now?.runId !== st.runId || !now.handOverAfter) return
    const d = handOverDecision(now, lane, (need) => readyFor(now, need))
    if ('wait' in d) {
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
      else await inWorkspace(ws, () => sessions.handOver(projectPath, agentId, agentId, { handover: true }, moment === 'between'))
    } catch (e) {
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
