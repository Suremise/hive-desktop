import { shell } from 'electron'
import { existsSync } from 'original-fs'
import { mkdir, readFile, readdir, stat } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { HIVE_DIR, projectAgents, slugify } from '../shared/defaults'
import { agentProvider, isKnownProvider, isProviderEnabled, providerDescriptor } from '../shared/providers'
import {
  exportable,
  exportFileName,
  isTemplateFile,
  readTemplate,
  TEMPLATE_VERSION,
  templateFile,
  templateFrom,
  uniqueName,
  uniqueTemplateName,
  unknownProviders,
  TEMPLATE_IMPORT_MAX,
  TEMPLATE_NAME_MAX,
  type AgentTemplate,
  type TemplateDest,
  type TemplateEntry,
  type TemplateRef,
  type TemplateScope
} from '../shared/templates'
import type { AgentDef, ProviderId, TemplateLoadPlan } from '../shared/types'
import { config } from './config'
import { readKeptJson, withFileLock, writeKeptJson, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { addAgent, claimMark, newWorktreePlace, prepareAgent, removedSince, reserveForRemoval, takePendingSetup } from './projectAgents'
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
 * all or nothing; adding one agent from a template leaves the others alone. #127: listing every scope, rename,
 * duplicate, delete (to the Recycle Bin), and export and import as files, read as untrusted.
 */

const log = createLogger('templates')

/** A template that isn't there, or can't be used: the caller says so as it is. */
export class TemplateError extends Error {}

const checkScope = (scope: unknown): TemplateScope => {
  if (scope !== 'workspace' && scope !== 'project') throw new TemplateError(`Unknown scope "${String(scope)}": workspace or project.`)
  return scope
}

/**
 * Where a scope's templates are kept. A project's: that project's folder (one of the workspace's). The workspace's:
 * the workspace of `project` when one is given (the project a template is used in), else this call's workspace.
 */
function folder(d: TemplateDest): string {
  if (checkScope(d.scope) === 'project') return join(workspace.assertProject(String(d.project ?? '')), HIVE_DIR, 'templates')
  const ws = d.project ? workspaceOf(d.project).path : workspace.path
  if (!ws) throw new TemplateError('Open a workspace first.')
  return join(ws, HIVE_DIR, 'templates')
}

/** The place a template is kept, as listed (a project's path only for a project's templates). */
const place = (d: TemplateDest): TemplateDest => (d.scope === 'project' ? { scope: 'project', project: workspace.assertProject(String(d.project ?? '')) } : { scope: 'workspace' })

async function readOne(d: TemplateDest, file: string): Promise<TemplateEntry> {
  const where = place(d)
  const raw = await readKeptJson<unknown>(join(folder(d), file), null)
  const t = raw === null ? "It couldn't be read." : readTemplate(raw)
  if (typeof t === 'string') {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, TEMPLATE_NAME_MAX) : file.replace(/\.json$/, '')
    return { ...where, file, name, savedAt: null, layout: 'auto', agents: [], problem: t }
  }
  return { ...where, file, name: t.name, savedAt: t.savedAt || null, layout: t.layout, ...(t.description ? { description: t.description } : {}), agents: t.agents }
}

/** The templates kept in one place, by file name. */
async function listIn(d: TemplateDest): Promise<TemplateEntry[]> {
  const files = (await readdir(folder(d)).catch(() => [] as string[])).filter(isTemplateFile).sort()
  const out: TemplateEntry[] = []
  for (const f of files) out.push(await readOne(d, f))
  return out
}

const byName = (a: TemplateEntry, b: TemplateEntry): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.scope === 'workspace' ? -1 : 1)

/** The templates a project can use: the workspace's and its own, each by name (a name in both scopes is listed twice). */
export async function listTemplates(projectPath: string): Promise<TemplateEntry[]> {
  projectPath = workspace.assertProject(projectPath)
  const out = [...(await listIn({ scope: 'workspace', project: projectPath })), ...(await listIn({ scope: 'project', project: projectPath }))]
  return out.sort(byName)
}

/** Every template of the workspace (the Templates view): the workspace's, then each project's, each by name. */
export async function listAllTemplates(): Promise<TemplateEntry[]> {
  if (!workspace.path) return []
  const out = (await listIn({ scope: 'workspace' })).sort(byName)
  for (const p of await workspace.listProjectPaths()) out.push(...(await listIn({ scope: 'project', project: p })).sort(byName))
  return out
}

/** One template's file, after checking it is one Hive could have made (never a path) and is there. */
function fileOf(ref: TemplateRef): string {
  if (!isTemplateFile(ref.file)) throw new TemplateError('That template is no longer there.')
  const f = join(folder(ref), ref.file)
  if (!existsSync(f)) throw new TemplateError('That template is no longer there.')
  return f
}

/** One template to use (refused, saying why, if it is missing or can't be used). */
async function usable(ref: TemplateRef): Promise<TemplateEntry & { template: AgentTemplate }> {
  fileOf(ref)
  const e = await readOne(ref, ref.file)
  if (e.problem) throw new TemplateError(`"${e.name}" can't be used: ${e.problem}`)
  return { ...e, template: { version: 1, name: e.name, savedAt: e.savedAt ?? '', layout: e.layout, ...(e.description ? { description: e.description } : {}), agents: e.agents } }
}

/** A template name as saved: one line, trimmed, refused (saying why) if empty or too long. */
function cleanName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw new TemplateError('Enter a name for the template.')
  if (clean.length > TEMPLATE_NAME_MAX) throw new TemplateError(`A template's name is at most ${TEMPLATE_NAME_MAX} characters.`)
  return clean
}

/** A new file for a template in a place: from its name, numbered when that file is taken. */
async function newFile(d: TemplateDest, name: string): Promise<string> {
  const taken = await readdir(folder(d)).catch(() => [] as string[])
  for (let n = 1; ; n++) if (!taken.includes(templateFile(name, n))) return templateFile(name, n)
}

/**
 * Runs a change to a place's templates with that place locked against every other change to it (save, import,
 * duplicate, rename, delete), from any project or window: what it reads, checks (a name taken), chooses (a new file) and
 * writes is one step, so two changes at once never pick the same file or miss each other's name. Readers need no lock
 * (each file is written whole). Never nested for one place.
 */
function changing<T>(d: TemplateDest, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${resolve(folder(d))}|templates`, fn)
}

/** Writes a template into a place (its file there: a new one, or the one it replaces). */
async function write(d: TemplateDest, file: string, t: AgentTemplate): Promise<TemplateEntry> {
  await mkdir(folder(d), { recursive: true })
  await writeKeptJson(join(folder(d), file), exportable(t))
  return readOne(d, file)
}

/**
 * Saves the project's agents and layout as a template in `scope`. A template of that name already there (case aside) is
 * replaced only with `overwrite`; otherwise the answer says it exists, so the user can be asked.
 */
export async function saveTemplate(projectPath: string, scope: TemplateScope, name: string, overwrite = false): Promise<{ saved: TemplateEntry } | { exists: string }> {
  projectPath = workspace.assertProject(projectPath)
  const d: TemplateDest = { scope: checkScope(scope), project: projectPath }
  const clean = cleanName(name)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (!agents.length) throw new TemplateError('This project has no agents to save.')
  const t = templateFrom(clean, agents, cfg.layout, (a) => agentProvider(a, cfg, config.settings))
  return changing(d, async () => {
    // The same name: its file (replaced when asked). Another name whose file name would be the same: a file of its own.
    const same = (await listIn(d)).find((e) => e.name.toLowerCase() === clean.toLowerCase())
    if (same && !overwrite) return { exists: same.file }
    const saved = await write(d, same?.file ?? (await newFile(d, clean)), t)
    log.info(`Saved template ${userText(clean)} (${scope}, ${t.agents.length} agents)`)
    return { saved }
  })
}

/** Renames a template where it is kept; another of that name there (case aside) refuses it. */
export async function renameTemplate(ref: TemplateRef, name: string): Promise<TemplateEntry> {
  const clean = cleanName(name)
  return changing(ref, async () => {
    const t = await usable(ref)
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw new TemplateError(`There is already a template called "${clean}" there.`)
    const renamed = await write(ref, ref.file, { ...t.template, name: clean })
    log.info(`Renamed template ${userText(t.name)} to ${userText(clean)}`)
    return renamed
  })
}

/**
 * Saves a template edited in the Templates view (#271): its name, description, layout and agents, in the file it is
 * kept in (its place stays: Duplicate… moves it). The edit is checked as untrusted (as an import is: 1–12 agents with
 * unique names, providers' ids, settings as CLIs name them) and refused, saying why, if another template there has its
 * name or the template changed since it was opened (`savedAt`, as it was then): nothing is half saved, and a change
 * made meanwhile (a re-save from a project, another window's edit) is never overwritten unasked.
 */
export async function updateTemplate(ref: TemplateRef, edited: unknown, savedAt: string | null): Promise<TemplateEntry> {
  const clean = cleanName(edited && typeof edited === 'object' ? (edited as { name?: unknown }).name : '')
  const t = readTemplate({ ...(edited as object), version: TEMPLATE_VERSION, name: clean, savedAt: new Date().toISOString() })
  if (typeof t === 'string') throw new TemplateError(t)
  return changing(ref, async () => {
    const now = await usable(ref)
    if ((now.savedAt ?? null) !== (savedAt ?? null)) throw new TemplateError(`"${now.name}" changed since you started editing it (saved again meanwhile): nothing was saved. Close the editor to see it as it is now.`)
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw new TemplateError(`There is already a template called "${clean}" there.`)
    const saved = await write(ref, ref.file, t)
    log.info(`Edited template ${userText(clean)} (${ref.scope}, ${t.agents.length} agents)`)
    return saved
  })
}

/** Copies a template into a place (the same or another); a name taken there gets a number ("Pair (2)"). */
export async function duplicateTemplate(ref: TemplateRef, to: TemplateDest): Promise<TemplateEntry> {
  // Read first (unlocked: the source may be in the same place), then the copy's name and file chosen and written there.
  const t = await usable(ref)
  return changing(to, async () => {
    const name = uniqueTemplateName(t.name, (await listIn(to)).map((e) => e.name))
    const copy = await write(to, await newFile(to, name), { ...t.template, name })
    log.info(`Duplicated template ${userText(t.name)} into ${to.scope} as ${userText(name)}`)
    return copy
  })
}

/** Deletes a template: its file (and the copy kept beside it) go to the Recycle Bin. */
export async function deleteTemplate(ref: TemplateRef): Promise<void> {
  await changing(ref, async () => {
    const f = fileOf(ref)
    await shell.trashItem(f)
    if (existsSync(`${f}.bak`)) await shell.trashItem(`${f}.bak`).catch((e) => log.warn('Could not remove the copy of a deleted template', e))
    log.info(`Deleted template ${userText(ref.file)} (${ref.scope})`)
  })
}

/** The file name an export of a template suggests ("Build and review.hive-template.json"); refused if it can't be used. */
export async function exportName(ref: TemplateRef): Promise<string> {
  return exportFileName((await usable(ref)).name)
}

/** Exports a template to a file the user chose: what it holds, nothing else (exportable). */
export async function exportTemplate(ref: TemplateRef, dest: string): Promise<void> {
  const t = await usable(ref)
  await writeTextAtomic(dest, JSON.stringify(exportable(t.template), null, 2) + '\n')
  log.info(`Exported template ${userText(t.name)} to ${userText(dest)}`)
}

/** A file to import, read and checked (untrusted): the template, or refused saying why. Nothing is written. */
export async function readImport(path: string): Promise<AgentTemplate> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new TemplateError("That file isn't there.")
  if (info.size > TEMPLATE_IMPORT_MAX) throw new TemplateError(`It isn't a Hive agent template (over ${TEMPLATE_IMPORT_MAX / 1024} KB).`)
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw new TemplateError("It isn't a Hive agent template (not JSON).")
  }
  const t = readTemplate(raw)
  if (typeof t === 'string') throw new TemplateError(t)
  return t
}

/** What an import would bring in: its name, agents, and the providers among them this Hive doesn't know (flagged). */
export async function inspectImport(path: string): Promise<{ path: string; name: string; agents: number; unknown: string[] }> {
  const t = await readImport(path)
  return { path, name: t.name, agents: t.agents.length, unknown: unknownProviders(t.agents) }
}

/**
 * Imports a template file into a place, all or nothing (the file is checked first, and written in one go). A template of
 * that name already there is a clash: the answer says so unless `onClash` says what to do — replace it, or keep both
 * (the new one numbered, "Pair (2)").
 */
export async function importTemplate(path: string, to: TemplateDest, onClash?: 'replace' | 'keep'): Promise<{ imported: TemplateEntry } | { clash: string }> {
  const t = await readImport(path)
  return changing(to, async () => {
    const here = await listIn(to)
    const same = here.find((e) => e.name.toLowerCase() === t.name.toLowerCase())
    if (same && onClash !== 'replace' && onClash !== 'keep') return { clash: same.name }
    const name = same && onClash === 'keep' ? uniqueTemplateName(t.name, here.map((e) => e.name)) : t.name
    const file = same && onClash === 'replace' ? same.file : await newFile(to, name)
    const imported = await write(to, file, { ...t, name })
    log.info(`Imported template ${userText(name)} into ${to.scope} (${t.agents.length} agents)`)
    return { imported }
  })
}

/** Why a provider can't run here (unknown to this Hive, off, or not installed), or null. */
function providerProblem(id: ProviderId): string | null {
  if (!isKnownProvider(id)) return `This Hive doesn't know the coding agent "${id}" (update Hive)`
  const name = providerDescriptor(id).name
  if (!isProviderEnabled(config.settings, id)) return `${name} is turned off (Settings → Providers)`
  if (!providerService.info(id).found) return `${name} isn't installed (Agent Setup)`
  return null
}

/** A template used in a project: a project's is looked up in `from` (another project's, from the Templates view), else in that project. */
const refFor = (projectPath: string, scope: TemplateScope, file: string, from?: string): TemplateRef => ({ scope: checkScope(scope), project: scope === 'project' && from ? from : projectPath, file })

/** A worktree a template's agent can work in again: its folder and branch. */
type Reuse = { path: string; branch: string }

/** Why a worktree can't be worked in again (null: it can): git must list it on `branch`, with nothing uncommitted (strict). */
async function notReusable(projectPath: string, w: Reuse, base: string, listed: { path: string; branch: string | null }[]): Promise<string | null> {
  const there = listed.find((x) => x.path.toLowerCase() === resolve(w.path).toLowerCase())
  if (!there) return `git doesn't list ${w.path} as a worktree any more`
  if (there.branch !== w.branch) return `its worktree is on ${there.branch ?? 'no branch'}, not ${w.branch}`
  try {
    const { dirty } = await wt.branchStatus(projectPath, { path: there.path, branch: w.branch, base }, { strict: true })
    return dirty ? `${w.branch} has ${dirty} uncommitted ${dirty === 1 ? 'file' : 'files'}` : null
  } catch (e) {
    return `Hive couldn't check ${w.branch} (${(e as Error).message.split('\n')[0]})`
  }
}

/**
 * The worktree a template's agent called `name` can work in again instead of a new one (#289), its branch left as it is:
 * the worktree of the agent of that name it replaces (`own`); else one Hive made for that name that git lists and no
 * agent works in (`inUse`, lower-cased paths): `hive/<name>` in that name's folder in the project's worktree location,
 * or one numbered when it was made (`-2`…: an earlier load's, kept when its agent was replaced). Only a clean one
 * (`notReusable`); of several clean ones, the unnumbered one, else none (ambiguous). `reuse`, or why the one that
 * matches can't be (null: none matches).
 */
async function reusableWorktree(projectPath: string, name: string, base: string, own: Reuse | undefined, inUse: ReadonlySet<string>, listed: { path: string; branch: string | null }[]): Promise<{ reuse: Reuse } | { why: string } | null> {
  if (own) {
    if (inUse.has(resolve(own.path).toLowerCase())) return { why: `another agent works in ${own.branch}'s worktree` }
    const why = await notReusable(projectPath, own, base, listed)
    return why ? { why } : { reuse: { path: resolve(own.path), branch: own.branch } }
  }
  const slug = slugify(name)
  const root = resolve(join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!)).toLowerCase()
  const numbered = (s: string, stem: string): boolean => s === stem || (s.startsWith(`${stem}-`) && /^\d+$/.test(s.slice(stem.length + 1)))
  const mine = listed.filter((w) => !!w.branch && dirname(w.path).toLowerCase() === root && numbered(basename(w.path).toLowerCase(), slug) && numbered(w.branch.toLowerCase(), `hive/${slug}`))
  if (!mine.length) return null
  const free = mine.filter((w) => !inUse.has(w.path.toLowerCase()))
  if (!free.length) return { why: `another agent works in ${mine[0].branch}'s worktree` }
  const checked = await Promise.all(free.map(async (w) => ({ w: { path: w.path, branch: w.branch! }, why: await notReusable(projectPath, { path: w.path, branch: w.branch! }, base, listed) })))
  const clean = checked.filter((c) => !c.why)
  const exact = clean.find((c) => basename(c.w.path).toLowerCase() === slug && c.w.branch.toLowerCase() === `hive/${slug}`)
  if (exact) return { reuse: exact.w }
  if (clean.length === 1) return { reuse: clean[0].w }
  if (clean.length > 1) return { why: `several clean worktrees could be its (${clean.map((c) => c.w.branch).join(', ')})` }
  return { why: checked[0].why! }
}

/** Whether an agent is running or starting (a start reserved, not yet live): either way, not safe to remove. */
const busy = (projectPath: string, agentId: string): boolean => !!sessions.liveFor(projectPath, agentId) || sessions.startingFor(projectPath, agentId)

/**
 * What loading a template into a project would do: the agents removed and created, the layout, and what stops it now —
 * an agent running or starting, a removed worktree agent's uncommitted work (or a worktree whose state git can't tell:
 * then it isn't known to be safe), a provider that is off or not installed, worktree agents in a project that isn't on
 * a git branch. Nothing is changed.
 */
export async function templatePlan(projectPath: string, scope: TemplateScope, file: string, from?: string): Promise<TemplateLoadPlan> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(refFor(projectPath, scope, file, from))
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
  const base = t.agents.some((a) => a.worktree) ? await wt.currentBranch(projectPath) : null
  if (t.agents.some((a) => a.worktree) && !base) blocked.push('Its worktree agents need the project to be a git repository on a branch.')
  // Where each worktree agent works, as the load makes them, one after another: in this project, never the template's
  // project (a template holds only whether an agent has its own worktree, #268). A clean worktree of the same name is
  // worked in again (#289: the replaced agent's, or an earlier load's), else a new one.
  const taken = { branches: new Set<string>(), folders: new Set<string>() }
  const worktrees: TemplateLoadPlan['worktrees'] = []
  const listed = base && t.agents.some((a) => a.worktree) ? await wt.listWorktrees(projectPath) : []
  for (const a of t.agents) {
    if (!a.worktree || !base) {
      worktrees.push(null)
      continue
    }
    const own = current.find((x) => x.worktree && x.name.toLowerCase() === a.name.toLowerCase())?.worktree
    const found = await reusableWorktree(projectPath, a.name, base, own && { path: own.path, branch: own.branch }, taken.folders, listed)
    if (found && 'reuse' in found) {
      taken.branches.add(found.reuse.branch)
      taken.folders.add(resolve(found.reuse.path).toLowerCase())
      worktrees.push({ ...found.reuse, base, reuse: true })
      continue
    }
    const spot = await newWorktreePlace(projectPath, a.name, undefined, taken)
    taken.branches.add(spot.branch)
    taken.folders.add(resolve(spot.path).toLowerCase())
    worktrees.push({ ...spot, base, ...(found ? { notReused: found.why } : {}) })
  }
  const setup = cfg.worktreeSetup.trim() || null
  // The removed agents' worktrees nobody works in again: which could go with the load, merged and clean (#289).
  const reused = new Set(worktrees.flatMap((w) => (w?.reuse ? [resolve(w.path).toLowerCase()] : [])))
  const oldWorktrees: TemplateLoadPlan['oldWorktrees'] = []
  let mergedInto: string | null = null
  for (const a of current) {
    if (!a.worktree || reused.has(resolve(a.worktree.path).toLowerCase())) continue
    const check = await wt.worktreeCheck(projectPath, a.worktree)
    mergedInto = check.into
    oldWorktrees.push({ agent: a.name, path: a.worktree.path, branch: a.worktree.branch, removable: check.removable, ...(check.removable ? {} : { why: check.reason ?? 'not checked' }) })
  }
  return { scope: t.scope, file: t.file, name: t.name, layout: t.layout, remove, create: t.agents, worktrees, setup, oldWorktrees, mergedInto, missing, blocked }
}

/** Seams for unit tests: called after each of a load's agents is staged (its name), before the load is published. */
export const testHooks: {
  staged?: (name: string) => Promise<void>
  /** Before an old worktree the user chose is reserved for removal (#289), and once it is checked, just before it goes. */
  beforeRemoval?: (branch: string) => Promise<void>
  removing?: (branch: string) => Promise<void>
} = {}

/** Loads under way, by project: one at a time each. */
const loading = new Set<string>()

/**
 * Replaces the project's agents with a template's, and its layout (#126). `expected` is the agents the user was shown
 * (their ids, in order). `from`: the project a project's template is kept in, when it isn't this one (#127: the Templates
 * view loads any template into any project).
 *
 * - The project's agents can't start for the whole load (a fence on its starts, lifted however the load ends), and one
 *   running or starting refuses it, as do the other checks of the plan.
 * - **Staged, then published at once:** the new agents (and their new worktrees) are made without touching project.json;
 *   then one write under the project file's lock swaps in the new agents and layout — only if the agents are still
 *   exactly those shown and none runs or is starting. Anything else (an agent added or removed meanwhile) refuses the
 *   load, and the staged worktrees go: no change made meanwhile is lost, and nothing half loaded is ever seen.
 * - The removed agents' worktrees and branches stay (to merge or reuse), their conversations stay in the Sessions tab,
 *   and their open cards go back (nobody has them; Doing ones to Todo). A created agent of the same name may work in
 *   one again (#289).
 * - `removeOld` (#289): the old worktrees the user chose to remove with their branches, which the dialog listed as merged
 *   into `mergedInto` and clean. Only once the load is published (a refused load removes nothing), and only a removed
 *   agent's worktree that no agent works in now, checked again and guarded while deleting (`removeCheckedWorktree`):
 *   one that isn't any more is kept, and the reply says why.
 */
export async function loadTemplate(projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, removeOld?: { paths: string[]; mergedInto: string | null }): Promise<{ created: string[]; removed: string[]; oldWorktrees: { branch: string; removed: boolean; why?: string }[] }> {
  projectPath = workspace.assertProject(projectPath)
  const key = projectPath.toLowerCase()
  if (loading.has(key)) throw new TemplateError('A template is already being loaded into this project.')
  loading.add(key)
  const unfence = sessions.fenceStarts(projectPath, 'A template is being loaded into this project')
  try {
    // Before the plan looks at the worktrees: one removed since then isn't worked in again (#289).
    const mark = claimMark()
    const plan = await templatePlan(projectPath, scope, file, from)
    if (plan.blocked.length) throw new TemplateError(`The template can't be loaded yet:\n${plan.blocked.map((b) => `• ${b}`).join('\n')}`)
    const changed = (ids: string[]): boolean => !Array.isArray(expected) || ids.length !== expected.length || ids.some((id, i) => id !== expected[i])
    if (changed(plan.remove.map((a) => a.id))) throw new TemplateError("The project's agents changed since you looked: open the template again.")
    const cfg = await workspace.projectConfig(projectPath)
    const staged: { def: AgentDef; discard: () => Promise<void> }[] = []
    let old: AgentDef[] = []
    try {
      for (const [i, a] of plan.create.entries()) {
        // A worktree the plan reuses (#289), checked again just now (the plan is made afresh for the load): else a new one.
        const reuse = plan.worktrees[i]?.reuse ? plan.worktrees[i] : null
        const opts = { name: a.name, role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, location: reuse ? ('existing-worktree' as const) : a.worktree ? ('new-worktree' as const) : ('project' as const), ...(reuse ? { worktreePath: reuse.path } : {}) }
        staged.push(await prepareAgent(projectPath, cfg, opts, a.name, staged.map((s) => s.def)))
        await testHooks.staged?.(a.name)
      }
      // Published at once, under the lock, on the agents as they are now.
      await workspace.mutateProjectConfig(projectPath, (now) => {
        const list = projectAgents(now)
        if (changed(list.map((a) => a.id))) throw new TemplateError("The project's agents changed while the template was loading: nothing was changed. Open the template again.")
        if (list.some((a) => busy(projectPath, a.id))) throw new TemplateError('An agent started meanwhile: nothing was changed. Stop it first.')
        if (staged.some((s) => s.def.worktree && (removedSince(s.def.worktree.path, mark) || !existsSync(s.def.worktree.path)))) throw new TemplateError('A worktree it would work in again is being removed, or was just removed: nothing was changed. Open the template again.')
        old = list
        // A worktree whose setup never ran keeps that (#289): an agent working in it again runs it first, and one kept
        // without an agent is remembered for the next.
        const pathKey = (p: string): string => resolve(p).toLowerCase()
        const taking = new Set(staged.flatMap((s) => (s.def.worktree ? [pathKey(s.def.worktree.path)] : [])))
        const pendingBefore = new Set(list.filter((a) => a.worktree && a.needsSetup).map((a) => pathKey(a.worktree!.path)))
        let pending = Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []
        for (const s of staged) {
          if (!s.def.worktree || s.def.needsSetup) continue
          if (pendingBefore.has(pathKey(s.def.worktree.path)) && now.worktreeSetup.trim()) s.def.needsSetup = true
          else pending = takePendingSetup({ ...now, setupPending: pending }, s.def)?.setupPending ?? pending
        }
        pending = [...pending.filter((p) => !taking.has(pathKey(p))), ...list.filter((a) => a.worktree && a.needsSetup && !taking.has(pathKey(a.worktree.path))).map((a) => a.worktree!.path)]
        return { agents: staged.map((s) => s.def), layout: plan.layout, setupPending: [...new Map(pending.map((p) => [pathKey(p), p])).values()].slice(-50) }
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
    const oldWorktrees = await removeOldWorktrees(projectPath, old, removeOld)
    await workspaceOf(projectPath).refresh()
    return { created: staged.map((s) => s.def.name), removed: old.map((a) => a.name), oldWorktrees }
  } finally {
    unfence()
    loading.delete(key)
  }
}


/**
 * After a load, the removed agents' worktrees the user chose to remove (#289): each only if it was a removed agent's, no
 * agent of the project works in it now, and it is merged into the main branch the user was shown and clean now
 * (`worktreeCheck`, then `removeCheckedWorktree`, which deletes nothing if either branch moved). What happened to each.
 */
async function removeOldWorktrees(projectPath: string, old: AgentDef[], removeOld: { paths: string[]; mergedInto: string | null } | undefined): Promise<{ branch: string; removed: boolean; why?: string }[]> {
  const key = (p: string): string => resolve(p).toLowerCase()
  const asked = new Set((Array.isArray(removeOld?.paths) ? removeOld.paths : []).filter((p) => typeof p === 'string').map(key))
  if (!asked.size) return []
  const out: { branch: string; removed: boolean; why?: string }[] = []
  for (const a of old) {
    const tree = a.worktree
    if (!tree || !asked.has(key(tree.path))) continue
    asked.delete(key(tree.path))
    await testHooks.beforeRemoval?.(tree.branch)
    // Reserved first, so no agent can be given it from now on (addAgent and a load refuse it under the project file's
    // lock); then, under that lock, whether one was given it before. Either an agent has it and it stays, or none can.
    let release: () => void
    try {
      release = reserveForRemoval(tree.path)
    } catch (e) {
      out.push({ branch: tree.branch, removed: false, why: (e as Error).message })
      continue
    }
    try {
      let owned = false
      await workspace.mutateProjectConfig(projectPath, (now) => {
        owned = projectAgents(now).some((x) => x.worktree && key(x.worktree.path) === key(tree.path))
        return {}
      })
      if (owned) {
        out.push({ branch: tree.branch, removed: false, why: 'an agent works in it now' })
        continue
      }
      await testHooks.removing?.(tree.branch)
      const done = await wt.removeCheckedWorktree(projectPath, tree, await wt.worktreeCheck(projectPath, tree), removeOld?.mergedInto ?? null).catch((e: Error) => ({ deleted: false, reason: e.message.split('\n')[0] }))
      out.push({ branch: tree.branch, removed: done.deleted, ...(done.reason ? { why: done.reason } : {}) })
      // A removed worktree's setup isn't pending any more.
      if (done.deleted) await workspace.mutateProjectConfig(projectPath, (now) => (Array.isArray(now.setupPending) ? { setupPending: now.setupPending.filter((p) => typeof p !== 'string' || key(p) !== key(tree.path)) } : {}))
    } finally {
      release()
    }
  }
  return out
}

/** Adds one agent of a template to the project, the others left alone; a name already taken gets a number ("Builder 2"). */
export async function addAgentFromTemplate(projectPath: string, scope: TemplateScope, file: string, index: number, from?: string): Promise<AgentDef & { reused?: true }> {
  projectPath = workspace.assertProject(projectPath)
  const t = await usable(refFor(projectPath, scope, file, from))
  const a = Number.isInteger(index) ? t.agents[index] : undefined
  if (!a) throw new TemplateError('That agent is no longer in the template.')
  const why = providerProblem(a.provider)
  if (why) throw new TemplateError(`${why}: ${a.name} needs it.`)
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  const name = uniqueName(a.name, agents.map((x) => x.name))
  // A clean worktree Hive made for that name that no agent works in is worked in again (#289), else a new one.
  const base = a.worktree ? await wt.currentBranch(projectPath) : null
  const inUse = new Set(agents.flatMap((x) => (x.worktree ? [resolve(x.worktree.path).toLowerCase()] : [])))
  const found = base ? await reusableWorktree(projectPath, name, base, undefined, inUse, await wt.listWorktrees(projectPath)) : null
  const reuse = found && 'reuse' in found ? found.reuse : null
  const settings = { name, role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext }
  const def = await addAgent(projectPath, reuse ? { ...settings, location: 'existing-worktree', worktreePath: reuse.path } : { ...settings, location: a.worktree ? 'new-worktree' : 'project' })
  if (reuse) log.info(`Added ${userText(name)} from a template in its worktree again (${userText(reuse.branch)})`)
  return reuse ? { ...def, reused: true } : def
}
