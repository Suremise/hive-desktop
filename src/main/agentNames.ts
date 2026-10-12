import { basename, resolve } from 'path'
import { projectAgents } from '../shared/defaults'
import { nameTaken, nameTakenMessage, suggestAgentName, type NamedAgent } from '../shared/agentNames'
import { withFileLock } from './fsutil'
import { workspaceOf } from './workspace'

/**
 * Agent names unique across the workspace (#702). Every change that gives an agent a name (Add Agent and quick add, a
 * rename, a template's load or one of its agents, a card started with a new agent; from the window or the Agent API)
 * checks it and writes it holding the workspace's names lock, so two projects can't take the same name at once. The
 * lock is taken before a project file's lock, never inside one.
 */

/** Runs `fn` holding the names lock of the workspace `projectPath` is in. */
export function withAgentNames<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${resolve(workspaceOf(projectPath).path ?? projectPath)}|agent-names`, fn)
}

/** Every agent of the workspace's projects (the listed ones: a hidden project's come back flagged if they clash). */
export async function workspaceAgents(projectPath: string): Promise<NamedAgent[]> {
  const ws = workspaceOf(projectPath)
  const out: NamedAgent[] = []
  for (const p of await ws.listProjectPaths()) {
    const cfg = await ws.projectConfig(p).catch(() => null)
    for (const a of cfg ? projectAgents(cfg) : []) out.push({ project: basename(p), name: a.name, id: a.id })
  }
  return out
}

/** A refused name: the message says who has it and a free name to use. */
export class NameTakenError extends Error {
  constructor(
    message: string,
    readonly suggestion: string
  ) {
    super(message)
  }
}

/**
 * Refuses `name` when another agent of the workspace has it (`self`: the agent being renamed; `except`: projects whose
 * agents don't count, a template load's own project, whose agents it replaces). Checked as the agents are now: call it
 * holding the names lock, just before the write.
 */
export async function assertNameFree(projectPath: string, name: string, opts: { self?: string; except?: string } = {}): Promise<void> {
  const project = basename(projectPath)
  const all = (await workspaceAgents(projectPath)).filter((a) => !opts.except || a.project.toLowerCase() !== opts.except.toLowerCase())
  const owner = nameTaken(name, all, opts.self ? { project, id: opts.self } : undefined)
  if (!owner) return
  const suggestion = suggestAgentName(name, project, all.map((a) => a.name))
  throw new NameTakenError(nameTakenMessage(name, owner, suggestion), suggestion)
}
