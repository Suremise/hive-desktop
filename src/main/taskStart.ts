import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import { taskPrompt } from '../shared/tasks'
import type { TaskCard, TaskStartTarget } from '../shared/types'
import { emit } from './events'
import { addAgent, removeAgent } from './projectAgents'
import { sessions } from './sessions'
import { getTask, updateTask, type TaskActor } from './tasks'
import { createLogger } from './logger'
import { workspace } from './workspace'

const log = createLogger('tasks')

const STATUS_WORDS: Record<string, string> = {
  working: 'is working',
  starting: 'is starting',
  waiting: 'is waiting for the user',
  background: 'is waiting on background tasks it started'
}

/** Cards being started now ("<workspace>#<n>"): a second Start of the same card is refused, not run twice. */
const starting = new Set<string>()

/**
 * Start on a card: gives it to an agent of its project (one that is stopped or idle, or a new one, in the project
 * folder or a new worktree) with the card as its prompt, and puts the card in Doing. The card is taken first,
 * checked under its lock (not archived or done meanwhile), so the prompt is the card as it now is; if the agent
 * then can't be started, the card goes back where it was and a new agent is removed again.
 */
export async function startTask(n: number, target: TaskStartTarget, actor: TaskActor): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean }> {
  const key = `${(workspace.path ?? '').toLowerCase()}#${n}`
  if (starting.has(key)) throw new Error(`#${n} is already being started.`)
  starting.add(key)
  try {
    return await startReserved(n, target, actor)
  } finally {
    starting.delete(key)
  }
}

function startable(card: TaskCard): void {
  if (card.archived) throw new Error(`#${card.number} is archived. Bring it back first.`)
  if (card.column === 'done') throw new Error(`#${card.number} is done.`)
  if (!card.project) throw new Error(`#${card.number} has no project. Give it one first: the agent works in that project.`)
}

async function startReserved(n: number, target: TaskStartTarget, actor: TaskActor): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean }> {
  const before = await getTask(n)
  startable(before)
  const p = workspace.assertProject(join(workspace.path!, before.project))

  let agentId: string
  let agentName: string
  let live = false
  if (target.kind === 'agent') {
    const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === target.agentId || x.name.toLowerCase() === target.agentId.toLowerCase())
    if (!a) throw new Error(`Unknown agent "${target.agentId}" in ${before.project}`)
    agentId = a.id
    agentName = a.name
    const st = sessions.liveFor(p, a.id)
    if (st && STATUS_WORDS[st.status]) throw new Error(`${a.name} ${STATUS_WORDS[st.status]}. Start the task once it's idle, or give it to another agent.`)
    if (st && actor.kind !== 'user' && sessions.userMayBeTyping(p, a.id)) throw new Error(`The user has just typed in ${a.name}'s terminal and may still be writing there. Ask the user first.`)
    live = !!st
  } else {
    const def = await addAgent(p, { name: target.name, location: target.worktree ? 'new-worktree' : 'project', provider: target.provider })
    agentId = def.id
    agentName = def.name
  }
  const added = target.kind !== 'agent'
  const undoAgent = async (): Promise<void> => {
    if (added) await removeAgent(p, agentId, { deleteWorktree: true }).catch((e) => log.warn(`Could not remove ${agentName} after #${n} didn't start`, e))
  }

  // Taken first, on the card as it is now: it must still be in this project and startable.
  let card: TaskCard
  try {
    card = await updateTask(n, { agent: agentId, ...(before.column === 'doing' ? {} : { column: 'doing' as const }) }, actor, {
      check: (now) => {
        startable(now)
        if (now.project.toLowerCase() !== before.project.toLowerCase()) throw new Error(`#${n} moved to ${now.project || 'the workspace'} meanwhile. Start it again.`)
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
  try {
    const prompt = taskPrompt(card, !!sessions.hiveMcp(p))
    if (live) await sessions.sendPrompt(p, agentId, prompt)
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
  return { card, agentId, agentName, added }
}
