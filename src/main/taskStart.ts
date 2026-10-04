import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import { columnLabel, taskPrompt } from '../shared/tasks'
import type { TaskCard, TaskStartTarget } from '../shared/types'
import { emit } from './events'
import { addAgent, removeAgent } from './projectAgents'
import { sessions } from './sessions'
import { getTask, updateTask, type TaskActor } from './tasks'
import { createLogger, userText } from './logger'
import { workspace } from './workspace'

const log = createLogger('tasks')

const STATUS_WORDS: Record<string, string> = {
  working: 'is working',
  starting: 'is starting',
  waiting: 'is waiting for the user',
  background: 'is waiting on background tasks it started',
  watching: 'is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header)'
}

/** Cards being started now ("<workspace>#<n>"): a second Start of the same card is refused, not run twice. */
const starting = new Set<string>()

/**
 * Agents being given a card now ("<project>|<agent id>"), from the first look at them until shortly after the prompt
 * went in (before its hook says the agent is working): a second Start for the same agent, of another card, is refused
 * rather than typed into the first one's work.
 */
const busyAgents = new Set<string>()
/** How long an agent stays reserved after its prompt went in, for its status to catch up. */
const SETTLE_MS = 5000

/** A Start's note is typed into the agent's terminal with the card. */
const MAX_NOTE = 4000

/**
 * Start on a card: gives it to an agent of its project (one that is stopped or idle, or a new one, in the project
 * folder or a new worktree) with the card as its prompt, and puts the card in Doing. A card in Review or Done is
 * started again for more work (it goes back to Review when that is done). The card is taken first, checked under
 * its lock (not archived or moved to Done meanwhile), so the prompt is the card as it now is; if the agent then
 * can't be started, the card goes back where it was and a new agent is removed again. note: what to do now (such as
 * "address the latest review comment"), added to the prompt.
 */
export async function startTask(n: number, target: TaskStartTarget, actor: TaskActor, note?: string): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean }> {
  if (note && note.length > MAX_NOTE) throw new Error(`The note is too long (at most ${MAX_NOTE} characters).`)
  const key = `${(workspace.path ?? '').toLowerCase()}#${n}`
  if (starting.has(key)) throw new Error(`#${n} is already being started.`)
  starting.add(key)
  try {
    return await startReserved(n, target, actor, note?.trim() || undefined)
  } finally {
    starting.delete(key)
  }
}

/**
 * Whether the agent can be given a card now: stopped (it is started with it) or idle (the prompt is typed in), and
 * for a Start that isn't the user's, not where the user has just typed. Checked when the Start begins and again just
 * before the prompt goes in, since the agent may have started work meanwhile.
 */
function availability(p: string, agentId: string, agentName: string, actor: TaskActor): { live: boolean } {
  const st = sessions.liveFor(p, agentId)
  if (st && STATUS_WORDS[st.status]) throw new Error(`${agentName} ${STATUS_WORDS[st.status]}. Start the task once it's idle, or give it to another agent.`)
  if (st && actor.kind !== 'user' && sessions.userMayBeTyping(p, agentId)) throw new Error(`The user has just typed in ${agentName}'s terminal and may still be writing there. Ask the user first.`)
  return { live: !!st }
}

function startable(card: TaskCard): void {
  if (card.archived) throw new Error(`#${card.number} is archived. Bring it back first.`)
  if (!card.project) throw new Error(`#${card.number} has no project. Give it one first: the agent works in that project.`)
}

async function startReserved(n: number, target: TaskStartTarget, actor: TaskActor, note: string | undefined): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean }> {
  const before = await getTask(n)
  startable(before)
  const p = workspace.assertProject(join(workspace.path!, before.project))

  let agentId: string
  let agentName: string
  let reserved: string | null = null
  if (target.kind === 'agent') {
    const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === target.agentId || x.name.toLowerCase() === target.agentId.toLowerCase())
    if (!a) throw new Error(`Unknown agent "${target.agentId}" in ${before.project}`)
    agentId = a.id
    agentName = a.name
    availability(p, a.id, a.name, actor)
    const agentKey = `${p.toLowerCase()}|${a.id}`
    if (busyAgents.has(agentKey)) throw new Error(`${a.name} is being given another card. Start this one once it's idle, or give it to another agent.`)
    busyAgents.add(agentKey)
    reserved = agentKey
  } else {
    const def = await addAgent(p, { name: target.name, location: target.worktree ? 'new-worktree' : 'project', provider: target.provider })
    agentId = def.id
    agentName = def.name
  }
  let typed = false
  try {
    const { typed: t, ...result } = await giveCard(n, before, p, agentId, agentName, target.kind !== 'agent', actor, note)
    typed = t
    return result
  } finally {
    // A prompt typed into a running agent: kept a moment, until the agent's own status says it's working (an agent
    // started with the card is "starting" at once).
    if (reserved) {
      const k = reserved
      if (typed) setTimeout(() => busyAgents.delete(k), SETTLE_MS).unref?.()
      else busyAgents.delete(k)
    }
  }
}

async function giveCard(
  n: number,
  before: TaskCard,
  p: string,
  agentId: string,
  agentName: string,
  added: boolean,
  actor: TaskActor,
  note: string | undefined
): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean; typed: boolean }> {
  const undoAgent = async (): Promise<void> => {
    if (added) await removeAgent(p, agentId, { deleteWorktree: true }).catch((e) => log.warn(`Could not remove ${userText(agentName)} after #${n} didn't start`, e))
  }

  // Taken first, on the card as it is now: it must still be startable, and in the project, column and with the agent
  // this Start read. Anything else is a newer decision (moved, reassigned, put in Done) and stays.
  let card: TaskCard
  try {
    card = await updateTask(n, { agent: agentId, ...(before.column === 'doing' ? {} : { column: 'doing' as const }) }, actor, {
      check: (now) => {
        startable(now)
        if (now.project.toLowerCase() !== before.project.toLowerCase()) throw new Error(`#${n} moved to ${now.project || 'the workspace'} meanwhile. Start it again.`)
        if (now.column === 'done' && before.column !== 'done') throw new Error(`#${n} was moved to Done meanwhile. Start it again if there is more to do.`)
        if (now.column !== before.column) throw new Error(`#${n} was moved to ${columnLabel(now.column)} meanwhile. Start it again if it's still to do.`)
        if (now.agent !== before.agent) throw new Error(`#${n} was given to ${now.agent ? 'another agent' : 'nobody'} meanwhile. Start it again if it's still to do.`)
      }
    })
  } catch (e) {
    await undoAgent()
    throw e
  }

  // Back where it was (to nobody if its earlier agent has gone), but only while the card is still as this Start
  // left it: a later decision (moved to Done or Review, another project, another agent) stays.
  const back = (agent: string | null): Promise<TaskCard> =>
    updateTask(n, { agent, column: before.column }, actor, {
      check: (now) => {
        if (now.agent !== agentId || now.column !== card.column || now.project !== card.project || now.archived) throw new Error('changed meanwhile')
      }
    })
  let live = false
  try {
    const prompt = taskPrompt(card, !!sessions.hiveMcp(p), { from: before.column, note })
    // Again now: the agent may have started work, or the user typed in it, while the card was taken.
    live = availability(p, agentId, agentName, actor).live
    // And while it is typed: an agent that starts work or that the user types in meanwhile doesn't get the rest.
    if (live)
      await sessions.sendPrompt(p, agentId, prompt, () => {
        if (!availability(p, agentId, agentName, actor).live) throw new Error(`${agentName} stopped before the task was sent.`)
      })
    else await sessions.start(p, { agentId, prompt })
  } catch (e) {
    await back(before.agent)
      .catch(() => back(null))
      .catch(() => undefined)
    await undoAgent()
    throw e
  }
  // The view stays where the user has it; the new agent is marked for them.
  if (added && actor.kind !== 'user') emit({ type: 'agent-added', projectPath: p, agentId })
  return { card, agentId, agentName, added, typed: live }
}
