import { basename, dirname, extname, join, resolve, sep } from 'path'
import { copyFile, mkdir, readdir, readFile, rmdir } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { projectHandovers } from '../shared/hiveGuidance'
import type { AgentDef, ProjectRemoval, ProjectRemovalInfo, TaskCard } from '../shared/types'
import { config } from './config'
import { suspendWatching } from './files'
import { readJson, removePath, writeJsonAtomic } from './fsutil'
import { createLogger } from './logger'
import { notesTree } from './notes'
import { sessions } from './sessions'
import { archiveProjectCards, deleteProjectCards, importCards, projectCards, restoreProjectCards } from './tasks'
import { REMOVED_DIR, workspace, type WorkspaceService } from './workspace'
import * as wt from './worktrees'

const log = createLogger('projects')

/**
 * A project leaving Hive (Project → Remove Project…), three ways:
 * - Hide: nothing moves; Hive leaves the folder out until it's restored (Settings → Workspace).
 * - Remove from Hive: its workspace files (handovers, cards) are packed into its own .hive/removed and leave the
 *   workspace, so the folder carries them wherever it goes; Hive offers them back when it sees the folder again.
 * - Delete: the folder, its worktrees and its handovers go to the Recycle Bin, and its cards are deleted.
 * The CLIs' own transcripts (~/.claude, ~/.codex) are never touched.
 *
 * Nothing about the project is decided from what the dialog saw: its agents are stopped (and kept from starting)
 * first, and its worktrees, handovers and cards are looked at again after that.
 */

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
/** Whether `a` is `b` or a folder containing it. */
const contains = (a: string, b: string): boolean => same(resolve(a), resolve(b)) || resolve(b).toLowerCase().startsWith(resolve(a).toLowerCase().replace(/[\\/]$/, '') + sep)

/** Every project folder name in the workspace, hidden ones too (handover names are matched against them all). */
async function allNames(ws: WorkspaceService): Promise<string[]> {
  return [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))].map((p) => basename(p))
}

/**
 * The project's handovers in the shared notes, by path relative to .hive/shared. Strictly: a file is its own when
 * its header names it, or it has no header and no other project could own it (they are moved or deleted).
 */
async function handoversOf(ws: WorkspaceService, name: string): Promise<string[]> {
  const tree = await notesTree()
  const mine = await projectHandovers(tree, name, await allNames(ws), (rel) => readFile(join(ws.sharedDir, rel), 'utf8'), { strict: true })
  return mine.map((f) => f.relPath)
}

/** A project folder of the open workspace, shown or hidden. */
function folderOf(ws: WorkspaceService, projectPath: string): string {
  const p = join(ws.path ?? '', basename(projectPath))
  if (!ws.path || !same(dirname(resolve(projectPath)), ws.path) || !existsSync(p) || basename(p).startsWith('.')) throw new Error(`Not a project in the open workspace: ${projectPath}`)
  return p
}

/**
 * The project's agent worktrees that are safe to remove: folders git lists as worktrees of this project, that are
 * not the project itself, nor contain it or the workspace, nor are another project. project.json can be edited by
 * hand: a path it gives is never removed on its word alone. The rest come back as `refused`, with why.
 */
async function checkedWorktrees(ws: WorkspaceService, p: string, agents: AgentDef[]): Promise<{ ok: AgentDef[]; refused: string[] }> {
  const registered = new Set((await wt.listWorktrees(p)).map((w) => resolve(w.path).toLowerCase()))
  const projects = (await allNames(ws)).map((n) => join(ws.path!, n))
  const ok: AgentDef[] = []
  const refused: string[] = []
  for (const a of agents) {
    if (!a.worktree) continue
    const t = resolve(a.worktree.path)
    const why = !registered.has(t.toLowerCase())
      ? "git doesn't list it as one of the project's worktrees"
      : contains(t, p) || contains(t, ws.path!)
        ? 'it contains the project or the workspace'
        : projects.some((x) => same(x, t))
          ? 'it is another project of the workspace'
          : null
    if (why) refused.push(`${a.name}'s worktree ${t} (${why})`)
    else ok.push(a)
  }
  return { ok, refused }
}

export async function removalInfo(projectPath: string): Promise<ProjectRemovalInfo> {
  const ws = workspace
  const p = folderOf(ws, projectPath)
  const name = basename(p)
  const cards = await projectCards(ws, name)
  const worktrees: ProjectRemovalInfo['worktrees'] = []
  for (const a of projectAgents(await ws.projectConfig(p))) {
    if (!a.worktree) continue
    // Unknown is not clean: a worktree git can't check counts as holding work.
    const st = await wt.branchStatus(p, a.worktree, { strict: true }).then(
      (s) => ({ ahead: s.ahead, dirty: s.dirty, error: undefined as string | undefined }),
      (e: Error) => ({ ahead: 0, dirty: 0, error: e.message })
    )
    worktrees.push({ agent: a.name, path: a.worktree.path, branch: a.worktree.branch, ...st })
  }
  return {
    name,
    path: p,
    running: sessions.projectStates(p).length,
    handovers: await handoversOf(ws, name),
    cards: cards.filter((c) => !c.archived).length,
    archivedCards: cards.filter((c) => c.archived).length,
    worktrees
  }
}

/** Why Remove from Hive can't go ahead: worktrees with work not merged, or that git can't check. Null when it can. */
function unmergedWork(worktrees: ProjectRemovalInfo['worktrees']): string | null {
  const held = worktrees.filter((w) => w.ahead || w.dirty || w.error)
  if (!held.length) return null
  const what = (w: ProjectRemovalInfo['worktrees'][number]): string =>
    w.error ?? [w.ahead && `${w.ahead} commit${w.ahead === 1 ? '' : 's'} not merged`, w.dirty && `${w.dirty} uncommitted file${w.dirty === 1 ? '' : 's'}`].filter(Boolean).join(', ')
  return `Merge or discard the work in ${held.map((w) => `${w.agent}'s worktree (${what(w)})`).join(' and ')} first: a worktree can't go with the project folder.`
}

/** Stops the project's agents (and starts in progress) and waits for them, so nothing holds or changes its folders. */
async function stopAgents(p: string): Promise<void> {
  await sessions.stopWhereAndWait((s) => same(s.projectPath, p), 8000)
  if (sessions.projectStates(p).length || sessions.pendingStarts().some((x) => same(x, p))) throw new Error(`Could not stop ${basename(p)}'s agents. Stop them, then try again.`)
}

/** Projects being removed now (lower-cased paths): one removal at a time each. */
const removing = new Set<string>()

/**
 * Hides, removes or deletes a project. Returns what couldn't be done after the point of no return (a Delete whose
 * folder is already in the Recycle Bin but a worktree or handover couldn't follow), for the user to see.
 */
export async function removeProject(projectPath: string, how: ProjectRemoval): Promise<{ warnings: string[] }> {
  const ws = workspace
  const p = folderOf(ws, projectPath)
  const name = basename(p)
  const key = p.toLowerCase()
  if (removing.has(key)) throw new Error(`${name} is already being removed.`)
  // Refused at once, before stopping anything, when it can already tell.
  if (how === 'remove') {
    const early = unmergedWork((await removalInfo(p)).worktrees)
    if (early) throw new Error(early)
  }
  removing.add(key)
  // No agent of the project may start from here on (the Assistant, a card, a hand-over…).
  const unfence = sessions.fenceStarts(p)
  try {
    await stopAgents(p)
    // Looked at again now nothing runs there: a stopping agent may have written to its worktree at the last moment.
    const info = await removalInfo(p)
    const agents = projectAgents(await ws.projectConfig(p))
    if (how === 'hide') {
      ws.setActive(p, false)
      await archiveProjectCards(ws, name, 'project-hidden')
      await ws.setHidden(name, 'hidden')
      log.info(`Hid ${name}`)
      return { warnings: [] }
    }
    if (how === 'remove') return await removeFromHive(ws, p, info, agents)
    return await deleteProject(ws, p, info, agents)
  } finally {
    unfence()
    removing.delete(key)
    await ws.refresh().catch((e) => log.warn('refresh after removing a project', e))
  }
}

async function removeFromHive(ws: WorkspaceService, p: string, info: ProjectRemovalInfo, agents: AgentDef[]): Promise<{ warnings: string[] }> {
  const name = basename(p)
  const held = unmergedWork(info.worktrees)
  if (held) throw new Error(held)
  const { ok, refused } = await checkedWorktrees(ws, p, agents)
  if (refused.length) throw new Error(`Hive won't remove ${refused.join(' or ')}. Fix or remove that agent first.`)
  // Packed first: everything after it can be undone from the pack.
  await pack(ws, p, info.handovers)
  // The worktrees have nothing left that isn't in the project: they and their agents go.
  for (const a of ok) await wt.removeWorktree(p, a.worktree!, true)
  if (ok.length) {
    const gone = new Set(ok.map((a) => a.id))
    await ws.mutateProjectConfig(p, (now) => ({ agents: now.agents.filter((a) => !gone.has(a.id)) }))
  }
  ws.setActive(p, false)
  await archiveProjectCards(ws, name, 'project-removed')
  const warnings: string[] = []
  for (const rel of info.handovers) {
    await shell.trashItem(join(ws.sharedDir, rel)).catch((e) => {
      log.warn(`Could not move ${rel} to the Recycle Bin`, e)
      warnings.push(`${rel} stayed in the shared notes (a copy is packed in the folder): ${(e as Error).message}`)
    })
  }
  await ws.setHidden(name, 'removed')
  log.info(`Removed ${name} from Hive (packed ${info.handovers.length} handovers and its cards)`)
  return { warnings }
}

async function deleteProject(ws: WorkspaceService, p: string, info: ProjectRemovalInfo, agents: AgentDef[]): Promise<{ warnings: string[] }> {
  const name = basename(p)
  const { ok, refused } = await checkedWorktrees(ws, p, agents)
  const trees = ok.map((a) => a.worktree!.path).filter((t) => existsSync(t))
  // The folder first: it is what Windows most often can't move (a program has it open), and until it has gone
  // nothing else is touched, so a refusal leaves the project as it was.
  const resume = suspendWatching([p, ...trees])
  try {
    await shell.trashItem(p)
  } catch (e) {
    resume()
    throw new Error(`Could not move ${name} to the Recycle Bin: ${(e as Error).message}. Close any program using its folder (a terminal, an editor), then try again. Nothing was deleted.`, { cause: e })
  }
  // From here the project is gone: what can't follow is reported, not undone.
  const warnings = refused.map((r) => `Left alone: ${r}.`)
  for (const t of trees) {
    await shell.trashItem(t).catch((e) => warnings.push(`${t} couldn't be moved to the Recycle Bin: ${(e as Error).message}`))
  }
  for (const rel of info.handovers) {
    await shell.trashItem(join(ws.sharedDir, rel)).catch((e) => warnings.push(`${rel} couldn't be moved to the Recycle Bin: ${(e as Error).message}`))
  }
  await deleteProjectCards(ws, name).catch((e) => warnings.push(`Its cards couldn't all be deleted: ${(e as Error).message}`))
  // The project's empty folder of worktrees.
  const treesDir = join(ws.worktreesRoot, name)
  if (existsSync(treesDir) && !(await readdir(treesDir).catch(() => ['?'])).length) await rmdir(treesDir).catch(() => undefined)
  if ((ws.config.hiddenProjects ?? []).some((h) => same(h.name, name))) await ws.setHidden(name, null)
  config.update((c) => {
    if (ws.path && c.activeProjects[ws.path]) c.activeProjects[ws.path] = c.activeProjects[ws.path].filter((n) => !same(n, name))
  })
  for (const w of warnings) log.warn(`Deleting ${name}: ${w}`)
  log.info(`Deleted ${name} (to the Recycle Bin)`)
  return { warnings }
}

interface Manifest {
  version: 1
  at: string
  /** The workspace it was removed from: restoring there brings back the archived cards rather than copies. */
  workspace: string
  project: string
  handovers: number
  cards: number
}

/** Writes the project's handovers and cards into <project>/.hive/removed, with a manifest. */
async function pack(ws: WorkspaceService, p: string, handovers: string[]): Promise<void> {
  const dir = join(p, HIVE_DIR, REMOVED_DIR)
  // An older pack (removed before, restored without unpacking) makes way for this one.
  await removePath(dir)
  await mkdir(join(dir, 'handovers'), { recursive: true })
  for (const rel of handovers) await copyFile(join(ws.sharedDir, rel), join(dir, 'handovers', basename(rel)))
  const cards = await projectCards(ws, basename(p))
  await writeJsonAtomic(join(dir, 'cards.json'), cards)
  const manifest: Manifest = { version: 1, at: new Date().toISOString(), workspace: ws.path!, project: basename(p), handovers: handovers.length, cards: cards.length }
  await writeJsonAtomic(join(dir, 'manifest.json'), manifest)
}

/**
 * Where a packed handover goes back: its own name, unless a different note took that name meanwhile; then
 * "<name>-restored.md" (-restored-2…). Null when the same note is already there.
 */
async function restoreTarget(dir: string, f: string, text: string): Promise<string | null> {
  const stem = f.slice(0, f.length - extname(f).length)
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? f : `${stem}-restored${n === 2 ? '' : `-${n - 1}`}${extname(f)}`
    const target = join(dir, name)
    if (!existsSync(target)) return target
    if ((await readFile(target, 'utf8').catch(() => null)) === text) return null
  }
  throw new Error(`Too many handovers named like ${f}`)
}

/**
 * Puts back what Remove from Hive packed: handovers into the shared notes (never over a different note: that one
 * keeps its name and the packed one comes back beside it), and the cards: in the workspace it was removed from,
 * the archived ones come back; anywhere else, copies with new numbers. The pack is deleted only once all is back.
 */
async function unpack(ws: WorkspaceService, p: string): Promise<{ handovers: number; cards: number }> {
  const dir = join(p, HIVE_DIR, REMOVED_DIR)
  const manifest = await readJson<Partial<Manifest> | null>(join(dir, 'manifest.json'), null)
  if (!manifest) return { handovers: 0, cards: 0 }
  let handovers = 0
  const target = join(ws.sharedDir, 'handovers')
  await mkdir(target, { recursive: true })
  for (const f of await readdir(join(dir, 'handovers')).catch(() => [] as string[])) {
    const text = await readFile(join(dir, 'handovers', f), 'utf8')
    const to = await restoreTarget(target, f, text)
    if (to) await copyFile(join(dir, 'handovers', f), to)
    handovers++
  }
  const name = basename(p)
  let cards: number
  if (manifest.workspace && ws.path && same(manifest.workspace, ws.path) && (await projectCards(ws, name)).length) cards = await restoreProjectCards(ws, name)
  else cards = await importCards(ws, (await readJson<TaskCard[]>(join(dir, 'cards.json'), [])).filter((c) => c && typeof c === 'object'), name)
  await removePath(dir)
  return { handovers, cards }
}

/** Brings a hidden or removed project back (Settings → Workspace → Projects). */
export async function restoreProject(name: string): Promise<{ handovers: number; cards: number }> {
  const ws = workspace
  const entry = (ws.config.hiddenProjects ?? []).find((h) => same(h.name, name))
  if (!entry) throw new Error(`${name} isn't hidden or removed.`)
  const p = join(ws.path!, entry.name)
  if (!existsSync(p)) throw new Error(`The folder ${entry.name} is no longer in the workspace. Put it back, or forget it.`)
  await ws.setHidden(entry.name, null)
  // If unpacking fails, the project is back and its pack stays: its banner offers to restore it again.
  const result = entry.mode === 'removed' && existsSync(join(p, HIVE_DIR, REMOVED_DIR)) ? await unpack(ws, p) : { handovers: 0, cards: await restoreProjectCards(ws, entry.name) }
  await ws.ensureProject(p)
  log.info(`Restored ${entry.name}`)
  await ws.refresh()
  return result
}

/** A project folder holding a pack from Remove from Hive (moved here, or never unpacked): takes it in, or drops it. */
export async function takeRemovedData(projectPath: string, keep: boolean): Promise<{ handovers: number; cards: number }> {
  const ws = workspace
  const p = ws.assertProject(projectPath)
  const result = keep ? await unpack(ws, p) : { handovers: 0, cards: 0 }
  if (!keep) await removePath(join(p, HIVE_DIR, REMOVED_DIR))
  await ws.refresh()
  return result
}

/** Stops listing a hidden or removed project whose folder has gone from the workspace. */
export async function forgetHidden(name: string): Promise<void> {
  const ws = workspace
  const entry = (ws.config.hiddenProjects ?? []).find((h) => same(h.name, name))
  if (!entry) return
  if (existsSync(join(ws.path!, entry.name))) throw new Error(`${entry.name} is still in the workspace: restore it instead.`)
  await ws.setHidden(entry.name, null)
  await ws.refresh()
}
