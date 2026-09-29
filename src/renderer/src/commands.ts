import { call } from './api'
import * as actions from './actions'
import { focusedAgentId, get, set, setActivity, setProjectTab, showAgent, toggleCompactSidebar, type ProjectTab } from './store'

export interface Command {
  id: string
  label: string
  category: string
  keybinding?: string
  run: (...args: any[]) => unknown
  when?: () => boolean
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
  setActivity('projects')
  setProjectTab(p, t)
}

export const commands: Command[] = [
  { id: 'palette.show', label: 'Show All Commands', category: 'View', keybinding: 'Mod+Shift+P', run: () => set({ paletteOpen: true }) },
  { id: 'settings.open', label: 'Open Settings', category: 'Preferences', keybinding: 'Mod+,', run: () => setActivity('settings') },
  { id: 'workspace.open', label: 'Open Workspace…', category: 'File', keybinding: 'Mod+K Mod+O', run: (path?: string) => actions.openWorkspace(path) },
  { id: 'workspace.create', label: 'New Workspace…', category: 'File', run: () => actions.createWorkspace() },
  { id: 'workspace.close', label: 'Close Workspace', category: 'File', when: hasWorkspace, run: () => actions.closeWorkspace() },
  { id: 'workspace.refresh', label: 'Refresh Workspace', category: 'File', keybinding: 'F5', when: hasWorkspace, run: () => actions.refreshWorkspace() },
  { id: 'project.new', label: 'New Project…', category: 'Project', keybinding: 'Mod+Alt+N', when: hasWorkspace, run: () => actions.createProject() },
  { id: 'project.toggleActive', label: 'Toggle Project Active', category: 'Project', keybinding: 'Mod+Alt+A', when: hasProject, run: () => actions.toggleActiveSelected() },
  { id: 'project.next', label: 'Next Project', category: 'Project', keybinding: 'Mod+PageDown', when: hasWorkspace, run: () => actions.cycleProject(1) },
  { id: 'project.previous', label: 'Previous Project', category: 'Project', keybinding: 'Mod+PageUp', when: hasWorkspace, run: () => actions.cycleProject(-1) },
  { id: 'project.focus', label: 'Focus Project', category: 'Project', run: (path: string) => path && actions.selectProject(path) },
  { id: 'project.openExplorer', label: 'Reveal Project in File Explorer', category: 'Project', when: hasProject, run: () => call('project:openInExplorer', get().selectedProject!) },
  { id: 'project.openTerminal', label: 'Open External Terminal Here', category: 'Project', when: hasProject, run: () => call('project:openTerminal', get().selectedProject!) },
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
  { id: 'session.new', label: 'New Session', category: 'Session', keybinding: 'Mod+Shift+N', when: hasProject, run: () => actions.newSession() },
  { id: 'session.resume', label: 'Resume Last Session', category: 'Session', keybinding: 'Mod+Shift+R', when: hasProject, run: () => actions.resumeLast() },
  { id: 'session.stop', label: 'Stop Session', category: 'Session', keybinding: 'Mod+Shift+X', when: hasLive, run: () => actions.stopSession() },
  {
    id: 'session.compact',
    label: 'Compact Conversation…',
    category: 'Session',
    when: hasLive,
    run: (path?: string, agentId?: string) => {
      const p = path ?? get().selectedProject
      if (p) set({ compactFor: { project: p, agentId: agentId ?? focusedAgentId(get().workspace?.projects.find((x) => x.path === p)) } })
    }
  },
  { id: 'agent.add', label: 'Add Agent…', category: 'Session', when: hasProject, run: (path?: string) => set({ addAgentFor: path ?? get().selectedProject }) },
  {
    id: 'agent.next',
    label: 'Focus Next Agent',
    category: 'Session',
    keybinding: 'Mod+Alt+]',
    when: hasProject,
    run: () => cycleAgent(1)
  },
  { id: 'agent.previous', label: 'Focus Previous Agent', category: 'Session', keybinding: 'Mod+Alt+[', when: hasProject, run: () => cycleAgent(-1) },
  { id: 'session.archive', label: 'Archive Session and Start New', category: 'Session', when: hasProject, run: () => actions.archiveCurrent() },
  { id: 'view.projects', label: 'Show Projects', category: 'View', keybinding: 'Mod+Shift+E', run: () => setActivity('projects') },
  { id: 'view.notes', label: 'Show Shared Notes', category: 'View', keybinding: 'Mod+Shift+H', run: () => setActivity('notes') },
  { id: 'view.skills', label: 'Show Skills', category: 'View', keybinding: 'Mod+Shift+K', run: () => setActivity('skills') },
  { id: 'view.mcp', label: 'Show MCP Servers', category: 'View', keybinding: 'Mod+Shift+M', run: () => setActivity('mcp') },
  { id: 'view.toggleSidebar', label: 'Toggle Sidebar', category: 'View', keybinding: 'Mod+B', run: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })) },
  { id: 'view.compactSidebar', label: 'Toggle Compact Sidebar', category: 'View', keybinding: 'Mod+Alt+B', run: () => toggleCompactSidebar() },
  { id: 'view.notifications', label: 'Show Notifications', category: 'View', run: () => set({ showNotifications: true, unread: 0 }) },
  { id: 'view.zoomIn', label: 'Zoom In', category: 'View', keybinding: 'Mod+=', run: () => call('window:zoom', 'in') },
  { id: 'view.zoomOut', label: 'Zoom Out', category: 'View', keybinding: 'Mod+-', run: () => call('window:zoom', 'out') },
  { id: 'view.zoomReset', label: 'Reset Zoom', category: 'View', keybinding: 'Mod+0', run: () => call('window:zoom', 'reset') },
  { id: 'view.fullScreen', label: 'Toggle Full Screen', category: 'View', keybinding: 'F11', run: () => call('window:toggleFullScreen') },
  { id: 'view.devTools', label: 'Toggle Developer Tools', category: 'Developer', keybinding: 'Mod+Shift+I', run: () => call('window:toggleDevTools') },
  { id: 'view.reload', label: 'Reload Window', category: 'Developer', run: () => location.reload() },
  { id: 'notes.open', label: 'Open Shared Note', category: 'Notes', run: (path: string) => { setActivity('notes'); set({ selectedNote: path }) } },
  { id: 'mcp.import', label: 'Copy Project MCP Servers to Workspace', category: 'MCP', run: (path: string, names: string[]) => actions.importProjectMcp(path, names) },
  { id: 'claude.setup', label: 'Claude Code Setup…', category: 'Help', run: () => set({ setupOpen: true }) },
  { id: 'claude.update', label: 'Update Claude Code', category: 'Help', run: () => set({ setupOpen: true }) },
  { id: 'claude.check', label: 'Check for Claude Code Updates', category: 'Help', run: () => actions.refreshAgent() },
  { id: 'help.docs', label: 'Documentation', category: 'Help', keybinding: 'F1', run: () => { set({ docsPage: 'guide' }); setActivity('docs') } },
  { id: 'help.api', label: 'Agent API Reference', category: 'Help', run: () => { set({ docsPage: 'api' }); setActivity('docs') } },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', category: 'Help', keybinding: 'Mod+K Mod+S', run: () => set({ shortcutsOpen: true }) },
  { id: 'help.releaseNotes', label: 'Release Notes', category: 'Help', run: () => { set({ docsPage: 'changelog' }); setActivity('docs') } },
  { id: 'help.logs', label: 'Open Logs Folder', category: 'Help', run: () => call('app:openLogs') },
  { id: 'help.about', label: 'About Hive', category: 'Help', run: () => set({ aboutOpen: true }) },
  { id: 'app.quit', label: 'Exit', category: 'File', keybinding: 'Mod+Q', run: () => call('app:quit') }
]

export function runCommand(id: string, ...args: unknown[]): void {
  const c = commands.find((x) => x.id === id)
  if (!c) return
  if (c.when && !c.when()) return
  void Promise.resolve(c.run(...args)).catch((e) => console.error(e))
}

export function commandKeybinding(id: string): string | undefined {
  return commands.find((c) => c.id === id)?.keybinding
}

function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  if (key === '+') key = '='
  if (key === '_') key = '-'
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return ''
  parts.push(key)
  return parts.join('+')
}

let chordPrefix: string | null = null
let chordTimer: number | undefined

/** Resolves a keyboard event to a command (supports two-step chords like "Mod+K Mod+S"). */
export function matchKeybinding(e: KeyboardEvent): Command | null {
  const key = eventToKey(e)
  if (!key) return null
  const norm = (k: string): string => k.toUpperCase()
  if (chordPrefix) {
    const full = `${chordPrefix} ${key}`
    chordPrefix = null
    window.clearTimeout(chordTimer)
    return commands.find((c) => c.keybinding && norm(c.keybinding) === norm(full)) ?? null
  }
  const exact = commands.find((c) => c.keybinding && norm(c.keybinding) === norm(key))
  if (exact) return exact
  if (commands.some((c) => c.keybinding && norm(c.keybinding).startsWith(norm(key) + ' '))) {
    chordPrefix = key
    chordTimer = window.setTimeout(() => (chordPrefix = null), 1500)
    e.preventDefault()
  }
  return null
}

// Shortcuts Claude Code itself uses (e.g. Ctrl+B background task, Ctrl+K kill line) stay with the terminal.
const TERMINAL_RESERVED = new Set(['MOD+B', 'MOD+K', 'MOD+O', 'MOD+R', 'MOD+T', 'MOD+G'])

/** Keys the terminal must pass through to Hive instead of the agent. Chords are not started from the terminal. */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false
  const key = eventToKey(e)
  if (!key) return false
  const norm = key.toUpperCase()
  if (TERMINAL_RESERVED.has(norm)) return false
  return commands.some((c) => c.keybinding && c.keybinding.toUpperCase() === norm)
}
