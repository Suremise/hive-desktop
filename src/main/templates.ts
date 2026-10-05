import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename, join } from 'path'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { agentProvider, isProviderEnabled, providerDescriptor } from '../shared/providers'
import { isTemplateFile, readTemplate, templateFile, templateFrom, uniqueName, TEMPLATE_NAME_MAX, type AgentTemplate, type TemplateEntry, type TemplateScope } from '../shared/templates'
import type { AgentDef, ProviderId, TemplateLoadPlan } from '../shared/types'
import { config } from './config'
import { readKeptJson, writeKeptJson } from './fsutil'
import { createLogger, userText } from './logger'
import { addAgent, prepareAgent } from './projectAgents'
import { providerService } from './providerService'
import { sessions } from './sessions'
import { endReviews, releaseAgentCards } from './tasks'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'

/**
 * Agent templates (#126): a project's agents and layout saved under a name, in the workspace (`<workspace>/.hive/
 * templates`, for every project) or the project (`<project>/.hive/templates`, private: the project's .hive is kept out
 * of git). One kept JSON file each (a damaged one is recovered from its copy). Loading one replaces the project's agents
 * — only when it is safe (none running, no uncommitted work in their worktrees, every provider on and installed), and
 * all or nothing; adding one agent from a template leaves the others alone.
 */

const log = createLogger('templates')

/** A template that isn't there, or can't be used: the caller says so as it is. */
export class TemplateError extends Error {}

function folder(projectPath: string, scope: TemplateScope): string {
  return scope === 'workspace' ? join(workspaceOf(projectPath).path!, HIVE_DIR, 'templates') : join(projectPath, HIVE_DIR, 'templates')
}

const checkScope = (scope: unknown): TemplateScope => {
  if (scope !== 'workspace' && scope !== 'project') throw new TemplateError(`Unknown scope "${String(scope)}": workspace or project.`)
  return scope
}

async function readOne(projectPath: string, scope: TemplateScope, file: string): Promise<TemplateEntry> {
  const raw = await readKeptJson<unknown>(join(folder(projectPath, scope), file), null)
  const t = raw === null ? "It couldn't be read." : readTemplate(raw)
  if (typeof t === 'string') {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, TEMPLATE_NAME_MAX) : file.replace(/\.json$/, '')
    return { scope, file, name, savedAt: null, layout: 'auto', agents: [], problem: t }
  }
  return { scope, file, name: t.name, savedAt: t.savedAt || null, layout: t.layout, agents: t.agents }
}

/** The templates a project can use: the workspace's and its own, each by name (a name in both scopes is listed twice). */
export async function listTemplates(projectPath: string): Promise<TemplateEntry[]> {
  projectPath = workspace.assertProject(projectPath)
  const out: TemplateEntry[] = []
  for (const scope of ['workspace', 'project'] as const) {
    const dir = folder(projectPath, scope)
    const files = (await readdir(dir).catch(() => [] as string[])).filter(isTemplateFile).sort()
    for (const f of files) out.push(await readOne(projectPath, scope, f))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.scope === 'workspace' ? -1 : 1))
}

/** One template to use (refused, saying why, if it is missing or can't be used). */
async function usable(projectPath: string, scope: TemplateScope, file: unknown): Promise<TemplateEntry & { template: AgentTemplate }> {
  if (!isTemplateFile(file) || !existsSync(join(folder(projectPath, scope), file))) throw new TemplateError('That template is no longer there.')
  const e = await readOne(projectPath, scope, file)
  if (e.problem) throw new TemplateError(`"${e.name}" can't be used: ${e.problem}`)
  return { ...e, template: { version: 1, name: e.name, savedAt: e.savedAt ?? '', layout: e.layout, agents: e.agents } }
}

/**
 * Saves the project's agents and layout as a template in `scope`. A template of that name already there (case aside) is
 * replaced only with `overwrite`; otherwise the answer says it exists, so the user can be asked.
 */
export async function saveTemplate(projectPath: string, scope: TemplateScope, name: string, overwrite = false): Promise<{ saved: TemplateEntry } | { exists: string }> {
  projectPath = workspace.assertProject(projectPath)
  scope = checkScope(scope)
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw new TemplateError('Enter a name for the template.')
  if (clean.length > TEMPLATE_NAME_MAX) throw new TemplateError(`A template's name is at most ${TEMPLATE_NAME_MAX} characters.`)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (!agents.length) throw new TemplateError('This project has no agents to save.')
  const dir = folder(projectPath, scope)
  await mkdir(dir, { recursive: true })
  const existing = (await readdir(dir).catch(() => [] as string[])).filter(isTemplateFile)
  // The same name: its file (replaced when asked). Another name whose file name would be the same: a file of its own.
  let file: string | null = null
  for (const f of existing) {
    const e = await readOne(projectPath, scope, f)
    if (e.name.toLowerCase() === clean.toLowerCase()) file = f
  }
  if (file && !overwrite) return { exists: file }
  if (!file) for (let n = 1; ; n++) if (!existing.includes((file = templateFile(clean, n)))) break
  const t = templateFrom(clean, agents, cfg.layout, (a) => agentProvider(a, cfg, config.settings))
  await writeKeptJson(join(dir, file!), t)
  log.info(`Saved template ${userText(clean)} (${scope}, ${t.agents.length} agents)`)
  return { saved: await readOne(projectPath, scope, file!) }
}

/** Why a provider can't run here (off, or not installed), or null. */
function providerProblem(id: ProviderId): string | null {
  const name = providerDescriptor(id).name
  if (!isProviderEnabled(config.settings, id)) return `${name} is turned off (Settings → Providers)`
  if (!providerService.info(id).found) return `${name} isn't installed (Agent Setup)`
  return null
}

/** Whether an agent is running or starting (a start reserved, not yet live): either way, not safe to remove. */
const busy = (projectPath: string, agentId: string): boolean => !!sessions.liveFor(projectPath, agentId) || sessions.startingFor(projectPath, agentId)

/**
 * What loading a template into a project would do: the agents removed and created, the layout, and what stops it now —
 * an agent running or starting, a removed worktree agent's uncommitted work (or a worktree whose state git can't tell:
 * then it isn't known to be safe), a provider that is off or not installed, worktree agents in a project that isn't on
 * a git branch. Nothing is changed.
 */
export async function templatePlan(projectPath: string, scope: TemplateScope, file: string): Promise<TemplateLoadPlan> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(projectPath, checkScope(scope), file)
  const cfg = await workspace.projectConfig(projectPath)
  const current = projectAgents(cfg)
  const remove: TemplateLoadPlan['remove'] = []
  const blocked: string[] = []
  for (const a of current) {
    const running = busy(projectPath, a.id)
    let dirty = 0
    if (a.worktree && existsSync(a.worktree.path)) {
      // As Remove Agent checks before a worktree goes: strictly, so a git that fails never reads as "nothing to lose".
      try {
        dirty = (await wt.branchStatus(projectPath, a.worktree, { strict: true })).dirty
      } catch (e) {
        blocked.push(`Hive couldn't check ${a.name}'s worktree (${a.worktree.path}): ${(e as Error).message.split('\n')[0]}`)
      }
    }
    remove.push({ id: a.id, name: a.name, running, dirty, ...(a.worktree ? { worktree: { path: a.worktree.path, branch: a.worktree.branch } } : {}) })
    if (running) blocked.push(`${a.name} is running or starting: stop it first.`)
    if (dirty) blocked.push(`${a.name} has uncommitted work in its worktree (${a.worktree!.path}): commit or discard it first.`)
  }
  const missing: TemplateLoadPlan['missing'] = []
  for (const id of [...new Set(t.agents.map((a) => a.provider))]) {
    const why = providerProblem(id)
    if (why) missing.push({ provider: id, reason: why, agents: t.agents.filter((a) => a.provider === id).map((a) => a.name) })
  }
  for (const m of missing) blocked.push(`${m.reason}, needed by ${m.agents.join(', ')}.`)
  if (t.agents.some((a) => a.worktree) && !(await wt.currentBranch(projectPath))) blocked.push('Its worktree agents need the project to be a git repository on a branch.')
  return { scope: t.scope, file: t.file, name: t.name, layout: t.layout, remove, create: t.agents, missing, blocked }
}

/** Seams for unit tests: called after each of a load's agents is staged (its name), before the load is published. */
export const testHooks: { staged?: (name: string) => Promise<void> } = {}

/** Loads under way, by project: one at a time each. */
const loading = new Set<string>()

/**
 * Replaces the project's agents with a template's, and its layout (#126). `expected` is the agents the user was shown
 * (their ids, in order).
 *
 * - The project's agents can't start for the whole load (a fence on its starts, lifted however the load ends), and one
 *   running or starting refuses it, as do the other checks of the plan.
 * - **Staged, then published at once:** the new agents (and their new worktrees) are made without touching project.json;
 *   then one write under the project file's lock swaps in the new agents and layout — only if the agents are still
 *   exactly those shown and none runs or is starting. Anything else (an agent added or removed meanwhile) refuses the
 *   load, and the staged worktrees go: no change made meanwhile is lost, and nothing half loaded is ever seen.
 * - The removed agents' worktrees and branches stay (to merge or reuse), their conversations stay in the Sessions tab,
 *   and their open cards go back (nobody has them; Doing ones to Todo).
 */
export async function loadTemplate(projectPath: string, scope: TemplateScope, file: string, expected: string[]): Promise<{ created: string[]; removed: string[] }> {
  projectPath = workspace.assertProject(projectPath)
  const key = projectPath.toLowerCase()
  if (loading.has(key)) throw new TemplateError('A template is already being loaded into this project.')
  loading.add(key)
  const unfence = sessions.fenceStarts(projectPath, 'A template is being loaded into this project')
  try {
    const plan = await templatePlan(projectPath, scope, file)
    if (plan.blocked.length) throw new TemplateError(`The template can't be loaded yet:\n${plan.blocked.map((b) => `• ${b}`).join('\n')}`)
    const changed = (ids: string[]): boolean => !Array.isArray(expected) || ids.length !== expected.length || ids.some((id, i) => id !== expected[i])
    if (changed(plan.remove.map((a) => a.id))) throw new TemplateError("The project's agents changed since you looked: open the template again.")
    const cfg = await workspace.projectConfig(projectPath)
    const staged: { def: AgentDef; discard: () => Promise<void> }[] = []
    let old: AgentDef[] = []
    try {
      for (const a of plan.create) {
        const opts = { name: a.name, role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, location: a.worktree ? ('new-worktree' as const) : ('project' as const) }
        staged.push(await prepareAgent(projectPath, cfg, opts, a.name, []))
        await testHooks.staged?.(a.name)
      }
      // Published at once, under the lock, on the agents as they are now.
      await workspace.mutateProjectConfig(projectPath, (now) => {
        const list = projectAgents(now)
        if (changed(list.map((a) => a.id))) throw new TemplateError("The project's agents changed while the template was loading: nothing was changed. Open the template again.")
        if (list.some((a) => busy(projectPath, a.id))) throw new TemplateError('An agent started meanwhile: nothing was changed. Stop it first.')
        old = list
        return { agents: staged.map((s) => s.def), layout: plan.layout }
      })
    } catch (e) {
      for (const s of staged) await s.discard()
      throw e instanceof TemplateError ? e : new TemplateError(`Nothing was changed: ${(e as Error).message}`)
    }
    const project = basename(projectPath)
    for (const a of old) {
      await releaseAgentCards(project, a.id, { kind: 'user' }).catch((err) => log.warn('Could not take back the cards of a removed agent', err))
      await endReviews(project, a.id, 'the agent was removed', workspaceOf(projectPath)).catch(() => undefined)
    }
    log.info(`Loaded template ${userText(plan.name)} into ${userText(projectPath)}: ${old.length} agents removed, ${staged.length} created`)
    await workspaceOf(projectPath).refresh()
    return { created: staged.map((s) => s.def.name), removed: old.map((a) => a.name) }
  } finally {
    unfence()
    loading.delete(key)
  }
}


/** Adds one agent of a template to the project, the others left alone; a name already taken gets a number ("Builder 2"). */
export async function addAgentFromTemplate(projectPath: string, scope: TemplateScope, file: string, index: number): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(projectPath, checkScope(scope), file)
  const a = Number.isInteger(index) ? t.agents[index] : undefined
  if (!a) throw new TemplateError('That agent is no longer in the template.')
  const why = providerProblem(a.provider)
  if (why) throw new TemplateError(`${why}: ${a.name} needs it.`)
  const taken = projectAgents(await workspace.projectConfig(projectPath)).map((x) => x.name)
  return addAgent(projectPath, { name: uniqueName(a.name, taken), role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, location: a.worktree ? 'new-worktree' : 'project' })
}
