import { basename, join } from 'path'
import type { ActivityAgent } from '../shared/assistantActivity'
import { projectAgents } from '../shared/defaults'
import type { TaskCard } from '../shared/types'
import { workspace } from './workspace'

/**
 * An existing agent of a project as an Assistant action's target (#763): by its id or name, in the project named so (a
 * folder of the current workspace). Undefined when there is no such agent or project: never throws, so a target that
 * can't be named never stops the action or its refusal being recorded.
 */
export async function knownAgent(project: string | null | undefined, value: unknown): Promise<ActivityAgent | undefined> {
  if (!project || basename(project) !== project || project === '.' || project === '..' || typeof value !== 'string' || !value || !workspace.path) return undefined
  try {
    const a = projectAgents(await workspace.projectConfig(join(workspace.path, project))).find((x) => x.id === value || x.name.toLowerCase() === value.toLowerCase())
    return a ? { id: a.id, name: a.name } : undefined
  } catch {
    return undefined
  }
}

/** A card's agent as a target: the agent it is with now, by its name in the project (else the name it was given under). */
export async function cardAgent(card: Pick<TaskCard, 'project' | 'agent' | 'agentName'>): Promise<ActivityAgent | undefined> {
  if (!card.agent) return undefined
  return (await knownAgent(card.project, card.agent)) ?? { id: card.agent, name: card.agentName ?? card.agent }
}
