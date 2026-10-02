import type { AgentBranchStatus, HiveEvent, ProjectInfo } from '../shared/types'
import { emit, onHiveEvent } from './events'
import { createLogger } from './logger'
import { openWorkspaces, workspaceFor } from './workspace'
import * as wt from './worktrees'

const log = createLogger('branches')

/**
 * What each worktree agent has not merged (commits ahead of the project folder's branch, uncommitted files),
 * for the Merge… button and the agent's tab. Git is asked when an agent's turn ends or it stops, when a window
 * gets focus, when an agent is added, after a merge or the Merge dialog's own check, and every minute for
 * agents that still have something to merge. Each change is sent as a `branch-status` event.
 */

/** Unmerged work counts; `null` when git couldn't say (a missing worktree, say). */
const known = new Map<string, { projectPath: string; agentId: string; status: AgentBranchStatus | null }>()
const running = new Map<string, Promise<void>>()
const timers = new Map<string, NodeJS.Timeout>()
/** The last status each agent reported, so only a change of status starts a check. */
const lastStatus = new Map<string, string>()
let lastFocusCheck = 0

const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

function same(a: AgentBranchStatus | null, b: AgentBranchStatus | null): boolean {
  return a === b || (!!a && !!b && a.ahead === b.ahead && a.dirty === b.dirty && a.into === b.into && a.branch === b.branch && a.base === b.base)
}

function projectsOf(ws = openWorkspaces()): ProjectInfo[] {
  return ws.flatMap((w) => w.info()?.projects ?? [])
}

function findAgent(projectPath: string, agentId: string): { project: ProjectInfo; worktree: NonNullable<ProjectInfo['agents'][number]['worktree']> } | null {
  const p = projectPath.toLowerCase()
  const ws = workspaceFor(projectPath)
  const project = projectsOf(ws ? [ws] : undefined).find((x) => x.path.toLowerCase() === p)
  const worktree = project?.agents.find((a) => a.id === agentId)?.worktree
  return project && worktree ? { project, worktree } : null
}

/** Records a status (from a check here or the Merge dialog's) and tells the window when it changed. */
export function record(projectPath: string, agentId: string, status: AgentBranchStatus | null): void {
  const key = keyOf(projectPath, agentId)
  const before = known.get(key)
  known.set(key, { projectPath, agentId, status })
  if (before && same(before.status, status)) return
  emit({ type: 'branch-status', projectPath, agentId, status })
}

/** Asks git about one worktree agent now (one check at a time per agent). */
export function check(projectPath: string, agentId: string): Promise<void> {
  const key = keyOf(projectPath, agentId)
  const busy = running.get(key)
  if (busy) return busy
  const found = findAgent(projectPath, agentId)
  if (!found) {
    forget(key)
    return Promise.resolve()
  }
  const p = wt
    .branchStatus(found.project.path, found.worktree)
    .then(
      (st) => record(found.project.path, agentId, st),
      (e) => {
        log.warn(`Couldn't check ${found.worktree.branch}`, e)
        record(found.project.path, agentId, null)
      }
    )
    .finally(() => running.delete(key))
  running.set(key, p)
  return p
}

/** A check a moment from now, so a burst of status changes asks git once. */
function soon(projectPath: string, agentId: string, ms = 1500): void {
  const key = keyOf(projectPath, agentId)
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void check(projectPath, agentId)
    }, ms)
  )
}

/** Every worktree agent of a project: a merge changes the branch they are all compared with. */
export function checkProject(projectPath: string): Promise<void> {
  const p = projectPath.toLowerCase()
  const project = projectsOf().find((x) => x.path.toLowerCase() === p)
  return Promise.all((project?.agents ?? []).filter((a) => a.worktree).map((a) => check(project!.path, a.id))).then(() => undefined)
}

function checkAll(onlyNew = false): void {
  const live = new Set<string>()
  for (const project of projectsOf()) {
    for (const a of project.agents) {
      if (!a.worktree) continue
      const key = keyOf(project.path, a.id)
      live.add(key)
      if (!onlyNew || !known.has(key)) void check(project.path, a.id)
    }
  }
  // Agents removed, or projects closed with their workspace.
  for (const key of [...known.keys()]) if (!live.has(key)) forget(key)
}

function forget(key: string): void {
  known.delete(key)
  lastStatus.delete(key)
  clearTimeout(timers.get(key))
  timers.delete(key)
}

/** What is known for the projects of the open workspaces, for a window that is just starting. */
export function statuses(): { projectPath: string; agentId: string; status: AgentBranchStatus | null }[] {
  checkAll(true)
  return [...known.values()]
}

function onEvent(e: HiveEvent): void {
  switch (e.type) {
    case 'session-status': {
      const { projectPath, agentId, status } = e.state
      const key = keyOf(projectPath, agentId)
      if (lastStatus.get(key) === status) return
      lastStatus.set(key, status)
      // Commits happen during a turn: look once it has ended (or the agent stopped).
      if (status !== 'working' && status !== 'starting' && findAgent(projectPath, agentId)) soon(projectPath, agentId)
      return
    }
    case 'workspace-changed':
      // An agent added (or a workspace opened): check those not known yet; removed ones are forgotten.
      checkAll(true)
      return
    case 'window-state':
      // Back to Hive: commits made in a terminal, or a branch switched in the project folder, show up.
      if (e.focused && Date.now() - lastFocusCheck > 10_000) {
        lastFocusCheck = Date.now()
        checkAll()
      }
      return
  }
}

let started = false

/** Starts listening; the minute's check covers agents that still have work to merge. */
export function startBranchWatch(): void {
  if (started) return
  started = true
  onHiveEvent(onEvent)
  setInterval(() => {
    for (const { projectPath, agentId, status } of known.values()) if (status && (status.ahead > 0 || status.dirty > 0)) void check(projectPath, agentId)
  }, 60_000).unref()
}
