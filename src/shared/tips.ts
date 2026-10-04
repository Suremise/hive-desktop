/**
 * Tips: one sentence or two each about something Hive can do, shown one a day in a card when Hive starts, at the
 * moment they matter (contextual), and all together in Help → Tips…. Adding a tip is adding an entry here.
 *
 * `text` may name a shortcut as {key:<command id>}: shown as the command's current shortcut (the user's own, if
 * changed). Without one it is left out at the end of the text, and named by the command's label elsewhere.
 * `docs` is a heading of the user guide that Learn more opens.
 */

export type TipGroup = 'Sessions' | 'Agents' | 'Board' | 'Assistant' | 'Files' | 'Shortcuts'
export const TIP_GROUPS: TipGroup[] = ['Sessions', 'Agents', 'Board', 'Assistant', 'Files', 'Shortcuts']

export interface Tip {
  id: string
  group: TipGroup
  title: string
  text: string
  /** A heading of the user guide (Learn more). */
  docs?: string
  /** A command Try it runs. */
  command?: string
  /** Not shown by itself once the user has run any of these commands (they know it already). Default: `command`. */
  knownBy?: string[]
}

/** Moments a tip is worth showing at, once each. */
export type TipMoment = 'transcript-long' | 'compact-suggested' | 'second-agent' | 'image-pasted'

/** The tip for each moment. */
export const TIP_MOMENTS: Record<TipMoment, string> = {
  'transcript-long': 'handover-self',
  'compact-suggested': 'compact-focus',
  'second-agent': 'agent-layouts',
  'image-pasted': 'images-tab'
}

export const TIPS: Tip[] = [
  // Sessions
  { id: 'compact-focus', group: 'Sessions', title: 'Compact with a focus', text: 'Compact summarises the conversation so every later message costs less. Give it a focus ("keep the API decisions, drop the test output") and the agent keeps what matters. {key:session.compact}', docs: 'Sessions', command: 'session.compact' },
  { id: 'handover-self', group: 'Sessions', title: 'A long conversation? Hand it over to itself', text: "When an agent's transcript size turns amber, click it and choose the agent itself: it writes a handover, and a new conversation picks up from it, short and fast again.", docs: 'Long conversations', command: 'session.handOverTo' },
  { id: 'archive-new', group: 'Sessions', title: 'Archive and Start New', text: "The cheapest way to carry on after a long session: archive it and start clean, so nothing old is re-cached. Write a handover first so the new one knows where to pick up.", docs: 'Sessions', command: 'session.archive' },
  { id: 'permission-mode', group: 'Sessions', title: 'Switch permission mode', text: "Click the mode in an agent's footer, or press {key:session.permissionMode}, to move between asking first, accepting edits and planning.", docs: 'Permission modes', command: 'session.permissionMode' },
  { id: 'storage-cleanup', group: 'Sessions', title: 'See what Hive keeps, and clean up', text: "Project Settings → Storage shows how much space a project's backups, archive, images and worktrees take. Clean Up… moves old images and backups to the Recycle Bin, and shows you exactly what goes first.", docs: 'Archiving and backups', command: 'project.storage' },
  { id: 'search-transcripts', group: 'Sessions', title: 'Search every past session', text: 'The Sessions tab searches one transcript or all of them (Ctrl+F there), and a hit opens the conversation at that message.', docs: 'Reading past sessions', command: 'project.tab.sessions' },
  { id: 'resume-all', group: 'Sessions', title: 'Resume all agents at once', text: "After a restart, Resume All Agents in the project header resumes every stopped agent's last session in one go.", docs: 'Sessions' },
  { id: 'quit-when-done', group: 'Sessions', title: 'Quit when agents finish', text: "Quitting while an agent works offers Quit when agents finish: Hive hides and quits by itself once they're done. Conversations are always kept.", docs: 'Quitting' },
  // Agents
  { id: 'agent-layouts', group: 'Agents', title: 'Several agents side by side', text: 'Each agent has its own pane: choose a layout at the right of the agent row, and drag tabs or panes to rearrange them. File locks stop two agents editing the same file.', docs: 'Several agents in one project', command: 'agent.addWith', knownBy: [] },
  { id: 'worktrees', group: 'Agents', title: 'Give an agent its own worktree', text: "In Add Agent…, choose New worktree: the agent works on its own branch, and Merge… brings its work back when you're happy with it.", docs: 'Several agents in one project', command: 'agent.addWith' },
  { id: 'two-providers', group: 'Agents', title: 'Mix Claude Code and Codex', text: 'Agents in one project can use different providers: say a Codex reviewer next to a Claude Code agent. Hand Over to… passes work between them.', docs: 'Coding agents: Claude Code and Codex', command: 'settings.providers' },
  { id: 'agent-settings', group: 'Agents', title: 'A model per agent', text: "Click an agent's model in its footer for Agent Settings: give a reviewer a faster model while another agent codes with the strongest.", docs: 'Several agents in one project' },
  { id: 'hive-skills', group: 'Agents', title: 'Skills for working with Hive', text: "Agents and the Assistant get Hive's own skills: work-on-card, review-agent-work, handover and more. Hive keeps them up to date; ones you edit stay yours.", docs: 'Skills', command: 'view.skills' },
  { id: 'unmerged', group: 'Agents', title: 'See what a worktree agent has to merge', text: 'Merge… turns orange with the number of commits not yet merged, and the Changes tab shows everything the agent changed since it branched.', docs: 'Changes', command: 'project.tab.changes' },
  // Board
  { id: 'board', group: 'Board', title: 'Plan work on the task board', text: 'Cards in Todo, Doing, Review and Done, each for a project. Start… gives a card to an agent with the card as its prompt. {key:view.board}', docs: 'Task board', command: 'view.board' },
  { id: 'card-move', group: 'Board', title: 'Move an open card out of the way', text: "Drag a card's dialog by its header to see what's behind it; Escape while dragging puts it back.", docs: 'Task board' },
  { id: 'project-cards', group: 'Board', title: "A project's cards at a glance", text: "A project's Overview starts with its cards: how many are in each column, stalled or blocked. Click a number to open its Tasks tab.", docs: 'Token use, cache and compaction', command: 'project.tab.overview' },
  { id: 'board-order', group: 'Board', title: "A column's order is its priority", text: 'Drag the most important cards to the top, or ask the Assistant or an agent to prioritise: they reorder the board itself.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'board-done', group: 'Board', title: 'Ask an agent to move a card to Done', text: 'Agents put finished work in Review for you to check. Say "looks good, move #65 to done" and they move it to Done; the card\'s history shows who moved it.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'board-review', group: 'Board', title: 'Have an agent review a card', text: 'Say "review #87" to another agent: the card stays in Review with the agent that did the work, shows who is reviewing it, and gets the verdict as a comment.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'card-loop', group: 'Board', title: 'Let two agents build and review in turn', text: 'Tell one agent to work through some cards as the builder and another to review them: each waits for the other at no cost, and Hive wakes it when the card changes.', docs: 'Card loops', command: 'view.board', knownBy: [] },
  { id: 'board-doing', group: 'Board', title: 'Choose who works on a card in Doing', text: 'Drag a card into Doing and Hive asks: nobody yet, an agent without starting anything, or an agent that starts on it now.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'new-card', group: 'Board', title: 'Jot down a card', text: 'Press {key:task.new} for a new card for the project you are in, without leaving what you are doing.', docs: 'Task board', command: 'task.new' },
  // Assistant
  { id: 'assistant', group: 'Assistant', title: 'Ask the Hive Assistant', text: 'The panel on the right oversees the workspace: ask what the agents are doing, what things cost, or for a plan. {key:assistant.toggle}', docs: 'Hive Assistant', command: 'assistant.toggle' },
  { id: 'assistant-control', group: 'Assistant', title: 'Let the Assistant run agents', text: 'Settings → Assistant → Control decides what it may do: only advise, or also add, start and brief agents and start cards when you ask.', docs: 'What the Assistant may do', command: 'assistant.settings' },
  { id: 'personas', group: 'Assistant', title: 'Personas for the Assistant', text: 'A persona gives the Assistant a role (planner, reviewer…). Switch it from the panel, or write your own.', docs: 'Personas', command: 'view.personas' },
  // Files
  { id: 'paste-screenshot', group: 'Files', title: 'Paste a screenshot into a session', text: 'Press Ctrl+V in an agent\'s terminal with an image on the clipboard, or drop an image onto it: the agent sees it, and Hive keeps a copy.', docs: 'Images', knownBy: [] },
  { id: 'images-tab', group: 'Files', title: 'Every image you pasted, in one place', text: 'The Images tab keeps each screenshot pasted into the project\'s sessions, grouped by session, ready to insert again.', docs: 'Images', command: 'project.tab.images' },
  { id: 'shared-notes', group: 'Files', title: 'Notes every project shares', text: "Shared notes and handovers live in the workspace, so every project's agents can read them with Hive's tools.", docs: 'Shared notes and handovers', command: 'view.notes' },
  { id: 'taskbar-badge', group: 'Agents', title: 'Glance at the taskbar', text: "Hive's taskbar button shows how many agents need you, and flashes when one asks you something while Hive is in the background.", docs: 'Agents that need you', knownBy: [] },
  { id: 'keep-awake', group: 'Agents', title: 'Leave agents working, the PC stays awake', text: "While an agent works, Hive stops Windows from sleeping (the screen can still lock), and lets it sleep once they're done. Choose when in Settings → General.", docs: 'Sleep and shutdown', command: 'settings.open', knownBy: [] },
  { id: 'copy-diagnostics', group: 'Shortcuts', title: 'Found a bug? Copy Diagnostics', text: "Help → Copy Diagnostics… gathers Hive's version, your coding agents, key settings and the end of the log for a bug report, with names, folders and tokens taken out.", docs: 'Troubleshooting', command: 'help.diagnostics' },
  { id: 'file-links', group: 'Files', title: 'Ctrl+click a path in the terminal', text: "File paths an agent prints, like src/app.ts:42, are links: Ctrl+click one to open the file in the Files tab at that line.", docs: 'Keyboard shortcuts', knownBy: [] },
  { id: 'files-tab', group: 'Files', title: 'Edit files without leaving Hive', text: 'The Files tab browses and edits the project, previews Markdown, CSV, HTML and images, and keeps unsaved edits as you switch.', docs: 'Files', command: 'project.tab.files' },
  // Shortcuts
  { id: 'palette', group: 'Shortcuts', title: 'Everything is in the command palette', text: 'Press {key:palette.show} and type: every command, with its shortcut.', docs: 'Keyboard shortcuts', command: 'palette.show' },
  { id: 'goto-project', group: 'Shortcuts', title: 'Jump to a project', text: 'Press {key:project.goto} and type a few letters of its name.', docs: 'Keyboard shortcuts', command: 'project.goto' },
  { id: 'performance', group: 'Shortcuts', title: 'What Hive itself costs', text: 'Performance, in the activity bar, shows what Hive\'s API, tools and guidance cost for the last day, week or month: the whole workspace or one project. Each project has its own Performance tab too.', docs: 'Performance view', command: 'view.performance' },
  { id: 'perf-compare', group: 'Shortcuts', title: 'Before and after a change', text: 'Performance → Compare: keep the current view before a change and again after it, and see whether Hive’s traffic fell while the work still got done.', docs: 'Comparing before and after', command: 'view.performance' },
  { id: 'overview', group: 'Shortcuts', title: 'The whole workspace at a glance', text: 'The Workspace Overview shows what every project used, what runs now and the board, by day. {key:view.overview}', docs: 'Workspace Overview', command: 'view.overview' },
  { id: 'compact-sidebar', group: 'Shortcuts', title: 'A compact project list', text: 'Toggle Compact Sidebar turns the project list into a narrow rail of tiles with each project\'s agents, leaving more room for the terminals.', docs: 'Workspaces and projects', command: 'view.compactSidebar' },
  { id: 'own-shortcuts', group: 'Shortcuts', title: 'Make the shortcuts yours', text: 'Settings → Keyboard Shortcuts changes any shortcut, and Project Settings can change them for one project.', docs: 'Keyboard shortcuts', command: 'settings.keybindings' }
]

/** What Hive remembers about tips, in the user's profile. */
export interface TipsState {
  /** Tips shown, in the current round (a round ends when every tip still worth showing was seen). */
  seen: string[]
  /** The day (YYYY-MM-DD, local) a tip last showed on start. */
  shownOn?: string
  /** Moments already used. */
  moments: string[]
  /** Commands the user has run (for knownBy). */
  used: string[]
}

export const EMPTY_TIPS_STATE: TipsState = { seen: [], moments: [], used: [] }

/** A day as YYYY-MM-DD in local time. */
export const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Whether the user already knows this (has run its command). */
export const tipKnown = (t: Tip, s: TipsState): boolean => (t.knownBy ?? (t.command ? [t.command] : [])).some((c) => s.used.includes(c))

/** The tip after `from` (or the first) still worth showing: not yet seen in this round, and not one the user knows; null when there's none. */
export function nextTip(s: TipsState, from: string | null = null, tips: Tip[] = TIPS): Tip | null {
  const worth = tips.filter((t) => !tipKnown(t, s))
  if (!worth.length) return null
  const start = from ? worth.findIndex((t) => t.id === from) + 1 : 0
  const order = [...worth.slice(start), ...worth.slice(0, start)].filter((t) => t.id !== from)
  // Every one seen: a new round.
  return order.find((t) => !s.seen.includes(t.id)) ?? order[0] ?? null
}

/** The tip for Hive starting today, unless one showed today already. */
export function tipForToday(s: TipsState, now: Date, tips: Tip[] = TIPS): Tip | null {
  return s.shownOn === localDay(now) ? null : nextTip(s, null, tips)
}

/** The tip for a moment, the first time it comes (and not one the user knows). */
export function tipForMoment(s: TipsState, moment: TipMoment, tips: Tip[] = TIPS): Tip | null {
  if (s.moments.includes(moment)) return null
  const t = tips.find((x) => x.id === TIP_MOMENTS[moment])
  return t && !tipKnown(t, s) ? t : null
}

/** The state after showing a tip: seen (starting a new round when it completes one). */
export function sawTip(s: TipsState, id: string, tips: Tip[] = TIPS): TipsState {
  const seen = s.seen.includes(id) ? s.seen : [...s.seen, id]
  const left = tips.filter((t) => !tipKnown(t, s) && !seen.includes(t.id))
  return { ...s, seen: left.length ? seen : [id] }
}

/** The state after the user ran a command. */
export const usedCommand = (s: TipsState, id: string): TipsState => (s.used.includes(id) ? s : { ...s, used: [...s.used, id].slice(-300) })

/** Reads a saved state, keeping only what is well formed. */
export function tipsState(v: unknown): TipsState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
  return { seen: list(o.seen), moments: list(o.moments), used: list(o.used), ...(typeof o.shownOn === 'string' ? { shownOn: o.shownOn } : {}) }
}
