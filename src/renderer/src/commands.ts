import { PROJECT_KEYBINDING_CATEGORIES, SESSION_LAYOUTS, resolveKeybinding } from '@shared/defaults'
import { PROVIDERS, providerDescriptor } from '@shared/providers'
import type { ProviderId, SessionLayout } from '@shared/types'
import { call } from './api'
import { checkForUpdates, openReleaseNotes } from './components/Updates'
import { openModeMenu } from './components/PermissionMode'
import * as actions from './actions'
import { focusedAgentId, get, notify, set, setActivity, setAssistantOpen, showView, setProjectTab, showAgent, toggleCompactSidebar, type ProjectTab } from './store'

export interface Command {
  id: string
  label: string
  category: string
  /** The default shortcut. Users change it in Settings → Keyboard Shortcuts (projects for Project and Session commands). */
  keybinding?: string
  run: (...args: any[]) => unknown
  when?: () => boolean
  /** Needs arguments (e.g. a path), so it can't have a shortcut or appear in the palette. */
  internal?: boolean
}

const hasWorkspace = (): boolean => !!get().workspace
const hasProject = (): boolean => !!get().selectedProject && hasWorkspace()
const selected = () => get().workspace?.projects.find((p) => p.path === get().selectedProject)
/** The focused agent of the selected project has a running session. */
const hasLive = (): boolean => {
  const p = selected()
  return !!p?.agents.find((a) => a.id === focusedAgentId(p))?.live
}

function cycleAgent(delta: number): void {
  const p = selected()
  if (!p || p.agents.length < 2) return
  const i = p.agents.findIndex((a) => a.id === focusedAgentId(p))
  showAgent(p, p.agents[(i + delta + p.agents.length) % p.agents.length].id)
  setProjectTab(p.path, 'session')
}

const tab = (t: ProjectTab) => () => {
  const p = get().selectedProject
  if (!p) return
  showView('projects')
  setProjectTab(p, t)
}

const TAB_ORDER: ProjectTab[] = ['session', 'overview', 'sessions', 'files', 'images', 'changes', 'memory', 'skills', 'mcp', 'settings']

function cycleTab(delta: number): void {
  const p = get().selectedProject
  if (!p) return
  const i = TAB_ORDER.indexOf(get().projectTabs[p] ?? 'session')
  showView('projects')
  setProjectTab(p, TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length])
}

/** Focus agent N (1-based) of the selected project and show it. */
function focusAgentN(n: number): void {
  const p = selected()
  const a = p?.agents[n - 1]
  if (!p || !a) return
  showAgent(p, a.id)
  setProjectTab(p.path, 'session')
}

function focusTerminal(): void {
  const p = selected()
  if (!p) return
  showView('projects')
  setProjectTab(p.path, 'session')
  setTimeout(() => {
    const host = document.querySelector<HTMLElement>(`.terminal-host.focused-agent textarea`) ?? document.querySelector<HTMLElement>('.terminal-host:not(.hidden) textarea')
    host?.focus()
  }, 50)
}

const layoutCommand = (value: SessionLayout, n: number): Command => ({
  id: `layout.${value}`,
  label: `Layout: ${SESSION_LAYOUTS.find((l) => l.value === value)?.label ?? value}`,
  category: 'Session',
  keybinding: `Mod+Alt+${n}`,
  when: hasProject,
  run: () => {
    const p = get().selectedProject
    if (p) void actions.setLayout(p, value)
  }
})

export const commands: Command[] = [
  { id: 'palette.show', label: 'Show All Commands', category: 'View', keybinding: 'Mod+Shift+P', run: () => set({ paletteOpen: true, paletteMode: 'commands' }) },
  { id: 'project.goto', label: 'Go to Project…', category: 'View', keybinding: 'Mod+P', when: hasWorkspace, run: () => set({ paletteOpen: true, paletteMode: 'projects' }) },
  { id: 'settings.open', label: 'Open Settings', category: 'Preferences', keybinding: 'Mod+,', run: () => setActivity('settings') },
  { id: 'settings.providers', label: 'Choose Coding Agents (Providers)', category: 'Preferences', run: () => { set({ settingsSection: 'providers', settingsQuery: '' }); setActivity('settings') } },
  { id: 'settings.keybindings', label: 'Customise Keyboard Shortcuts', category: 'Preferences', run: () => { set({ settingsSection: 'keybindings', settingsQuery: '' }); setActivity('settings') } },
  { id: 'window.new', label: 'New Window', category: 'File', keybinding: 'Mod+K Mod+N', run: () => call('window:new') },
  { id: 'workspace.open', label: 'Open Workspace…', category: 'File', keybinding: 'Mod+K Mod+O', run: (path?: string) => actions.openWorkspace(path) },
  { id: 'workspace.create', label: 'New Workspace…', category: 'File', run: () => actions.createWorkspace() },
  { id: 'workspace.close', label: 'Close Workspace', category: 'File', when: hasWorkspace, run: () => actions.closeWorkspace() },
  { id: 'workspace.refresh', label: 'Refresh Workspace', category: 'File', keybinding: 'F5', when: hasWorkspace, run: () => actions.refreshWorkspace() },
  { id: 'project.new', label: 'New Project…', category: 'Project', keybinding: 'Mod+Alt+N', when: hasWorkspace, run: () => actions.createProject() },
  { id: 'project.toggleActive', label: 'Toggle Project Active', category: 'Project', keybinding: 'Mod+Alt+A', when: hasProject, run: () => actions.toggleActiveSelected() },
  { id: 'project.next', label: 'Next Project', category: 'Project', keybinding: 'Mod+PageDown', when: hasWorkspace, run: () => actions.cycleProject(1) },
  { id: 'project.previous', label: 'Previous Project', category: 'Project', keybinding: 'Mod+PageUp', when: hasWorkspace, run: () => actions.cycleProject(-1) },
  { id: 'project.focus', label: 'Focus Project', category: 'Project', internal: true, run: (path: string) => path && actions.selectProject(path) },
  { id: 'project.openExplorer', label: 'Reveal Project in File Explorer', category: 'Project', when: hasProject, run: () => call('project:openInExplorer', get().selectedProject!) },
  { id: 'project.openTerminal', label: 'Open External Terminal Here', category: 'Project', keybinding: 'Mod+Shift+`', when: hasProject, run: () => call('project:openTerminal', get().selectedProject!) },
  { id: 'project.tab.session', label: 'Go to Session', category: 'Project', keybinding: 'Alt+1', when: hasProject, run: tab('session') },
  { id: 'project.tab.overview', label: 'Go to Overview', category: 'Project', keybinding: 'Alt+2', when: hasProject, run: tab('overview') },
  { id: 'project.tab.sessions', label: 'Go to Sessions History', category: 'Project', keybinding: 'Alt+3', when: hasProject, run: tab('sessions') },
  { id: 'project.tab.files', label: 'Go to Files', category: 'Project', keybinding: 'Alt+4', when: hasProject, run: tab('files') },
  { id: 'project.tab.images', label: 'Go to Images', category: 'Project', keybinding: 'Alt+5', when: hasProject, run: tab('images') },
  { id: 'project.tab.changes', label: 'Go to Changes', category: 'Project', keybinding: 'Alt+6', when: hasProject, run: tab('changes') },
  { id: 'project.tab.memory', label: 'Go to Memory', category: 'Project', keybinding: 'Alt+7', when: hasProject, run: tab('memory') },
  { id: 'project.tab.skills', label: 'Go to Project Skills', category: 'Project', keybinding: 'Alt+8', when: hasProject, run: tab('skills') },
  { id: 'project.tab.mcp', label: 'Go to Project MCP Servers', category: 'Project', keybinding: 'Alt+9', when: hasProject, run: tab('mcp') },
  { id: 'project.tab.settings', label: 'Go to Project Settings', category: 'Project', keybinding: 'Alt+0', when: hasProject, run: tab('settings') },
  { id: 'project.tab.next', label: 'Next Project Tab', category: 'Project', keybinding: 'Mod+Tab', when: hasProject, run: () => cycleTab(1) },
  { id: 'project.tab.previous', label: 'Previous Project Tab', category: 'Project', keybinding: 'Mod+Shift+Tab', when: hasProject, run: () => cycleTab(-1) },
  { id: 'session.new', label: 'New Session', category: 'Session', keybinding: 'Mod+Shift+N', when: hasProject, run: () => actions.newSession() },
  { id: 'session.resume', label: 'Resume Last Session', category: 'Session', keybinding: 'Mod+Shift+R', when: hasProject, run: () => actions.resumeLast() },
  { id: 'session.stop', label: 'Stop Session', category: 'Session', keybinding: 'Mod+Shift+X', when: hasLive, run: () => actions.stopSession() },
  {
    id: 'session.compact',
    label: 'Compact Conversation…',
    category: 'Session',
    keybinding: 'Mod+Alt+C',
    when: hasLive,
    run: (path?: string, agentId?: string) => {
      const p = path ?? get().selectedProject
      const id = agentId ?? focusedAgentId(get().workspace?.projects.find((x) => x.path === p))
      if (p && id) set({ compactFor: { project: p, agentId: id } })
    }
  },
  {
    id: 'session.permissionMode',
    label: 'Switch Permission Mode…',
    category: 'Session',
    keybinding: 'Mod+Alt+M',
    when: hasProject,
    run: () => {
      const p = selected()
      const id = focusedAgentId(p)
      if (p && id) openModeMenu(p.path, id, document.querySelector('.project-header .mode-badge'))
    }
  },
  {
    id: 'session.allowLockedEdit',
    label: 'Allow a Locked Edit',
    category: 'Session',
    // Only from the notification, which passes the agent and file.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown, path?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string' && typeof path === 'string')
        void actions.attempt('Could not allow the edit', () => call('session:allowLockedEdit', projectPath, agentId, path))
    }
  },
  {
    id: 'session.stopBackgroundAndResume',
    label: 'Stop a Background Session and Resume It',
    category: 'Session',
    // Only from the notification, which names the job and the conversation.
    internal: true,
    run: (projectPath?: unknown, agentId?: unknown, jobId?: unknown, sessionId?: unknown) => {
      if (typeof projectPath === 'string' && typeof agentId === 'string' && typeof jobId === 'string' && typeof sessionId === 'string')
        void actions.attempt('Could not stop the background session', () => call('session:stopBackgroundAndResume', projectPath, agentId, jobId, sessionId))
    }
  },
  {
    id: 'session.applyPermissionModes',
    label: 'Switch Running Agents to Their Permission Mode Settings',
    category: 'Session',
    run: async () => {
      const r = await actions.attempt('Could not switch permission modes', () => call('session:applyModes'))
      if (!r) return
      if (r.switched.length) notify('success', 'Permission mode switched', r.switched.join('\n'))
      if (r.skipped.length) notify('warning', r.switched.length ? 'Some agents were not switched' : 'Permission mode not switched', r.skipped.join('\n'))
      if (!r.switched.length && !r.skipped.length) notify('info', 'Nothing to switch', 'Every running agent is already in the mode its settings ask for.')
    }
  },
  { id: 'session.focusTerminal', label: 'Focus Session Terminal', category: 'Session', keybinding: 'Mod+`', when: hasProject, run: () => focusTerminal() },
  { id: 'agent.add', label: 'Add Agent', category: 'Session', keybinding: 'Mod+Alt+Shift+N', when: hasProject, run: (path?: string) => void actions.quickAddAgent(path ?? get().selectedProject) },
  { id: 'agent.addWith', label: 'Add Agent…', category: 'Session', when: hasProject, run: (path?: string) => set({ addAgentFor: path ?? get().selectedProject }) },
  {
    id: 'agent.next',
    label: 'Focus Next Agent',
    category: 'Session',
    keybinding: 'Mod+Alt+]',
    when: hasProject,
    run: () => cycleAgent(1)
  },
  { id: 'agent.previous', label: 'Focus Previous Agent', category: 'Session', keybinding: 'Mod+Alt+[', when: hasProject, run: () => cycleAgent(-1) },
  ...[1, 2, 3, 4].map((n): Command => ({ id: `agent.focus${n}`, label: `Focus Agent ${n}`, category: 'Session', keybinding: `Mod+${n}`, when: () => (selected()?.agents.length ?? 0) >= n, run: () => focusAgentN(n) })),
  layoutCommand('single', 1),
  layoutCommand('columns2', 2),
  layoutCommand('columns3', 3),
  layoutCommand('grid', 4),
  { id: 'session.archive', label: 'Archive Session and Start New', category: 'Session', when: hasProject, run: () => actions.archiveCurrent() },
  { id: 'view.projects', label: 'Show Projects', category: 'View', keybinding: 'Mod+Shift+E', run: () => setActivity('projects') },
  { id: 'view.notes', label: 'Show Shared Notes', category: 'View', keybinding: 'Mod+Shift+H', run: () => setActivity('notes') },
  { id: 'view.skills', label: 'Show Skills', category: 'View', keybinding: 'Mod+Shift+K', run: () => setActivity('skills') },
  { id: 'view.mcp', label: 'Show MCP Servers', category: 'View', keybinding: 'Mod+Shift+M', run: () => setActivity('mcp') },
  { id: 'view.personas', label: 'Show Assistant Personas', category: 'View', run: () => setActivity('personas') },
  { id: 'assistant.toggle', label: 'Toggle Hive Assistant', category: 'Assistant', keybinding: 'Mod+Alt+I', when: hasWorkspace, run: () => setAssistantOpen(!get().assistantOpen) },
  { id: 'assistant.settings', label: 'Assistant Settings…', category: 'Assistant', when: hasWorkspace, run: () => set({ assistantSettingsOpen: true }) },
  {
    id: 'assistant.start',
    label: 'Start the Hive Assistant',
    category: 'Assistant',
    when: () => !!get().workspace?.assistant && !get().workspace?.assistant?.agents[0]?.live,
    run: () => {
      setAssistantOpen(true)
      const a = get().workspace?.assistant
      if (a) void actions.newSession(a.path, a.agents[0]?.id)
    }
  },
  { id: 'view.toggleSidebar', label: 'Toggle Sidebar', category: 'View', keybinding: 'Mod+B', run: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })) },
  { id: 'view.compactSidebar', label: 'Toggle Compact Sidebar', category: 'View', keybinding: 'Mod+Alt+B', run: () => toggleCompactSidebar() },
  { id: 'view.notifications', label: 'Show Notifications', category: 'View', keybinding: 'Mod+Alt+U', run: () => set({ showNotifications: true, unread: 0 }) },
  { id: 'view.zoomIn', label: 'Zoom In', category: 'View', keybinding: 'Mod+=', run: () => call('window:zoom', 'in') },
  { id: 'view.zoomOut', label: 'Zoom Out', category: 'View', keybinding: 'Mod+-', run: () => call('window:zoom', 'out') },
  { id: 'view.zoomReset', label: 'Reset Zoom', category: 'View', keybinding: 'Mod+0', run: () => call('window:zoom', 'reset') },
  { id: 'view.fullScreen', label: 'Toggle Full Screen', category: 'View', keybinding: 'F11', run: () => call('window:toggleFullScreen') },
  { id: 'view.devTools', label: 'Toggle Developer Tools', category: 'Developer', keybinding: 'Mod+Shift+I', run: () => call('window:toggleDevTools') },
  { id: 'view.reload', label: 'Reload Window', category: 'Developer', run: () => void actions.saveUnsavedFirst('reload the window').then((ok) => ok && location.reload()) },
  { id: 'notes.open', label: 'Open Shared Note', category: 'Notes', internal: true, run: (path: string) => { showView('notes'); set({ selectedNote: path }) } },
  { id: 'mcp.import', label: 'Copy Project MCP Servers to Workspace', category: 'MCP', internal: true, run: (path: string, names: string[]) => actions.importProjectMcp(path, names) },
  { id: 'help.agentSetup', label: 'Agent Setup…', category: 'Help', run: (provider?: unknown) => set({ setupOpen: typeof provider === 'string' ? provider : true }) },
  { id: 'help.checkProviders', label: 'Check Coding Agents for Updates', category: 'Help', run: () => actions.refreshProviders() },
  { id: 'help.docs', label: 'Documentation', category: 'Help', keybinding: 'F1', run: () => { set({ docsPage: 'guide' }); setActivity('docs') } },
  { id: 'help.api', label: 'Agent API Reference', category: 'Help', run: () => { set({ docsPage: 'api' }); setActivity('docs') } },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', category: 'Help', keybinding: 'Mod+K Mod+S', run: () => set({ shortcutsOpen: true }) },
  { id: 'help.releaseNotes', label: 'Release Notes', category: 'Help', run: () => { set({ docsPage: 'changelog' }); setActivity('docs') } },
  { id: 'help.logs', label: 'Open Logs Folder', category: 'Help', run: () => call('app:openLogs') },
  { id: 'help.about', label: 'About Hive', category: 'Help', run: () => set({ aboutOpen: true }) },
  { id: 'help.checkUpdates', label: 'Check for Updates…', category: 'Help', run: () => checkForUpdates() },
  { id: 'update.show', label: 'Show Hive Update', category: 'Help', when: () => ['available', 'downloading', 'ready'].includes(get().update?.status ?? ''), run: () => set({ updateOpen: true }) },
  { id: 'update.install', label: 'Restart and Update Hive', category: 'Help', when: () => get().update?.status === 'ready', run: () => call('update:install') },
  { id: 'update.releaseNotes', label: "What's New in Hive", category: 'Help', run: (version?: unknown) => openReleaseNotes(typeof version === 'string' ? version : get().appInfo?.version) },
  { id: 'app.quit', label: 'Exit', category: 'File', keybinding: 'Mod+Q', run: () => call('app:quit') }
]

export function runCommand(id: string, ...args: unknown[]): void {
  const c = commands.find((x) => x.id === id)
  if (!c) return
  if (c.when && !c.when()) return
  void Promise.resolve(c.run(...args)).catch((e) => console.error(e))
}

/** Whether a project may override this command's shortcut. */
export function isProjectScoped(c: Pick<Command, 'category'>): boolean {
  return PROJECT_KEYBINDING_CATEGORIES.includes(c.category)
}

/** The shortcut a command has now: the selected project's override, the user's, or the default. */
export function commandKeybinding(id: string): string | undefined {
  const c = commands.find((x) => x.id === id)
  if (!c || c.internal) return undefined
  const s = get()
  const project = isProjectScoped(c) ? s.workspace?.projects.find((p) => p.path === s.selectedProject)?.config.keybindings : undefined
  return resolveKeybinding(id, c.keybinding, s.settings?.keybindings, project)
}

// Physical keys, so Shift and AltGr don't change what a combination is called (Ctrl+Shift+1 stays "1", not "!").
const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space'
}

/** A key event as a combination string ("Mod+Shift+P"), or '' for a lone modifier. */
export function eventToKey(e: KeyboardEvent): string {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const code = e.code ?? ''
  let key: string
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Numpad\d$/.test(code)) key = code.slice(6)
  else if (CODE_KEYS[code]) key = CODE_KEYS[code]
  else {
    key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (key === '+') key = '='
    if (key === '_') key = '-'
  }
  parts.push(key)
  return parts.join('+')
}

/** Every command that currently has a shortcut, with it. */
function bound(): { c: Command; key: string }[] {
  const out: { c: Command; key: string }[] = []
  for (const c of commands) {
    const key = commandKeybinding(c.id)
    if (key) out.push({ c, key: key.toUpperCase() })
  }
  return out
}

let chordPrefix: string | null = null
let chordTimer: number | undefined

/** Resolves a keyboard event to a command (supports two-step chords like "Mod+K Mod+S"). */
export function matchKeybinding(e: KeyboardEvent): Command | null {
  const key = eventToKey(e)
  if (!key) return null
  const norm = (k: string): string => k.toUpperCase()
  const all = bound()
  if (chordPrefix) {
    const full = `${chordPrefix} ${key}`
    chordPrefix = null
    window.clearTimeout(chordTimer)
    return all.find((b) => b.key === norm(full))?.c ?? null
  }
  const exact = all.find((b) => b.key === norm(key))
  if (exact) return exact.c
  if (all.some((b) => b.key.startsWith(norm(key) + ' '))) {
    chordPrefix = key
    chordTimer = window.setTimeout(() => (chordPrefix = null), 1500)
    e.preventDefault()
  }
  return null
}

/**
 * Shortcuts an agent's terminal UI uses itself (Claude Code: Ctrl+B background task, Ctrl+K kill line…)
 * stay with the terminal. Each provider lists its own; outside a terminal, all of them count.
 */
export function terminalReserved(provider?: ProviderId): Set<string> {
  return new Set(provider ? providerDescriptor(provider).reservedKeys : PROVIDERS.flatMap((p) => p.reservedKeys))
}

/** Keys the terminal must pass through to Hive instead of the agent. Chords are not started from the terminal. */
export function isAppShortcut(e: KeyboardEvent, provider?: ProviderId): boolean {
  if (e.type !== 'keydown') return false
  const key = eventToKey(e)
  if (!key) return false
  const norm = key.toUpperCase()
  if (terminalReserved(provider).has(norm)) return false
  return bound().some((b) => b.key === norm)
}
