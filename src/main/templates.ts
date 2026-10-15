import { existsSync } from 'original-fs'
import { mkdir, readFile, readdir, stat } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { HIVE_DIR, projectAgents, slugify } from '../shared/defaults'
import { agentProvider, isKnownProvider, isProviderEnabled, providerDescriptor } from '../shared/providers'
import {
  exportable,
  exportFileName,
  isAgentTemplate,
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
  templateLimitText,
  type AgentTemplate,
  type TemplateDeleted,
  type TemplateDest,
  type TemplateEntry,
  type TemplateRef,
  type TemplateAgent,
  type TemplateScope
} from '../shared/templates'
import type { AgentBranchStatus, AgentDef, AgentWorktree, OldWorktreeOutcome, ProviderId, TemplateLoadPlan } from '../shared/types'
import { config } from './config'
import { placeKey, readKeptJson, withFileLock, writeKeptJson, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { addAgent, agentLimit, branchPlace, claimMark, newWorktreePlace, prepareAgent, removedSince, reserveForRemoval, takePendingSetup } from './projectAgents'
import { providerService } from './providerService'
import { sessions } from './sessions'
import { endReviews, releaseAgentCards } from './tasks'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { gitTool } from './gitTool'
import { gitProblemData } from '../shared/gitTool'
import { englishText, listOf, shownText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import { fmt, msg, tr, type Msg } from '../shared/i18n'
import { errorText, HiveError, shownError } from './hiveError'
import { unusedWorktreesNamed } from './unusedWorktrees'
import { trash } from './trash'
import { withAgentNames, workspaceAgents } from './agentNames'
import { hiveBranchNumber } from '../shared/hiveBranches'
import { AGENT_NAME_MAX, agentNameProblem, nameTaken, sameAgentName } from '../shared/agentNames'

/**
 * Agent templates (#126): a project's agents and layout saved under a name, in the workspace (`<workspace>/.hive/
 * templates`, for every project) or the project (`<project>/.hive/templates`, private: the project's .hive is kept out
 * of git). One kept JSON file each (a damaged one is recovered from its copy). Loading one replaces the project's agents
 * — only when it is safe (none running, no uncommitted work in their worktrees, every provider on and installed), and
 * all or nothing; adding one agent from a template leaves the others alone. #127: listing every scope, rename,
 * duplicate, delete (to the Recycle Bin), and export and import as files, read as untrusted.
 */

const log = createLogger('templates')

/** A template that isn't there, or can't be used: the caller says so as it is, in the window's language (#849). */
export class TemplateError extends HiveError {}

/** A refusal from a message and its values. */
const refusal = (m: Msg, values?: TextValues, kind?: 'invalid' | 'notFound' | 'conflict'): TemplateError => new TemplateError(values ? withValues(m, values) : m, kind ? { kind } : undefined)

/** Templates' refusals and the load plan's reasons, which only the window reads (#849): IPC shows them in its language. */
const M = {
  gone: msg({ id: 'content.templates.gone', defaultMessage: 'That template is no longer there.', description: 'An error: the template was deleted or renamed meanwhile.' }),
  nameTaken: msg({ id: 'content.templates.nameTaken', defaultMessage: 'There is already a template called "{name}" there.', description: 'An error renaming or editing a template: another template where it is kept (the workspace or a project) is called {name}.' }),
  provider: msg({ id: 'content.templates.provider', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive)} off {{provider} is turned off (Settings → Providers)} other {{provider} isn\'t installed (Agent Setup)}}', description: "Why a template can't be loaded: a coding agent CLI it needs. {problem} is why: unknown ({provider} is the id the template gives, which this version of Hive doesn't know), off (turned off in Settings → Providers), or not installed (Agent Setup is a Help window). {provider} is otherwise its name (\"Codex\")." }),
  neededBy: msg({ id: 'content.templates.neededBy', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive), needed by {agents}.} off {{provider} is turned off (Settings → Providers), needed by {agents}.} other {{provider} isn\'t installed (Agent Setup), needed by {agents}.}}', description: "Why a template can't be loaded: a coding agent CLI its agents {agents} (their names, listed in the language's way: \"Builder and Reviewer\") need. {problem} and {provider} as in the reason without the agents." }),
  needsIt: msg({ id: 'content.templates.needsIt', defaultMessage: '{problem, select, unknown {This Hive doesn\'t know the coding agent "{provider}" (update Hive): {agent} needs it.} off {{provider} is turned off (Settings → Providers): {agent} needs it.} other {{provider} isn\'t installed (Agent Setup): {agent} needs it.}}', description: "An error adding one agent from a template: the coding agent CLI it needs. {agent} is its name; {problem} and {provider} as in the reason a template can't be loaded." }),
  taken: msg({ id: 'content.templates.taken', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}.', description: "Why a template can't be loaded: agents of other projects ({projects}) have its agents' names {names} ({count} of them). {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  takenNothing: msg({ id: 'content.templates.takenNothing', defaultMessage: '{names} {count, plural, one {is already an agent} other {are already agents}} in {projects}: agent names are unique across the workspace, so rename {count, plural, one {it} other {them}}. Nothing was changed.', description: "An error loading a template: agents of other projects ({projects}) took its agents' names {names} ({count} of them) while it loaded, so nothing changed. {names} and {projects} are lists, in the language's way (\"B1 and R1\")." }),
  inUse: msg({ id: 'content.templates.inUse', defaultMessage: "another agent works in {branch}'s worktree", description: "Why a template's agent gets a new worktree: another agent works in the one of its name, on {branch}. A clause, lower case." }),
  nothing: msg({ id: 'content.templates.nothing', defaultMessage: '{problem} Nothing was changed.', description: "An error loading a template, nothing changed: {problem} is why, a sentence of its own (how many agents a project can have)." })
}

const checkScope = (scope: unknown): TemplateScope => {
  if (scope !== 'workspace' && scope !== 'project') throw refusal(msg({ id: 'content.templates.scope', defaultMessage: 'Unknown scope "{scope}": workspace or project.', description: 'An error: where a template is kept must be workspace or project (keep those two words: they are the values to use).' }), { scope: String(scope) }, 'invalid')
  return scope
}

/**
 * Where a scope's templates are kept. A project's: that project's folder (one of the workspace's). The workspace's:
 * the workspace of `project` when one is given (the project a template is used in), else this call's workspace.
 */
function folder(d: TemplateDest): string {
  if (checkScope(d.scope) === 'project') return join(workspace.assertProject(String(d.project ?? '')), HIVE_DIR, 'templates')
  const ws = d.project ? workspaceOf(d.project).path : workspace.path
  if (!ws) throw refusal(msg({ id: 'content.templates.noWorkspace', defaultMessage: 'Open a workspace first.', description: "An error: the workspace's templates need a workspace open." }))
  return join(ws, HIVE_DIR, 'templates')
}

/** The place a template is kept, as listed (a project's path only for a project's templates). */
const place = (d: TemplateDest): TemplateDest => (d.scope === 'project' ? { scope: 'project', project: workspace.assertProject(String(d.project ?? '')) } : { scope: 'workspace' })

async function readOne(d: TemplateDest, file: string): Promise<TemplateEntry> {
  const where = place(d)
  const raw = await readKeptJson<unknown>(join(folder(d), file), null)
  const t = raw === null ? msg({ id: 'content.templates.unreadable', defaultMessage: "It couldn't be read.", description: "Why a template can't be used: its file couldn't be read." }) : readTemplate(raw)
  if (!isAgentTemplate(t)) {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, TEMPLATE_NAME_MAX) : file.replace(/\.json$/, '')
    // Why, in English for the log and a refusal's message, and as text the window shows in its language (#870).
    return { ...where, file, name, savedAt: null, layout: 'auto', agents: [], problem: englishText(t), problemText: t }
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
  if (!isTemplateFile(ref.file)) throw refusal(M.gone, undefined, 'notFound')
  const f = join(folder(ref), ref.file)
  if (!existsSync(f)) throw refusal(M.gone, undefined, 'notFound')
  return f
}

/** One template to use (refused, saying why, if it is missing or can't be used). */
async function usable(ref: TemplateRef): Promise<TemplateEntry & { template: AgentTemplate }> {
  fileOf(ref)
  const e = await readOne(ref, ref.file)
  if (e.problem) throw refusal(msg({ id: 'content.templates.cantUse', defaultMessage: '"{name}" can\'t be used: {problem}', description: "An error: the template {name} can't be used; {problem} says why (a sentence)." }), { name: e.name, problem: e.problemText ?? e.problem })
  return { ...e, template: { version: 1, name: e.name, savedAt: e.savedAt ?? '', layout: e.layout, ...(e.description ? { description: e.description } : {}), agents: e.agents } }
}

/** A template name as saved: one line, trimmed, refused (saying why) if empty or too long. */
function cleanName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw refusal(msg({ id: 'content.templates.enterName', defaultMessage: 'Enter a name for the template.', description: "An error saving or renaming a template with no name." }), undefined, 'invalid')
  if (clean.length > TEMPLATE_NAME_MAX) throw refusal(msg({ id: 'content.templates.nameTooLong', defaultMessage: "A template's name is at most {max} characters.", description: "An error saving or renaming a template whose name is longer than {max} characters." }), { max: TEMPLATE_NAME_MAX }, 'invalid')
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
  if (!agents.length) throw refusal(msg({ id: 'content.templates.noAgents', defaultMessage: 'This project has no agents to save.', description: "An error saving a project's agents as a template: it has none." }))
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
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw refusal(M.nameTaken, { name: clean }, 'conflict')
    const renamed = await write(ref, ref.file, { ...t.template, name: clean })
    log.info(`Renamed template ${userText(t.name)} to ${userText(clean)}`)
    return renamed
  })
}

/**
 * Saves a template edited in the Templates view (#271): its name, description, layout and agents, in the file it is
 * kept in (its place stays: Duplicate… moves it). The edit is checked as untrusted (as an import is: 1–24 agents with
 * unique names, providers' ids, settings as CLIs name them) and refused, saying why, if another template there has its
 * name or the template changed since it was opened (`savedAt`, as it was then): nothing is half saved, and a change
 * made meanwhile (a re-save from a project, another window's edit) is never overwritten unasked.
 */
export async function updateTemplate(ref: TemplateRef, edited: unknown, savedAt: string | null): Promise<TemplateEntry> {
  const clean = cleanName(edited && typeof edited === 'object' ? (edited as { name?: unknown }).name : '')
  const t = readTemplate({ ...(edited as object), version: TEMPLATE_VERSION, name: clean, savedAt: new Date().toISOString() })
  if (!isAgentTemplate(t)) throw new TemplateError(t, { kind: 'invalid' })
  return changing(ref, async () => {
    const now = await usable(ref)
    if ((now.savedAt ?? null) !== (savedAt ?? null)) throw refusal(msg({ id: 'content.templates.editedMeanwhile', defaultMessage: '"{name}" changed since you started editing it (saved again meanwhile): nothing was saved. Close the editor to see it as it is now.', description: 'An error saving an edited template: it was saved again elsewhere after the editor opened it.' }), { name: now.name }, 'conflict')
    if ((await listIn(ref)).some((e) => e.file !== ref.file && e.name.toLowerCase() === clean.toLowerCase())) throw refusal(M.nameTaken, { name: clean }, 'conflict')
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

/**
 * Deletes a template: its file (and the copy kept beside it) go to the Recycle Bin. A template touches no worktree; but
 * the worktrees its worktree agents left, now no agent's, are said (#353): per project, those named after its agents.
 */
export async function deleteTemplate(ref: TemplateRef): Promise<TemplateDeleted> {
  const names = await readOne(ref, ref.file).then((t) => t.agents.filter((a) => a.worktree).map((a) => a.name)).catch(() => [] as string[])
  await changing(ref, async () => {
    const f = fileOf(ref)
    await trash(f)
    if (existsSync(`${f}.bak`)) await trash(`${f}.bak`).catch((e) => log.warn('Could not remove the copy of a deleted template', e))
    log.info(`Deleted template ${userText(ref.file)} (${ref.scope})`)
  })
  if (!names.length) return { unusedWorktrees: [] }
  const projects = ref.scope === 'project' ? [workspace.assertProject(String(ref.project ?? ''))] : await (ref.project ? workspaceOf(ref.project) : workspace).listProjectPaths()
  const unused: TemplateDeleted['unusedWorktrees'] = []
  for (const p of projects) {
    const paths = await unusedWorktreesNamed(p, names)
    if (paths.length) unused.push({ project: p, count: paths.length })
  }
  return { unusedWorktrees: unused }
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
  if (!info?.isFile()) throw refusal(msg({ id: 'content.templates.noFile', defaultMessage: "That file isn't there.", description: 'An error importing a template: the file chosen is gone.' }), undefined, 'notFound')
  if (info.size > TEMPLATE_IMPORT_MAX) throw refusal(msg({ id: 'content.templates.importTooLarge', defaultMessage: "It isn't a Hive agent template (over {kb} KB).", description: 'An error importing a template: the file is larger than {kb} KB, more than any template.' }), { kb: TEMPLATE_IMPORT_MAX / 1024 })
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw refusal(msg({ id: 'content.templates.importNotJson', defaultMessage: "It isn't a Hive agent template (not JSON).", description: "An error importing a template: the file isn't JSON." }))
  }
  const t = readTemplate(raw)
  if (!isAgentTemplate(t)) throw new TemplateError(t)
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

/** Why a provider can't run here (unknown to this Hive, off, or not installed), with the name it goes by (its id when unknown), or null. */
function providerProblem(id: ProviderId): { problem: NonNullable<TemplateLoadPlan['missing'][number]['problem']>; provider: string } | null {
  if (!isKnownProvider(id)) return { problem: 'unknown', provider: id }
  const name = providerDescriptor(id).name
  if (!isProviderEnabled(config.settings, id)) return { problem: 'off', provider: name }
  if (!providerService.info(id).found) return { problem: 'notInstalled', provider: name }
  return null
}

/** A template used in a project: a project's is looked up in `from` (another project's, from the Templates view), else in that project. */
const refFor = (projectPath: string, scope: TemplateScope, file: string, from?: string): TemplateRef => ({ scope: checkScope(scope), project: scope === 'project' && from ? from : projectPath, file })

/** A worktree a template's agent can work in again: its folder and branch. */
type Reuse = { path: string; branch: string }

/** A worktree's `branchStatus`, as one plan reads it (#732: once each, though the plan looks at one twice). */
type StatusOf = (w: AgentWorktree) => Promise<AgentBranchStatus>

/** `branchStatus` read once per worktree and branch for one operation (#732), with its reads of the repository. */
function statusReads(projectPath: string, reads: wt.RepoReads): StatusOf {
  const kept = new Map<string, Promise<AgentBranchStatus>>()
  return (w) => {
    const key = `${placeKey(w.path)}|${w.branch}`
    let p = kept.get(key)
    if (!p) kept.set(key, (p = wt.branchStatus(projectPath, w, reads)))
    return p
  }
}

/** Why a worktree can't be worked in again (null: it can): git must list it on `branch`, with nothing uncommitted (strict). */
async function notReusable(w: Reuse, base: string, listed: { path: string; branch: string | null }[], status: StatusOf): Promise<string | null> {
  const here = placeKey(w.path)
  const there = listed.find((x) => placeKey(x.path) === here)
  if (!there) return tr(msg({ id: 'content.templates.notListed', defaultMessage: "git doesn't list {folder} as a worktree any more", description: "Why a template's agent gets a new worktree, not the one of its name: git no longer lists that folder as a worktree. A clause, lower case." }), { folder: w.path })
  if (there.branch !== w.branch) return there.branch ? tr(msg({ id: 'content.templates.otherBranch', defaultMessage: 'its worktree is on {current}, not {branch}', description: "Why a template's agent gets a new worktree: the one of its name has another branch checked out ({current}) than its own ({branch}). A clause, lower case." }), { current: there.branch, branch: w.branch }) : tr(msg({ id: 'content.templates.noBranch', defaultMessage: 'its worktree is on no branch, not {branch}', description: "Why a template's agent gets a new worktree: the one of its name has no branch checked out (a detached HEAD), not its own {branch}. A clause, lower case." }), { branch: w.branch })
  try {
    const { dirty } = await status({ path: there.path, branch: w.branch, base })
    return dirty ? tr(msg({ id: 'content.templates.dirty', defaultMessage: '{branch} has {n, plural, one {# uncommitted file} other {# uncommitted files}}', description: "Why a template's agent gets a new worktree: the one of its name, on {branch}, has work not committed. A clause." }), { branch: w.branch, n: dirty }) : null
  } catch (e) {
    return tr(msg({ id: 'content.templates.cantCheck', defaultMessage: "Hive couldn't check {branch} ({error})", description: "Why a template's agent gets a new worktree: git couldn't read the state of the one of its name, on {branch}; {error} is why (often git's own words)." }), { branch: w.branch, error: shownError(e).split('\n')[0] })
  }
}

/**
 * The worktree a template's agent called `name` can work in again instead of a new one (#289), its branch left as it is:
 * the worktree of the agent of that name it replaces (`own`); else one Hive made for that name that git lists and no
 * agent works in (`inUse`, `placeKey`s): `hive/<name>` in that name's folder in the project's worktree location, or one
 * numbered when it was made (`-2`…: an earlier load's, kept when its agent was replaced). Only a clean one
 * (`notReusable`); of several clean ones, the unnumbered one, else none (ambiguous). `reuse`, or why the one that
 * matches can't be (null: none matches). Paths are compared by their real names (#389): git lists the long ones.
 */
async function reusableWorktree(projectPath: string, name: string, base: string, own: Reuse | undefined, inUse: ReadonlySet<string>, listed: { path: string; branch: string | null }[], status: StatusOf): Promise<{ reuse: Reuse } | { why: string } | null> {
  if (own) {
    if (inUse.has(placeKey(own.path))) return { why: tr(M.inUse, { branch: own.branch }) }
    const why = await notReusable(own, base, listed, status)
    return why ? { why } : { reuse: { path: resolve(own.path), branch: own.branch } }
  }
  const slug = slugify(name)
  const root = placeKey(join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!))
  const numbered = (s: string, stem: string): boolean => s === stem || (s.startsWith(`${stem}-`) && /^\d+$/.test(s.slice(stem.length + 1)))
  // Its branch Hive's for that name in either form (#703): hive/<workspace>/<project>/<name> now, hive/<its slug> from
  // before (compared as Hive made it then).
  const home = await branchPlace(projectPath)
  const mine = listed.filter((w) => !!w.branch && placeKey(dirname(w.path)) === root && numbered(basename(w.path).toLowerCase(), slug) && hiveBranchNumber(w.branch, home, name) !== null)
  if (!mine.length) return null
  const free = mine.filter((w) => !inUse.has(placeKey(w.path)))
  if (!free.length) return { why: tr(M.inUse, { branch: mine[0].branch ?? '' }) }
  const checked = await Promise.all(free.map(async (w) => ({ w: { path: w.path, branch: w.branch! }, why: await notReusable({ path: w.path, branch: w.branch! }, base, listed, status) })))
  const clean = checked.filter((c) => !c.why)
  const exact = clean.find((c) => basename(c.w.path).toLowerCase() === slug && hiveBranchNumber(c.w.branch, home, name) === 0)
  if (exact) return { reuse: exact.w }
  if (clean.length === 1) return { reuse: clean[0].w }
  if (clean.length > 1) return { why: tr(msg({ id: 'content.templates.several', defaultMessage: 'several clean worktrees could be its ({branches})', description: "Why a template's agent gets a new worktree: more than one unused worktree made for its name could be its own ({branches}: their branches, listed in the language's way), so Hive takes none. A clause, lower case." }), { branches: fmt.list(clean.map((c) => c.w.branch)) }) }
  return { why: checked[0].why! }
}

/** Names another project's agents have, in a refusal: "B1, R1 are already agents in amberlight: … rename them" (and nothing changed, at the load's end). */
function takenText(taken: { name: string; project: string }[], nothingChanged = false): Text {
  const where = listOf([...new Set(taken.map((t) => t.project))])
  return withValues(nothingChanged ? M.takenNothing : M.taken, { names: listOf(taken.map((t) => t.name)), count: taken.length, projects: where })
}

/** Whether an agent is running or starting (a start reserved, not yet live): either way, not safe to remove. */
const busy = (projectPath: string, agentId: string): boolean => !!sessions.liveFor(projectPath, agentId) || sessions.startingFor(projectPath, agentId)

/**
 * What loading a template into a project would do: the agents removed and created, the layout, and what stops it now —
 * an agent running or starting, a removed worktree agent's uncommitted work (or a worktree whose state git can't tell:
 * then it isn't known to be safe), a provider that is off or not installed, worktree agents in a project that isn't on
 * a git branch. Nothing is changed. The repository is read once for the whole plan, not once per agent (#732): its
 * branches, worktrees and current branch, and each worktree's status; `reads`: a load's, which it goes on using.
 */
export async function templatePlan(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[], reads?: wt.RepoReads): Promise<TemplateLoadPlan> {
  return (await planFor(projectPath, scope, file, from, names, reads)).plan
}

/** The plan, with what stops it as text (`why`, which `blocked` says in the window's language): a load refuses with it. */
async function planFor(projectPath: string, scope: TemplateScope, file: string, from?: string, names?: string[], reads?: wt.RepoReads): Promise<{ plan: TemplateLoadPlan; why: TextPart[] }> {
  projectPath = workspace.assertProject(projectPath)
  const repo = reads ?? new wt.RepoReads(projectPath)
  const status = statusReads(projectPath, repo)
  const original = await usable(refFor(projectPath, scope, file, from))
  const t = { ...original, agents: withNames(original.agents, names) }
  const cfg = await workspace.projectConfig(projectPath)
  const current = projectAgents(cfg)
  const remove: TemplateLoadPlan['remove'] = []
  const blocked: TextPart[] = []
  for (const a of current) {
    const running = busy(projectPath, a.id)
    let dirty = 0
    if (a.worktree && existsSync(a.worktree.path)) {
      // As Remove Agent checks before a worktree goes: strictly, so a git that fails never reads as "nothing to lose".
      try {
        dirty = (await status(a.worktree)).dirty
      } catch (e) {
        blocked.push(withValues(msg({ id: 'content.templates.checkFailed', defaultMessage: "Hive couldn't check {agent}'s worktree ({folder}): {error}", description: "Why a template can't be loaded: git couldn't tell whether the worktree {folder} of the agent {agent} it would remove has uncommitted work; {error} is why (often git's own words)." }), { agent: a.name, folder: a.worktree.path, error: firstLine(e) }))
      }
    }
    remove.push({ id: a.id, name: a.name, running, dirty, ...(a.worktree ? { worktree: { path: a.worktree.path, branch: a.worktree.branch } } : {}) })
    if (running) blocked.push(withValues(msg({ id: 'content.templates.running', defaultMessage: '{agent} is running or starting: stop it first.', description: "Why a template can't be loaded: the agent {agent} it would replace is running." }), { agent: a.name }))
    if (dirty) blocked.push(withValues(msg({ id: 'content.templates.uncommitted', defaultMessage: '{agent} has uncommitted work in its worktree ({folder}): commit or discard it first.', description: "Why a template can't be loaded: the worktree {folder} of the agent {agent} it would replace has work not committed." }), { agent: a.name, folder: a.worktree!.path }))
  }
  const missing: TemplateLoadPlan['missing'] = []
  for (const id of [...new Set(t.agents.map((a) => a.provider))]) {
    const why = providerProblem(id)
    if (why) {
      const agents = t.agents.filter((a) => a.provider === id).map((a) => a.name)
      missing.push({ provider: id, reason: tr(M.provider, why), agents, problem: why.problem })
      blocked.push(withValues(M.neededBy, { ...why, agents: listOf(agents) }))
    }
  }
  // It replaces the project's agents: all of them have to fit (#562).
  const limit = agentLimit(projectPath)
  if (t.agents.length > limit) blocked.push(templateLimitText(t.agents.length, limit))
  const base = t.agents.some((a) => a.worktree) ? await repo.currentBranch() : null
  if (t.agents.some((a) => a.worktree) && !base) blocked.push(await needsGit(projectPath, t.agents.filter((a) => a.worktree).map((a) => a.name), repo))
  // Where each worktree agent works, as the load makes them, one after another: in this project, never the template's
  // project (a template holds only whether an agent has its own worktree, #268). A clean worktree of the same name is
  // worked in again (#289: the replaced agent's, or an earlier load's), else a new one.
  const taken = { branches: new Set<string>(), folders: new Set<string>() }
  const worktrees: TemplateLoadPlan['worktrees'] = []
  const listed = base && t.agents.some((a) => a.worktree) ? await repo.worktrees() : []
  for (const a of t.agents) {
    if (!a.worktree || !base) {
      worktrees.push(null)
      continue
    }
    const own = current.find((x) => x.worktree && x.name.toLowerCase() === a.name.toLowerCase())?.worktree
    const found = await reusableWorktree(projectPath, a.name, base, own && { path: own.path, branch: own.branch }, taken.folders, listed, status)
    if (found && 'reuse' in found) {
      taken.branches.add(found.reuse.branch)
      taken.folders.add(placeKey(found.reuse.path))
      worktrees.push({ ...found.reuse, base, reuse: true })
      continue
    }
    const spot = await newWorktreePlace(projectPath, a.name, undefined, taken, repo)
    taken.branches.add(spot.branch)
    taken.folders.add(placeKey(spot.path))
    worktrees.push({ ...spot, base, ...(found ? { notReused: found.why } : {}) })
  }
  const setup = cfg.worktreeSetup.trim() || null
  // The removed agents' worktrees nobody works in again: which could go with the load, merged and clean (#289).
  const reused = new Set(worktrees.flatMap((w) => (w?.reuse ? [placeKey(w.path)] : [])))
  const oldWorktrees: TemplateLoadPlan['oldWorktrees'] = []
  let mergedInto: string | null = null
  for (const a of current) {
    if (!a.worktree || reused.has(placeKey(a.worktree.path))) continue
    const check = await wt.worktreeCheck(projectPath, a.worktree, repo)
    mergedInto = check.into
    oldWorktrees.push({ agent: a.name, path: a.worktree.path, branch: a.worktree.branch, removable: check.removable, ...(check.removable ? {} : { why: check.reason ?? tr(msg({ id: 'content.templates.notChecked', defaultMessage: 'not checked', description: "Why a worktree the template's load would leave can't be removed with it: Hive couldn't check it. A clause, lower case." })) }) })
  }
  // Names another project's agent has (#702): this project's own don't count, as the load replaces them.
  const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
  const takenNames = t.agents.flatMap((a) => {
    const owner = nameTaken(a.name, others)
    return owner ? [{ name: a.name, project: owner.project }] : []
  })
  const plan = { scope: t.scope, file: t.file, name: t.name, layout: t.layout, remove, create: t.agents, templateNames: original.agents.map((a) => a.name), taken: takenNames, worktrees, setup, oldWorktrees, mergedInto, missing, blocked: blocked.map(shownText) }
  return { plan, why: blocked }
}

/** An error's first line as text (git's message can run on), its descriptor when it is Hive's and one line. */
function firstLine(e: unknown): TextPart {
  const text = errorText(e)
  return typeof text === 'string' || shownText(text).includes('\n') ? shownText(text).split('\n')[0] : text
}

/**
 * A template's agents with the names chosen for them in the Load template dialog (#702), by order: as many as it has,
 * each a name an agent can have, no two the same. None given: its own names.
 */
function withNames(agents: TemplateAgent[], names: unknown): TemplateAgent[] {
  if (names === undefined || names === null) return agents
  if (!Array.isArray(names) || names.length !== agents.length || names.some((n) => typeof n !== 'string')) throw refusal(msg({ id: 'content.templates.namesChanged', defaultMessage: 'The names given for its agents no longer match the template: open it again.', description: 'An error loading a template: the names chosen for its agents in the Load template dialog no longer fit it (it was edited meanwhile).' }), undefined, 'conflict')
  const clean = (names as string[]).map((n) => n.replace(/\s+/g, ' ').trim())
  for (const n of clean) {
    if (!agentNameProblem(n)) continue
    if (!n) throw refusal(msg({ id: 'content.templates.nameEach', defaultMessage: 'Enter a name for each of its agents.', description: "An error loading a template: a name given for one of its agents is empty." }), undefined, 'invalid')
    throw refusal(msg({ id: 'content.templates.nameEachTooLong', defaultMessage: 'A name is at most {max} characters for each of its agents.', description: "An error loading a template: a name given for one of its agents is longer than {max} characters." }), { max: AGENT_NAME_MAX }, 'invalid')
  }
  const twice = clean.find((n, i) => clean.findIndex((m) => sameAgentName(m, n)) !== i)
  if (twice) throw refusal(msg({ id: 'content.templates.twice', defaultMessage: 'Two of its agents would be called "{name}".', description: 'An error loading a template: the names given for its agents call two of them {name}.' }), { name: twice }, 'invalid')
  return agents.map((a, i) => ({ ...a, name: clean[i] }))
}

/**
 * Why a template's worktree agents can't have worktrees here (#702: why a template couldn't be loaded into a project
 * without git): git can't run, the project isn't a repository, or it isn't on a branch (detached, or no commit yet).
 */
async function needsGit(projectPath: string, names: string[], reads: wt.RepoReads): Promise<Text> {
  const who = { count: names.length, names: listOf(names) }
  const problem = gitProblemData(gitTool())
  if (problem) return withValues(msg({ id: 'content.templates.gitBroken', defaultMessage: "{problem}, so its worktree {count, plural, one {agent} other {agents}} ({names}) can't have worktrees of their own: fix git (Agent Setup), or edit the template to put them in the project folder.", description: "Why a template can't be loaded: git can't run ({problem}: \"Git isn't installed (or isn't on Hive's PATH)\"), so its {count} agents with worktrees of their own ({names}) can't have them. Agent Setup is a Help window." }), { ...who, problem })
  const project = basename(projectPath)
  if (!(await reads.worktrees()).length) return withValues(msg({ id: 'content.templates.notRepo', defaultMessage: "{project} isn't a git repository, so its worktree {count, plural, one {agent} other {agents}} ({names}) can't have worktrees of their own. Make it a repository with a first commit, or edit the template to put them in the project folder.", description: "Why a template can't be loaded into the project {project}: it isn't a git repository, so the template's {count} agents with worktrees of their own ({names}) can't have them." }), { ...who, project })
  return withValues(msg({ id: 'content.templates.notOnBranch', defaultMessage: "{project} isn't on a branch (a detached HEAD, or no commit yet), so its worktree {count, plural, one {agent} other {agents}} ({names}) have nothing to branch from. Check out a branch or make a first commit, or edit the template to put them in the project folder.", description: "Why a template can't be loaded into the project {project}: it has no branch checked out, so the template's {count} agents with worktrees of their own ({names}) have no branch to start theirs from." }), { ...who, project })
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
export async function loadTemplate(projectPath: string, scope: TemplateScope, file: string, expected: string[], from?: string, removeOld?: { paths: string[]; mergedInto: string | null }, names?: string[]): Promise<{ created: string[]; removed: string[]; oldWorktrees: OldWorktreeOutcome[] }> {
  projectPath = workspace.assertProject(projectPath)
  const key = projectPath.toLowerCase()
  if (loading.has(key)) throw refusal(msg({ id: 'content.templates.loading', defaultMessage: 'A template is already being loaded into this project.', description: 'An error loading a template while another load into the same project is under way.' }), undefined, 'conflict')
  loading.add(key)
  const unfence = sessions.fenceStarts(projectPath, 'A template is being loaded into this project') // i18n-ignore: why starts are fenced, which the sessions' refusal says (E10c's)
  try {
    // Before the plan looks at the worktrees: one removed since then isn't worked in again (#289).
    const mark = claimMark()
    // The plan's reads of the repository, which staging goes on using (#732): read again only after it makes a worktree.
    const reads = new wt.RepoReads(projectPath)
    const { plan, why } = await planFor(projectPath, scope, file, from, names, reads)
    if (why.length) throw new TemplateError({ lines: [msg({ id: 'content.templates.cantLoad', defaultMessage: "The template can't be loaded yet:", description: "An error loading a template, above the list of what stops it (each line a reason)." }), ...why.map((item) => withValues(msg({ id: 'content.templates.bullet', defaultMessage: '• {item}', description: 'A line of a list of reasons: a bullet, then the reason {item}.' }), { item }))] })
    const changed = (ids: string[]): boolean => !Array.isArray(expected) || ids.length !== expected.length || ids.some((id, i) => id !== expected[i])
    if (changed(plan.remove.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedSince', defaultMessage: "The project's agents changed since you looked: open the template again.", description: "An error loading a template: the project's agents changed after the Load template dialog showed them." }), undefined, 'conflict')
    if (plan.taken.length) throw new TemplateError(takenText(plan.taken), { kind: 'conflict' })
    const cfg = await workspace.projectConfig(projectPath)
    const staged: { def: AgentDef; discard: () => Promise<void> }[] = []
    let old: AgentDef[] = []
    try {
      for (const [i, a] of plan.create.entries()) {
        // A worktree the plan reuses (#289), checked again just now (the plan is made afresh for the load): else a new one.
        const reuse = plan.worktrees[i]?.reuse ? plan.worktrees[i] : null
        const opts = { name: a.name, role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, mcpServers: a.mcpServers, location: reuse ? ('existing-worktree' as const) : a.worktree ? ('new-worktree' as const) : ('project' as const), ...(reuse ? { worktreePath: reuse.path } : {}) }
        staged.push(await prepareAgent(projectPath, cfg, opts, a.name, staged.map((s) => s.def), reads))
        await testHooks.staged?.(a.name)
      }
      // Published at once, under the lock, on the agents as they are now; their names checked with it, holding the
      // workspace's names lock (#702): another project may have taken one meanwhile.
      await withAgentNames(projectPath, async () => {
        const others = (await workspaceAgents(projectPath)).filter((a) => a.project.toLowerCase() !== basename(projectPath).toLowerCase())
        const clash = staged.flatMap((s) => {
          const owner = nameTaken(s.def.name, others)
          return owner ? [{ name: s.def.name, project: owner.project }] : []
        })
        if (clash.length) throw new TemplateError(takenText(clash, true), { kind: 'conflict' })
        await workspace.mutateProjectConfig(projectPath, (now) => {
          const list = projectAgents(now)
          if (changed(list.map((a) => a.id))) throw refusal(msg({ id: 'content.templates.changedWhile', defaultMessage: "The project's agents changed while the template was loading: nothing was changed. Open the template again.", description: "An error loading a template: the project's agents changed while it loaded, so nothing changed." }), undefined, 'conflict')
          if (list.some((a) => busy(projectPath, a.id))) throw refusal(msg({ id: 'content.templates.started', defaultMessage: 'An agent started meanwhile: nothing was changed. Stop it first.', description: "An error loading a template: one of the project's agents started while it loaded, so nothing changed." }), undefined, 'conflict')
          // The limit as it is now: Settings may have lowered it since the plan.
          const limit = agentLimit(projectPath)
          if (staged.length > limit) throw refusal(M.nothing, { problem: templateLimitText(staged.length, limit) })
          if (staged.some((s) => s.def.worktree && (removedSince(s.def.worktree.path, mark) || !existsSync(s.def.worktree.path)))) throw refusal(msg({ id: 'content.templates.removing', defaultMessage: 'A worktree it would work in again is being removed, or was just removed: nothing was changed. Open the template again.', description: "An error loading a template: a worktree one of its agents would work in again was removed while it loaded, so nothing changed." }), undefined, 'conflict')
          old = list
          // A worktree whose setup never ran keeps that (#289): an agent working in it again runs it first, and one kept
          // without an agent is remembered for the next.
          const pathKey = placeKey
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
      })
    } catch (e) {
      for (const s of staged) await s.discard()
      throw e instanceof TemplateError ? e : refusal(msg({ id: 'content.templates.failed', defaultMessage: 'Nothing was changed: {error}', description: "An error loading a template: making its agents failed, so nothing changed; {error} is why (often git's own words)." }), { error: errorText(e) })
    }
    const project = basename(projectPath)
    for (const a of old) {
      await releaseAgentCards(project, a.id, { kind: 'user' }).catch((err) => log.warn('Could not take back the cards of a removed agent', err))
      await endReviews(project, a.id, 'the agent was removed', workspaceOf(projectPath)).catch(() => undefined) // i18n-ignore: a ReviewEnd key (tasks.ts words it)
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
async function removeOldWorktrees(projectPath: string, old: AgentDef[], removeOld: { paths: string[]; mergedInto: string | null } | undefined): Promise<OldWorktreeOutcome[]> {
  const key = placeKey
  const asked = new Set((Array.isArray(removeOld?.paths) ? removeOld.paths : []).filter((p) => typeof p === 'string').map(key))
  if (!asked.size) return []
  const out: OldWorktreeOutcome[] = []
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
      out.push({ branch: tree.branch, removed: false, why: shownError(e) })
      continue
    }
    try {
      let owned = false
      await workspace.mutateProjectConfig(projectPath, (now) => {
        owned = projectAgents(now).some((x) => x.worktree && key(x.worktree.path) === key(tree.path))
        return {}
      })
      if (owned) {
        out.push({ branch: tree.branch, removed: false, why: tr(msg({ id: 'content.templates.inUseNow', defaultMessage: 'an agent works in it now', description: "Why a worktree the user chose to remove with a template's load was kept: one of the new agents works in it. A clause, lower case." })) })
        continue
      }
      await testHooks.removing?.(tree.branch)
      const done = await wt.removeCheckedWorktree(projectPath, tree, await wt.worktreeCheck(projectPath, tree), removeOld?.mergedInto ?? null).catch((e: Error) => ({ deleted: false, reason: shownError(e).split('\n')[0] }))
      // The folder went but its branch stayed (a ref moved in the last step): said, so the notice doesn't claim both went.
      out.push({ branch: tree.branch, removed: done.deleted, ...('branchKept' in done && done.branchKept ? { branchKept: true as const } : {}), ...(done.reason ? { why: done.reason } : {}) })
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
  if (!a) throw refusal(msg({ id: 'content.templates.agentGone', defaultMessage: 'That agent is no longer in the template.', description: 'An error adding one agent from a template: the template no longer has it (edited meanwhile).' }), undefined, 'notFound')
  const why = providerProblem(a.provider)
  if (why) throw refusal(M.needsIt, { ...why, agent: a.name })
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  // Unique across the workspace (#702): a name any agent of it has gets a number ("Builder 2"), never a prefix.
  const name = uniqueName(a.name, (await workspaceAgents(projectPath)).map((x) => x.name))
  // A clean worktree Hive made for that name that no agent works in is worked in again (#289), else a new one.
  const base = a.worktree ? await wt.currentBranch(projectPath) : null
  const inUse = new Set(agents.flatMap((x) => (x.worktree ? [placeKey(x.worktree.path)] : [])))
  const found = base ? await reusableWorktree(projectPath, name, base, undefined, inUse, await wt.listWorktrees(projectPath), (w) => wt.branchStatus(projectPath, w)) : null
  const reuse = found && 'reuse' in found ? found.reuse : null
  const settings = { name, role: a.role, provider: a.provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext, mcpServers: a.mcpServers }
  const def = await addAgent(projectPath, reuse ? { ...settings, location: 'existing-worktree', worktreePath: reuse.path } : { ...settings, location: a.worktree ? 'new-worktree' : 'project' })
  if (reuse) log.info(`Added ${userText(name)} from a template in its worktree again (${userText(reuse.branch)})`)
  return reuse ? { ...def, reused: true } : def
}
