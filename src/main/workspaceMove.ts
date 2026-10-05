import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import type { MoveHostPlan, MoveOptions, MovePlan, MoveReport, MoveWorktree, PathDataCopy, WorkspaceMoved } from '../shared/types'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { moveHasWork, rebase, rebaseAny, samePath, worktreeCandidates, type PathMove } from '../shared/movePaths'
import { recreateWorktree } from './agentWorktree'
import { config } from './config'
import { git } from './git'
import { createLogger, userText } from './logger'
import { allProviders } from './providers'
import { recentChanged } from './recentWorkspaces'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'
import { listWorktrees } from './worktrees'

/**
 * A workspace (or project) moved to another folder (#146). Hive records where each was last opened (`lastPath` in
 * workspace.json and project.json); when that differs, what is stored by absolute path is out of date: agents'
 * worktrees (and git's links both ways), session folders, Claude Code's per-path transcripts and memory, the recent
 * list. The plan says what Repair would do; repair does it, refusing while agents run. Every step can run again
 * harmlessly, and nothing at the old location is ever deleted.
 */

const log = createLogger('move')

const ASSISTANT = 'Hive Assistant'
const PROJECT_FILE = join(HIVE_DIR, 'project.json')

/** Whether p is inside root (or is it). */
const under = (p: string, root: string): boolean => rebase(p, root, root) !== null

/**
 * A moved project folder (or the Assistant's home), where its sessions ran then (from) and now (folder): its own folder,
 * except the Assistant's, which works in the workspace folder.
 */
interface Host {
  path: string
  name: string
  from: string
  folder: string
  /** The Assistant's home: no worktrees, and it moved with the workspace. */
  assistant: boolean
  /** Only earlier moves' data left to copy: the folder itself hasn't moved since it was recorded. */
  pendingOnly?: boolean
}

/** Whether a folder is a git worktree's (it has a .git file, not a folder). */
async function isWorktreeFolder(p: string): Promise<boolean> {
  return (await stat(join(p, '.git')).catch(() => null))?.isFile() ?? false
}

/** Whether git's links between a repository and one of its worktrees are right both ways. */
async function linked(repo: string, wt: string): Promise<boolean> {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(join(wt, '.git'), 'utf8'))?.[1]?.trim()
    if (!gitdir || !under(resolve(wt, gitdir), join(repo, '.git', 'worktrees'))) return false
    const back = (await readFile(join(resolve(wt, gitdir), 'gitdir'), 'utf8')).trim()
    return samePath(resolve(back), join(wt, '.git'))
  } catch {
    return false
  }
}

/** Records where the workspace and its projects are, for those that have no record yet (opened before #146). */
async function recordNew(ws: WorkspaceService, projects: string[]): Promise<void> {
  if (!ws.config.lastPath && ws.path) {
    ws.config.lastPath = ws.path
    await ws.saveWorkspaceConfig()
  }
  for (const p of projects) if (!(await ws.projectConfig(p)).lastPath) await ws.mutateProjectConfig(p, (c) => (c.lastPath ? {} : { lastPath: p }))
}

/** The workspace's project folders that have Hive's files (hidden ones too). */
async function projectFolders(ws: WorkspaceService): Promise<string[]> {
  const all = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  return all.filter((p) => existsSync(join(p, PROJECT_FILE)))
}

/** The projects (and the Assistant's home) whose recorded folder isn't where they are now. */
async function movedHosts(ws: WorkspaceService): Promise<{ from: string | null; hosts: Host[] }> {
  const here = ws.path!
  const wsFrom = ws.config.lastPath && !samePath(ws.config.lastPath, here) ? ws.config.lastPath : null
  const hosts: Host[] = []
  for (const p of await projectFolders(ws)) {
    const cfg = await ws.projectConfig(p)
    const moved = !!cfg.lastPath && !samePath(cfg.lastPath, p)
    // A project whose move was repaired but some of whose data copies didn't work is still to finish.
    if (moved || cfg.pendingCopies?.length) hosts.push({ path: p, name: basename(p), from: moved ? cfg.lastPath! : p, folder: p, assistant: false, ...(moved ? {} : { pendingOnly: true }) })
  }
  if (wsFrom) hosts.push({ path: ws.assistantHome, name: ASSISTANT, from: wsFrom, folder: here, assistant: true })
  return { from: wsFrom, hosts }
}

/** Where each agent worktree of a moved project is now, or why it can't be repaired. */
async function worktreesOf(ws: WorkspaceService, host: Host, wsMove: PathMove, opts: MoveOptions): Promise<MoveWorktree[]> {
  if (host.assistant) return []
  const out: MoveWorktree[] = []
  const projectMove = { from: host.from, to: host.folder }
  const copied = existsSync(host.from)
  for (const a of projectAgents(await ws.projectConfig(host.path))) {
    if (!a.worktree) continue
    const key = `${host.path}#${a.id}`
    const base = { agentId: a.id, agentName: a.name, from: a.worktree.path }
    if (opts.unlink?.includes(key)) {
      out.push({ ...base, to: null, how: 'unlink' })
      continue
    }
    const picked = opts.locate?.[key]
    if (picked && (await isWorktreeFolder(picked))) {
      if (!(await linked(host.path, picked)) || !samePath(picked, a.worktree.path)) out.push({ ...base, to: resolve(picked), how: 'located' })
      continue
    }
    // Already right (repaired before, or a worktree the move didn't touch).
    if (await linked(host.path, a.worktree.path)) continue
    const candidates = worktreeCandidates(a.worktree.path, wsMove, projectMove)
    let found: string | null = null
    for (const c of candidates) {
      if (await isWorktreeFolder(c)) {
        found = c
        break
      }
    }
    if (!found) {
      // Its branch lives in the repository: Recreate makes the worktree again on it (where it would have moved to).
      const branch = { branch: a.worktree.branch, branchExists: (await git(host.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${a.worktree.branch}`])).ok }
      out.push(opts.recreate?.includes(key) ? { ...base, ...branch, to: candidates[0], how: 'recreate' } : { ...base, ...branch, to: null, how: 'missing' })
    }
    // Still at its old place while the project is at its old folder too: a copy, and the original keeps its worktree.
    else if (samePath(found, a.worktree.path) && copied) out.push({ ...base, to: null, how: 'original' })
    else out.push({ ...base, to: found, how: samePath(found, a.worktree.path) ? 'stayed' : 'moved' })
  }
  return out
}

type Move = PathMove & { of: string }

/**
 * The folder moves a host's paths follow, each saying whose: the host itself, each worktree found (or to be made) at a
 * new place, and the moves of earlier repairs whose data isn't all copied yet.
 */
function movesOf(host: Pick<Host, 'from' | 'folder' | 'assistant'>, worktrees: MoveWorktree[], pending: Move[] = []): Move[] {
  const out: Move[] = []
  const add = (m: Move): void => {
    if (!out.some((x) => samePath(x.from, m.from) && samePath(x.to, m.to))) out.push(m)
  }
  add({ from: host.from, to: host.folder, of: host.assistant ? 'the Assistant' : 'the project' })
  for (const w of worktrees) if (w.to && !samePath(w.from, w.to)) add({ from: w.from, to: w.to, of: `${w.agentName}'s worktree` })
  for (const m of pending) add(m)
  return out
}

/** A project's moves whose data copy is still to finish (project.json pendingCopies). */
const pendingOf = async (ws: WorkspaceService, host: string): Promise<Move[]> => (samePath(host, ws.assistantHome) ? [] : ((await ws.projectConfig(host)).pendingCopies ?? []))

/** A pending move done: its sessions rewritten and its data copied. */
async function donePending(ws: WorkspaceService, host: string, m: Move): Promise<void> {
  await ws.mutateProjectConfig(host, (cfg) => {
    const rest = (cfg.pendingCopies ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to)))
    return { pendingCopies: rest.length ? rest : undefined }
  })
}

/**
 * Finishes a project's pending moves outside Repair (a worktree recreated at a new place from Start): its sessions
 * rewritten, the CLIs' data copied, each move dropped once both worked. What doesn't work stays pending, and the
 * banner offers Repair….
 */
export async function finishPending(ws: WorkspaceService, host: string): Promise<void> {
  const pending = await pendingOf(ws, host)
  if (pending.length) {
    try {
      await sessionCwds(ws, host, pending, true)
      for (const m of pending) if (!(await copyFor(m, true)).some((f) => f.failed?.length)) await donePending(ws, host, m)
    } catch (e) {
      log.warn(`finishing ${userText(basename(host))}'s moved worktree`, e)
    }
  }
  ws.setMoved(movedSummary(await movePlan(ws)))
}

/** Adds a move whose data is still to be copied (kept until its copy works). */
const withPending = (list: Move[] | undefined, m: Move): Move[] => [...(list ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to))), m]

/** Session records whose folder moves, counted (apply: rewritten under the lock). */
async function sessionCwds(ws: WorkspaceService, host: string, moves: PathMove[], apply: boolean): Promise<number> {
  const rewrite = (list: { cwd?: string }[]): number => {
    let n = 0
    for (const s of list) {
      const next = s.cwd ? rebaseAny(s.cwd, moves) : null
      if (!next || !s.cwd || next === s.cwd) continue
      if (apply) s.cwd = next
      n++
    }
    return n
  }
  if (!apply) return rewrite(structuredClone((await ws.sessionsFile(host)).sessions))
  return ws.mutateSessions(host, (f) => rewrite(f.sessions))
}

/** What each CLI keeps by folder path for one moved folder. */
async function copyFor(m: Move, apply: boolean): Promise<PathDataCopy[]> {
  const out: PathDataCopy[] = []
  for (const p of allProviders()) {
    if (!p.copyPathData) continue
    const r = await p.copyPathData(m.from, m.to, apply).catch((e) => {
      log.warn(`copying ${p.id}'s data for ${userText(m.to)}`, e)
      return { provider: p.id, from: m.from, to: m.to, copy: 0, kept: [], failed: [String(e instanceof Error ? e.message : e)] }
    })
    if (r) out.push({ ...r, of: m.of })
  }
  return out
}

/** What each CLI keeps by folder path for a host's moves. */
async function pathData(moves: Move[], apply: boolean): Promise<PathDataCopy[]> {
  const out: PathDataCopy[] = []
  for (const m of moves) out.push(...(await copyFor(m, apply)))
  return out
}

/** Agents running in the workspace (the Assistant too), as "project · agent". */
function runningIn(ws: WorkspaceService, folders: string[]): string[] {
  const mine = new Set([...folders, ws.assistantHome].map((p) => resolve(p).toLowerCase()))
  return sessions
    .liveStates()
    .filter((l) => mine.has(resolve(l.projectPath).toLowerCase()))
    .map((l) => (samePath(l.projectPath, ws.assistantHome) ? ASSISTANT : `${basename(l.projectPath)} · ${l.agentName ?? l.agentId}`))
}

/** The projects marked Working on in a workspace folder (config.json keeps them by the folder's path). */
function workingAt(folder: string): string[] {
  const all = config.get().activeProjects
  return Object.keys(all)
    .filter((k) => samePath(k, folder))
    .flatMap((k) => all[k] ?? [])
}

/** What Repair would do now; null when nothing moved. */
export async function movePlan(ws: WorkspaceService, opts: MoveOptions = {}): Promise<MovePlan | null> {
  if (!ws.path) return null
  const here = ws.path
  const { from, hosts } = await movedHosts(ws)
  if (!hosts.length && !from) return null
  const wsMove = { from: from ?? here, to: here }
  const planned: MoveHostPlan[] = []
  for (const h of hosts) {
    const worktrees = await worktreesOf(ws, h, wsMove, opts)
    const moves = movesOf(h, worktrees, await pendingOf(ws, h.path))
    planned.push({ path: h.path, name: h.name, from: h.from, folder: h.folder, worktrees, sessions: await sessionCwds(ws, h.path, moves, false), folders: await pathData(moves, false) })
  }
  return {
    from,
    to: here,
    projects: hosts.filter((h) => !h.assistant && !h.pendingOnly).map((h) => h.name),
    pending: hosts.filter((h) => h.pendingOnly).map((h) => h.name),
    running: runningIn(ws, await projectFolders(ws)),
    hosts: planned,
    recent: !!from && config.get().recentWorkspaces.some((p) => samePath(p, from)),
    working: from ? workingAt(from).filter((n) => !workingAt(here).includes(n)) : []
  }
}

/** The plan's headline for the banner, or null when there's nothing to repair. */
export const movedSummary = (plan: MovePlan | null): WorkspaceMoved | null => (plan && moveHasWork(plan) ? { from: plan.from, projects: plan.projects, pending: plan.pending } : null)

/**
 * On opening a workspace: records the folders of those opened for the first time, and works out whether anything
 * moved. A move with nothing to repair is simply recorded; otherwise the window's banner offers Repair….
 */
export async function checkMoved(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  await recordNew(ws, await projectFolders(ws))
  const plan = await movePlan(ws)
  if (ws.path !== path) return
  if (plan && !moveHasWork(plan)) await recordDone(ws, plan.hosts.map((h) => h.path), true)
  else if (plan) log.info(`Moved since last opened: ${plan.from ? `the workspace, from ${userText(plan.from)}` : `${plan.projects.length} project(s)`}`)
  ws.setMoved(movedSummary(plan))
}

/** Records the hosts' folders as where they are now, and the workspace's when all of them are (the Assistant's included). */
async function recordDone(ws: WorkspaceService, hosts: string[], all: boolean): Promise<void> {
  for (const h of hosts) if (!samePath(h, ws.assistantHome)) await ws.mutateProjectConfig(h, () => ({ lastPath: h }))
  if (all && ws.path && ws.config.lastPath !== ws.path) {
    ws.config.lastPath = ws.path
    await ws.saveWorkspaceConfig()
  }
}

const trimList = (list: string[], max = 5): string => (list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', '))

/**
 * Repairs a moved workspace or project (the user's choices in opts): worktrees (git's links, then the agents' records),
 * session folders, the CLIs' per-path data (copied), the recent list. A project is recorded as repaired only when all
 * of its steps worked and none is left (a worktree not found stays listed until it is located or its link removed).
 */
export async function repairMove(ws: WorkspaceService, opts: MoveOptions = {}): Promise<MoveReport> {
  if (repairing.has(ws)) throw new Error('A repair is already running in this window.')
  // No agent starts while it runs (sessions.ts checks the flag), and the running check comes after it is set.
  ws.repairingMove = true
  const run = repairNow(ws, opts)
  repairing.set(ws, run)
  try {
    return await run
  } finally {
    repairing.delete(ws)
    ws.repairingMove = false
  }
}
const repairing = new WeakMap<WorkspaceService, Promise<MoveReport>>()

async function repairNow(ws: WorkspaceService, opts: MoveOptions): Promise<MoveReport> {
  const report: MoveReport = { done: [], skipped: [], failed: [], complete: false }
  const plan = await movePlan(ws, opts)
  if (!plan || !moveHasWork(plan)) {
    if (plan) await recordDone(ws, plan.hosts.map((h) => h.path), true)
    ws.setMoved(null)
    report.skipped.push('Nothing to repair: everything already points to where the workspace is now.')
    report.complete = true
    return report
  }
  if (plan.running.length) throw new Error(`Stop the running agents first: ${plan.running.join(', ')}.`)
  log.info(`Repairing a move to ${userText(plan.to)}${plan.from ? ` from ${userText(plan.from)}` : ''}`)
  const repaired: string[] = []
  for (const h of plan.hosts) {
    const failedBefore = report.failed.length
    let open = false
    // Worktrees: git's links both ways, checked, then the agent's record.
    const fix = h.worktrees.filter((w) => w.to && (w.how === 'moved' || w.how === 'stayed' || w.how === 'located'))
    if (fix.length) {
      const r = await git(h.path, ['worktree', 'repair', ...fix.map((w) => w.to!)])
      const listed = await listWorktrees(h.path)
      for (const w of fix) {
        const ok = listed.some((l) => samePath(l.path, w.to!)) && (await linked(h.path, w.to!))
        if (!ok) {
          report.failed.push(`${h.name}: ${w.agentName}'s worktree at ${w.to} couldn't be repaired${r.ok ? '' : ` (${(r.err || 'git worktree repair failed').trim()})`}.`)
          continue
        }
        // The new path, and the move its data follows until that is copied, in one locked change.
        const m = { from: w.from, to: w.to!, of: `${w.agentName}'s worktree` }
        await ws.mutateProjectConfig(h.path, (cfg) => ({
          agents: projectAgents(cfg).map((a) => (a.id === w.agentId && a.worktree ? { ...a, worktree: { ...a.worktree, path: w.to! } } : a)),
          ...(samePath(w.from, w.to!) ? {} : { pendingCopies: withPending(cfg.pendingCopies, m) })
        }))
        report.done.push(`${h.name}: ${w.agentName}'s worktree ${samePath(w.from, w.to!) ? `at ${w.to} is linked to the project again` : `is now at ${w.to}`}.`)
      }
    }
    // Worktrees to make again: after the repairs above, so git's prune can't drop a link they still needed.
    const remake = h.worktrees.filter((w) => w.how === 'recreate')
    for (const w of remake) {
      const what = w.branchExists ? `recreated on its branch ${w.branch}` : `made new on ${w.branch} (its branch was gone)`
      try {
        // Its new path and the move its sessions and data follow are written together (in recreateWorktree).
        const def = await recreateWorktree(h.path, w.agentId, { prefer: w.to ?? undefined, alsoRecreating: remake.map((x) => x.from) })
        const to = def.worktree!.path
        report.done.push(`${h.name}: ${w.agentName}'s worktree was ${what}, at ${to}.`)
      } catch (e) {
        report.failed.push(`${h.name}: ${w.agentName}'s worktree couldn't be ${w.branchExists ? 'recreated' : 'made new'}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const w of h.worktrees) {
      if (w.how === 'unlink') {
        await ws.mutateProjectConfig(h.path, (cfg) => ({ agents: projectAgents(cfg).map((a) => (a.id === w.agentId ? { ...a, worktree: undefined } : a)) }))
        report.done.push(`${h.name}: ${w.agentName} no longer has a worktree (its folder ${w.from} was left as it was).`)
      } else if (w.how === 'missing') {
        open = true
        report.skipped.push(`${h.name}: ${w.agentName}'s worktree wasn't found (it was at ${w.from}). ${w.branchExists ? 'Recreate it on its branch' : 'Create a new worktree'}, locate it, or remove the agent's worktree link.`)
      } else if (w.how === 'original') {
        report.skipped.push(`${h.name}: ${w.agentName}'s worktree at ${w.from} stays linked to the project at ${h.from}, which is still there.`)
      }
    }
    // Sessions and the CLIs' per-path data follow the project and the worktrees now at new places: those are kept in
    // project.json (pendingCopies) until their data is copied, so a copy that fails is tried again, after a restart too.
    const pending = await pendingOf(ws, h.path)
    const moves = movesOf({ ...h, assistant: samePath(h.path, ws.assistantHome) }, [], pending)
    // A sessions.json that can't be written leaves the moves pending: the next Repair rewrites them.
    let sessionsOk = true
    try {
      const n = await sessionCwds(ws, h.path, moves, true)
      if (n) report.done.push(`${h.name}: ${n} session${n === 1 ? '' : 's'} now point${n === 1 ? 's' : ''} to the new folder.`)
    } catch (e) {
      sessionsOk = false
      report.failed.push(`${h.name}: the sessions' folders couldn't be updated (${e instanceof Error ? e.message : String(e)}). Repair tries again.`)
    }
    // Copied, never moved; the old folders stay.
    for (const m of moves) {
      const results = await copyFor(m, true)
      for (const f of results) {
        const who = allProviders().find((p) => p.id === f.provider)?.descriptor.name ?? f.provider
        if (f.copy) report.done.push(`${h.name}: copied ${f.copy} file${f.copy === 1 ? '' : 's'} of ${who}'s conversations and memory for ${f.of} to its folder for the new path (the old folder is kept).`)
        if (f.kept.length) report.skipped.push(`${h.name}: ${f.kept.length} file${f.kept.length === 1 ? '' : 's'} of ${who}'s for ${f.of} already in ${f.to} with other content, not overwritten: ${trimList(f.kept)}.`)
        if (f.failed?.length) report.failed.push(`${h.name}: ${f.failed.length} file${f.failed.length === 1 ? '' : 's'} of ${who}'s for ${f.of} couldn't be copied to ${f.to}: ${trimList(f.failed)}. Repair tries them again.`)
      }
      if (sessionsOk && pending.some((x) => samePath(x.from, m.from) && samePath(x.to, m.to)) && !results.some((f) => f.failed?.length)) await donePending(ws, h.path, m)
    }
    if (report.failed.length === failedBefore && !open) repaired.push(h.path)
  }
  if (plan.recent && plan.from) {
    const from = plan.from
    config.update((c) => {
      const rest = c.recentWorkspaces.filter((p) => !samePath(p, from))
      c.recentWorkspaces = rest.some((p) => samePath(p, plan.to)) ? rest : [plan.to, ...rest]
    })
    recentChanged()
    report.done.push(`Open Recent lists ${plan.to} instead of ${from}.`)
  }
  if (plan.working.length) {
    config.update((c) => {
      c.activeProjects[plan.to] = [...new Set([...(c.activeProjects[plan.to] ?? []), ...plan.working])]
    })
    report.done.push(`Working on: ${trimList(plan.working)}, as before the move.`)
  }
  await recordDone(ws, repaired, repaired.length === plan.hosts.length)
  const after = await movePlan(ws)
  report.complete = report.failed.length === 0 && (!after || !moveHasWork(after))
  if (report.complete && after) await recordDone(ws, after.hosts.map((h) => h.path), true)
  ws.setMoved(report.complete ? null : movedSummary(after))
  for (const line of report.done) log.info(`Repair: ${userText(line)}`)
  for (const line of report.skipped) log.info(`Repair skipped: ${userText(line)}`)
  for (const line of report.failed) log.warn(`Repair failed: ${userText(line)}`)
  return report
}
