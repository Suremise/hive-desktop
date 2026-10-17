import { msg } from './i18n/msg'

/**
 * A project's tabs, in the order the tab strip shows them (#216), and the title bar's Project menu built from the same
 * list, so the menu can't fall behind the strip again. Each tab has a command, `project.tab.<id>` (commands.ts). Their
 * labels are messages, shown with tr() where the strip draws them.
 */
export const PROJECT_TABS = [
  { id: 'session', label: msg({ id: 'project.tab.session', defaultMessage: 'Session', description: "A project's tab: its agents' terminals." }), icon: 'terminal' },
  { id: 'overview', label: msg({ id: 'project.tab.overview', defaultMessage: 'Overview', description: "A project's tab: its usage, cost and sessions in figures." }), icon: 'dashboard' },
  { id: 'performance', label: msg({ id: 'project.tab.performance', defaultMessage: 'Performance', description: "A project's tab: how its agents' turns perform." }), icon: 'pulse' },
  { id: 'tasks', label: msg({ id: 'project.tab.tasks', defaultMessage: 'Tasks', description: "A project's tab: its cards on the task board." }), icon: 'project' },
  { id: 'sessions', label: msg({ id: 'project.tab.sessions', defaultMessage: 'Sessions', description: "A project's tab: its sessions' transcripts." }), icon: 'history' },
  { id: 'files', label: msg({ id: 'project.tab.files', defaultMessage: 'Files', description: "A project's tab: its files." }), icon: 'files' },
  // Attachments (#387): its id is from when it showed only images, kept so tab settings and shortcuts carry over.
  { id: 'images', label: msg({ id: 'project.tab.attachments', defaultMessage: 'Attachments', description: "A project's tab: what was pasted or dropped into its sessions." }), icon: 'attach' },
  // The Git view (#607): Changes, History, Branches & remotes. Its id stays `changes` (saved tabs, `project.tab.changes`).
  { id: 'changes', label: msg({ id: 'project.tab.git', defaultMessage: 'Git', description: "A project's tab: its git changes, history and branches. Usually kept as Git." }), icon: 'source-control' },
  { id: 'memory', label: msg({ id: 'project.tab.memory', defaultMessage: 'Memory', description: "A project's tab: the instructions and memory files its agents read." }), icon: 'book' },
  { id: 'skills', label: msg({ id: 'project.tab.skills', defaultMessage: 'Skills', description: "A project's tab: the skills its agents get." }), icon: 'sparkle' },
  { id: 'templates', label: msg({ id: 'project.tab.templates', defaultMessage: 'Templates', description: "A project's tab: templates of agents and cards." }), icon: 'library' },
  { id: 'mcp', label: msg({ id: 'project.tab.mcp', defaultMessage: 'MCP', description: "A project's tab: the MCP servers its agents get. Keep MCP." }), icon: 'plug' },
  { id: 'settings', label: msg({ id: 'project.tab.settings', defaultMessage: 'Settings', description: "A project's tab: its own settings." }), icon: 'settings' }
] as const

export type ProjectTab = (typeof PROJECT_TABS)[number]['id']

/**
 * The tabs the strip shows (#974): all but Settings, which opens from the project header's ⋯, the title bar's Project
 * menu and its command (Alt+0), and shows with no tab of the strip chosen.
 */
export const STRIP_TABS = PROJECT_TABS.filter((t) => t.id !== 'settings')

/**
 * What a new instructions file (CLAUDE.md, AGENTS.md…) starts with when Memory creates it: its agents read it, so it is
 * English whatever the window's language, under a heading of the project's own name.
 */
export const instructionsStarter = (project: string, provider: string): string => `# ${project}\n\nInstructions for ${provider} in this project.\n` // i18n-ignore: an instructions file is what agents read, not the window's text

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
