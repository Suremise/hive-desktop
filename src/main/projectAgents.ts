import { join, resolve } from 'path'
import { MAIN_AGENT, MAX_AGENTS, projectAgents, slugify } from '../shared/defaults'
import type { AddAgentOptions, AgentBranchStatus, AgentDef, MergeResult, ProjectGitInfo } from '../shared/types'
import { config } from './config'
import { toast } from './events'
import { createLogger } from './logger'
import { sessions } from './sessions'
import { workspace } from './workspace'
import * as wt from './worktrees'

const log = createLogger('agents')

/** Branches and worktrees for the Add Agent dialog. */
export async function gitInfo(projectPath: string): Promise<ProjectGitInfo> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  const used = new Set(projectAgents(cfg).map((a) => a.worktree?.path.toLowerCase()).filter(Boolean))
  const current = await wt.currentBranch(projectPath)
  const all = await wt.listWorktrees(projectPath)
  return {
    isRepo: all.length > 0,
    current,
    branches: await wt.localBranches(projectPath),
    worktrees: all.filter((w) => w.path.toLowerCase() !== resolve(projectPath).toLowerCase()).map((w) => ({ ...w, used: used.has(w.path.toLowerCase()) })),
    worktreesRoot: join(workspace.worktreesRoot, projectPath.split(/[\\/]/).pop()!)
  }
}

export async function addAgent(projectPath: string, opts: AddAgentOptions): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (agents.length >= MAX_AGENTS) throw new Error(`A project can have up to ${MAX_AGENTS} agents.`)
  let n = agents.length + 1
  while (agents.some((a) => a.name === `Agent ${n}`)) n++
  const name = opts.name?.trim() || `Agent ${n}`
  if (agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called "${name}".`)
  let id = `a${n}`
  while (agents.some((a) => a.id === id)) id = `a${++n}`

  const def: AgentDef = { id, name }
  if (opts.model) def.model = opts.model
  if (opts.effort) def.effort = opts.effort
  if (opts.permissionMode) def.permissionMode = opts.permissionMode

  if (opts.location === 'new-worktree') {
    const base = opts.base || (await wt.currentBranch(projectPath))
    if (!base) throw new Error('The project folder is not on a branch. Choose the branch to start from.')
    const branch = await wt.uniqueBranch(projectPath, opts.branch?.trim() || `hive/${slugify(name)}`)
    const dest = wt.uniqueFolder(join(workspace.worktreesRoot, projectPath.split(/[\\/]/).pop()!, slugify(name)))
    await wt.createWorktree(projectPath, dest, branch, base)
    const s = config.settings.agents
    const copied = await wt.copyIgnored(projectPath, dest, cfg.worktreeCopy ?? s.worktreeCopy)
    if (copied.length) log.info(`Copied into ${dest}: ${copied.join(', ')}`)
    def.worktree = { path: dest, branch, base }
    if (cfg.worktreeSetup.trim()) def.needsSetup = true
  } else if (opts.location === 'existing-worktree') {
    if (!opts.worktreePath) throw new Error('Choose a worktree.')
    const target = resolve(opts.worktreePath).toLowerCase()
    const found = (await wt.listWorktrees(projectPath)).find((w) => w.path.toLowerCase() === target)
    if (!found || target === resolve(projectPath).toLowerCase()) throw new Error('That folder is not a worktree of this project.')
    if (agents.some((a) => a.worktree?.path.toLowerCase() === target)) throw new Error('Another agent already works in that worktree.')
    if (!found.branch) throw new Error('That worktree is not on a branch (detached HEAD).')
    def.worktree = { path: found.path, branch: found.branch, base: (await wt.currentBranch(projectPath)) ?? found.branch }
  }

  await workspace.mutateProjectConfig(projectPath, (now) => {
    if (projectAgents(now).length >= MAX_AGENTS) throw new Error(`A project can have up to ${MAX_AGENTS} agents.`)
    return { agents: [...(now.agents ?? []), def] }
  })
  await workspace.refresh()
  return def
}

export async function updateAgent(projectPath: string, agentId: string, patch: Partial<Pick<AgentDef, 'name' | 'model' | 'effort' | 'permissionMode'>>): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  if (patch.name !== undefined) {
    patch.name = patch.name.trim()
    if (!patch.name) throw new Error('Enter a name.')
    if (agents.some((a) => a.id !== agentId && a.name.toLowerCase() === patch.name!.toLowerCase())) throw new Error(`There is already an agent called "${patch.name}".`)
  }
  // Empty values clear an override so the agent follows the project again.
  const clean: Partial<AgentDef> = { ...patch }
  for (const k of ['model', 'effort', 'permissionMode'] as const) if (k in clean && !clean[k]) clean[k] = undefined
  const def = await workspace.updateAgent(projectPath, agentId, clean)
  const live = sessions.liveFor(projectPath, agentId)
  if (live && patch.name) live.agentName = patch.name
  await workspace.refresh()
  return def
}

export async function removeAgent(projectPath: string, agentId: string, opts: { deleteWorktree: boolean }): Promise<void> {
  projectPath = workspace.assertProject(projectPath)
  if (agentId === MAIN_AGENT) throw new Error('Agent 1 works in the project folder and cannot be removed.')
  if (sessions.liveFor(projectPath, agentId)) throw new Error('Stop the agent before removing it.')
  const cfg = await workspace.projectConfig(projectPath)
  const def = cfg.agents.find((a) => a.id === agentId)
  if (!def) return
  if (def.worktree && opts.deleteWorktree) await wt.removeWorktree(projectPath, def.worktree, true)
  await workspace.mutateProjectConfig(projectPath, (now) => ({ agents: now.agents.filter((a) => a.id !== agentId) }))
  await workspace.refresh()
}

async function worktreeOf(projectPath: string, agentId: string) {
  const def = projectAgents(await workspace.projectConfig(projectPath)).find((a) => a.id === agentId)
  if (!def?.worktree) throw new Error('This agent works in the project folder, not a worktree.')
  return { def, worktree: def.worktree }
}

export async function branchStatus(projectPath: string, agentId: string): Promise<AgentBranchStatus> {
  projectPath = workspace.assertProject(projectPath)
  return wt.branchStatus(projectPath, (await worktreeOf(projectPath, agentId)).worktree)
}

export async function merge(projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean }): Promise<MergeResult> {
  projectPath = workspace.assertProject(projectPath)
  const { def, worktree } = await worktreeOf(projectPath, agentId)
  if (opts.cleanup && sessions.liveFor(projectPath, agentId)) throw new Error(`Stop ${def.name} before merging and removing its worktree.`)
  const result = await wt.mergeWorktree(projectPath, worktree, opts)
  if (!result.ok || !opts.cleanup) {
    workspace.scheduleRefresh()
    return result
  }
  try {
    await wt.removeWorktree(projectPath, worktree, true)
    await workspace.mutateProjectConfig(projectPath, (now) => ({ agents: now.agents.filter((a) => a.id !== agentId) }))
    await workspace.refresh()
    return { ...result, cleanedUp: true }
  } catch (e) {
    toast('warning', 'Merged, but the worktree was not removed', (e as Error).message, undefined, projectPath)
    return result
  }
}
