/**
 * Tips: one sentence or two each about something Hive can do, shown one a day in a card when Hive starts, at the
 * moment they matter (contextual), and all together in Help → Tips…. Adding a tip is adding an entry to TIP_ENTRIES, in
 * id order, with an `order` for where it's shown.
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
  /**
   * Where it comes in the tip of the day's rounds, Help → Tips and "Tip n of N": lowest first, unique. Give a new tip a
   * free number in the gap where it belongs (they go up in tens to leave room).
   */
  order: number
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

/** Every tip, sorted by id so tips added on different branches land in different places (tests/tips.test.ts checks). */
export const TIP_ENTRIES: Tip[] = [
  { id: 'agent-layouts', group: 'Agents', order: 90, title: 'Several agents side by side', text: 'Each agent has its own pane: choose a layout at the right of the agent row, and drag tabs or panes to rearrange them. File locks stop two agents editing the same file.', docs: 'Several agents in one project', command: 'agent.addWith', knownBy: [] },
  { id: 'agent-settings', group: 'Agents', order: 120, title: 'A model per agent', text: "Click an agent's model in its footer for Agent Settings: give a reviewer a faster model while another agent codes with the strongest.", docs: 'Several agents in one project' },
  { id: 'always-on-top', group: 'Shortcuts', order: 395, title: 'Keep a Hive window on top', text: 'The pin in the title bar (or Ctrl+Alt+O) keeps the window above your other apps, so a test run or an emulator can work underneath. Each window has its own, remembered for its workspace.', docs: 'Always on Top', command: 'view.alwaysOnTop' },
  { id: 'archive-new', group: 'Sessions', order: 30, title: 'Archive and Start New', text: "The cheapest way to carry on after a long session: archive it and start clean, so nothing old is re-cached. Write a handover first so the new one knows where to pick up.", docs: 'Sessions', command: 'session.archive' },
  { id: 'assistant', group: 'Assistant', order: 240, title: 'Ask the Hive Assistant', text: 'The panel on the right oversees the workspace: ask what the agents are doing, what things cost, or for a plan. {key:assistant.toggle}', docs: 'Hive Assistant', command: 'assistant.toggle' },
  { id: 'assistant-control', group: 'Assistant', order: 250, title: 'Let the Assistant run agents', text: 'Settings → Assistant → Control decides what it may do: only advise, or also add, start and brief agents and start cards when you ask.', docs: 'What the Assistant may do', command: 'assistant.settings' },
  { id: 'assistant-images', group: 'Assistant', order: 258, title: "The images you've pasted to the Assistant", text: "The Assistant view's Images shows every screenshot you've pasted into its conversations, by conversation. Click a conversation's name to read it again.", docs: 'The Assistant view', command: 'view.assistantImages' },
  { id: 'assistant-side', group: 'Assistant', order: 255, title: 'The Assistant on the left', text: 'Windows notifications or another app covering the right of the screen? View → Move Assistant Panel to the Left puts the Assistant beside the project list.', docs: 'Hive Assistant', command: 'assistant.moveSide' },
  { id: 'banners', group: 'Agents', order: 305, title: 'Notices in Hive, not over it', text: 'While you use Hive, an agent finishing or needing you is a banner in the window, not a Windows notification over the Assistant. Settings → Notifications chooses where it shows, for which workspaces, and for how long.', docs: 'Banners in Hive', command: 'settings.notifications' },
  { id: 'board', group: 'Board', order: 150, title: 'Plan work on the task board', text: 'Cards in Todo, Doing, Review and Done, each for a project. Start… gives a card to an agent with the card as its prompt. {key:view.board}', docs: 'Task board', command: 'view.board' },
  { id: 'board-doing', group: 'Board', order: 220, title: 'Choose who works on a card in Doing', text: 'Drag a card into Doing and Hive asks: nobody yet, an agent without starting anything, or an agent that starts on it now.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'board-done', group: 'Board', order: 190, title: 'Ask an agent to move a card to Done', text: 'Agents put finished work in Review for you to check. Say "looks good, move #65 to done" and they move it to Done; the card\'s history shows who moved it.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'board-order', group: 'Board', order: 180, title: "A column's order is its priority", text: 'Drag the most important cards to the top, or ask the Assistant or an agent to prioritise: they reorder the board itself.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'board-review', group: 'Board', order: 200, title: 'Have an agent review a card', text: 'Say "review #87" to another agent: the card stays in Review with the agent that did the work, shows who is reviewing it, and gets the verdict as a comment.', docs: 'Task board', command: 'view.board', knownBy: [] },
  { id: 'card-loop', group: 'Board', order: 210, title: 'Let two agents build and review in turn', text: 'Tell one agent to work through some cards as the builder and another to review them: each waits for the other at no cost, and Hive wakes it when the card changes.', docs: 'Card loops', command: 'view.board', knownBy: [] },
  { id: 'card-move', group: 'Board', order: 160, title: 'Move a dialog out of the way', text: "Drag any dialog by its header (a card, Add Agent, Agent Settings…) to see what's behind it; Escape while dragging puts it back.", docs: 'Moving dialogs' },
  { id: 'close-window', group: 'Shortcuts', order: 396, title: 'Close one window, or all of them', text: 'With several windows open, File → Close Window ({key:window.close}) closes just this one, as its X does. Exit Hive (all windows) closes every window and stops all their agents.', docs: 'Several windows', knownBy: ['window.close'] },
  { id: 'compact-focus', group: 'Sessions', order: 10, title: 'Compact with a focus', text: 'Compact summarises the conversation so every later message costs less. Give it a focus ("keep the API decisions, drop the test output") and the agent keeps what matters. {key:session.compact}', docs: 'Sessions', command: 'session.compact' },
  { id: 'compact-sidebar', group: 'Shortcuts', order: 400, title: 'A compact project list', text: 'Toggle Compact Sidebar turns the project list into a narrow rail of tiles with each project\'s agents, leaving more room for the terminals.', docs: 'Workspaces and projects', command: 'view.compactSidebar' },
  { id: 'compaction-history', group: 'Sessions', order: 45, title: 'Read a compaction where it happened', text: "The Overview's compaction history pages, filters and sorts a long session's compactions; click one to read it in the transcript, with the summary the agent carried on from.", docs: 'Token use, cache and compaction', command: 'project.tab.overview', knownBy: [] },
  { id: 'copy-diagnostics', group: 'Shortcuts', order: 320, title: 'Found a bug? Copy Diagnostics', text: "Help → Copy Diagnostics… gathers Hive's version, your coding agents, key settings and the end of the log for a bug report, with names, folders and tokens taken out.", docs: 'Troubleshooting', command: 'help.diagnostics' },
  { id: 'date-format', group: 'Sessions', order: 65, title: 'Dates your way', text: 'Hive shows dates as 2026-10-04 and times as 14:05. Settings → General → Date format and Time format change them everywhere, sessions named by when they started too.', docs: 'Dates and times', command: 'settings.open', knownBy: [] },
  { id: 'file-links', group: 'Files', order: 330, title: 'Ctrl+click a path in the terminal', text: "File paths an agent prints, like src/app.ts:42, are links: Ctrl+click one to open the file in the Files tab at that line.", docs: 'Keyboard shortcuts', knownBy: [] },
  { id: 'files-tab', group: 'Files', order: 340, title: 'Edit files without leaving Hive', text: 'The Files tab browses and edits the project, previews Markdown, CSV, HTML and images, and keeps unsaved edits as you switch.', docs: 'Files', command: 'project.tab.files' },
  { id: 'goto-project', group: 'Shortcuts', order: 360, title: 'Jump to a project', text: 'Press {key:project.goto} and type a few letters of its name.', docs: 'Keyboard shortcuts', command: 'project.goto' },
  { id: 'handover-self', group: 'Sessions', order: 20, title: 'A long conversation? Hand it over to itself', text: "When an agent's transcript size turns amber, click it and choose the agent itself: it writes a handover, and a new conversation picks up from it, short and fast again.", docs: 'Long conversations', command: 'session.handOverTo' },
  { id: 'hive-skills', group: 'Agents', order: 130, title: 'Skills for working with Hive', text: "Agents and the Assistant get Hive's own skills: work-on-card, review-agent-work, handover and more. Hive keeps them up to date; ones you edit stay yours.", docs: 'Skills', command: 'view.skills' },
  { id: 'images-tab', group: 'Files', order: 280, title: 'Every image you pasted, in one place', text: 'The Images tab keeps each screenshot pasted into the project\'s sessions, grouped by session, ready to insert again.', docs: 'Images', command: 'project.tab.images' },
  { id: 'keep-awake', group: 'Agents', order: 310, title: 'Leave agents working, the PC stays awake', text: "While an agent works, Hive stops Windows from sleeping (the screen can still lock), and lets it sleep once they're done. Choose when in Settings → General.", docs: 'Sleep and shutdown', command: 'settings.open', knownBy: [] },
  { id: 'model-fallbacks', group: 'Agents', order: 115, title: 'New models without a Hive update', text: "Hive asks Claude Code and Codex which models they have and which effort levels each takes. If a CLI can't say, the model, effort and price lists on its Settings page are yours to edit.", docs: 'Models, effort levels and prices', command: 'settings.providers' },
  { id: 'new-card', group: 'Board', order: 230, title: 'Jot down a card', text: 'Press {key:task.new} for a new card for the project you are in, without leaving what you are doing.', docs: 'Task board', command: 'task.new' },
  { id: 'overview', group: 'Shortcuts', order: 390, title: 'The whole workspace at a glance', text: 'The Workspace Overview shows what every project used, what runs now and the board, by day. {key:view.overview}', docs: 'Workspace Overview', command: 'view.overview' },
  { id: 'own-shortcuts', group: 'Shortcuts', order: 410, title: 'Make the shortcuts yours', text: 'Settings → Keyboard Shortcuts changes any shortcut, and Project Settings can change them for one project.', docs: 'Keyboard shortcuts', command: 'settings.keybindings' },
  { id: 'palette', group: 'Shortcuts', order: 350, title: 'Everything is in the command palette', text: 'Press {key:palette.show} and type: every command, with its shortcut.', docs: 'Keyboard shortcuts', command: 'palette.show' },
  { id: 'paste-screenshot', group: 'Files', order: 270, title: 'Paste a screenshot into a session', text: 'Press Ctrl+V in an agent\'s terminal with an image on the clipboard, or drop an image onto it: the agent sees it, and Hive keeps a copy.', docs: 'Images', knownBy: [] },
  { id: 'perf-compare', group: 'Shortcuts', order: 380, title: 'Before and after a change', text: 'Performance → Compare: keep the current view before a change and again after it, and see whether Hive’s traffic fell while the work still got done.', docs: 'Comparing before and after', command: 'view.performance' },
  { id: 'performance', group: 'Shortcuts', order: 370, title: 'What Hive itself costs', text: 'Performance, in the activity bar, shows what Hive\'s API, tools and guidance cost for the last day, week or month: the whole workspace or one project. Each project has its own Performance tab too.', docs: 'Performance view', command: 'view.performance' },
  { id: 'permission-mode', group: 'Sessions', order: 40, title: 'Switch permission mode', text: "Click the mode in an agent's footer, or press {key:session.permissionMode}, to move between asking first, accepting edits and planning.", docs: 'Permission modes', command: 'session.permissionMode' },
  { id: 'personas', group: 'Assistant', order: 260, title: 'Personas for the Assistant', text: 'A persona gives the Assistant a role (planner, reviewer…). Switch it from the panel, or write your own.', docs: 'Personas', command: 'view.personas' },
  { id: 'progress-command', group: 'Agents', order: 376, title: 'Progress for any command', text: 'Agents run long commands such as tests and builds through hive-progress, so the Progress panel shows them under the agent\'s name, with about how long is left from the second time. Settings can have them do it only when you ask.', docs: 'Show progress for any command' },
  { id: 'progress-details', group: 'Shortcuts', order: 377, title: 'What did that run do?', text: 'Click a run in the Progress panel, or one under Recent, for its details: the whole command, when it ran and how long it took, its exit code, the log it wrote and why it failed.', docs: 'Progress panel', command: 'progress.toggle', knownBy: [] },
  { id: 'progress-panel', group: 'Shortcuts', order: 375, title: 'How long until the tests finish?', text: 'When agents run tests or builds that report progress, the Progress panel on the right shows each run: the agent, how far along it is and the time left, and Hive\'s taskbar button fills as they go. {key:progress.toggle} shows it.', docs: 'Progress panel', command: 'progress.toggle' },
  { id: 'project-cards', group: 'Board', order: 170, title: "A project's cards at a glance", text: "A project's Overview starts with its cards: how many are in each column, stalled or blocked. Click a number to open its Tasks tab.", docs: 'Token use, cache and compaction', command: 'project.tab.overview' },
  { id: 'project-tabs', group: 'Shortcuts', order: 402, title: 'Tabs that make room', text: "When space is short, a project's tabs shrink to icons, and the tab you're on keeps its name while it fits. Hover a tab for its name and shortcut.", docs: 'Working on a project' },
  { id: 'quit-when-done', group: 'Sessions', order: 80, title: 'Quit when agents finish', text: "Quitting while an agent works offers Quit when agents finish: Hive hides and quits by itself once they're done. Conversations are always kept.", docs: 'Quitting' },
  { id: 'recent-workspaces', group: 'Shortcuts', order: 397, title: 'Tidy your recent workspaces', text: 'Remove a workspace from File → Open Recent or the welcome page with its ✕, or right-click it. Clear Recently Opened forgets them all; folders that are gone show as not found.', docs: 'Recent workspaces', command: 'workspace.clearRecent' },
  { id: 'resume-all', group: 'Sessions', order: 70, title: 'Resume all agents at once', text: "After a restart, Resume All Agents in the project header resumes every stopped agent's last session in one go.", docs: 'Sessions' },
  { id: 'save-template', group: 'Agents', order: 117, title: 'Save your agents as a template', text: 'Set agents up once and reuse them: Save Template… on the agent strip keeps their settings, roles and layout, and Template ▾ loads them into any project.', docs: 'Agent templates', command: 'template.save' },
  { id: 'search-transcripts', group: 'Sessions', order: 60, title: 'Search every past session', text: "The Sessions tab searches every session's name, date and transcript (Ctrl+F there): the tree keeps what matches, and a hit opens the conversation at that message.", docs: 'Reading past sessions', command: 'project.tab.sessions' },
  { id: 'session-tree', group: 'Sessions', order: 62, title: 'Clear out a whole branch of sessions', text: "In the Sessions tab, right-click a provider, an agent or a session with sub-sessions to archive or delete everything in it at once. Running sessions and ones in use are skipped, and Hive says which.", docs: 'Reading past sessions', command: 'project.tab.sessions' },
  { id: 'share-templates', group: 'Agents', order: 118, title: 'Share agent templates', text: "The Templates view (activity bar) and a project's Templates tab list every template. Export… saves one as a file for teammates; Import… brings one in, for the workspace or a project.", docs: 'Managing and sharing templates', command: 'view.templates' },
  { id: 'shared-notes', group: 'Files', order: 290, title: 'Notes every project shares', text: "Shared notes and handovers live in the workspace, so every project's agents can read them with Hive's tools.", docs: 'Shared notes and handovers', command: 'view.notes' },
  { id: 'start-new-all', group: 'Sessions', order: 35, title: 'Fresh sessions for every agent', text: 'Start New (All) in the project header gives every agent a new session after one question; Archive and Start New (All) archives their old ones first. Their conversations stay in the Sessions tab.', docs: 'Sessions', command: 'session.startNewAll' },
  { id: 'storage-cleanup', group: 'Sessions', order: 50, title: 'See what Hive keeps, and clean up', text: "Project Settings → Storage shows how much space a project's backups, archive, images and worktrees take. Clean Up… moves old images and backups to the Recycle Bin, and shows you exactly what goes first.", docs: 'Archiving and backups', command: 'project.storage' },
  { id: 'taskbar-badge', group: 'Agents', order: 300, title: 'Glance at the taskbar', text: "Hive's taskbar button shows how many agents need you, and flashes when one asks you something while Hive is in the background.", docs: 'Agents that need you', knownBy: [] },
  { id: 'two-providers', group: 'Agents', order: 110, title: 'Mix Claude Code and Codex', text: 'Agents in one project can use different providers: say a Codex reviewer next to a Claude Code agent. Hand Over to… passes work between them.', docs: 'Coding agents: Claude Code and Codex', command: 'settings.providers' },
  { id: 'unmerged', group: 'Agents', order: 140, title: 'See what a worktree agent has to merge', text: 'Merge… turns orange with the number of commits not yet merged, and the Changes tab shows everything the agent changed since it branched.', docs: 'Changes', command: 'project.tab.changes' },
  { id: 'workspace-moved', group: 'Files', order: 345, title: 'Move a workspace without losing its agents', text: "Moved the workspace folder, say to another drive? Open it from its new place and choose Repair… in the banner: agents' worktrees, their sessions, and Claude Code's conversations and memory follow it.", docs: 'Moving a workspace' },
  { id: 'worktrees', group: 'Agents', order: 100, title: 'Give an agent its own worktree', text: "In Add Agent…, choose New worktree: the agent works on its own branch, and Merge… brings its work back when you're happy with it.", docs: 'Several agents in one project', command: 'agent.addWith' }
]

/** The tips in the order they're shown: by `order`. */
export const TIPS: Tip[] = [...TIP_ENTRIES].sort((a, b) => a.order - b.order)

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
