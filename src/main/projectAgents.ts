import { randomBytes } from 'crypto'
import { basename, join, resolve } from 'path'
import { MAX_AGENTS, moveAgentTo, projectAgents, slugify } from '../shared/defaults'
import { agentProvider, isKnownProvider } from '../shared/providers'
import type { AddAgentOptions, AgentBranchStatus, AgentDef, AgentPatch, MergeResult, ProjectGitInfo } from '../shared/types'
import { config } from './config'
import { toast } from './events'
import { withFileLock } from './fsutil'
import { createLogger } from './logger'
import { checkProject } from './branchWatch'
import { sessions } from './sessions'
import { releaseAgentCards } from './tasks'
import { workspace, workspaceOf } from './workspace'
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
    worktreesRoot: join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!)
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
  // Never reused: sessions of a removed agent keep its id and must not attach to a new one.
  const id = `a-${randomBytes(4).toString('hex')}`

  // The provider is stored on the agent, so changing a default later doesn't move existing agents.
  const provider = opts.provider || agentProvider(null, cfg, config.settings)
  if (!isKnownProvider(provider)) throw new Error(`Unknown provider "${provider}".`)
  const def: AgentDef = { id, name, provider }
  if (opts.model) def.model = opts.model
  if (opts.effort) def.effort = opts.effort
  if (opts.permissionMode) def.permissionMode = opts.permissionMode
  if (typeof opts.use200kContext === 'boolean') def.use200kContext = opts.use200kContext

  if (opts.location === 'new-worktree') {
    const base = opts.base || (await wt.currentBranch(projectPath))
    if (!base) throw new Error('The project folder is not on a branch. Choose the branch to start from.')
    const branch = await wt.uniqueBranch(projectPath, opts.branch?.trim() || `hive/${slugify(name)}`)
    const dest = wt.uniqueFolder(join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!, slugify(name)))
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

  try {
    await workspace.mutateProjectConfig(projectPath, (now) => {
      const list = projectAgents(now)
      // Checked again under the lock: another add (the UI and the Assistant at once) may have come first.
      if (list.length >= MAX_AGENTS) throw new Error(`A project can have up to ${MAX_AGENTS} agents.`)
      if (list.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called "${name}".`)
      const wtPath = def.worktree?.path.toLowerCase()
      if (wtPath && list.some((a) => a.worktree?.path.toLowerCase() === wtPath)) throw new Error('Another agent already works in that worktree.')
      // Pages whose layout wasn't chosen by hand follow their agents, so the new one shows.
      return { agents: [...list, def] }
    })
  } catch (e) {
    // A worktree made for this agent alone goes with it.
    if (opts.location === 'new-worktree' && def.worktree) await wt.removeWorktree(projectPath, def.worktree, true).catch((err) => log.warn('Could not remove the new worktree', err))
    throw e
  }
  await workspaceOf(projectPath).refresh()
  return def
}

export async function updateAgent(projectPath: string, agentId: string, patch: AgentPatch): Promise<AgentDef> {
  // The Hive Assistant's settings for this workspace are its agent's, too (it keeps its name).
  projectPath = workspace.assertSessionHost(projectPath)
  if (workspace.isAssistantHome(projectPath)) delete patch.name
  else delete patch.persona
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (patch.name !== undefined) {
    patch.name = patch.name.trim()
    if (!patch.name) throw new Error('Enter a name.')
    if (agents.some((a) => a.id !== agentId && a.name.toLowerCase() === patch.name!.toLowerCase())) throw new Error(`There is already an agent called "${patch.name}".`)
  }
  // Empty values clear an override so the agent follows the project again.
  const { use200kContext, ...rest } = patch
  const clean: Partial<AgentDef> = { ...rest }
  for (const k of ['model', 'effort', 'permissionMode', 'persona'] as const) if (k in clean && !clean[k]) clean[k] = undefined
  if (use200kContext !== undefined) clean.use200kContext = typeof use200kContext === 'boolean' ? use200kContext : undefined
  if (patch.provider !== undefined) {
    const current = agents.find((a) => a.id === agentId)
    if (!isKnownProvider(patch.provider)) throw new Error(`Unknown provider "${patch.provider}".`)
    if (current && agentProvider(current, cfg, config.settings) !== patch.provider) {
      if (sessions.liveFor(projectPath, agentId)) throw new Error('Stop the agent before changing its provider.')
      // Model, effort, mode and context belong to the old provider, and its conversations can't be resumed by the new one.
      Object.assign(clean, { model: patch.model || undefined, effort: patch.effort || undefined, permissionMode: patch.permissionMode || undefined, use200kContext: typeof use200kContext === 'boolean' ? use200kContext : undefined, lastSessionId: undefined })
    }
  }
  const def = await workspace.updateAgent(projectPath, agentId, clean)
  const live = sessions.liveFor(projectPath, agentId)
  if (live && patch.name) live.agentName = patch.name
  await workspaceOf(projectPath).refresh()
  return def
}

/** Removes an agent (stopped). `releaseCards` takes its open cards from it too (Doing ones back to Todo). */
export async function removeAgent(projectPath: string, agentId: string, opts: { deleteWorktree: boolean; releaseCards?: boolean }): Promise<void> {
  projectPath = workspace.assertProject(projectPath)
  if (sessions.liveFor(projectPath, agentId)) throw new Error('Stop the agent before removing it.')
  const cfg = await workspace.projectConfig(projectPath)
  const def = cfg.agents.find((a) => a.id === agentId)
  if (!def) return
  if (def.worktree && opts.deleteWorktree) await wt.removeWorktree(projectPath, def.worktree, true)
  await workspace.mutateProjectConfig(projectPath, (now) => ({ agents: now.agents.filter((a) => a.id !== agentId) }))
  if (opts.releaseCards) await releaseAgentCards(basename(projectPath), agentId, { kind: 'user' })
  await workspaceOf(projectPath).refresh()
}

/** Moves an agent to `index` in the project's order (its position afterwards); returns the agents' ids in the new order. */
export async function moveAgent(projectPath: string, agentId: string, index: number): Promise<string[]> {
  projectPath = workspace.assertProject(projectPath)
  if (!Number.isFinite(index)) throw new Error('Choose where to move the agent.')
  const next = await workspace.mutateProjectConfig(projectPath, (now) => {
    const list = projectAgents(now)
    if (!list.some((a) => a.id === agentId)) throw new Error('That agent no longer exists.')
    return { agents: moveAgentTo(list, agentId, index) }
  })
  await workspaceOf(projectPath).refresh()
  return projectAgents(next).map((a) => a.id)
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
  // Its uncommitted work is committed first: not while it is still changing it.
  const st = sessions.liveFor(projectPath, agentId)?.status
  if (st === 'working' || st === 'starting') throw new Error(`${def.name} is working. Merge once it has finished.`)
  if (st === 'background') throw new Error(`${def.name} is waiting on background tasks it started. Merge once it has finished.`)
  // One merge at a time per project folder: two would stage and commit into each other.
  const result = await withFileLock(join(projectPath, '.git', 'hive-merge'), () => wt.mergeWorktree(projectPath, worktree, opts))
  // The project folder's branch moved on: every worktree agent's unmerged work is counted again.
  if (!result.ok || !opts.cleanup) {
    workspaceOf(projectPath).scheduleRefresh()
    void checkProject(projectPath)
    return result
  }
  try {
    await wt.removeWorktree(projectPath, worktree, true)
    await workspace.mutateProjectConfig(projectPath, (now) => ({ agents: now.agents.filter((a) => a.id !== agentId) }))
    await workspaceOf(projectPath).refresh()
    void checkProject(projectPath)
    return { ...result, cleanedUp: true }
  } catch (e) {
    toast('warning', 'Merged, but the worktree was not removed', (e as Error).message, undefined, projectPath)
    return result
  }
}
