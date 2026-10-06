import { basename } from './util'
import { call, errorMessage } from './api'
import { agentOf, agentProviderOf, choose, confirm, findProject, focusAfterRemoving, focusAgent, runOnce, isAssistantPath, setAssistantOpen, focusedAgentId, get, notify, prompt, revealAgent, set, setActivity, setProjectTab, showAgent, showView } from './store'
import { MANY_AGENTS, MAX_AGENTS, chosenLayout, moveAgentTo, sessionInAgentFolder, swapAgentsIn } from '@shared/defaults'
import { isProviderEnabled, projectDefaultProvider, providerName } from '@shared/providers'
import { agentsToResume, resumeAll, stalledOnSignIn } from '@shared/resumeAll'
import { batchLine, eachAgent, removeLine, sessionsToArchive, type BatchResult } from '@shared/startAll'
import type { OldWorktreeOutcome, ProjectInfo, ProjectProviderConfig, ProviderId, SessionLayout, SessionListItem } from '@shared/types'
import { TEMPLATE_NAME_MAX, type TemplateEntry, type TemplateScope } from '@shared/templates'
import { oldWorktreesNotice, templateLoadDetail } from '@shared/templateLoad'
import { formatTokens, type SessionAction } from './util'
import { statusText } from './components/ui'
import { clearEditorDraft, clearEditorDraftsUnder } from './editorDrafts'

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
  // Edited while it was saving: those edits are unsaved again.
  if (unsavedFiles().length) {
    notify('warning', 'Some files changed while they were being saved', `Save them, then ${action} again.`)
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

/** This window's view of the recent workspaces, asked for again (whether each folder is there now; #144). */
export async function loadRecent(): Promise<void> {
  const recent = await call('workspace:recent').catch(() => null)
  if (recent) set({ recent })
}

/** Forgets a recent workspace (the folder is left alone); every window's list follows. */
export async function removeRecent(path: string): Promise<void> {
  const recent = await attempt('Could not remove it from the recent list', () => call('workspace:removeRecent', path))
  if (recent) set({ recent })
}

/** Clears the recent workspaces, after asking; the ones open in a window stay. */
export async function clearRecent(): Promise<void> {
  const ok = await confirm({ title: 'Clear recently opened workspaces?', message: 'File → Open Recent and the welcome page forget them. The folders are left alone, and workspaces open in a window stay in the list.', confirmLabel: 'Clear' })
  if (!ok) return
  const recent = await attempt('Could not clear the recent list', () => call('workspace:clearRecent'))
  if (recent) set({ recent })
}

/**
 * Opens a recent workspace: one open in another window brings that window forward (workspace:open); one whose folder
 * can't be found (checked again now) says so and offers to forget it, rather than an error (#144).
 */
export async function openRecent(path: string): Promise<void> {
  await loadRecent()
  const entry = get().recent.find((r) => r.path.toLowerCase() === path.toLowerCase())
  if (entry && !entry.exists) {
    const remove = await confirm({ title: "Workspace folder not found", message: `${path} can't be found. It may have been moved or deleted, or be on a drive that isn't connected.`, confirmLabel: 'Remove from Recent', cancelLabel: 'Keep' })
    if (remove) await removeRecent(path)
    return
  }
  await openWorkspace(path)
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
        danger: true,
        action: 'stop'
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
  if (!get().providers[provider]?.found) {
    set({ setupOpen: provider })
    return false
  }
  return ensureWorktree(path, agentId)
}

/**
 * A worktree agent whose folder is gone (#146): its branch lives in the repository, so the worktree can be made again
 * on it before the agent starts (or, with the branch gone too, made new from its base, or the link removed).
 */
async function ensureWorktree(path: string, agentId: string): Promise<boolean> {
  if (!agentOf(project(path), agentId)?.worktree) return true
  const gone = await call('agents:missingWorktree', path, agentId).catch(() => null)
  if (!gone) return true
  const setup = "Hive copies in the files it copies into new worktrees, and the project's worktree setup command, if it has one, runs before the agent starts. Nothing is deleted."
  if (gone.branchExists) {
    return confirm({
      title: 'Recreate the worktree?',
      message: `${gone.agentName}'s worktree folder is missing: ${gone.path}. Its branch ${gone.branch} is still in the repository: recreate the worktree on it, with its commits, and start?`,
      detail: setup,
      confirmLabel: 'Recreate and Start',
      action: 'start',
      busyLabel: 'Recreating…',
      run: () => call('agents:recreateWorktree', path, agentId)
    })
  }
  const choice = await choose({
    title: 'The worktree is gone',
    message: `${gone.agentName}'s worktree folder is missing (${gone.path}), and its branch ${gone.branch} is gone too. Create a new worktree on ${gone.branch} from ${gone.base}, or remove the agent's worktree link so it works in the project folder?`,
    detail: `${setup} If the workspace moved, Repair… in its banner can also locate the folder.`,
    choices: [
      { label: 'Remove the Worktree Link', value: 'unlink' },
      { label: 'Create a New Worktree', value: 'create' }
    ]
  })
  if (choice === 'unlink') {
    await attempt('Could not remove the worktree link', () => call('agents:unlinkWorktree', path, agentId))
    return false
  }
  if (choice !== 'create') return false
  return !!(await attempt('Could not create the worktree', () => call('agents:recreateWorktree', path, agentId)))
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
  noteManyAgents(path)
  const now = project(path)
  if (now) showAgent(now, def.id)
  return def.id
}

/** After adding an agent: the seventh brings a note that each agent is its own CLI process. */
export function noteManyAgents(path: string): void {
  const n = project(path)?.agents.length ?? 0
  if (n === MANY_AGENTS) notify('info', `${n} agents in this project`, "Each agent runs its own copy of its CLI (roughly 150–400 MB of memory each), and they all share your plan's usage limits.")
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

async function stopIfRunning(path: string, agentId: string, action: string, then: SessionAction): Promise<boolean> {
  const p = project(path)
  // Main's word, not the window's copy: just after a session stops, main saves its record before it tells the window,
  // so the copy can still show it running (Restart session then asked to stop a session already stopped, #218).
  const running = (await call('session:live')).some((l) => l.projectPath.toLowerCase() === path.toLowerCase() && l.agentId === agentId)
  if (!running) return true
  const ok = await confirm({
    title: `${action}?`,
    message: `${p!.name}${agentSuffix(p, agentId)} already has a running session.`,
    detail: 'It will be stopped first. Its conversation is kept and can be resumed from the Sessions tab.',
    confirmLabel: `Stop and ${action.toLowerCase()}`,
    // In the colour of what it goes on to do (#344).
    action: then
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
  if (!(await stopIfRunning(path, id, 'Start a new session', 'start'))) return
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
    const what = isAssistantPath(path) ? 'conversation' : 'session'
    const choice = await choose({
      title: `Resume ${what}?`,
      message: `The prompt cache for this ${what} has expired. Resuming will re-cache about ${formatTokens(item.recache.tokens)} tokens on the first message.`,
      detail: `To save tokens, archive it and start a fresh ${what} instead. The archived one stays readable${isAssistantPath(path) ? '' : ', and a handover note can carry the work on'}.`,
      choices: [
        { label: 'Archive and Start Fresh', value: 'fresh', action: 'archive-start' },
        { label: 'Resume', value: 'resume', action: 'resume' }
      ]
    })
    if (!choice) return
    if (choice === 'fresh') {
      const archived = await attempt(`Could not archive ${what}`, () => call('session:archive', path, item.id, true).then(() => true))
      if (archived) await newSession(path, target)
      return
    }
  }
  if (!(await stopIfRunning(path, target, 'Resume this session', 'resume'))) return
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
      danger: true,
      action: 'stop'
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
  // The question stays open, with a spinner, until they have stopped.
  await confirm({
    title: running.length === 1 ? 'Stop the agent?' : 'Stop all agents?',
    message: `These ${running.length === 1 ? 'agent stops' : `${running.length} agents stop`} in ${p!.name}:`,
    detail: `${running.map((a) => `• ${a.name} — ${statusText(a.live!)}`).join('\n')}\n\nTheir conversations are kept and can be resumed later.`,
    confirmLabel: running.length === 1 ? 'Stop' : 'Stop all',
    busyLabel: 'Stopping…',
    danger: true,
    action: 'stop',
    run: async () => {
      await call('session:stop', path)
      await Promise.all(running.map((a) => waitForStop(path, a.id)))
    }
  })
}

/**
 * Resumes every stopped agent that has a conversation to resume, one after another; running agents are
 * left alone, except those a refused sign-in stopped, which are told to carry on (#309). Asks first only when some
 * caches have expired; one failure doesn't stop the rest, and the failures are reported together with their reasons.
 */
export function resumeAllAgents(path: string): Promise<void> {
  // A second click while it runs is ignored; the button shows a spinner.
  return runOnce(`resumeAll:${path}`, () => resumeAll_(path)).then(() => undefined)
}

async function resumeAll_(path: string): Promise<void> {
  const p = project(path)
  if (!p) return
  const stopped = agentsToResume(p.agents)
  if (!stopped.length) return notify('info', 'Nothing to resume', 'No stopped agent has a session to resume.')
  const list = (await attempt('Could not list sessions', () => call('session:list', path))) ?? []
  const cold = stopped.flatMap((a) => {
    if (a.live) return []
    const r = list.find((s) => s.id === a.resume!.id)?.recache
    return r && !r.warm && r.tokens > 20000 ? [`• ${a.name} — about ${formatTokens(r.tokens)} tokens`] : []
  })
  if (cold.length) {
    const ok = await confirm({
      title: stopped.length === 1 ? 'Resume the agent?' : 'Resume all agents?',
      message: `The prompt cache has expired for ${cold.length === stopped.length && cold.length > 1 ? 'all of them' : cold.length === 1 ? 'one agent' : `${cold.length} agents`}. Resuming re-caches on the first message:`,
      detail: cold.join('\n'),
      confirmLabel: stopped.length === 1 ? 'Resume' : 'Resume all',
      action: 'resume'
    })
    if (!ok) return
  }
  // The agents as they are now: one may have started while the dialog was open.
  const result = await resumeAll(project(path)?.agents ?? [], async (a) => {
    // Running, stopped mid-turn by a refused sign-in: a short "carry on" (its CLI resumes nothing itself).
    if (stalledOnSignIn(a.live)) return void (await call('session:carryOn', path, a.id))
    const provider = agentProviderOf(project(path), a)
    const name = providerName(provider)
    if (!isProviderEnabled(get().settings, provider)) throw new Error(`${name} is turned off in Settings → Providers.`)
    if (!get().providers[provider]?.found) throw new Error(`${name} isn't installed (Agent Setup).`)
    try {
      await call('session:start', path, { resumeId: a.resume!.id, name: a.resume!.name, agentId: a.id })
    } catch (e) {
      throw new Error(errorMessage(e), { cause: e })
    }
  })
  if (result.failed.length) {
    const tried = result.failed.length + result.resumed.length
    notify(
      'error',
      result.failed.length === tried ? (tried === 1 ? 'Could not resume the agent' : 'Could not resume the agents') : `${result.failed.length} of ${tried} agents could not resume`,
      [...result.failed.map((f) => `• ${f.name}: ${f.error}`), ...(result.resumed.length ? [`Resumed: ${result.resumed.join(', ')}`] : [])].join('\n')
    )
  }
}

/**
 * Start New (All) (#216): after one confirmation listing every agent (busy ones flagged), running agents are stopped and
 * every agent starts a fresh session; old conversations stay resumable from the Sessions tab. With `archive` (Archive
 * and Start New (All)): each agent's current or last session is archived first, as Archive Session and Start New… does,
 * and only agents with one are listed. One at a time; failures are reported together. A second click while it runs is
 * ignored (the button shows a spinner).
 */
export function startNewAll(path: string, archive = false): Promise<void> {
  return runOnce(`${archive ? 'archiveAll' : 'startNewAll'}:${path}`, () => startNewAll_(path, archive)).then(() => undefined)
}

async function startNewAll_(path: string, archive: boolean): Promise<void> {
  const p = project(path)
  if (!p?.agents.length) return notify('info', 'No agents', 'Add an agent first.')
  const list = archive ? await attempt('Could not list sessions', () => call('session:list', path)) : []
  if (!list) return
  const archives = archive ? sessionsToArchive(p.agents, list) : []
  if (archive && !archives.length) return notify('info', 'Nothing to archive', 'No agent has a session to archive.')
  const agents = archive ? archives.map((x) => x.agent) : p.agents
  const running = agents.filter((a) => a.live)
  const one = agents.length === 1
  const ok = await confirm({
    title: archive ? (one ? 'Archive and start new?' : 'Archive and start new for all agents?') : one ? 'Start a new session?' : 'Start new sessions for all agents?',
    message: archive
      ? `${one ? `${agents[0].name}'s session is` : `The sessions of these ${agents.length} agents are`} archived in ${p.name}, and each starts a fresh one:`
      : `${one ? 'This agent starts' : `Every agent in ${p.name} starts`} a fresh session:`,
    detail: [
      agents.map((a) => batchLine(a, statusText)).join('\n'),
      '',
      `${running.length ? `Running agents are stopped first. ` : ''}${archive ? "The transcripts are kept in the project's .hive/archive folder." : 'Their conversations are kept and can be resumed from the Sessions tab.'}`
    ].join('\n'),
    confirmLabel: archive ? 'Archive and start new' : 'Start new',
    action: archive ? 'archive-start' : 'start'
  })
  if (!ok) return
  // As they are now: one may have stopped or started while the dialog was open.
  const now = (id: string) => agentOf(project(path), id)
  for (const a of agents) if (now(a.id)?.live) await call('session:stop', path, a.id).catch(() => undefined)
  await Promise.all(agents.map((a) => waitForStop(path, a.id)))
  const result = await eachAgent(agents, async (a) => {
    const provider = agentProviderOf(project(path), a)
    const name = providerName(provider)
    if (!isProviderEnabled(get().settings, provider)) throw new Error(`${name} is turned off in Settings → Providers.`)
    if (!get().providers[provider]?.found) throw new Error(`${name} isn't installed (Agent Setup).`)
    try {
      const target = archives.find((x) => x.agent.id === a.id)
      if (target) await call('session:archive', path, target.sessionId, true)
      await call('session:start', path, { agentId: a.id })
    } catch (e) {
      throw new Error(errorMessage(e), { cause: e })
    }
  })
  if (result.failed.length) {
    const tried = result.failed.length + result.done.length
    notify(
      'error',
      result.failed.length === tried ? (tried === 1 ? 'Could not start the agent' : 'Could not start the agents') : `${result.failed.length} of ${tried} agents could not start`,
      [...result.failed.map((f) => `• ${f.name}: ${f.error}`), ...(result.done.length ? [`Started: ${result.done.join(', ')}`] : [])].join('\n')
    )
  }
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
    confirmLabel: 'Archive and start new',
    action: 'archive-start'
  })
  if (!ok) return
  if (live) {
    await call('session:stop', path, id)
    await waitForStop(path, id)
  }
  const archived = await attempt('Could not archive session', () => call('session:archive', path, target.id, true).then(() => true))
  if (archived) await newSession(path, id)
}

/** Deletes a workspace MCP server after asking; true when it was deleted. */
export async function deleteMcpServer(name: string): Promise<boolean> {
  const ok = await confirm({
    title: 'Delete MCP server?',
    message: `Move ${name}.json to the Recycle Bin? Projects will no longer be able to use it.`,
    confirmLabel: 'Delete',
    busyLabel: 'Deleting…',
    danger: true,
    run: () => call('mcp:delete', name)
  })
  if (!ok) return false
  clearEditorDraft(`mcp:${name}`)
  set((s) => ({ skillsVersion: s.skillsVersion + 1, ...(s.selectedMcp === name ? { selectedMcp: null } : {}) }))
  return true
}

/** Deletes a shared note or folder after asking. */
export async function deleteNote(path: string, label: string, isDir: boolean): Promise<void> {
  const ok = await confirm({
    title: 'Delete?',
    message: `Move "${label}"${isDir ? ' and everything in it' : ''} to the Recycle Bin?`,
    confirmLabel: 'Delete',
    busyLabel: 'Deleting…',
    danger: true,
    run: () => call('notes:delete', path)
  })
  if (!ok) return
  // Unsaved edits of it would otherwise bring it back (Save All, or saving before quitting).
  clearEditorDraftsUnder(path)
  const gone = (p: string | null): boolean => !!p && (p === path || p.toLowerCase().startsWith(`${path.toLowerCase()}\\`))
  set((s) => ({ notesVersion: s.notesVersion + 1, ...(gone(s.selectedNote) ? { selectedNote: null } : {}) }))
}

/**
 * The agent's open cards: asks whether to take them back (nobody has them; Doing ones go to Todo) or leave them
 * (they show the agent as removed, and Doing ones as stalled). Null: cancelled, keep the agent.
 */
function cardsOfRemovedAgent(p: ProjectInfo, agentId: string, name: string): Promise<boolean | null> {
  return cardsOfRemovedAgents(p, [{ id: agentId, name }])
}

/** The same, asked once for several agents' cards together (Remove All, #291). */
async function cardsOfRemovedAgents(p: ProjectInfo, agents: readonly { id: string; name: string }[]): Promise<boolean | null> {
  const ids = new Set(agents.map((a) => a.id))
  const open = get().tasks.filter((c) => !c.archived && c.column !== 'done' && !!c.agent && ids.has(c.agent) && c.project.toLowerCase() === p.name.toLowerCase())
  if (!open.length) return false
  const them = open.length === 1 ? 'it' : 'them'
  const list = open.slice(0, 5).map((c) => `#${c.number} ${c.title}`).join(', ') + (open.length > 5 ? ` and ${open.length - 5} more` : '')
  const one = agents.length === 1
  const name = one ? agents[0].name : 'its agent'
  const choice = await choose({
    title: `${one ? `${name} has` : `The ${agents.length} agents have`} ${open.length} open card${open.length === 1 ? '' : 's'}`,
    message: list,
    detail:
      open.length === 1
        ? `Move it back: nobody has it, and if it is in Doing it goes to Todo, ready to start on another agent. Leave it: it keeps showing ${name} (removed), and in Doing shows as stalled.`
        : `Move them back: nobody has them, and those in Doing go to Todo, ready to start on another agent. Leave them: they keep showing ${one ? name : 'their agent'} (removed), and those in Doing show as stalled.`,
    choices: [
      { label: `Leave ${them}`, value: 'leave' },
      { label: `Move ${them} back`, value: 'release' }
    ]
  })
  return choice === null ? null : choice === 'release'
}

/** Removes an agent; for a worktree agent, asks whether to keep its worktree and branch. */
/**
 * Moves an agent to `index` in the project's order (its position afterwards): the strip, its pages and the panes
 * follow. Shown at once, then saved; the agent keeps focus, so the view goes to its page.
 */
export async function moveAgent(path: string, agentId: string, index: number): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || !agentOf(p, agentId)) return
  const agents = moveAgentTo(p.agents, agentId, index)
  if (agents.every((a, i) => a.id === p.agents[i].id)) return
  // The panes follow the order (#134): what's on screen changes with it.
  set((s) => ({ workspace: s.workspace && { ...s.workspace, projects: s.workspace.projects.map((x) => (x.path === path ? { ...x, agents } : x)) } }))
  focusAgent(path, agentId)
  const saved = await attempt('Could not move the agent', () => call('agents:move', path, agentId, index))
  // Puts the tabs back as saved; the move's own error was already shown, and the next refresh catches up anyway.
  if (!saved) await call('workspace:refresh').then((ws) => set({ workspace: ws })).catch(() => undefined)
}

/**
 * Swaps two agents' places (#135: one dropped on another's pane), across pages too: the panes follow the order, so they
 * swap on screen at once, then it is saved. The dragged agent keeps focus, so the view stays on the page it was dropped
 * on. Running or not, their sessions and terminals are untouched.
 */
export async function swapAgents(path: string, agentId: string, otherId: string): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || agentId === otherId || !agentOf(p, agentId) || !agentOf(p, otherId)) return
  const agents = swapAgentsIn(p.agents, agentId, otherId)
  set((s) => ({ workspace: s.workspace && { ...s.workspace, projects: s.workspace.projects.map((x) => (x.path === path ? { ...x, agents } : x)) } }))
  focusAgent(path, agentId)
  const saved = await attempt('Could not move the agent', () => call('agents:swap', path, agentId, otherId))
  if (!saved) await call('workspace:refresh').then((ws) => set({ workspace: ws })).catch(() => undefined)
}

/** Moves the focused agent (or `agentId`) one place left or right, across pages at their edges. */
export function nudgeAgent(delta: -1 | 1, path: string | null = get().selectedProject, agentId?: string): void {
  const p = path ? project(path) : undefined
  const id = agentId ?? (p ? focusedAgentId(p) : null)
  if (!p || !id || p.agents.length < 2) return
  const i = p.agents.findIndex((a) => a.id === id)
  if (i < 0 || i + delta < 0 || i + delta >= p.agents.length) return
  void moveAgent(p.path, id, i + delta)
}

// ---------------------------------------------------------------------------
// Agent templates (#126)
// ---------------------------------------------------------------------------

const SCOPE_WORD: Record<TemplateScope, string> = { workspace: 'the workspace', project: 'this project' }

/**
 * Save Template…: the project's agents and layout under a name, in the project (private) or, ticked, the workspace (for
 * every project). A name already there asks before it is replaced.
 */
export async function saveTemplate(path: string): Promise<void> {
  const p = project(path)
  if (!p?.agents.length) return notify('info', 'No agents to save', 'Add the agents first, then save them as a template.')
  let workspaceScope = false
  const name = await prompt({
    title: 'Save as template',
    message: `${p.agents.length === 1 ? 'Its agent' : `Its ${p.agents.length} agents`} (settings and roles) and the layout, to load into any project later. Sessions and worktrees aren't saved.`,
    placeholder: 'Template name',
    confirmLabel: 'Save',
    validate: (v) => (!v.trim() ? 'Enter a name.' : v.trim().length > TEMPLATE_NAME_MAX ? `At most ${TEMPLATE_NAME_MAX} characters.` : null),
    check: { label: 'For every project in the workspace (else for this project only)', initial: false, set: (v) => (workspaceScope = v) }
  })
  if (name === null) return
  const scope: TemplateScope = workspaceScope ? 'workspace' : 'project'
  let r = await attempt('Could not save the template', () => call('templates:save', path, scope, name, false))
  if (r && 'exists' in r) {
    const ok = await confirm({ title: 'Replace the template?', message: `${SCOPE_WORD[scope].replace(/^t/, 'T')} already has a template called "${name.trim()}".`, detail: 'Saving replaces it with these agents and this layout.', confirmLabel: 'Replace' })
    if (!ok) return
    r = await attempt('Could not save the template', () => call('templates:save', path, scope, name, true))
  }
  if (r && 'saved' in r) set((s) => ({ templatesVersion: s.templatesVersion + 1 }))
  if (r && 'saved' in r) notify('success', 'Template saved', `"${r.saved.name}" (${r.saved.agents.length} ${r.saved.agents.length === 1 ? 'agent' : 'agents'}), for ${SCOPE_WORD[scope]}.`)
}

/**
 * Loads a template into a project: it replaces every agent, so it says first who goes and who comes. Refused, saying
 * why, while an agent runs, a worktree has uncommitted work or a provider it needs is off or not installed (with a way
 * into Agent Setup or Settings). `from`: the project a project's template is kept in, when it isn't this one (the Templates
 * view loads any template into any project).
 */
export async function loadTemplate(path: string, entry: Pick<TemplateEntry, 'scope' | 'file' | 'name'>, from?: string): Promise<void> {
  const plan = await attempt('Could not read the template', () => call('templates:plan', path, entry.scope, entry.file, from))
  if (!plan) return
  if (plan.blocked.length) {
    const fix = plan.missing.find((m) => /isn't installed/.test(m.reason))?.provider ?? null
    const off = plan.missing.some((m) => /turned off/.test(m.reason))
    const choice = await choose({
      title: `Can't load "${plan.name}" yet`,
      message: 'It would replace every agent of this project, which isn’t safe or possible yet:',
      detail: plan.blocked.map((b) => `• ${b}`).join('\n'),
      choices: [...(fix ? [{ label: 'Open Agent Setup', value: 'setup' }] : []), { label: 'OK', value: 'ok' }]
    })
    if (choice === 'setup' && fix) set({ setupOpen: fix })
    else if (off) notify('warning', 'A provider it needs is turned off', 'Turn it on in Settings → Providers, then load the template again.', [{ label: 'Open Settings', command: 'settings.providers' }])
    return
  }
  const p = project(path)
  const expected = (p?.agents ?? []).map((a) => a.id)
  const removable = plan.oldWorktrees.filter((w) => w.removable)
  let removeOld = false
  let result: { oldWorktrees: OldWorktreeOutcome[] } | undefined
  const ok = await confirm({
    title: `Load "${plan.name}"?`,
    message: plan.remove.length ? `It replaces every agent of ${p?.name ?? 'this project'}.` : `It adds its agents to ${p?.name ?? 'this project'}.`,
    // Who goes and who comes: each new agent's settings, and its new worktree's branch and folder in this project (#268).
    detail: p ? templateLoadDetail(plan, p.config, get().settings, (id) => get().providers[id]) : undefined,
    scrollDetail: true,
    confirmLabel: 'Load template',
    busyLabel: 'Loading…',
    danger: plan.remove.length > 0,
    // The removed agents' worktrees that are merged and clean can go with the load, if ticked (off by default, #289).
    check: removable.length ? { label: removeOldLabel(removable.map((w) => w.branch), plan.mergedInto), initial: false, set: (v) => (removeOld = v) } : undefined,
    run: async () => {
      result = await call('templates:load', path, entry.scope, entry.file, expected, from, removeOld ? { paths: removable.map((w) => w.path), mergedInto: plan.mergedInto } : undefined)
    }
  })
  if (!ok) return
  await refreshWorkspace()
  const said = oldWorktreesNotice(result?.oldWorktrees ?? [])
  if (said) notify(said.level, said.title, said.detail)
}

/** The tick box for removing the old worktrees that are merged and clean (#289). */
function removeOldLabel(branches: string[], into: string | null): string {
  return `Also remove ${branches.length === 1 ? 'the old worktree' : `${branches.length} old worktrees`} and ${branches.length === 1 ? 'its branch' : 'their branches'} (merged into ${into ?? 'the main branch'} and clean): ${branches.join(', ')}`
}

/** Adds one agent of a template, the project's others left alone (a name already taken gets a number). */
export async function addAgentFromTemplate(path: string, entry: Pick<TemplateEntry, 'scope' | 'file'>, index: number): Promise<void> {
  const def = await attempt('Could not add the agent', () => call('templates:addAgent', path, entry.scope, entry.file, index))
  if (!def) return
  // A clean worktree Hive made for that name, which no agent used, is worked in again rather than a new "-2" (#289).
  if (def.reused && def.worktree) notify('info', `${def.name} works in its worktree again`, `${def.worktree.branch} in ${def.worktree.path}: it was clean, and its branch is left as it is.`)
  await refreshWorkspace()
  const p = project(path)
  if (p) showAgent(p, def.id)
}

export async function removeAgent(path: string, agentId: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, agentId)
  if (!p || !a) return
  if (a.live && !(await stopIfRunning(path, agentId, `Remove ${a.name}`, 'remove'))) return
  let deleteWorktree = false
  if (a.worktree) {
    const keep = await confirm({
      title: `Remove ${a.name}?`,
      message: `${a.name} works in its own worktree on branch ${a.worktree.branch}.`,
      detail: `Keep the worktree and branch to merge or reuse them later (Add Agent → Existing worktree), or delete both. Its sessions stay in the Sessions tab either way.`,
      confirmLabel: 'Keep worktree and branch',
      cancelLabel: 'Delete them…',
      action: 'remove'
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
  } else if (!(await confirm({ title: `Remove ${a.name}?`, message: `${a.name} is removed from ${p.name}. Its sessions stay in the Sessions tab.`, confirmLabel: 'Remove', action: 'remove' }))) return
  const releaseCards = await cardsOfRemovedAgent(p, agentId, a.name)
  if (releaseCards === null) return
  // Its tab shows a spinner while it goes (deleting a worktree takes a moment); a second Remove is ignored.
  const ok = await runOnce(`removeAgent:${path}#${agentId}`, () => attempt('Could not remove agent', () => call('agents:remove', path, agentId, { deleteWorktree, releaseCards }).then(() => true)))
  if (!ok) return
  focusAfterRemoving(p, agentId)
  await refreshWorkspace()
}

/**
 * Remove All (#291): every agent of the project after one question (danger style) listing them, running ones flagged
 * and worktrees marked; running agents are stopped first. Worktrees and branches are kept, unless the box is ticked:
 * then only those merged into the repository's main branch (the one named in the question) with no uncommitted changes
 * are deleted, main checking again and guarding the deletion (`removeCheckedWorktree`); unmerged or changed work is
 * never deleted. Their cards are asked about once. One agent at a time, each
 * tab showing the spinner until it has gone; failures and kept worktrees are reported together. Sessions stay.
 */
export function removeAllAgents(path: string): Promise<void> {
  return runOnce(`removeAll:${path}`, () => removeAllAgents_(path)).then(() => undefined)
}

async function removeAllAgents_(path: string): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || !p.agents.length) return
  const checks = p.agents.some((a) => a.worktree) ? await attempt('Could not check the worktrees', () => call('agents:worktreeChecks', path)) : []
  if (!checks) return
  const checkOf = (id: string) => checks.find((c) => c.agentId === id)
  const agents = p.agents
  const one = agents.length === 1
  const trees = agents.filter((a) => a.worktree)
  const removable = trees.filter((a) => checkOf(a.id)?.removable)
  const into = checks.find((c) => c.into)?.into
  let deleteMerged = false
  const ok = await confirm({
    title: one ? `Remove ${agents[0].name}?` : `Remove all ${agents.length} agents?`,
    message: one ? `${agents[0].name} is removed from ${p.name}:` : `Every agent of ${p.name} is removed:`,
    detail: [
      agents.map((a) => removeLine(a, statusText, a.worktree && { branch: a.worktree.branch, check: checkOf(a.id) })).join('\n'),
      '',
      [
        agents.some((a) => a.live) ? 'Running agents are stopped first.' : '',
        'Their sessions stay in the Sessions tab.',
        trees.length ? (removable.length ? 'Worktrees and branches are kept unless you tick the box; unmerged or changed ones are kept either way.' : 'Their worktrees and branches are kept.') : ''
      ]
        .filter(Boolean)
        .join(' ')
    ].join('\n'),
    check: removable.length
      ? { label: `Also delete the worktrees and branches fully merged into ${into} with no uncommitted changes: ${removable.map((a) => a.worktree!.branch).join(', ')}`, initial: false, set: (v) => (deleteMerged = v) }
      : undefined,
    confirmLabel: one ? 'Remove' : `Remove ${agents.length} agents`,
    danger: true,
    action: 'remove'
  })
  if (!ok) return
  const releaseCards = await cardsOfRemovedAgents(p, agents)
  if (releaseCards === null) return
  // Every tab shows the spinner until its agent has gone; a Remove on one meanwhile is ignored.
  const key = (id: string) => `removeAgent:${path}#${id}`
  const done = (ids: string[]) => set((s) => ({ running: Object.fromEntries(Object.entries(s.running).filter(([k]) => !ids.some((id) => k === key(id)))) }))
  set((s) => ({ running: { ...s.running, ...Object.fromEntries(agents.map((a) => [key(a.id), true])) } }))
  const deleted: string[] = []
  const kept: string[] = []
  let result: BatchResult
  try {
    for (const a of agents) if (agentOf(project(path), a.id)?.live) await call('session:stop', path, a.id).catch(() => undefined)
    await Promise.all(agents.map((a) => waitForStop(path, a.id)))
    result = await eachAgent(agents, async (a) => {
      try {
        const r = await call('agents:remove', path, a.id, { deleteWorktree: deleteMerged ? 'merged-clean' : false, mergedInto: into ?? null, releaseCards })
        const w = r.worktree
        if (w?.deleted && w.branchKept) kept.push(`branch ${w.branch} (${w.reason}; its worktree was deleted)`)
        else if (w?.deleted) deleted.push(w.branch)
        else if (deleteMerged && w) kept.push(`${w.branch} (${w.reason ?? 'not checked'})`)
      } catch (e) {
        throw new Error(errorMessage(e), { cause: e })
      } finally {
        done([a.id])
      }
    })
  } finally {
    done(agents.map((a) => a.id))
  }
  await refreshWorkspace()
  const trail = [deleted.length ? `Worktrees deleted: ${deleted.join(', ')}` : '', kept.length ? `Worktrees kept: ${kept.join(', ')}` : ''].filter(Boolean)
  if (result.failed.length) {
    const tried = result.failed.length + result.done.length
    notify(
      'error',
      result.failed.length === tried ? (tried === 1 ? 'Could not remove the agent' : 'Could not remove the agents') : `${result.failed.length} of ${tried} agents could not be removed`,
      [...result.failed.map((f) => `• ${f.name}: ${f.error}`), ...(result.done.length ? [`Removed: ${result.done.join(', ')}`] : []), ...trail].join('\n')
    )
  } else if (deleteMerged) notify('success', one ? `Removed ${agents[0].name}` : `Removed ${agents.length} agents`, trail.join('\n'))
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
  const releaseCards = await cardsOfRemovedAgent(p, agentId, a.name)
  if (releaseCards === null) return
  const done = await runOnce(`removeAgent:${path}#${agentId}`, async () => {
    if (a.live) {
      await call('session:stop', path, agentId)
      await waitForStop(path, agentId)
    }
    return attempt('Could not discard agent', () => call('agents:remove', path, agentId, { deleteWorktree: true, releaseCards }).then(() => true))
  })
  if (!done) return
  focusAfterRemoving(p, agentId)
  await refreshWorkspace()
}

/** Chooses the project's layout (#134: one for the project; the one that shows its agents makes it automatic again). */
export async function setLayout(path: string, layout: SessionLayout): Promise<void> {
  const p = project(path)
  if (!p) return
  await attempt('Could not change layout', () => call('project:updateConfig', path, { layout: chosenLayout(p.config, layout) }))
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
