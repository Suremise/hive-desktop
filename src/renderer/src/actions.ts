import { basename } from './util'
import { call, errorMessage } from './api'
import { agentOf, confirm, focusedAgentId, get, notify, prompt, revealAgent, set, setActivity, setProjectTab, showAgent } from './store'
import { MAIN_AGENT, sessionInAgentFolder } from '@shared/defaults'
import type { ProjectInfo, SessionLayout, SessionListItem } from '@shared/types'
import { formatTokens } from './util'

/** Runs an async action and shows a toast if it fails. */
export async function attempt<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    notify('error', title, errorMessage(e))
    return undefined
  }
}

export async function refreshWorkspace(): Promise<void> {
  const ws = await call('workspace:refresh')
  set({ workspace: ws })
}

export async function openWorkspace(path?: string): Promise<void> {
  const ws = await attempt('Could not open workspace', () => call('workspace:open', path))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent') })
  if (ws && !ws.projects.some((p) => p.path === get().selectedProject)) {
    const first = ws.projects.find((p) => p.active) ?? ws.projects[0]
    set({ selectedProject: first?.path ?? null })
  }
  setActivity('projects')
}

export async function createWorkspace(): Promise<void> {
  const ws = await attempt('Could not create workspace', () => call('workspace:create'))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent'), selectedProject: ws?.projects[0]?.path ?? null })
  setActivity('projects')
}

export async function closeWorkspace(): Promise<void> {
  const ok = await attempt('Could not close workspace', () => call('workspace:close').then(() => true))
  if (ok) set({ workspace: null, selectedProject: null })
}

export async function createProject(): Promise<void> {
  if (!get().workspace) return notify('warning', 'Open a workspace first')
  const name = await prompt({
    title: 'New Project',
    message: 'A new folder is created in the workspace. Hive adds its .hive metadata folder automatically.',
    placeholder: 'project-name',
    confirmLabel: 'Create',
    validate: (v) => (!v.trim() ? 'Enter a name' : /[<>:"/\\|?*]/.test(v) ? 'Names cannot contain < > : " / \\ | ? *' : v.trim().startsWith('.') ? 'Names cannot start with "."' : null)
  })
  if (!name) return
  const ws = await attempt('Could not create project', () => call('project:create', name.trim()))
  if (!ws) return
  const created = ws.projects.find((p) => p.name === name.trim())
  set({ workspace: ws, selectedProject: created?.path ?? get().selectedProject })
  setActivity('projects')
  notify('success', `Project "${name.trim()}" created`)
}

export function selectProject(path: string): void {
  set({ selectedProject: path })
  if (get().activity !== 'projects') setActivity('projects')
  void call('session:markSeen', path)
}

const project = (path: string): ProjectInfo | undefined => get().workspace?.projects.find((x) => x.path === path)

export async function setProjectActive(path: string, active: boolean): Promise<void> {
  const ws = await attempt(active ? 'Could not activate project' : 'Could not deactivate project', async () => {
    const p = project(path)
    const running = p?.agents.filter((a) => a.live).length ?? 0
    if (!active && running) {
      const ok = await confirm({
        title: running > 1 ? 'Stop agents and deactivate?' : 'Stop session and deactivate?',
        message: running > 1 ? `${p!.name} has ${running} agents running.` : `${p!.name} has a running session.`,
        detail: `${running > 1 ? 'They are' : 'The session is'} stopped (and can be resumed later) and the project is marked inactive.`,
        confirmLabel: 'Stop and deactivate',
        danger: true
      })
      if (!ok) return undefined
      await call('session:stop', path)
      await waitForStop(path)
    }
    return call('project:setActive', path, active)
  })
  if (ws) set({ workspace: ws })
}

/** Waits until an agent's session (or, without agentId, every agent of the project) has stopped. */
async function waitForStop(path: string, agentId?: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const live = await call('session:live')
    if (!live.some((l) => l.projectPath.toLowerCase() === path.toLowerCase() && (!agentId || (l.agentId ?? MAIN_AGENT) === agentId))) return
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function ensureAgent(): Promise<boolean> {
  const agent = get().agent
  if (agent?.found) return true
  set({ setupOpen: true })
  return false
}

/** " (Agent 2)" in projects with several agents, else nothing — for dialog wording. */
function agentSuffix(p: ProjectInfo | undefined, agentId: string): string {
  const a = agentOf(p, agentId)
  return (p?.agents.length ?? 1) > 1 && a ? ` (${a.name})` : ''
}

async function stopIfRunning(path: string, agentId: string, action: string): Promise<boolean> {
  const p = project(path)
  if (!agentOf(p, agentId)?.live) return true
  const ok = await confirm({
    title: `${action}?`,
    message: `${p!.name}${agentSuffix(p, agentId)} already has a running session.`,
    detail: 'It will be stopped first. Its conversation is kept and can be resumed from the Sessions tab.',
    confirmLabel: `Stop and ${action.toLowerCase()}`
  })
  if (!ok) return false
  await call('session:stop', path, agentId)
  await waitForStop(path, agentId)
  return true
}

function reveal(path: string, agentId: string): void {
  setProjectTab(path, 'session')
  set({ selectedProject: path })
  const p = project(path)
  if (p) showAgent(p, agentId)
}

export async function newSession(path: string | null = get().selectedProject, agentId?: string, opts: { skipSetup?: boolean } = {}): Promise<void> {
  if (!path || !(await ensureAgent())) return
  const id = agentId ?? focusedAgentId(project(path))
  if (!(await stopIfRunning(path, id, 'Start a new session'))) return
  const st = await attempt('Could not start session', () => call('session:start', path, { agentId: id, skipSetup: opts.skipSetup }))
  if (st) reveal(path, id)
}

/**
 * The agent to resume a session with. A session runs in the folder it started in, so one from a
 * worktree goes back to the agent working there, and one from the project folder to the chosen (or
 * focused) agent if that one works in the project folder, else Agent 1. Null if no agent works there.
 */
/**
 * Which agent resumes a session: the one asked for, else one that isn't running — the agent that
 * last ran it, the focused one, any other in the session's folder — else the agent that ran it.
 */
export function resumeTarget(p: ProjectInfo | undefined, item: Pick<SessionListItem, 'agentId' | 'cwd'>, preferred?: string): string | null {
  if (!p) return preferred ?? MAIN_AGENT
  if (item.cwd && item.cwd.toLowerCase() !== p.path.toLowerCase()) {
    return p.agents.find((a) => a.worktree?.path.toLowerCase() === item.cwd!.toLowerCase())?.id ?? null
  }
  const inFolder = (id: string | undefined): boolean => !!id && p.agents.some((a) => a.id === id && !a.worktree)
  const free = (id: string | undefined): boolean => inFolder(id) && !agentOf(p, id!)?.live
  if (inFolder(preferred)) return preferred!
  const recorded = item.agentId ?? MAIN_AGENT
  const focused = focusedAgentId(p)
  if (free(recorded)) return recorded
  if (free(focused)) return focused
  return p.agents.find((a) => !a.worktree && !a.live)?.id ?? (inFolder(recorded) ? recorded : MAIN_AGENT)
}

/** Agents that can run a session: those working in the folder it ran in. */
export function agentsForSession(p: ProjectInfo, item: Pick<SessionListItem, 'cwd'>): ProjectInfo['agents'] {
  return p.agents.filter((a) => sessionInAgentFolder(p.path, a, item))
}

export async function resumeSession(path: string, item: Pick<SessionListItem, 'id' | 'recache' | 'title' | 'name' | 'agentId' | 'cwd'>, agentId?: string): Promise<void> {
  if (!(await ensureAgent())) return
  const p = project(path)
  const target = resumeTarget(p, item, agentId)
  if (!target) {
    notify('warning', "Can't resume this session", `It ran in a worktree no agent uses any more (${item.cwd}). Add an agent for that worktree (Add Agent → existing worktree) to resume it.`)
    return
  }
  // One conversation can't run in two terminals: show the agent that has it open instead.
  const holder = p?.agents.find((a) => a.live?.sessionId === item.id)
  if (p && holder && holder.id !== target) {
    revealAgent(p, holder.id)
    notify('info', 'Already open', `This conversation is open in ${holder.name}. An agent can only resume a session no other agent is running.`)
    return
  }
  if (item.recache && !item.recache.warm && item.recache.tokens > 20000) {
    const ok = await confirm({
      title: 'Resume session?',
      message: `The prompt cache for this session has expired. Resuming will re-cache about ${formatTokens(item.recache.tokens)} tokens on the first message.`,
      detail: 'To save tokens, you can archive it and start a fresh session instead, perhaps from a handover note.',
      confirmLabel: 'Resume'
    })
    if (!ok) return
  }
  if (!(await stopIfRunning(path, target, 'Resume this session'))) return
  const st = await attempt('Could not resume session', () => call('session:start', path, { resumeId: item.id, name: item.name, agentId: target }))
  if (st) reveal(path, target)
}

export async function resumeLast(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  const a = agentOf(p, id)
  // Hive works out the session in the main process (AgentInfo.resume), skipping any open in another agent.
  const list = a?.resume ? await attempt('Could not list sessions', () => call('session:list', path)) : []
  const last = a?.resume ? (list ?? []).find((s) => s.id === a.resume!.id) ?? { id: a.resume.id, name: a.resume.name, title: null, recache: null, agentId: id, cwd: a.worktree?.path } : null
  if (!last) {
    notify('info', 'No previous session', `${(p?.agents.length ?? 1) > 1 && a ? `${a.name} has` : 'There is'} no session to resume. Start a new one instead.`)
    return
  }
  await resumeSession(path, last, id)
}

export async function stopSession(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  if (!agentOf(p, id)?.live) return
  if (get().settings?.sessions.confirmStop) {
    const ok = await confirm({
      title: 'Stop session?',
      message: `Stop the running session in ${p!.name}${agentSuffix(p, id)}?`,
      detail: 'The conversation is kept and can be resumed later.',
      confirmLabel: 'Stop',
      danger: true
    })
    if (!ok) return
  }
  await attempt('Could not stop session', () => call('session:stop', path, id))
}

export async function stopAllAgents(path: string): Promise<void> {
  const p = project(path)
  const running = p?.agents.filter((a) => a.live).length ?? 0
  if (!running) return
  if (get().settings?.sessions.confirmStop) {
    const ok = await confirm({
      title: 'Stop all agents?',
      message: `Stop the ${running} running sessions in ${p!.name}?`,
      detail: 'Their conversations are kept and can be resumed later.',
      confirmLabel: 'Stop all',
      danger: true
    })
    if (!ok) return
  }
  await attempt('Could not stop sessions', () => call('session:stop', path))
}

export async function archiveCurrent(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  const a = agentOf(p, id)
  const live = a?.live
  const list = await call('session:list', path)
  const target = live
    ? list.find((s) => s.id === live.sessionId)
    : list.find((s) => s.id === a?.lastSessionId && !s.archived) ?? (id === MAIN_AGENT ? list.find((s) => s.source === 'hive' && !s.archived && !s.cwd) : undefined)
  if (!target) return notify('info', 'Nothing to archive')
  const ok = await confirm({
    title: 'Archive session and start fresh?',
    message: `Archive "${target.name || target.title || target.id.slice(0, 8)}" and start a new session?`,
    detail: "The transcript is preserved in the project's .hive/archive folder. A new session starts with an empty context, which avoids re-caching the old conversation.",
    confirmLabel: 'Archive and start new'
  })
  if (!ok) return
  if (live) {
    await call('session:stop', path, id)
    await waitForStop(path, id)
  }
  await attempt('Could not archive session', () => call('session:archive', path, target.id, true))
  await newSession(path, id)
}

/** Removes an agent; for a worktree agent, asks whether to keep its worktree and branch. */
export async function removeAgent(path: string, agentId: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, agentId)
  if (!p || !a) return
  if (a.live && !(await stopIfRunning(path, agentId, `Remove ${a.name}`))) return
  let deleteWorktree = false
  if (a.worktree) {
    const keep = await confirm({
      title: `Remove ${a.name}?`,
      message: `${a.name} works in its own worktree on branch ${a.worktree.branch}.`,
      detail: `Keep the worktree and branch to merge or reuse them later (Add Agent → Existing worktree), or delete both. Its sessions stay in the Sessions tab either way.`,
      confirmLabel: 'Keep worktree and branch',
      cancelLabel: 'Delete them…'
    })
    if (!keep) {
      const del = await confirm({
        title: 'Delete the worktree and branch?',
        message: `Delete ${a.worktree.path} and branch ${a.worktree.branch}?`,
        detail: `Anything on ${a.worktree.branch} that hasn't been merged is lost. Cancel keeps the agent.`,
        confirmLabel: 'Delete worktree and branch',
        danger: true
      })
      if (!del) return
      deleteWorktree = true
    }
  } else if (!(await confirm({ title: `Remove ${a.name}?`, message: `${a.name} is removed from ${p.name}. Its sessions stay in the Sessions tab.`, confirmLabel: 'Remove' }))) return
  const ok = await attempt('Could not remove agent', () => call('agents:remove', path, agentId, { deleteWorktree }).then(() => true))
  if (ok) await refreshWorkspace()
}

/** Removes a worktree agent together with its worktree and branch. */
export async function discardAgent(path: string, agentId: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, agentId)
  if (!p || !a?.worktree) return
  const ok = await confirm({
    title: `Discard ${a.name}'s work?`,
    message: `Delete the worktree ${a.worktree.path} and branch ${a.worktree.branch}, and remove ${a.name}?`,
    detail: "Everything on the branch that hasn't been merged is lost. Its sessions stay in the Sessions tab.",
    confirmLabel: 'Discard',
    danger: true
  })
  if (!ok) return
  if (a.live) {
    await call('session:stop', path, agentId)
    await waitForStop(path, agentId)
  }
  const done = await attempt('Could not discard agent', () => call('agents:remove', path, agentId, { deleteWorktree: true }).then(() => true))
  if (done) await refreshWorkspace()
}

export async function setLayout(path: string, layout: SessionLayout): Promise<void> {
  await attempt('Could not change layout', () => call('project:updateConfig', path, { sessionLayout: layout }))
  await refreshWorkspace()
}

export async function toggleActiveSelected(): Promise<void> {
  const p = get().workspace?.projects.find((x) => x.path === get().selectedProject)
  if (p) await setProjectActive(p.path, !p.active)
}

export function cycleProject(delta: number): void {
  const ws = get().workspace
  if (!ws?.projects.length) return
  const list = ws.projects.filter((p) => p.active).length ? ws.projects.filter((p) => p.active) : ws.projects
  const i = list.findIndex((p) => p.path === get().selectedProject)
  const next = list[(i + delta + list.length) % list.length]
  selectProject(next.path)
}

export async function refreshAgent(): Promise<void> {
  const info = await attempt('Could not check Claude Code', () => call('agent:refresh'))
  if (info) {
    set({ agent: info })
    if (!info.found) notify('warning', 'Claude Code CLI not installed', 'Hive needs the standalone Claude Code CLI. Open Help → Claude Code Setup to install it.')
    else if (info.updateAvailable) notify('info', `Claude Code ${info.latestVersion} is available`, `You have ${info.version}.`, [{ label: 'Update', command: 'claude.update' }])
    else notify('success', 'Claude Code is up to date', `Version ${info.version}`)
  }
}

export async function importProjectMcp(path: string, names: string[]): Promise<void> {
  const imported = await attempt('Could not copy MCP servers', () => call('mcp:importFromProject', path, names))
  if (imported?.length) notify('success', `Copied ${imported.join(', ')} to the workspace`, 'Enable them in MCP Servers to use them in sessions.')
}

export { basename }
