/**
 * A project's tabs, in the order the tab strip shows them (#216), and the title bar's Project menu built from the same
 * list, so the menu can't fall behind the strip again. Each tab has a command, `project.tab.<id>` (commands.ts).
 */
export const PROJECT_TABS = [
  { id: 'session', label: 'Session', icon: 'terminal' },
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'performance', label: 'Performance', icon: 'pulse' },
  { id: 'tasks', label: 'Tasks', icon: 'project' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'images', label: 'Images', icon: 'file-media' },
  { id: 'changes', label: 'Changes', icon: 'git-compare' },
  { id: 'memory', label: 'Memory', icon: 'book' },
  { id: 'skills', label: 'Skills', icon: 'sparkle' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
] as const

export type ProjectTab = (typeof PROJECT_TABS)[number]['id']

/** The command that shows a tab. */
export const tabCommand = (id: ProjectTab): string => `project.tab.${id}`

/** The title bar's Project menu: command ids, '-' for a separator. Its tabs are the strip's, in its order. */
export const PROJECT_MENU: string[] = [
  'project.toggleActive',
  'project.next',
  'project.previous',
  '-',
  'task.new',
  '-',
  'project.openExplorer',
  'project.openTerminal',
  '-',
  ...PROJECT_TABS.map((t) => tabCommand(t.id)),
  '-',
  'project.remove'
]
