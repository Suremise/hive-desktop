import { randomBytes } from 'crypto'
import { existsSync } from 'original-fs'
import { rename } from 'original-fs/promises'
import { basename, dirname, join } from 'path'
import { MAX_AGENTS, ROLE_MAX, agentPtyKey, mergeBlocked, moveAgentTo, projectAgents, slugify, swapAgentsIn } from '../shared/defaults'
import { forgetPtys } from './ptyHost'
import { agentProvider, defaultProviderPending, isKnownProvider } from '../shared/providers'
import type { AddAgentOptions, AddedAgent, AgentBranchStatus, AgentDef, AgentPatch, AgentWorktree, MergeResult, ProjectConfig, ProjectGitInfo, RemovedAgent, WorktreeCheck, WorktreeMatch, WorktreeReuse } from '../shared/types'
import { lockfileChanged, reuseNote } from '../shared/unusedWorktrees'
import { config } from './config'
import { toast } from './events'
import { placeKey, samePlace, withFileLock } from './fsutil'
import { git } from './git'
import { createLogger, userText } from './logger'
import { checkProject } from './branchWatch'
import { sessions } from './sessions'
import { endReviews, releaseAgentCards } from './tasks'
import { laneAgentRemoved } from './lanes'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { gitProblem } from './gitTool'
import { providerService } from './providerService'

const log = createLogger('agents')

/** Branches and worktrees for the Add Agent dialog. */
export async function gitInfo(projectPath: string): Promise<ProjectGitInfo> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  // By real paths (#389): git lists the long names, while an agent's may be saved short (8.3), or through a junction.
  const used = new Set(projectAgents(cfg).flatMap((a) => (a.worktree ? [placeKey(a.worktree.path)] : [])))
  const current = await wt.currentBranch(projectPath)
  const all = await wt.listWorktrees(projectPath)
  // No worktrees listed because git can't run is not "not a repository" (#346).
  const problem = all.length ? null : gitProblem()
  return {
    isRepo: all.length > 0,
    ...(problem ? { gitProblem: problem } : {}),
    current,
    branches: await wt.localBranches(projectPath),
    worktrees: all.filter((w) => !samePlace(w.path, projectPath)).map((w) => ({ ...w, used: used.has(placeKey(w.path)) })),
    worktreesRoot: join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!)
  }
}

/**
 * Removals of worktrees (#289), by `placeKey`: when each started and, once over, ended, on one counter. Whatever
 * gives an agent a worktree (`addAgent`, a template's load) takes a mark (`claimMark`) before it looks at the project's
 * worktrees, and refuses, under the project file's lock, one whose removal was going on at any time since
 * (`removedSince`): a claim that saw the worktree before or while it was removed never publishes an agent in it. A few
 * hundred kept at most (the oldest ended ones go first); removals are rare.
 */
const removals = new Map<string, { start: number; end?: number }>()
let removalClock = 0
const REMOVALS_KEPT = 200
const worktreeKey = placeKey

/** Reserves a worktree while it is checked and removed, or an unused one merged (#400); the function returned ends it. */
export function reserveForRemoval(path: string): () => void {
  const key = worktreeKey(path)
  const was = removals.get(key)
  if (was && was.end === undefined) throw new Error('That worktree is already being removed or merged.')
  const entry: { start: number; end?: number } = { start: ++removalClock }
  removals.delete(key)
  removals.set(key, entry)
  for (const [k, r] of removals) {
    if (removals.size <= REMOVALS_KEPT) break
    if (r.end !== undefined) removals.delete(k)
  }
  return () => void (entry.end = ++removalClock)
}

/** Whether a worktree is being removed or merged as an unused one right now. */
const beingRemoved = (path: string): boolean => {
  const r = removals.get(worktreeKey(path))
  return !!r && r.end === undefined
}

/** A point to check claims against: taken before looking at the project's worktrees. */
export const claimMark = (): number => removalClock

/** Whether a worktree's removal was going on at any time since `mark` (or is now): a claim from then can't have it. */
export function removedSince(path: string, mark: number): boolean {
  const r = removals.get(worktreeKey(path))
  return !!r && (r.end === undefined || r.end > mark)
}

/**
 * An agent given an existing worktree whose setup never ran (#289: kept after its agent was replaced before its first
 * session) runs it first: its definition marked, and the worktree taken off the project's list. Called under the lock.
 */
export function takePendingSetup(now: ProjectConfig, def: AgentDef): Pick<ProjectConfig, 'setupPending'> | null {
  const pending = Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []
  if (!def.worktree || !pending.some((p) => worktreeKey(p) === worktreeKey(def.worktree!.path))) return null
  if (now.worktreeSetup.trim()) def.needsSetup = true
  return { setupPending: pending.filter((p) => worktreeKey(p) !== worktreeKey(def.worktree!.path)) }
}

/**
 * project.json's list of worktrees still to set up (#289, #319), changed: `add` (kept, their setup never ran) and `drop`
 * (worked in again, or gone) applied, each once, at most 50 kept (the newest). Null when nothing changes. Under the lock.
 */
export function pendingSetupPatch(now: ProjectConfig, change: { add?: string[]; drop?: string[] }): Pick<ProjectConfig, 'setupPending'> | null {
  const before = Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []
  const drop = new Set((change.drop ?? []).map(worktreeKey))
  const list = new Map<string, string>()
  for (const p of [...before, ...(change.add ?? [])]) if (!drop.has(worktreeKey(p))) list.set(worktreeKey(p), p)
  const after = [...list.values()].slice(-50)
  return after.length === before.length && after.every((p, i) => p === before[i]) ? null : { setupPending: after }
}

export async function addAgent(projectPath: string, opts: AddAgentOptions): Promise<AddedAgent> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (agents.length >= MAX_AGENTS) throw new Error(`A project can have up to ${MAX_AGENTS} agents.`)
  let n = agents.length + 1
  while (agents.some((a) => a.name === `Agent ${n}`)) n++
  const name = opts.name?.trim() || `Agent ${n}`
  if (agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called "${name}".`)
  // Before the worktrees are looked at: a removal since then refuses the claim (#289).
  const mark = claimMark()
  const { def, discard, reuse } = await prepareAgent(projectPath, cfg, opts, name, agents)
  try {
    await workspace.mutateProjectConfig(projectPath, (now) => {
      const list = projectAgents(now)
      // Checked again under the lock: another add (the UI and the Assistant at once) may have come first.
      if (list.length >= MAX_AGENTS) throw new Error(`A project can have up to ${MAX_AGENTS} agents.`)
      if (list.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called "${name}".`)
      const wtPath = def.worktree && placeKey(def.worktree.path)
      if (wtPath && list.some((a) => a.worktree && placeKey(a.worktree.path) === wtPath)) throw new Error('Another agent already works in that worktree.')
      if (def.worktree && (removedSince(def.worktree.path, mark) || !existsSync(def.worktree.path))) throw new Error('That worktree is being removed, or was just removed.')
      // An existing worktree whose setup never ran runs it first (#289), one reused for a new one too (#456).
      const pending = opts.location === 'existing-worktree' || reuse?.reused ? takePendingSetup(now, def) : null
      // An automatic layout follows the agents, so the new one shows; with one chosen by hand, a full page sends it to the next (#134).
      return { agents: [...list, def], ...pending }
    })
  } catch (e) {
    await discard()
    throw e
  }
  await workspaceOf(projectPath).refresh()
  if (reuse) log.info(`Added ${userText(name)}: ${userText(reuseNote(reuse))}`)
  return reuse ? { ...def, reuse } : def
}

/** Whether a worktree on `branch` is merged into `base` (a squash merge counting) and clean: its commits then, or why not. */
async function reuseCheck(projectPath: string, path: string, branch: string, base: string): Promise<{ tip: string; baseTip: string } | { why: string }> {
  const [tip, baseTip] = await Promise.all([wt.tipOf(projectPath, branch), wt.tipOf(projectPath, base)])
  const [ahead, dirty] = tip && baseTip ? await Promise.all([wt.unmergedCommits(projectPath, baseTip, tip), wt.dirtyCount(path)]) : [null, null]
  if (!tip || !baseTip || ahead === null || dirty === null) return { why: gitProblem() ?? `git couldn't check it against ${base}` }
  const why = [ahead ? `${ahead} commit${ahead === 1 ? '' : 's'} not merged into ${base}` : '', dirty ? `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` : ''].filter(Boolean)
  return why.length ? { why: why.join(' and ') } : { tip, baseTip }
}

/**
 * The project's unused worktree on `branch` (#456), checked against `base`: one in Hive's worktrees folder for the
 * project that git lists on that branch and no agent (`others`) works in. Null when there is none.
 */
export async function matchingWorktree(projectPath: string, branch: string, base: string, others: readonly AgentDef[]): Promise<WorktreeMatch | null> {
  const root = placeKey(join(workspaceOf(projectPath).worktreesRoot, basename(projectPath)))
  const used = new Set(others.flatMap((a) => (a.worktree ? [placeKey(a.worktree.path)] : [])))
  const w = (await wt.listWorktrees(projectPath)).find((x) => x.branch === branch && !samePlace(x.path, projectPath) && placeKey(dirname(x.path)) === root && !used.has(placeKey(x.path)) && existsSync(x.path))
  if (!w) return null
  const checked = await reuseCheck(projectPath, w.path, branch, base)
  return { path: w.path, branch, base, reusable: !('why' in checked), ...('why' in checked ? { why: checked.why } : {}) }
}

/** The Add Agent dialog's look before adding (#456): the unused worktree a new one on `branch` from `base` would reuse. */
export async function worktreeMatch(projectPath: string, branch: string, base: string): Promise<WorktreeMatch | null> {
  projectPath = workspace.assertProject(projectPath)
  return matchingWorktree(projectPath, branch.trim(), base, projectAgents(await workspace.projectConfig(projectPath)))
}

/** Worktrees being brought up to their base right now (#456), by `placeKey`: one add at a time takes each. */
const bringingUp = new Set<string>()

/**
 * Why nothing should take an unused worktree now (#456), or null when nothing uses it: git busy in it (a lock on its
 * index, HEAD or branch), or a process in it. Windows refuses to rename a folder while a process has its working folder,
 * or a file open, anywhere in it, so Hive renames it aside and back; when that fails, or Hive can't tell, it counts as used.
 */
async function inUse(path: string, branch: string): Promise<string | null> {
  // Where git itself keeps each lock (the branch's and packed-refs' in the project's common git folder).
  const locks = ['index.lock', 'HEAD.lock', `refs/heads/${branch}.lock`, 'packed-refs.lock']
  const where = await git(path, ['rev-parse', '--path-format=absolute', ...locks.flatMap((l) => ['--git-path', l])])
  const files = where.ok ? where.out.split(/\r?\n/).filter(Boolean) : []
  if (files.length !== locks.length) return gitProblem() ?? "git couldn't read it"
  if (files.some((f) => existsSync(f))) return 'git is busy in it'
  const aside = `${path}.hive-${randomBytes(4).toString('hex')}`
  try {
    await rename(path, aside)
  } catch {
    return 'a program is using it'
  }
  try {
    await rename(aside, path)
  } catch (err) {
    log.warn(`Could not move ${userText(aside)} back to ${userText(path)}`, err)
    throw new Error(`Hive moved ${path} aside to check it and couldn't move it back: it is at ${aside}.`, { cause: err })
  }
  return null
}

/**
 * Brings an unused worktree up to `base` to reuse it (#456), when nothing uses it: no agent (the caller's check), not
 * being removed, merged or taken by another add, no git lock and no process in it (`inUse`), merged and clean. Checked
 * once, then `reset --keep` to the base: a convenience, not a guard against work started in it meanwhile. `why` when
 * it isn't reused; else `upTo` (the commit, when it moved) and `setup` (a lockfile changed, so the project's worktree
 * setup runs again).
 */
async function bringUp(projectPath: string, path: string, branch: string, base: string): Promise<{ upTo?: string; setup: boolean } | { why: string }> {
  const key = placeKey(path)
  if (beingRemoved(path)) return { why: 'it is being removed or merged' }
  if (bringingUp.has(key)) return { why: 'another agent is taking it' }
  bringingUp.add(key)
  try {
    const busy = await inUse(path, branch)
    if (busy) return { why: busy }
    const checked = await reuseCheck(projectPath, path, branch, base)
    if ('why' in checked) return checked
    const { tip, baseTip } = checked
    if (tip === baseTip) return { setup: false }
    const moved = await git(path, ['reset', '--keep', baseTip])
    if (!moved.ok) return { why: `git couldn't bring it up to ${base} (${moved.err.split(/\r?\n/)[0] || 'reset failed'})` }
    const diff = await git(projectPath, ['diff', '--name-only', tip, baseTip])
    log.info(`Brought ${userText(branch)} up to ${userText(base)} at ${baseTip.slice(0, 7)} to reuse it`)
    return { upTo: baseTip, setup: !diff.ok || lockfileChanged(diff.out.split(/\r?\n/)) }
  } finally {
    bringingUp.delete(key)
  }
}

/**
 * Where a new worktree for an agent called `name` goes in this project: a new branch `hive/<name>` in the project's own
 * repository and a folder in the workspace's worktree location under the project's name, each numbered (`-2`) when taken.
 * `taken`: branches and folders (`placeKey`s) a plan has already given out. Shared by adding an agent and by a template's
 * load plan (#268), so what the plan shows is what the load makes.
 */
export async function newWorktreePlace(projectPath: string, name: string, branch?: string, taken: { branches: ReadonlySet<string>; folders: ReadonlySet<string> } = { branches: new Set(), folders: new Set() }): Promise<{ branch: string; path: string }> {
  return {
    branch: await wt.uniqueBranch(projectPath, branch?.trim() || `hive/${slugify(name)}`, taken.branches),
    path: wt.uniqueFolder(join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!, slugify(name)), taken.folders)
  }
}

/**
 * A new agent's definition, ready to add but not added (#126: a template stages its agents, then adds them all at once):
 * its id, settings and, for a new worktree, the worktree made for it. `others` are the agents it must not clash with (a
 * worktree in use). `discard` removes a worktree made for it, for when it isn't added after all.
 */
export async function prepareAgent(projectPath: string, cfg: ProjectConfig, opts: AddAgentOptions, name: string, others: AgentDef[]): Promise<{ def: AgentDef; discard: () => Promise<void>; reuse?: WorktreeReuse }> {
  // Never reused: sessions of a removed agent keep its id and must not attach to a new one.
  const id = `a-${randomBytes(4).toString('hex')}`

  // The provider is stored on the agent, so changing a default later doesn't move existing agents. Automatic's is only
  // known once Hive has looked for every CLI before the one it found (#506).
  if (!opts.provider && defaultProviderPending(cfg, config.settings)) await providerService.settle()
  const provider = opts.provider || agentProvider(null, cfg, config.settings)
  if (!isKnownProvider(provider)) throw new Error(`Unknown provider "${provider}".`)
  const def: AgentDef = { id, name, provider }
  if (opts.model) def.model = opts.model
  if (opts.effort) def.effort = opts.effort
  if (opts.permissionMode) def.permissionMode = opts.permissionMode
  if (typeof opts.use200kContext === 'boolean') def.use200kContext = opts.use200kContext
  const role = cleanRole(opts.role)
  if (role) def.role = role

  let reuse: WorktreeReuse | undefined
  if (opts.location === 'new-worktree') {
    const base = opts.base || (await wt.currentBranch(projectPath))
    if (!base) throw new Error(gitProblem() ? `${gitProblem()}, so Hive can't make a worktree.` : 'The project folder is not on a branch. Choose the branch to start from.')
    // An unused worktree on the branch it would get is worked in again when merged and clean (#456), else a new one.
    const match = opts.reuseWorktree ? await matchingWorktree(projectPath, opts.branch?.trim() || `hive/${slugify(name)}`, base, others) : null
    if (match) {
      const took = match.reusable ? await bringUp(projectPath, match.path, match.branch, base) : { why: match.why ?? 'not checked' }
      if ('why' in took) reuse = { branch: match.branch, reused: false, base, notReused: took.why }
      else {
        def.worktree = { path: match.path, branch: match.branch, base }
        if (took.setup && cfg.worktreeSetup.trim()) def.needsSetup = true
        reuse = { branch: match.branch, reused: true, base, ...(took.upTo ? { upTo: took.upTo } : {}) }
      }
    }
    if (!def.worktree) {
      const { branch, path: dest } = await newWorktreePlace(projectPath, name, opts.branch)
      await wt.createWorktree(projectPath, dest, branch, base)
      const s = config.settings.agents
      const copied = await wt.copyIgnored(projectPath, dest, cfg.worktreeCopy ?? s.worktreeCopy)
      if (copied.length) log.info(`Copied into ${userText(dest)}: ${userText(copied.join(', '))}`)
      def.worktree = { path: dest, branch, base }
      if (cfg.worktreeSetup.trim()) def.needsSetup = true
    }
  } else if (opts.location === 'existing-worktree') {
    if (!opts.worktreePath) throw new Error('Choose a worktree.')
    const target = placeKey(opts.worktreePath)
    const found = (await wt.listWorktrees(projectPath)).find((w) => placeKey(w.path) === target)
    if (!found || target === placeKey(projectPath)) throw new Error(gitProblem() ? `${gitProblem()}, so Hive can't check that worktree.` : 'That folder is not a worktree of this project.')
    if (others.some((a) => a.worktree && placeKey(a.worktree.path) === target)) throw new Error('Another agent already works in that worktree.')
    if (!found.branch) throw new Error('That worktree is not on a branch (detached HEAD).')
    const base = (await wt.currentBranch(projectPath)) ?? found.branch
    def.worktree = { path: found.path, branch: found.branch, base }
    // Chosen by the user (#456): brought up to the base when merged and clean, else taken as it is, with its work.
    if (opts.reuseWorktree && base !== found.branch) {
      const took = await bringUp(projectPath, found.path, found.branch, base)
      if ('why' in took) reuse = { branch: found.branch, reused: true, base, keptWork: true }
      else {
        if (took.setup && cfg.worktreeSetup.trim()) def.needsSetup = true
        reuse = { branch: found.branch, reused: true, base, ...(took.upTo ? { upTo: took.upTo } : {}) }
      }
    }
  }
  // A worktree made for this agent alone goes with it (not one it reuses).
  const made = opts.location === 'new-worktree' && !reuse?.reused ? def.worktree : undefined
  const discard = async (): Promise<void> => {
    if (made) await wt.removeWorktree(projectPath, made, true).catch((err) => log.warn('Could not remove the new worktree', err))
  }
  return { def, discard, ...(reuse ? { reuse } : {}) }
}

/** A role as saved: trimmed, one line, at most ROLE_MAX characters ('' for none). */
export function cleanRole(role: unknown): string {
  if (typeof role !== 'string') return ''
  const r = role.replace(/\s+/g, ' ').trim()
  if (r.length > ROLE_MAX) throw new Error(`A role is at most ${ROLE_MAX} characters.`)
  return r
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
  // Empty values clear an override so the agent follows the project again (and an empty role: its name is its role).
  const { use200kContext, ...rest } = patch
  const clean: Partial<AgentDef> = { ...rest }
  if ('role' in clean) clean.role = cleanRole(clean.role) || undefined
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

/**
 * Removes an agent (stopped). `releaseCards` takes its open cards from it too (Doing ones back to Todo). `deleteWorktree`
 * deletes its worktree and branch; 'merged-clean' (Remove All, #291) only when they are merged into the main branch (the
 * one the user was shown, `mergedInto`) and clean now, checked here and guarded while deleting (`removeCheckedWorktree`),
 * and no other agent of the project works in that worktree: otherwise they are kept and the reply says why.
 */
export async function removeAgent(projectPath: string, agentId: string, opts: { deleteWorktree: boolean | 'merged-clean'; mergedInto?: string | null; releaseCards?: boolean }): Promise<RemovedAgent> {
  projectPath = workspace.assertProject(projectPath)
  if (sessions.liveFor(projectPath, agentId)) throw new Error('Stop the agent before removing it.')
  const cfg = await workspace.projectConfig(projectPath)
  const def = cfg.agents.find((a) => a.id === agentId)
  if (!def) return {}
  const tree = def.worktree
  let result: RemovedAgent = {}
  if (tree && opts.deleteWorktree === 'merged-clean') {
    const shared = projectAgents(cfg).some((a) => a.id !== agentId && a.worktree && samePlace(a.worktree.path, tree.path))
    const done = shared ? { deleted: false, reason: 'another agent works in it' } : await wt.removeCheckedWorktree(projectPath, tree, await wt.worktreeCheck(projectPath, tree), opts.mergedInto)
    result = { worktree: { path: tree.path, branch: tree.branch, ...done } }
  } else if (tree && opts.deleteWorktree) {
    await wt.removeWorktree(projectPath, tree, true)
    result = { worktree: { path: tree.path, branch: tree.branch, deleted: true } }
  } else if (tree) result = { worktree: { path: tree.path, branch: tree.branch, deleted: false } }
  await workspace.mutateProjectConfig(projectPath, (now) => {
    // Its worktree kept before its setup ever ran (#319): remembered, so the next agent given it runs setup first; one
    // deleted is forgotten. As the agent is now, under the lock; a worktree another agent works in is that agent's.
    const was = now.agents.find((a) => a.id === agentId)
    const left = now.agents.filter((a) => a.id !== agentId)
    const keptTree = result.worktree && !result.worktree.deleted ? was?.worktree : undefined
    const pending = keptTree && was?.needsSetup && now.worktreeSetup.trim() && !left.some((a) => a.worktree && samePlace(a.worktree.path, keptTree.path)) ? [keptTree.path] : []
    const gone = result.worktree?.deleted ? [result.worktree.path] : []
    return { agents: left, ...pendingSetupPatch(now, { add: pending, drop: gone }) }
  })
  if (opts.releaseCards) await releaseAgentCards(basename(projectPath), agentId, { kind: 'user' })
  // A review it left going (from before Hive last started) ends with it.
  await endReviews(basename(projectPath), agentId, 'the agent was removed', workspaceOf(projectPath))
  // Its lanes, as builder or reviewer, are abandoned (#483).
  await laneAgentRemoved(workspaceOf(projectPath), basename(projectPath), agentId).catch((e) => log.warn('abandoning the lanes of a removed agent', e))
  // Its terminal's kept size and output go: a new agent never has its id (#489).
  forgetPtys(agentPtyKey(projectPath, agentId))
  await workspaceOf(projectPath).refresh()
  return result
}

/** For each worktree agent of the project, whether its worktree could be deleted without losing work (#291). */
export async function worktreeChecks(projectPath: string): Promise<({ agentId: string } & WorktreeCheck)[]> {
  projectPath = workspace.assertProject(projectPath)
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  const out: ({ agentId: string } & WorktreeCheck)[] = []
  for (const a of agents) if (a.worktree) out.push({ agentId: a.id, ...(await wt.worktreeCheck(projectPath, a.worktree)) })
  return out
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

/**
 * Swaps two agents' places in the project's order (#135: one dropped on another's pane), under the project file's lock so
 * a change meanwhile isn't lost. Returns the order as saved.
 */
export async function swapAgents(projectPath: string, agentId: string, otherId: string): Promise<string[]> {
  projectPath = workspace.assertProject(projectPath)
  const next = await workspace.mutateProjectConfig(projectPath, (now) => {
    const list = projectAgents(now)
    if (!list.some((a) => a.id === agentId) || !list.some((a) => a.id === otherId)) throw new Error('That agent no longer exists.')
    return { agents: swapAgentsIn(list, agentId, otherId) }
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

/**
 * Runs the user's merge holding the merge slot of the branch it merges into (#350). mergeSlotHost sets it at startup
 * (this module stays below the slot service); until then a merge runs as it is.
 */
let userMergeSlot: (projectPath: string, branch: string, run: () => Promise<MergeResult>) => Promise<MergeResult> = (_p, _b, run) => run()
export function setUserMergeSlot(fn: typeof userMergeSlot): void {
  userMergeSlot = fn
}

/**
 * Merges a worktree's branch into the project folder's, the user's way: one merge at a time per project folder (two
 * would stage and commit into each other), holding the merge slot of the branch it merges into (#350), so an agent's
 * merge doesn't land in the middle. An agent's merge and an unused worktree's (#400) both go through it.
 */
export async function mergeInProject(projectPath: string, worktree: AgentWorktree, opts: { squash: boolean; message: string; moveBranch?: boolean }): Promise<MergeResult> {
  const into = await workspace.branch(projectPath)
  const run = (): Promise<MergeResult> => withFileLock(join(projectPath, '.git', 'hive-merge'), () => wt.mergeWorktree(projectPath, worktree, opts))
  return into ? await userMergeSlot(projectPath, into, run) : await run()
}

export async function merge(projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean; moveBranch?: boolean }): Promise<MergeResult> {
  projectPath = workspace.assertProject(projectPath)
  const { def, worktree } = await worktreeOf(projectPath, agentId)
  if (opts.cleanup && sessions.liveFor(projectPath, agentId)) throw new Error(`Stop ${def.name} before merging and removing its worktree.`)
  // Its uncommitted work is committed first: not while it is still in the middle of a task.
  const blocked = mergeBlocked(def.name, sessions.liveFor(projectPath, agentId)?.status)
  if (blocked) throw new Error(blocked)
  // One merge at a time, holding the slot (the Merge dialog waits until it is free). A branch removed afterwards isn't moved.
  const result = await mergeInProject(projectPath, worktree, { ...opts, moveBranch: opts.moveBranch && !opts.cleanup })
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
