import { basename } from './util'
import { call, errorMessage } from './api'
import { agentOf, agentProviderOf, confirm, findProject, isAssistantPath, setAssistantOpen, focusedAgentId, get, notify, prompt, revealAgent, set, setActivity, setProjectTab, showAgent, showView } from './store'
import { MAX_AGENTS, sessionInAgentFolder } from '@shared/defaults'
import { isProviderEnabled, projectDefaultProvider, providerName } from '@shared/providers'
import type { ProjectInfo, ProjectProviderConfig, ProviderId, SessionLayout, SessionListItem } from '@shared/types'
import { formatTokens } from './util'
import { STATUS_TEXT } from './components/ui'

/** Runs an async action and shows a toast if it fails. */
export async function attempt<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    notify('error', title, errorMessage(e))
    return undefined
  }
}

/**
 * Before something that drops unsaved edits (reloading the window, switching or closing the
 * workspace): offers to save them. False means stay (cancelled, or a file couldn't be saved).
 */
export async function saveUnsavedFirst(action: string): Promise<boolean> {
  const { saveAllDrafts, unsavedFiles } = await import('./components/FileView')
  const files = unsavedFiles()
  if (!files.length) return true
  const ok = await confirm({
    title: 'Save your changes?',
    message: `${files.length === 1 ? `${files[0].rel} has` : `${files.length} files have`} unsaved changes. Save ${files.length === 1 ? 'it' : 'them'} before you ${action}?`,
    detail: files.length > 1 ? files.map((f) => f.rel).join('\n') : undefined,
    confirmLabel: 'Save All'
  })
  if (!ok) return false
  const r = await saveAllDrafts()
  if (r.failed.length) {
    notify('error', `Couldn't save ${r.failed.length === 1 ? 'a file' : `${r.failed.length} files`}`, r.failed.map((f) => f.message).join('\n'))
    return false
  }
  return true
}

export async function refreshWorkspace(): Promise<void> {
  const ws = await call('workspace:refresh')
  set({ workspace: ws })
}

export async function openWorkspace(path?: string): Promise<void> {
  const current = get().workspace?.path
  if (current && path?.toLowerCase() !== current.toLowerCase() && !(await saveUnsavedFirst('switch workspace'))) return
  const ws = await attempt('Could not open workspace', () => call('workspace:open', path))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent') })
  if (ws && !ws.projects.some((p) => p.path === get().selectedProject)) {
    const first = ws.projects.find((p) => p.active) ?? ws.projects[0]
    set({ selectedProject: first?.path ?? null })
  }
  showView('projects')
}

export async function createWorkspace(): Promise<void> {
  if (get().workspace && !(await saveUnsavedFirst('switch workspace'))) return
  const ws = await attempt('Could not create workspace', () => call('workspace:create'))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent'), selectedProject: ws?.projects[0]?.path ?? null })
  showView('projects')
}

export async function closeWorkspace(): Promise<void> {
  if (!(await saveUnsavedFirst('close the workspace'))) return
  const ok = await attempt('Could not close workspace', () => call('workspace:close'))
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
  showView('projects')
  notify('success', `Project "${name.trim()}" created`)
}

export function selectProject(path: string): void {
  set({ selectedProject: path })
  if (get().activity !== 'projects') setActivity('projects')
  void call('session:markSeen', path)
}

const project = (path: string): ProjectInfo | undefined => findProject(get(), path) ?? undefined

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
export async function waitForStop(path: string, agentId?: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const live = await call('session:live')
    if (!live.some((l) => l.projectPath.toLowerCase() === path.toLowerCase() && (!agentId || l.agentId === agentId))) return
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** The agent's provider is turned on and installed; otherwise says so (or opens its setup) and returns false. */
async function ensureAgent(path: string, agentId: string): Promise<boolean> {
  const p = project(path)
  const provider = agentProviderOf(p, agentOf(p, agentId))
  const name = providerName(provider)
  if (!isProviderEnabled(get().settings, provider)) {
    notify('warning', `${name} is turned off`, `Turn it on in Settings → Providers to run this agent, or give the agent another provider in its settings.`, [{ label: 'Open Settings', command: 'settings.providers' }])
    return false
  }
  if (get().providers[provider]?.found) return true
  set({ setupOpen: provider })
  return false
}

/**
 * Add Agent's quick add: an agent with the project's default provider and default settings, in the project
 * folder. When that provider is off or not installed, opens the Add Agent dialog instead. Returns the new
 * agent's id, or null.
 */
export async function quickAddAgent(path: string | null = get().selectedProject, forProvider?: ProviderId): Promise<string | null> {
  if (!path) return null
  const p = project(path)
  if (p && p.agents.length >= MAX_AGENTS) {
    notify('warning', 'No room for another agent', `A project can have up to ${MAX_AGENTS} agents. Remove one first.`)
    return null
  }
  const provider = forProvider ?? projectDefaultProvider(p?.config, get().settings)
  if (!isProviderEnabled(get().settings, provider) || !get().providers[provider]?.found) {
    set({ addAgentFor: path })
    return null
  }
  const def = await attempt('Could not add an agent', () => call('agents:add', path, { location: 'project', provider }))
  if (!def) return null
  await refreshWorkspace()
  const now = project(path)
  if (now) showAgent(now, def.id)
  return def.id
}

/** Changes a project's settings for one provider. */
export async function updateProjectProvider(path: string, provider: ProviderId, patch: Partial<ProjectProviderConfig>): Promise<void> {
  const p = project(path)
  if (!p) return
  await attempt('Could not save project settings', () => call('project:updateProvider', path, provider, patch))
  await refreshWorkspace()
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
  // The Hive Assistant lives in its own panel.
  if (isAssistantPath(path)) return setAssistantOpen(true)
  setProjectTab(path, 'session')
  set({ selectedProject: path })
  const p = project(path)
  if (p) showAgent(p, agentId)
}

export async function newSession(path: string | null = get().selectedProject, agentId?: string, opts: { skipSetup?: boolean } = {}): Promise<void> {
  if (!path) return
  // A project without agents gets one (the quick add) and starts it.
  const id = agentId ?? focusedAgentId(project(path)) ?? (await quickAddAgent(path))
  if (!id) return
  if (!(await ensureAgent(path, id))) return
  if (!(await stopIfRunning(path, id, 'Start a new session'))) return
  const st = await attempt('Could not start session', () => call('session:start', path, { agentId: id, skipSetup: opts.skipSetup }))
  if (st) reveal(path, id)
}

/**
 * Which agent resumes a session. A session runs in the folder it started in and with its provider, so
 * one from a worktree goes back to the agent working there (null if none does, or it runs another
 * provider). For the project folder: the agent asked for, else one that isn't running — the agent that
 * last ran it, the focused one, any other in the folder — else the agent that ran it.
 */
export function resumeTarget(p: ProjectInfo | undefined, item: Pick<SessionListItem, 'agentId' | 'cwd'> & { provider?: ProviderId }, preferred?: string): string | null {
  if (!p) return preferred ?? null
  const sameProvider = (a: ProjectInfo['agents'][number]): boolean => !item.provider || agentProviderOf(p, a) === item.provider
  // The Hive Assistant's sessions ran in the workspace folder, with its one agent.
  if (isAssistantPath(p.path)) return p.agents[0] && sameProvider(p.agents[0]) ? p.agents[0].id : null
  if (item.cwd && item.cwd.toLowerCase() !== p.path.toLowerCase()) {
    const a = p.agents.find((x) => x.worktree?.path.toLowerCase() === item.cwd!.toLowerCase())
    return a && sameProvider(a) ? a.id : null
  }
  const inFolder = (id: string | undefined): boolean => !!id && p.agents.some((a) => a.id === id && !a.worktree && sameProvider(a))
  const free = (id: string | undefined): boolean => inFolder(id) && !agentOf(p, id!)?.live
  if (inFolder(preferred)) return preferred!
  const recorded = item.agentId
  const focused = focusedAgentId(p) ?? undefined
  if (free(recorded)) return recorded!
  if (free(focused)) return focused!
  const other = p.agents.find((a) => !a.worktree && !a.live && sameProvider(a))?.id
  return other ?? (inFolder(recorded) ? recorded! : (p.agents.find((a) => !a.worktree && sameProvider(a))?.id ?? null))
}

/** Agents that can run a session: those working in the folder it ran in, with its provider. */
export function agentsForSession(p: ProjectInfo, item: Pick<SessionListItem, 'cwd'> & { provider?: ProviderId }): ProjectInfo['agents'] {
  return p.agents.filter((a) => sessionInAgentFolder(p.path, a, item) && (!item.provider || agentProviderOf(p, a) === item.provider))
}

export async function resumeSession(path: string, item: Pick<SessionListItem, 'id' | 'recache' | 'title' | 'name' | 'agentId' | 'cwd'> & { provider?: ProviderId }, agentId?: string): Promise<void> {
  let p = project(path)
  let target = resumeTarget(p, item, agentId)
  // A session from the project folder that no agent can run (none runs its provider): add one that does.
  const inProjectFolder = !item.cwd || item.cwd.toLowerCase() === path.toLowerCase()
  if (!target && isAssistantPath(path)) {
    const who = item.provider ? providerName(item.provider) : 'another provider'
    notify('warning', "Can't resume this conversation", `It ran in ${who}, and the Assistant now runs ${providerName(agentProviderOf(p, p?.agents[0]))}. Switch its provider in Assistant Settings to resume it.`)
    return
  }
  if (!target && inProjectFolder && item.provider && (p?.agents.length ?? 0) < MAX_AGENTS) {
    target = await quickAddAgent(path, item.provider)
    if (!target) return
    p = project(path)
  }
  if (!target) {
    const inWorktree = item.cwd && p && item.cwd.toLowerCase() !== p.path.toLowerCase()
    const who = item.provider ? providerName(item.provider) : 'its provider'
    notify(
      'warning',
      "Can't resume this session",
      inWorktree
        ? `It ran in a worktree no ${who} agent uses any more (${item.cwd}). Add a ${who} agent for that worktree (Add Agent → existing worktree) to resume it.`
        : `It ran in ${who}, and no agent in the project folder runs ${who}. Conversations can't move between providers: add a ${who} agent, or continue the work with a handover.`
    )
    return
  }
  if (!(await ensureAgent(path, target))) return
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
  // A project without agents gets one (the quick add), which resumes the latest session it can.
  const id = agentId ?? focusedAgentId(project(path)) ?? (await quickAddAgent(path))
  if (!id) return
  const p = project(path)
  const a = agentOf(p, id)
  // Hive works out the session in the main process (AgentInfo.resume), skipping any open in another agent.
  const list = a?.resume ? await attempt('Could not list sessions', () => call('session:list', path)) : []
  const last = a?.resume ? (list ?? []).find((s) => s.id === a.resume!.id) ?? { id: a.resume.id, name: a.resume.name, title: null, recache: null, agentId: id, cwd: a.worktree?.path, provider: agentProviderOf(p, a) } : null
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
  if (!id || !agentOf(p, id)?.live) return
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
  const running = p?.agents.filter((a) => a.live) ?? []
  if (!running.length) return
  // Always asks, naming each agent that will stop and what it's doing.
  const ok = await confirm({
    title: running.length === 1 ? 'Stop the agent?' : 'Stop all agents?',
    message: `These ${running.length === 1 ? 'agent stops' : `${running.length} agents stop`} in ${p!.name}:`,
    detail: `${running.map((a) => `• ${a.name} — ${a.live!.statusMessage ?? STATUS_TEXT[a.live!.status]}`).join('\n')}\n\nTheir conversations are kept and can be resumed later.`,
    confirmLabel: running.length === 1 ? 'Stop' : 'Stop all',
    danger: true
  })
  if (!ok) return
  await attempt('Could not stop sessions', () => call('session:stop', path))
}

export async function archiveCurrent(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  if (!id) return notify('info', 'Nothing to archive')
  const a = agentOf(p, id)
  const live = a?.live
  const list = await call('session:list', path)
  const target = live ? list.find((s) => s.id === live.sessionId) : list.find((s) => s.id === (a?.lastSessionId ?? a?.resume?.id) && !s.archived)
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
  const archived = await attempt('Could not archive session', () => call('session:archive', path, target.id, true).then(() => true))
  if (archived) await newSession(path, id)
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

/** Looks for the enabled providers' CLIs again and reports what it found. */
export async function refreshProviders(): Promise<void> {
  const all = await attempt('Could not check the providers', () => call('provider:refresh'))
  if (!all) return
  set({ providers: all })
  const enabled = Object.values(all).filter((i) => isProviderEnabled(get().settings, i.provider))
  if (!enabled.length) return notify('info', 'No providers are turned on', 'Turn on Claude Code or another provider in Settings → Providers.', [{ label: 'Open Settings', command: 'settings.providers' }])
  for (const info of enabled) {
    const name = providerName(info.provider)
    if (!info.found) notify('warning', `${name} not installed`, `Open Help → Agent Setup to install it.`, [{ label: 'Agent Setup', command: 'help.agentSetup' }])
    else if (info.updateAvailable) notify('info', `${name} ${info.latestVersion} is available`, `You have ${info.version}.`, [{ label: 'Update', command: 'help.agentSetup', args: [info.provider] }])
    else notify('success', `${name} is up to date`, `Version ${info.version}`)
  }
}

export async function importProjectMcp(path: string, names: string[]): Promise<void> {
  const imported = await attempt('Could not copy MCP servers', () => call('mcp:importFromProject', path, names))
  if (imported?.length) notify('success', `Copied ${imported.join(', ')} to the workspace`, 'Enable them in MCP Servers to use them in sessions.')
}

export { basename }
