/**
 * Hive's settings catalog (#186): every setting described once, for Settings and Project Settings (which render these
 * rows) and for the Hive Assistant's tools (hive_list_settings, hive_read_setting, hive_update_setting), so what the
 * user reads and what the Assistant explains never drift apart. Each entry says where the setting is, what it does,
 * when it helps, the values it takes and its default, whether it needs a restart, and whether the Assistant may change
 * it: sensitive settings (permission modes, the Agent API, what runs, the Assistant's own Control) are read-only to it.
 * Rows that hold no value (a button, a status, a list) are kept here for their text and left out of the tools.
 * Pure data and helpers: no React (the views add the custom controls by id), no Node.
 */
import type { AppSettings, ProjectConfig, ProviderId } from './types'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, FILE_LOCK_MODES } from './defaults'
import { PRICES_CHECKED } from './prices'
import { PROVIDERS, defaultProviderSettings, permissionLabel, projectProviderConfig, providerDescriptor, providerSettings, type ProviderDescriptor } from './providers'

/** Where a setting lives: Hive's own (Settings), a provider's page in Settings, the open workspace, or one project (Project Settings). */
export type SettingScope = 'app' | 'provider' | 'workspace' | 'project'

/** The control Settings shows for it; custom ones are drawn by the view (by id). */
export type SettingControl = 'boolean' | 'select' | 'number' | 'text' | 'range' | 'custom'

/** A settings section: a group of AppSettings, "providers" (turning them on), one provider's page ("provider:<id>"), "workspace" or "advanced". */
export type SettingsSection = keyof AppSettings | 'advanced' | 'workspace' | `provider:${string}`

/** A row as written below, before the catalog adds its id, scope and flags. */
interface Row {
  section: string
  /** For a provider page or a project's provider section: the provider whose settings this reads and writes. */
  provider?: ProviderId
  key: string
  title: string
  desc: string
  tip?: string
  type: SettingControl
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  /** A number setting that 0 turns off: the label of its Off checkbox ("Never"). */
  off?: string
  placeholder?: string
  danger?: boolean
  /** Takes the full width under its title (e.g. a table). */
  wide?: boolean
  confirmOn?: { title: string; message: string; detail?: string }
  /** Why it can't be changed now (another setting it depends on is off), shown under it; null when it can. */
  disabledBy?: (s: AppSettings) => string | null
  /** One field of the Assistant's settings with a provider (settings.assistant.providers[<id>]). */
  assistantProvider?: ProviderId
  /** Not a row of its own in Settings: drawn as part of another (the Assistant's "With <provider>"). */
  hidden?: boolean
}

/** The Assistant's model, effort, mode, context and arguments with one provider, a field each (Settings → Assistant → With <provider>). */
function assistantProviderRows(p: ProviderDescriptor): Row[] {
  const row = (key: string, title: string, desc: string, more: Partial<Row> = {}): Row => ({ section: 'assistant', assistantProvider: p.id, hidden: true, key: `${p.id}.${key}`, title, desc, tip: '', type: 'custom', ...more })
  return [
    row('model', 'Model', `The model when the Assistant runs ${p.name}. Empty follows Settings → ${p.name} → Default model.`),
    row('effort', 'Effort', `Its reasoning effort with ${p.name}. Empty follows Settings → ${p.name} → Default effort.`),
    row('permissionMode', 'Permission mode', `Its permission mode with ${p.name}. Empty is ${permissionLabel(p.id, p.assistantMode)}, where ${p.name} approves safe actions itself and only asks about risky ones.`),
    ...(p.capabilities.contextLimit ? [row('use200kContext', 'Use 200K context (instead of 1M)', `A 200K-token context window for it with ${p.name}. Empty follows Settings → ${p.name}.`)] : []),
    row('extraArgs', 'Extra arguments', `Additional ${p.cliName} command-line arguments when the Assistant runs ${p.name}.`)
  ]
}

export interface SettingEntry extends Row {
  /** Stable: "<section>.<key>" for Hive's settings, "<provider>.<key>" for a provider's page, "project.<key>" (and "project.<provider>.<key>") for a project's. */
  id: string
  scope: SettingScope
  tip: string
  /** When it helps: the signal that makes it worth suggesting (the tune-settings skill's opportunities). */
  helps?: string
  /** No value: a button, a status or a list. The tools leave it out. */
  action?: boolean
  /** What the tools take for a custom control (a model is any text); without it, a custom setting is read-only to them. */
  value?: 'text' | 'boolean' | 'select' | 'effort' | 'table'
  /** Read-only to the Hive Assistant, and why (it can still read and explain it). */
  readOnly?: string
  /** Sensitive: permissions, what runs, the Agent API, the Assistant's own settings (readOnly says which). */
  sensitive?: boolean
  /** Who takes a change only when restarted: running agents' sessions, or the Assistant. */
  restart?: 'sessions' | 'assistant'
  /** The user guide's heading about it (Help → User Guide). */
  docs: string
  /** A project setting that can inherit Hive's (null, or the 'inherit' option). */
  inherits?: boolean
}

export const providerSection = (id: ProviderId): SettingsSection => `provider:${id}`

/** Settings' sections, in order (the view adds their icons). */
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; desc: string; provider?: ProviderId }[] = [
  { id: 'general', label: 'General', desc: 'Startup, window and tray behaviour.' },
  { id: 'updates', label: 'Updates', desc: "Keeping Hive itself up to date. New versions come from Hive's GitHub releases and are verified before they install." },
  { id: 'appearance', label: 'Appearance', desc: 'Theme, fonts and terminal look.' },
  { id: 'providers', label: 'Providers', desc: 'The coding agents Hive can run. Turn on the ones you use; each has its own page below with its CLI and the defaults every project inherits.' },
  ...PROVIDERS.map((p) => ({ id: providerSection(p.id), label: p.name, provider: p.id, desc: `The ${p.name} CLI (the standalone one — copies bundled with editor extensions are not used) and the defaults every project inherits for ${p.name} agents.` })),
  { id: 'notifications', label: 'Notifications', desc: 'Chimes and desktop notifications when agents finish or need you.' },
  { id: 'sessions', label: 'Sessions', desc: 'Transcript backups, cache estimates and session behaviour.' },
  { id: 'assistant', label: 'Assistant', desc: "The Hive Assistant's defaults: the side panel's overseer of each workspace (Ctrl+Alt+I). Each workspace can change them in the panel's Assistant Settings." },
  { id: 'workspace', label: 'Workspace', desc: "The open workspace's projects that Hive leaves out (hidden, or removed from Hive with their handovers and cards packed into the folder), and how much Hive keeps for each project." },
  { id: 'board', label: 'Board', desc: "The task board's colours and housekeeping, the same in every workspace." },
  { id: 'agents', label: 'Agents & Worktrees', desc: 'Defaults for projects running several agents: file locks, new worktrees and merging (projects can override them), and how long background tasks count.' },
  { id: 'keybindings', label: 'Keyboard Shortcuts', desc: 'Change, remove or add shortcuts for any command. Projects can set their own for project and session commands (Project Settings → Keyboard Shortcuts).' },
  { id: 'agentApi', label: 'Agent API', desc: 'Local API and built-in MCP server that let agents interact with Hive.' },
  { id: 'advanced', label: 'Advanced', desc: 'Logs, data and resetting Hive.' }
]

const APP_ROWS: Row[] = [
  // General
  { section: 'general', key: 'closeToTray', title: 'Close to tray', desc: 'Closing the window keeps Hive running in the system tray so sessions continue.', tip: 'When off, closing the window quits Hive (asking first if sessions are running). Use File → Exit or the tray menu to quit.', type: 'boolean' },
  { section: 'general', key: 'minimizeToTray', title: 'Minimise to tray', desc: 'Minimising hides Hive to the system tray instead of the taskbar.', tip: 'Click the tray icon to bring Hive back.', type: 'boolean' },
  { section: 'general', key: 'startMinimized', title: 'Start in tray', desc: 'Start Hive hidden in the system tray.', tip: 'Useful together with "Launch at login".', type: 'boolean' },
  { section: 'general', key: 'launchAtLogin', title: 'Launch at login', desc: 'Start Hive automatically when you sign in to Windows.', tip: 'Hive starts hidden in the tray when launched at login.', type: 'boolean' },
  { section: 'general', key: 'reopenLastWorkspace', title: 'Reopen last workspace', desc: 'Open the workspace you used last when Hive starts.', tip: 'Sessions are never resumed automatically — only the workspace is reopened.', type: 'boolean' },
  { section: 'general', key: 'confirmOnQuit', title: 'Confirm before quitting', desc: 'When to ask before quitting stops running sessions.', tip: 'Quitting stops every running session. Their conversations are kept and can be resumed, so by default Hive only asks when an agent is in the middle of something (working, or waiting for your answer).', type: 'select', options: [{ value: 'working', label: 'When an agent is working' }, { value: 'always', label: 'Whenever sessions are running' }, { value: 'never', label: 'Never' }] },
  { section: 'general', key: 'progressPanel', title: 'Progress panel', desc: 'Show long runs agents report, such as tests and builds: how far along each is and the time left, in a panel on the right and on the taskbar button.', tip: 'Folded, the panel is a strip with a small bar per run; click it, or use Toggle Progress Panel in the command palette. Off hides the panel, the strip and the taskbar progress; agents can still report, and Hive ignores it.', type: 'boolean' },
  {
    section: 'general',
    key: 'progressCommands',
    title: 'Agents show long commands in the Progress panel',
    desc: 'Agents run tests, builds and other commands that take more than about 30 seconds through hive-progress without being asked, so they show in the panel. Off: only when you ask.',
    tip: "hive-progress runs the command unchanged (same output and exit code). Hive's session guidance tells agents to use it, so a change applies to agents started or restarted afterwards. With the Progress panel off, agents aren't told to use it either.",
    type: 'boolean',
    disabledBy: (s) => (s.general.progressPanel === false ? 'Turn on the Progress panel to use this.' : null)
  },
  { section: 'general', key: 'keepAwake', title: 'Keep the PC awake while agents work', desc: "Stop Windows from sleeping while an agent is working or waiting on background tasks, so it doesn't stop mid-task.", tip: 'Hive lets the PC sleep again as soon as no agent is working. The screen can still turn off and lock. On a laptop, "When plugged in" lets it sleep on battery.', type: 'select', options: [{ value: 'plugged-in', label: 'When plugged in' }, { value: 'always', label: 'Always, on battery too' }, { value: 'never', label: 'Never' }] },
  { section: 'general', key: 'dateFormat', title: 'Date format', desc: 'How dates show in Hive: sessions named by when they started, the session lists and their tooltips, exports.', tip: "System uses your Windows language's short date. Names you give sessions stay as you typed them: only the automatic ones (when a session started) follow this. How long ago something happened (\"2 hours ago\") stays, with the date on hover.", type: 'select', options: [{ value: 'ymd', label: 'yyyy-mm-dd (2026-10-04)' }, { value: 'dmy', label: 'dd/mm/yyyy (04/10/2026)' }, { value: 'mdy', label: 'mm/dd/yyyy (10/04/2026)' }, { value: 'system', label: 'System' }] },
  { section: 'general', key: 'timeFormat', title: 'Time format', desc: 'How times show with the dates.', tip: 'Applies wherever Hive shows a time, such as a session that started today or the time a screenshot was pasted.', type: 'select', options: [{ value: '24h', label: '24-hour (14:05)' }, { value: '12h', label: '12-hour (2:05 PM)' }] },
  { section: 'general', key: 'showTips', title: 'Show a tip when Hive starts', desc: 'One tip a day about something Hive can do, and a tip at the moments one helps.', tip: 'Tips show in a small card in the bottom corner and never get in the way. Help → Tips… lists them all, whether this is on or off.', type: 'boolean' },
  // Updates
  { section: 'updates', key: 'status', title: 'Hive version', desc: '', tip: 'The version you are running and the result of the last check.', type: 'custom' },
  { section: 'updates', key: 'checkAutomatically', title: 'Check for updates automatically', desc: 'Look for a new version of Hive shortly after it starts and every 6 hours.', tip: 'When off, Hive only checks when you choose Help → Check for Updates. Development builds never update.', type: 'boolean' },
  { section: 'updates', key: 'downloadAutomatically', title: 'Download updates automatically', desc: 'Download a new version in the background as soon as it is found.', tip: 'When off, the status bar says a new version is available and you choose when to download it. Downloads are checked against the release checksum.', type: 'boolean' },
  { section: 'updates', key: 'install', title: 'Install updates', desc: 'When a downloaded update is installed.', tip: 'Automatically: the update installs when you next quit Hive (never while it is running, so your sessions are not interrupted); Restart and Update installs it straight away. Manually: it installs only when you choose Restart and Update. Either way, Hive asks before stopping agents that are working.', type: 'select', options: [{ value: 'auto', label: 'Automatically, when Hive quits' }, { value: 'manual', label: 'Manually, with Restart and Update' }] },
  { section: 'updates', key: 'prerelease', title: 'Include pre-releases', desc: 'Also offer beta versions published before a full release.', tip: 'Pre-releases get new features first and may have rough edges. Turning this off again waits for the next full release rather than going back.', type: 'boolean' },
  // Keyboard shortcuts
  { section: 'keybindings', key: 'editor', title: 'Shortcuts', desc: 'Click the pencil (or double-click a shortcut), then press the new keys. Wait a moment after the first combination, or press a second one for a chord such as Ctrl+K Ctrl+S.', tip: "Shortcuts need Ctrl or Alt (or are F-keys). Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Ctrl+Z, Ctrl+Y and Shift+Tab stay with editing and the agents' terminals. Some keys go to the agent while its terminal has focus (for Claude Code: Ctrl+B, Ctrl+K, Ctrl+O, Ctrl+R, Ctrl+T and Ctrl+G).", type: 'custom', wide: true },
  // Appearance
  { section: 'appearance', key: 'theme', title: 'Theme', desc: 'Colour theme for Hive.', tip: 'System follows your Windows light/dark setting.', type: 'select', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }] },
  { section: 'appearance', key: 'uiFontSize', title: 'Interface font size', desc: 'Font size for menus, lists and panels, in pixels.', tip: 'Use View → Zoom to scale everything, including the terminal.', type: 'number', min: 11, max: 18 },
  { section: 'appearance', key: 'terminalFontFamily', title: 'Terminal font', desc: 'Font family for session terminals (CSS font list).', tip: "Monospace fonts work best. Cascadia Code ships with Windows Terminal; Nerd Fonts add extra glyphs.", type: 'text' },
  { section: 'appearance', key: 'terminalFontSize', title: 'Terminal font size', desc: 'Font size for session terminals, in pixels.', tip: 'Applies to open terminals immediately.', type: 'number', min: 8, max: 28 },
  { section: 'appearance', key: 'terminalScrollback', title: 'Terminal scrollback', desc: 'Lines kept in each terminal for scrolling back.', tip: 'Higher values use more memory per running session.', type: 'number', min: 1000, max: 100000, step: 1000 },
  { section: 'appearance', key: 'terminalCursorBlink', title: 'Blinking cursor', desc: 'Blink the terminal cursor.', tip: 'Purely cosmetic.', type: 'boolean' },
  // Providers
  { section: 'providers', key: 'list', title: 'Providers', desc: 'Turn on the coding agents you want to use. Agents of a provider that is off stay listed but can\'t start.', tip: 'Each project agent runs one provider, chosen when you add it (Add Agent) or in its settings. A provider needs its CLI installed and signed in.', type: 'custom', wide: true },
  { section: 'providers', key: 'defaultProvider', title: 'Default provider', desc: 'The provider Add Agent uses for new agents (one click, with its default settings) unless the project chooses another.', tip: 'Projects can choose their own default in Project Settings. Agents keep the provider they were given; Add Agent… (▾) can choose another.', type: 'custom' },
  ...PROVIDERS.flatMap(providerRows),
  // Notifications
  { section: 'notifications', key: 'chimeEnabled', title: 'Completion chime', desc: 'Play a sound when an agent finishes or needs your input.', tip: 'Projects can override this in their settings.', type: 'boolean' },
  { section: 'notifications', key: 'chimeSound', title: 'Chime sound', desc: 'Which sound to play.', tip: 'Sounds are synthesised by Hive — no audio files needed.', type: 'custom' },
  { section: 'notifications', key: 'chimeVolume', title: 'Chime volume', desc: 'Volume of the chime.', tip: 'Independent of Windows notification sounds.', type: 'range', min: 0, max: 1, step: 0.05 },
  { section: 'notifications', key: 'desktopNotifications', title: 'Notifications', desc: 'Tell you when an agent finishes or needs input: in Hive while you use it, else with a Windows notification.', tip: 'Clicking one shows its project. Off, nothing is shown either way; the chime and the taskbar have settings of their own.', type: 'boolean' },
  { section: 'notifications', key: 'notifyOnFinished', title: 'Notify when an agent finishes', desc: 'Notify when a session completes its task.', tip: "Triggered when the agent's turn ends (its Stop hook), or for an agent waiting on background tasks it started, when they have ended.", type: 'boolean' },
  { section: 'notifications', key: 'notifyOnWaiting', title: 'Notify when input is needed', desc: 'Notify when a session is waiting for permission or input.', tip: "Triggered by the agent's permission prompts and questions.", type: 'boolean' },
  { section: 'notifications', key: 'taskbarCount', title: 'Show a count on the taskbar button', desc: "A badge on Hive's taskbar button, and the window title, show how many agents need you.", tip: 'The same count as the status bar: agents waiting for your input, and those that finished while you were not looking. Each window shows its own workspace.', type: 'boolean' },
  { section: 'notifications', key: 'flashOnWaiting', title: 'Flash the taskbar button when an agent needs input', desc: 'When an agent starts waiting for your answer while Hive is in the background.', tip: 'It stops when you switch to the window. Finishing agents never flash it.', type: 'boolean' },
  { section: 'notifications', key: 'whileFocused', title: 'While Hive is focused', desc: 'What to show while you are using a Hive window. With Hive in the background, a Windows notification.', tip: 'Show in Hive: a banner in the window you are using, where Windows notifications would cover the Assistant. The chime still plays either way.', type: 'select', options: [{ value: 'inApp', label: 'Show in Hive' }, { value: 'nothing', label: 'Show nothing' }, { value: 'windows', label: 'Windows notification' }] },
  { section: 'notifications', key: 'bannerScope', title: 'Show banners for', desc: 'Which notices the window you are using shows as banners.', tip: "Clicking a banner from another window brings that window up. A notice left out shows nothing, but still counts on its own window's taskbar button and in its inbox.", type: 'select', options: [{ value: 'all', label: 'All workspaces' }, { value: 'workspace', label: 'This workspace' }, { value: 'project', label: 'This project' }] },
  { section: 'notifications', key: 'bannerPosition', title: 'Banner position', desc: 'Where banners show in the window.', tip: 'Several stack, the newest nearest the edge.', type: 'select', options: [{ value: 'top-left', label: 'Top left' }, { value: 'top-center', label: 'Top centre' }, { value: 'top-right', label: 'Top right' }, { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-center', label: 'Bottom centre' }, { value: 'bottom-right', label: 'Bottom right' }] },
  { section: 'notifications', key: 'bannerSeconds', title: 'Finished banners close after (seconds)', desc: 'How long a banner for a finished agent, or another notice, stays.', tip: 'It stays while the pointer is on it.', type: 'number', min: 2, max: 60 },
  { section: 'notifications', key: 'waitingBannerStays', title: 'Banners for an agent waiting for you stay until handled', desc: 'Until you click or dismiss it, or answer the agent. Off, they close like the others.', tip: 'Answering the agent anywhere (its terminal, another window) closes its banner.', type: 'boolean' },
  // Sessions
  { section: 'sessions', key: 'backupTranscripts', title: 'Back up transcripts', desc: "Copy each session's transcript into the project's .hive/sessions folder.", tip: 'Agents delete old transcripts after a while (Claude Code: 30 days by default). Backups let you resume and review sessions later. Archived sessions are always preserved.', type: 'boolean' },
  { section: 'sessions', key: 'cacheTtl', title: 'Prompt cache lifetime', desc: 'Used to estimate whether resuming a session needs to re-cache its context.', tip: 'Auto detects the cache type from the transcript (5 minutes or 1 hour).', type: 'select', options: [{ value: 'auto', label: 'Auto-detect' }, { value: '5m', label: '5 minutes' }, { value: '1h', label: '1 hour' }] },
  { section: 'sessions', key: 'compactSuggestTokens', title: 'Suggest compacting above', desc: 'Context size, in tokens, at which the Compact button and the context count in the status bar turn orange. Never: the button never turns orange.', tip: 'Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript. Projects can set their own value in Project Settings, and the Assistant has its own (Settings → Assistant). Compact is always available once the agent has finished.', type: 'number', min: 1000, max: 2000000, step: 10000, off: 'Never' },
  { section: 'sessions', key: 'transcriptWarnMB', title: 'Warn when a transcript is over', desc: "Size, in MB, at which a running conversation's transcript turns orange in its footer and Hive notifies you once.", tip: "A long conversation slows down the CLI and Hive: each turn, resume and transcript view has more to read. Compacting doesn't shrink the file, which keeps the whole history; handing the work over to a new conversation does (click the size in the footer for Hand Over to…, and choose the agent itself). Projects can set their own value in Project Settings.", type: 'number', min: 1, max: 2000, step: 10, off: 'Never' },
  { section: 'sessions', key: 'overviewRefresh', title: 'Overview updates', desc: 'How the Overview and the session lists update while agents work.', tip: 'Live updates as sessions change, at most every 15 seconds and only while the tab is shown. Each update reads the project\'s session files, so with many sessions or agents a slower choice keeps Hive lighter. Refresh always updates at once.', type: 'select', options: [{ value: 'live', label: 'Live (at most every 15 s)' }, { value: 'minute', label: 'Every minute' }, { value: 'manual', label: 'Only when I click Refresh' }] },
  { section: 'sessions', key: 'followTranscripts', title: 'Follow running sessions in the transcript viewer', desc: 'The Sessions tab shows new messages of a running session as they arrive.', tip: 'Off: the transcript shows what was there when you opened it; Refresh loads what is new. You can also switch following on in the viewer itself. The Session tab always shows the agent working.', type: 'boolean' },
  { section: 'sessions', key: 'usageCacheSize', title: 'Usage cache size', desc: 'How many transcripts Hive remembers the token use of, so the Overview and session lists open without reading them again, also after a restart.', tip: 'Kept in usage-cache.json in your Hive profile: a few KB per transcript. A transcript is read again only when it changed (for example, a session you continued outside Hive), and the cache starts afresh with each Hive version. The least recently used go first when it is full. 100 to 50,000.', type: 'number', min: 100, max: 50000, step: 100 },
  { section: 'sessions', key: 'usageCacheClear', title: 'Clear the usage cache', desc: 'Forget what the cache holds; each transcript is read again the next time it is shown.', tip: 'Only needed if the token counts look wrong. Nothing else is lost: sessions, transcripts and backups stay as they are.', type: 'custom' },
  {
    section: 'sessions',
    key: 'recordPerformance',
    title: 'Record performance metrics',
    desc: "Count what Hive's Agent API, tools, guidance and skills cost, for the Performance view.",
    tip: "Only totals are kept: request and reply sizes, times and outcomes, the size of what each session was given, and the providers' own reported usage. Never prompts, replies, tokens or paths. Kept 30 days per workspace in .hive/metrics (git-ignored, this machine's). Turned off, nothing new is recorded; what was recorded stays until you reset it.",
    type: 'boolean'
  },
  { section: 'sessions', key: 'resetPerformance', title: 'Reset performance metrics', desc: "Clear this workspace's recorded performance metrics.", tip: 'Starts the history again from now. Session usage and transcripts are not affected.', type: 'custom' },
  { section: 'sessions', key: 'confirmStop', title: 'Confirm before stopping', desc: 'Ask before stopping a running session.', tip: 'Stopped sessions can always be resumed.', type: 'boolean' },
  // Workspace
  {
    section: 'workspace',
    key: 'hiddenProjects',
    title: 'Hidden and removed projects',
    desc: 'Restore one to bring it back with its cards (and, for a removed one, the handovers packed into its folder). A folder that has left the workspace can be forgotten.',
    tip: 'Project → Remove Project… hides a project, removes it from Hive (its folder keeps its handovers and cards in .hive/removed, so it can move to another workspace) or deletes it (to the Recycle Bin). Deleted projects are not listed here: restore the folder from the Recycle Bin and Hive sees it as a new project.',
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'storage',
    title: 'Storage',
    desc: "What Hive keeps for each of the workspace's projects (the biggest first) and the Hive Assistant: transcript backups, archived sessions, images and worktrees. Storage opens a project's page, with Clean Up….",
    tip: "Measured in the background, a project at a time. The coding agents' own transcripts (in ~/.claude and ~/.codex) aren't counted. Hidden projects aren't included.",
    type: 'custom',
    wide: true
  },
  // Agents
  {
    section: 'agents',
    key: 'fileLocks',
    title: 'File locks',
    desc: 'What happens when an agent tries to edit a file another agent in the same folder is editing.',
    tip: `${FILE_LOCK_MODES.map((m) => `${m.label}: ${m.description}`).join('\n')}\n\nAn agent claims a file when it edits it and releases it when its turn ends (or after 15 minutes). Agents in their own worktrees never collide. Edits made through shell commands are not covered.`,
    type: 'select',
    options: FILE_LOCK_MODES.map((m) => ({ value: m.value, label: m.label }))
  },
  { section: 'agents', key: 'worktreeCopy', title: 'Copy into new worktrees', desc: 'Git-ignored files copied from the project folder into each new worktree, comma separated (e.g. .env*, config/local.json).', tip: 'A new worktree only gets the files git tracks. Patterns without a slash match a file or folder name anywhere; with a slash they match a path from the project root. Projects can set their own list and a setup command (e.g. npm install) in Project Settings → Agents & Worktrees.', type: 'text', placeholder: '.env*' },
  { section: 'agents', key: 'mergeStyle', title: 'Default merge style', desc: "How a worktree agent's branch is merged back, unless you choose otherwise in the Merge dialog.", tip: "Merge keeps the agent's commits and their messages, plus a merge commit: right for an agent that keeps its worktree for task after task. Squash makes one commit with everything the agent did.", type: 'select', options: [{ value: 'merge', label: 'Merge commit' }, { value: 'squash', label: 'Squash' }] },
  { section: 'board', key: 'archiveDoneDays', title: 'Archive Done cards after', desc: 'Days a card stays in Done before Hive archives it.', tip: "Counted from when the card last went into Done (or was brought back from the archive), not from its last change. An archived card is kept: the board's Archived list shows it, and you can bring it back. Hive checks when a workspace opens and every hour.", type: 'number', min: 1, max: 365, step: 1, off: 'Never' },
  { section: 'board', key: 'columnColors', title: 'Colour columns', desc: "Give each column's heading its colour and tint its cards with it.", tip: 'A card takes the colour of the column it is in. Blocked, stalled and finished cards keep their red, amber and green edge, and their text, over the tint.', type: 'boolean' },
  { section: 'board', key: 'colors', title: 'Column colours', desc: 'Pick the colour of each column.', tip: 'The tint on cards is a light mix of the colour with the theme, so it works in light and dark themes. Reset puts back the default.', type: 'custom' },
  { section: 'agents', key: 'backgroundTaskMinutes', title: 'Count background tasks for up to', desc: 'Minutes an agent waits on a background task it started (such as a test run) before Hive counts it as finished anyway.', tip: "An agent that ends its turn while a task it started is still running shows as waiting on background tasks, not finished: Claude Code carries on by itself when the task ends. Hive can't tell a test run from something that never ends, such as a dev server, so it stops counting a task after this long (a Monitor also when it expires). Codex isn't told when its background terminals end, so they are only counted and shown. 10 to 480 minutes.", type: 'number', min: 10, max: 480, step: 5 },
  // Assistant
  { section: 'assistant', key: 'provider', title: 'Provider', desc: 'The coding agent the Assistant runs, unless a workspace chooses another.', tip: 'The Assistant is independent of your project agents: a Codex Assistant can look after Claude Code agents, and the other way round.', type: 'custom' },
  {
    section: 'assistant',
    key: 'control',
    title: 'Control',
    desc: 'What the Assistant may do beyond looking and advising, in every workspace.',
    tip: "Look and advise: it reads and suggests, and you act.\nControl agents: it can also add agents, change their settings, start and stop them, and give idle ones tasks, when you ask it to. Stopping a busy agent asks you first.\nControl agents and create projects: also new projects.\n\nIt never removes agents, discards worktrees or deletes projects, never types into an agent that is working, asking you something or that you just typed in (see Pause after you type), and makes at most 30 changes per message. What it does is listed in its panel. A running Assistant takes a change after a restart.",
    type: 'select',
    options: [
      { value: 'look', label: 'Look and advise' },
      { value: 'agents', label: 'Control agents' },
      { value: 'projects', label: 'Control agents and create projects' }
    ]
  },
  {
    section: 'assistant',
    key: 'changeSettings',
    title: 'Change settings',
    desc: "Let the Assistant change Hive's settings when you ask it to, in every workspace. Whatever this says, it can read and explain them.",
    tip: "It suggests a setting first and changes one only when you agree. Each change is listed in its panel with the old and new value and a Revert button, and counts towards its 30 changes per message. It can never change its own Control, permission modes, the Agent API or what Hive runs (CLI paths, extra arguments, setup commands): it tells you where to change those. A running Assistant takes a change after a restart.",
    type: 'boolean'
  },
  { section: 'assistant', key: 'typingPause', title: 'Pause after you type', desc: "Seconds after you type in an agent's terminal before the Assistant may type there (give it a task or hand its work over).", tip: "The Assistant types a task by clearing the agent's input line (Ctrl+U) and entering it, which would wipe or mix with something you were writing. During the pause it asks you instead.", type: 'number', min: 1, max: 600, off: 'No pause' },
  { section: 'assistant', key: 'enterEndsPause', title: 'Enter ends the pause', desc: 'Once you press Enter in the terminal (you sent what you typed), the Assistant may type there at once.', tip: 'Turn this off if you often type a line and then keep writing (e.g. answering a question, then adding more).', type: 'boolean' },
  { section: 'assistant', key: 'panelSide', title: 'Panel side', desc: "Which side of the window the Assistant's panel is on, in every workspace.", tip: 'On the left it sits between the project list and your work, which keeps it clear of Windows notifications and other windows at the bottom right. View → Move Assistant Panel… and the panel\'s ⋯ menu switch it too.', type: 'select', options: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }] },
  { section: 'assistant', key: 'compactSuggestTokens', title: 'Highlight Compact over', desc: "Context size, in tokens, at which the Assistant's Compact button and the context count in its footer turn orange. Never: they never do.", tip: "The Assistant usually runs a bigger context than your agents, so it has its own threshold (your agents' is Settings → Sessions → Suggest compacting above). Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript.", type: 'number', min: 1000, max: 2000000, step: 10000, off: 'Never' },
  { section: 'assistant', key: 'persona', title: 'Default persona', desc: 'Who the Assistant is in a new conversation, unless a workspace chooses another.', tip: 'Personas are Markdown files in each workspace (.hive/personas): edit them, or add your own, in the Hive Assistant view (the robot on the left).', type: 'custom' },
  ...PROVIDERS.map(
    (p): Row => ({
      section: 'assistant',
      key: `provider:${p.id}`,
      title: `With ${p.name}`,
      desc: `The model, effort, permission mode${p.capabilities.contextLimit ? ', context' : ''} and extra arguments when the Assistant runs ${p.name}. Default follows ${p.name}'s own settings, except the mode: ${permissionLabel(p.id, p.assistantMode)}, where ${p.name} approves safe actions itself and only asks about risky ones.`,
      tip: "By default it uses the same model and effort as your agents. A lighter model or low effort saves tokens but makes it careless (for example, saying it will check on an agent later and never doing so). Its default mode is the one your agents default to, so it rarely asks. Hive's own tools never ask: what they may do is set by Control above.",
      type: 'custom',
      wide: true
    })
  ),
  // Each field of those rows, for the tools (the row above draws them together).
  ...PROVIDERS.flatMap(assistantProviderRows),
  // Agent API
  { section: 'agentApi', key: 'status', title: 'Status', desc: '', tip: 'Whether the Agent API is listening.', type: 'custom' },
  { section: 'agentApi', key: 'enabled', title: 'Enable Agent API', desc: 'Run a local HTTP API that agents and scripts can use to talk to Hive.', tip: "Listens on 127.0.0.1 only and requires the bearer token below. See Help → Agent API Reference. Turned off, the port still answers the Hive Assistant alone (it has its own token, and Settings → Assistant → Control decides what it may do).", type: 'boolean' },
  { section: 'agentApi', key: 'port', title: 'Port', desc: 'Local port for the Agent API.', tip: 'Change this if the port is used by another program.', type: 'number', min: 1024, max: 65535 },
  { section: 'agentApi', key: 'provideHiveMcp', title: 'Provide Hive tools to sessions', desc: 'Add the built-in "hive" MCP server to every session.', tip: 'Gives agents tools for shared notes, handovers, project status and notifications.', type: 'boolean' },
  {
    section: 'agentApi',
    key: 'allowSessionInput',
    title: 'Allow sending input to sessions',
    desc: 'Let API clients type into running sessions (POST /v1/projects/{name}/input).',
    tip: 'Powerful: an agent in one project could drive another project\'s session. Keep off unless you need orchestration.',
    type: 'boolean',
    danger: true,
    confirmOn: { title: 'Allow API input to sessions?', message: 'Any program with the API token will be able to type commands into running sessions.' }
  },
  { section: 'agentApi', key: 'token', title: 'Access token', desc: 'Bearer token required by the Agent API.', tip: 'Stored in %APPDATA%\\Hive\\agent-api.json. Sessions receive it automatically as HIVE_API_TOKEN.', type: 'custom' },
  // Advanced
  { section: 'advanced', key: 'logs', title: 'Logs', desc: 'Open the folder containing Hive\'s log files.', tip: 'Useful when reporting a problem.', type: 'custom' },
  { section: 'advanced', key: 'data', title: 'Settings file', desc: 'Hive keeps its settings in %APPDATA%\\Hive\\config.json.', tip: 'Project settings live in each project\'s .hive folder; workspace settings in the workspace .hive folder.', type: 'custom' },
  { section: 'advanced', key: 'reset', title: 'Reset all settings', desc: 'Restore every setting on this page to its default. Workspaces and projects are not affected.', tip: 'Recent workspaces and window position are kept.', type: 'custom', danger: true }
]

/** The settings on one provider's page, from its descriptor. */
function providerRows(p: ProviderDescriptor): Row[] {
  const section = providerSection(p.id)
  const safe = p.permissionModes.filter((m) => !m.danger)
  const danger = p.permissionModes.find((m) => m.danger)
  const defs: Row[] = [
    { section, provider: p.id, key: 'enabled', title: `Use ${p.name}`, desc: `Let project agents run ${p.name}.`, tip: `When off, ${p.name} agents stay listed but can't start, and Hive doesn't check for its CLI.`, type: 'custom' },
    { section, provider: p.id, key: 'status', title: 'Installation', desc: '', tip: `Where Hive found ${p.name}, whether it is signed in and whether an update is available.`, type: 'custom' },
    { section, provider: p.id, key: 'executablePath', title: 'CLI path', desc: `Full path to the ${p.name} CLI (${p.cliName}.exe). Leave empty to detect it automatically.`, tip: 'Detection checks PATH and the usual install folders. Copies bundled with editor extensions (VS Code, Cursor…) are never used — Hive requires the standalone CLI.', type: 'text', placeholder: 'Auto-detect' },
    { section, provider: p.id, key: 'checkUpdatesOnLaunch', title: 'Check for updates on launch', desc: 'Compare the installed version with the latest release when Hive starts.', tip: `Hive never updates ${p.name} without asking. Standalone installs may also update themselves.`, type: 'boolean' },
    { section, provider: p.id, key: 'defaultModel', title: 'Default model', desc: `Model for ${p.name} sessions unless a project overrides it. ${p.name} default uses its own choice.`, tip: 'Whether your account can use a model is only known when a session starts.', type: 'custom' },
    { section, provider: p.id, key: 'defaultEffort', title: 'Default effort', desc: 'Reasoning effort unless a project overrides it. The levels are the default model\'s, as the CLI reports them.', tip: 'Higher effort is more thorough but slower and uses more tokens.', type: 'custom' },
    {
      section,
      provider: p.id,
      key: 'defaultPermissionMode',
      title: 'Default permission mode',
      desc: 'The mode sessions start in unless a project overrides it.',
      tip: safe.map((m) => `${m.label}: ${m.description}`).join('\n'),
      type: 'select',
      options: safe.map((m) => ({ value: m.value, label: m.label }))
    }
  ]
  if (danger) {
    defs.push({
      section,
      provider: p.id,
      key: 'enableDangerousMode',
      title: `Enable the ${danger.label} option`,
      desc: `Allow projects and agents to choose "${danger.label}", where the agent runs every action without asking.`,
      tip: `${danger.label} is never a global default. When turned off, projects and agents using it return to Inherit.`,
      type: 'boolean',
      danger: true,
      confirmOn: {
        title: `Enable the ${danger.label} option?`,
        message: `Projects will be able to run sessions where ${p.name} executes every command, file edit and network request without asking.`,
        detail: 'Recommended only for disposable environments. Each project still has to choose it, and doing so asks for confirmation.'
      }
    })
  }
  if (p.capabilities.contextLimit) {
    defs.push({
      section,
      provider: p.id,
      key: 'use200kContext',
      title: 'Use 200K context (instead of 1M)',
      desc: `Run ${p.name} sessions with a 200K-token context window instead of the model's 1M one, unless a project or agent chooses otherwise. Applies to sessions started afterwards.`,
      tip: `Current models have a 1M window at no extra price per token, but a long conversation sends more tokens with every message, and answers slow down as the context fills. With 200K, ${p.name} compacts the conversation sooner.`,
      type: 'boolean'
    })
  }
  if (p.capabilities.backgroundSessions) {
    defs.push({
      section,
      provider: p.id,
      key: 'allowBackgroundSessions',
      title: 'Allow background sessions',
      desc: `Let ${p.name}'s agent view move a session into its own background service. Applies to sessions started afterwards.`,
      tip: `Off by default. In ${p.name}, pressing ← on an empty prompt (easy to do while moving through text) opens its agent view and moves the session into the background. Hive can then no longer see it or stop it: Stop only closes the terminal, the session keeps running, and resuming it fails until it is stopped with "${p.cliName} stop".`,
      type: 'boolean'
    })
  }
  defs.push({ section, provider: p.id, key: 'extraArgs', title: 'Extra arguments', desc: `Additional ${p.cliName} command-line arguments for every session.`, tip: 'Projects can add more in their own settings.', type: 'text', placeholder: 'e.g. --verbose' })
  defs.push({
    section,
    provider: p.id,
    key: 'modelFallback',
    title: 'Models (fallback)',
    desc: `Hive asks ${p.name} which models it has and what each can do. This list is only used when it can't be asked (not installed, too old, or an unexpected answer).`,
    tip: `Add, remove and rename models; a custom model ID can still be typed in any model picker. Reset to defaults goes back to Hive's list, which then follows Hive's updates.`,
    type: 'custom',
    wide: true
  })
  defs.push({
    section,
    provider: p.id,
    key: 'effortFallback',
    title: 'Effort levels (fallback)',
    desc: `The effort levels offered when ${p.name} doesn't report a model's own. With the CLI's answer, each model offers just the levels it takes.`,
    tip: `The value is what Hive passes to ${p.name}; the name is what the pickers and footer show.`,
    type: 'custom',
    wide: true
  })
  defs.push({
    section,
    provider: p.id,
    key: 'prices',
    title: 'API prices',
    desc: p.capabilities.reportsCost
      ? `${p.name} reports each session's cost itself; these prices are only used for sessions without one. USD per million tokens.`
      : `Used to estimate what ${p.name} sessions would cost at API prices (shown with ≈ on the Overview). USD per million tokens.`,
    tip: `Hive's starting prices are the published ones, checked ${PRICES_CHECKED}: edit any that are out of date, add models and remove them. Hive never fetches prices. On a subscription you are not charged these — they show how heavy the work was.`,
    type: 'custom',
    wide: true
  })
  return defs
}

/** Project Settings' sections, in order (the view adds their icons). */
export const PROJECT_SETTINGS_SECTIONS: { id: string; label: string; desc: string; provider?: ProviderId }[] = [
  { id: 'agents', label: 'Agents & Worktrees', desc: 'The project’s agents and their providers, file locks between them, and how new worktrees are set up.' },
  ...PROVIDERS.map((p) => ({ id: `provider:${p.id}`, label: p.name, provider: p.id, desc: `Model, effort and permissions for this project’s ${p.name} agents. Agents can override these for themselves.` })),
  { id: 'sessions', label: 'Sessions', desc: 'Compacting and notifications for this project.' },
  { id: 'storage', label: 'Storage', desc: 'What Hive keeps for this project: transcript backups, archived sessions, images and the agents’ worktrees. Clean Up… moves old backups and images to the Recycle Bin.' },
  { id: 'keys', label: 'Keyboard Shortcuts', desc: 'Shortcuts for project and session commands while this project is selected, over the global ones.' },
  { id: 'advanced', label: 'Advanced', desc: 'Where the settings are stored, and resetting them.' }
]

const INHERIT = { value: 'inherit', label: 'Inherit' }
const ON_OFF = [INHERIT, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]

/** A project's model, effort, mode, context and arguments for one provider (Project Settings → <provider>). */
function projectProviderRows(p: ProviderDescriptor): Row[] {
  const section = `provider:${p.id}`
  return [
    { section, provider: p.id, key: 'model', title: 'Model', desc: `Model for this project's ${p.name} agents. Inherit uses Settings → ${p.name} → Default model.`, tip: `Passed to ${p.name} when a session starts. Agents can choose their own.`, type: 'custom' },
    { section, provider: p.id, key: 'effort', title: 'Effort', desc: 'How much reasoning effort the model uses. Higher is more thorough but slower and uses more tokens.', tip: `Passed to ${p.name} when a session starts. Inherit uses Settings → ${p.name} → Default effort.`, type: 'custom' },
    {
      section,
      provider: p.id,
      key: 'permissionMode',
      title: 'Permission mode',
      desc: `The mode this project's ${p.name} sessions start in. Inherit uses Settings → ${p.name} → Default permission mode.`,
      tip: `${p.permissionModes.map((m) => `${m.label}: ${m.description}`).join('\n')}${p.capabilities.liveModeSwitch === 'cycle' ? '\n\nYou can still switch modes inside a running session with Shift+Tab.' : ''}`,
      type: 'custom'
    },
    ...(p.capabilities.contextLimit
      ? [{ section, provider: p.id, key: 'use200kContext', title: 'Use 200K context (instead of 1M)', desc: `A 200K-token context window for this project's ${p.name} agents instead of the model's 1M one. Inherit uses Settings → ${p.name}.`, tip: 'Applies to sessions started afterwards. Agents can choose for themselves.', type: 'select' as const, options: ON_OFF }]
      : []),
    { section, provider: p.id, key: 'extraArgs', title: 'Extra arguments', desc: `Additional ${p.cliName} command-line arguments for this project, added after the global ones.`, tip: 'Split like a command line; quote arguments with spaces.', type: 'text', placeholder: '--add-dir ../lib' }
  ]
}

const PROJECT_ROWS: Row[] = [
  { section: 'agents', key: 'defaultProvider', title: 'Default provider', desc: "The provider Add Agent uses for this project's new agents (the dialog can choose another). Inherit uses Settings → Providers → Default provider.", tip: 'Each agent keeps the provider it was given; change it in the agent’s settings.', type: 'custom' },
  ...PROVIDERS.flatMap(projectProviderRows),
  { section: 'sessions', key: 'compactSuggestTokens', title: 'Suggest compacting above', desc: 'Context size (tokens) at which Compact is highlighted for this project. Empty inherits Settings → Sessions → Suggest compacting above.', tip: 'Only changes when the Compact button turns orange; compacting is always available once the agent has finished.', type: 'number', min: 1000, max: 2000000, step: 10000, off: 'Never' },
  { section: 'sessions', key: 'transcriptWarnMB', title: 'Warn when a transcript is over', desc: "Size, in MB, at which a running conversation's transcript is flagged for this project. Empty inherits Settings → Sessions → Warn when a transcript is over.", tip: 'A long conversation slows down the CLI and Hive; handing the work over to a new conversation makes it short again.', type: 'number', min: 1, max: 2000, step: 10, off: 'Never' },
  { section: 'sessions', key: 'chime', title: 'Completion chime', desc: 'Play a sound when an agent in this project finishes or needs input.', tip: 'Inherit follows Settings → Notifications.', type: 'select', options: ON_OFF },
  { section: 'storage', key: 'storage', title: 'What Hive keeps', desc: 'Measured in the background; Refresh measures again. The coding agents’ own transcripts (in ~/.claude and ~/.codex) aren’t counted, and Clean Up… never touches them.', type: 'custom', wide: true },
  { section: 'keys', key: 'keybindings', title: 'Shortcuts', desc: 'Change one to give this project its own; Reset returns it to the global shortcut. Stored in the project’s .hive folder, which is not committed.', type: 'custom', wide: true },
  { section: 'agents', key: 'agents', title: 'Agents', desc: "Up to 12 agents can work on the project at once, each in the project folder or its own worktree. Agents without their own settings use this project's.", type: 'custom', wide: true },
  {
    section: 'agents',
    key: 'fileLocks',
    title: 'File locks',
    desc: "What happens when an agent tries to edit a file another agent in this project's folder is editing. Inherit uses Settings → Agents & Worktrees → File locks.",
    tip: `${FILE_LOCK_MODES.map((m) => `${m.label}: ${m.description}`).join('\n')}\n\nApplies to agents sharing a folder (agents in their own worktrees never collide). An agent claims a file when it edits it and releases it when its turn ends. Edits made through shell commands are not covered.`,
    type: 'select',
    options: [INHERIT, ...FILE_LOCK_MODES.map((m) => ({ value: m.value, label: m.label }))]
  },
  { section: 'agents', key: 'worktreeCopy', title: 'Copy into new worktrees', desc: 'Git-ignored files to copy from the project folder into a new worktree, such as .env files. One pattern per line; empty inherits Settings → Agents & Worktrees → Copy into new worktrees.', tip: 'A new worktree only gets the files git tracks. Patterns without a slash match a file or folder name anywhere (e.g. .env*); with a slash they match a path from the project root (e.g. config/local.json). Large folders such as node_modules are better recreated by the setup command.', type: 'custom' },
  { section: 'agents', key: 'worktreeSetup', title: 'Setup command', desc: "Runs in a new worktree before its agent's first session, e.g. npm install. Its output shows in the agent's pane.", tip: 'Runs with cmd.exe in the worktree folder. If it fails, the pane offers to retry or to start the agent without it.', type: 'text', placeholder: 'npm install' },
  { section: 'advanced', key: 'metadata', title: 'Settings file', desc: "Stored in the project's .hive/project.json (excluded from git). Changes apply to new sessions; restart a running session to apply them.", type: 'custom' },
  { section: 'advanced', key: 'reset', title: 'Reset project settings', desc: 'Everything on this page goes back to Inherit. Agents, and skill and MCP opt-outs, are kept.', type: 'custom' }
]

// ---------------------------------------------------------------------------
// What the catalog adds to each row: its id and scope, the rows that hold no value, what the tools take for custom
// controls, the sensitive settings, restarts, "when it helps" and the user guide's heading.
// ---------------------------------------------------------------------------

/** Rows that hold no value: buttons, statuses, lists and views. */
const ACTIONS = new Set([
  'updates.status',
  'providers.list',
  'sessions.usageCacheClear',
  'sessions.resetPerformance',
  'workspace.hiddenProjects',
  'workspace.storage',
  'agentApi.status',
  'agentApi.token',
  'advanced.logs',
  'advanced.data',
  'advanced.reset',
  'project.storage',
  'project.keybindings',
  'project.agents',
  'project.metadata',
  'project.reset',
  ...PROVIDERS.map((p) => `${p.id}.status`),
  // The Assistant's "With <provider>" rows: their fields are entries of their own (assistant.<provider>.<key>).
  ...PROVIDERS.map((p) => `assistant.provider:${p.id}`)
])

/** Custom controls whose value the tools can set (checked by checkSettingValue). */
const CUSTOM_VALUES: Record<string, SettingEntry['value']> = {
  'notifications.chimeSound': 'select',
  'providers.defaultProvider': 'select',
  'assistant.provider': 'select',
  'assistant.persona': 'text',
  'project.defaultProvider': 'select',
  'project.worktreeCopy': 'text',
  'board.colors': 'table',
  ...Object.fromEntries(
    PROVIDERS.flatMap((p): [string, SettingEntry['value']][] => [
      [`${p.id}.enabled`, 'boolean'],
      [`${p.id}.defaultModel`, 'text'],
      [`${p.id}.defaultEffort`, 'effort'],
      [`${p.id}.modelFallback`, 'table'],
      [`${p.id}.effortFallback`, 'table'],
      [`${p.id}.prices`, 'table'],
      [`project.${p.id}.model`, 'text'],
      [`project.${p.id}.effort`, 'effort'],
      [`project.${p.id}.permissionMode`, 'select'],
      [`assistant.${p.id}.model`, 'text'],
      [`assistant.${p.id}.effort`, 'effort'],
      [`assistant.${p.id}.permissionMode`, 'select'],
      [`assistant.${p.id}.use200kContext`, 'select'],
      [`assistant.${p.id}.extraArgs`, 'text']
    ])
  )
}

/** Read-only to the Assistant because they decide what agents or the Assistant may do, or what runs (#186). */
const SENSITIVE: [RegExp, string][] = [
  [/^agentApi\./, 'The Agent API decides what other programs can do through Hive'],
  [/^assistant\.(control|changeSettings|typingPause|enterEndsPause)$/, "These are the Assistant's own permissions"],
  [/^assistant\.(provider|persona)$|^assistant\.provider:|^assistant\.[\w-]+\.\w+$/, 'It decides how the Assistant itself runs (its provider, persona, model, effort, mode and arguments)'],
  [/^(project\.)?[\w-]+\.(defaultPermissionMode|permissionMode|enableDangerousMode)$/, 'A permission mode decides how much agents do without asking'],
  [/^(project\.)?[\w-]+\.(executablePath|extraArgs)$/, 'It decides what Hive runs: a CLI and its arguments'],
  [/^[\w-]+\.allowBackgroundSessions$/, "It lets sessions run out of Hive's reach (Hive can't see or stop them)"],
  [/^project\.worktreeSetup$/, 'It is a command Hive runs in every new worktree'],
  [/^updates\.prerelease$/, 'It decides which builds of Hive install']
]

/** Read-only to the Assistant for now, though not sensitive (#186: keybindings). */
const READ_ONLY: [RegExp, string][] = [[/^keybindings\./, 'Shortcuts are read-only to the Assistant for now']]

const RESTART: [RegExp, NonNullable<SettingEntry['restart']>][] = [
  [/^(project\.)?[\w-]+\.(executablePath|defaultModel|defaultEffort|model|effort|extraArgs|use200kContext|allowBackgroundSessions|defaultPermissionMode|permissionMode)$/, 'sessions'],
  [/^general\.progressCommands$|^agentApi\.provideHiveMcp$/, 'sessions'],
  [/^assistant\.(control|changeSettings|provider|persona)$|^assistant\.provider:|^assistant\.[\w-]+\.\w+$/, 'assistant']
]

/** When a setting is worth suggesting: the signal to look for (the tune-settings skill reads these). */
const HELPS: Record<string, string> = {
  'general.progressPanel': "Agents run long tests or builds and the user can't see how far along they are.",
  'general.progressCommands': "Agents' long commands don't show in the Progress panel, or the user wants them shown only on request.",
  'general.keepAwake': 'Long runs stop when the PC sleeps (agents left working while the user is away).',
  'general.confirmOnQuit': 'The user quits Hive and stops agents by mistake, or finds the question tiresome.',
  'general.dateFormat': 'Session names and lists show dates in a format the user finds unfamiliar.',
  'general.showTips': 'The user finds the daily tip distracting, or wants to learn what Hive can do.',
  'appearance.uiFontSize': 'Menus and panels are hard to read at the current size.',
  'appearance.terminalFontSize': "The agents' terminals are hard to read, or too little fits.",
  'notifications.chimeEnabled': 'The chime distracts the user during focused work, or they miss agents finishing.',
  'notifications.desktopNotifications': 'Too many notifications, or agents waiting for the user go unnoticed.',
  'notifications.whileFocused': 'Banners interrupt the user while they work in Hive.',
  'notifications.flashOnWaiting': 'Agents wait for answers while Hive is in the background and nobody notices.',
  'sessions.backupTranscripts': 'Old conversations should stay readable after the CLI deletes its transcripts.',
  'sessions.compactSuggestTokens': 'Agents work with big contexts for long stretches, so every message costs more: a lower threshold suggests compacting sooner.',
  'sessions.transcriptWarnMB': "Agents' transcripts grow to tens of MB and typing or the CLI slows down: a lower value flags them sooner, for a handover to a new conversation.",
  'sessions.confirmStop': 'Agents get stopped by mistake.',
  'sessions.followTranscripts': 'The user reads running sessions in the Sessions tab and wants new messages to appear as they come.',
  'assistant.compactSuggestTokens': "The Assistant's own conversation gets long and slow: a lower threshold suggests compacting it sooner.",
  'assistant.panelSide': 'Windows notifications or other apps cover the right of the screen.',
  'board.archiveDoneDays': 'The Done column has grown long with finished cards.',
  'agents.fileLocks': 'Several agents work in the same project folder and edit the same files.',
  'agents.worktreeCopy': "New worktrees miss git-ignored files such as .env, so agents' builds or tests fail there.",
  'agents.backgroundTaskMinutes': "Agents' background tasks (long test runs) count as finished too soon, or a dev server keeps an agent waiting long after its work is done.",
  'project.compactSuggestTokens': "One project's conversations run much longer than others'.",
  'project.transcriptWarnMB': "One project's conversations grow much bigger than others'.",
  'project.fileLocks': "This project's agents share its folder and edit the same files.",
  'project.worktreeCopy': 'New worktrees of this project miss git-ignored files its builds need.',
  ...Object.fromEntries(PROVIDERS.filter((p) => p.capabilities.contextLimit).map((p) => [`${p.id}.use200kContext`, `${p.name} conversations get slow and costly as they grow: a 200K window makes ${p.name} compact sooner.`]))
}

/** The user guide's heading for each section (Help → User Guide). */
const DOCS: Record<string, string> = {
  general: 'Getting started',
  updates: 'Updating Hive',
  appearance: 'Getting started',
  providers: 'Coding agents: Claude Code and Codex',
  notifications: 'Notifications',
  sessions: 'Sessions',
  assistant: 'Assistant settings',
  workspace: 'Workspaces and projects',
  board: 'Task board',
  agents: 'Several agents in one project',
  keybindings: 'Keyboard shortcuts',
  agentApi: 'The built-in `hive` server',
  advanced: 'Troubleshooting'
}
const DOCS_BY_ID: Record<string, string> = {
  'general.progressPanel': 'Progress panel',
  'general.progressCommands': 'Progress panel',
  'general.keepAwake': 'Sleep and shutdown',
  'general.dateFormat': 'Dates and times',
  'general.timeFormat': 'Dates and times',
  'general.showTips': 'Tips',
  'sessions.transcriptWarnMB': 'Long conversations',
  'sessions.backupTranscripts': 'Archiving and backups',
  'sessions.recordPerformance': 'Performance metrics',
  'agents.backgroundTaskMinutes': 'Sessions'
}

function settingPathOf(row: Row, scope: SettingScope): string {
  if (scope === 'project') return `Project Settings → ${PROJECT_SETTINGS_SECTIONS.find((s) => s.id === row.section)?.label ?? row.section} → ${row.title}`
  if (row.assistantProvider) return `Settings → Assistant → With ${providerDescriptor(row.assistantProvider).name} → ${row.title}`
  return `Settings → ${SETTINGS_SECTIONS.find((s) => s.id === row.section)?.label ?? row.section} → ${row.title}`
}

function entry(row: Row, id: string, scope: SettingScope, docs: string): SettingEntry {
  const sensitive = SENSITIVE.find(([re]) => re.test(id))
  const readOnly = READ_ONLY.find(([re]) => re.test(id))
  const action = ACTIONS.has(id)
  const value = row.type === 'custom' ? CUSTOM_VALUES[id] : undefined
  const restart = RESTART.find(([re]) => re.test(id))?.[1]
  return {
    ...row,
    id,
    scope,
    tip: row.tip ?? '',
    docs: DOCS_BY_ID[id] ?? docs,
    ...(HELPS[id] ? { helps: HELPS[id] } : {}),
    ...(action ? { action: true } : {}),
    ...(value ? { value } : {}),
    ...(sensitive && !action ? { sensitive: true, readOnly: `${sensitive[1]}: only the user can change it, in ${settingPathOf(row, scope)}.` } : readOnly ? { readOnly: `${readOnly[1]}: the user changes them in ${settingPathOf(row, scope)}.` } : {}),
    ...(restart ? { restart } : {}),
    ...(scope === 'project' && !action && row.key !== 'worktreeSetup' ? { inherits: true } : {})
  }
}

/** Where the user finds it: "Settings → Sessions → Suggest compacting above", "Project Settings → Claude Code → Model". */
export const settingPath = (e: SettingEntry): string => settingPathOf(e, e.scope)

/** Settings' entries (Hive's and the providers' pages), in their order. */
export const APP_SETTINGS_CATALOG: readonly SettingEntry[] = APP_ROWS.map((r) =>
  r.provider ? entry(r, `${r.provider}.${r.key}`, 'provider', 'Coding agents: Claude Code and Codex') : entry(r, `${r.section}.${r.key}`, r.section === 'workspace' ? 'workspace' : 'app', DOCS[r.section] ?? 'Getting started')
)

/** Project Settings' entries, in their order. */
export const PROJECT_SETTINGS_CATALOG: readonly SettingEntry[] = PROJECT_ROWS.map((r) => entry(r, r.provider ? `project.${r.provider}.${r.key}` : `project.${r.key}`, 'project', 'Project settings'))

/** Every setting, Settings' then Project Settings'. */
export const SETTINGS_CATALOG: readonly SettingEntry[] = [...APP_SETTINGS_CATALOG, ...PROJECT_SETTINGS_CATALOG]

export function settingEntry(id: string): SettingEntry | undefined {
  return SETTINGS_CATALOG.find((e) => e.id === id)
}

// ---------------------------------------------------------------------------
// Values: where each entry's value lives, its default, checking a new one, and the change that sets it.
// ---------------------------------------------------------------------------

/** A setting's value now: in Hive's settings, or in a project's config ('inherit' or null for one that inherits). */
export function settingValue(e: SettingEntry, settings: AppSettings, project?: ProjectConfig | null): unknown {
  if (e.action) return undefined
  if (e.scope === 'project') {
    if (!project) return undefined
    if (e.provider) return (projectProviderConfig(project, e.provider) as unknown as Record<string, unknown>)[e.key] ?? 'inherit'
    return (project as unknown as Record<string, unknown>)[e.key]
  }
  if (e.assistantProvider) return (settings.assistant?.providers?.[e.assistantProvider] as unknown as Record<string, unknown> | undefined)?.[fieldKey(e)] ?? ''
  if (e.id === 'providers.defaultProvider') return settings.defaultProvider
  if (e.provider) {
    const v = (providerSettings(settings, e.provider) as unknown as Record<string, unknown>)[e.key]
    // A fallback list nobody edited is Hive's own (an empty list).
    return (e.key === 'modelFallback' || e.key === 'effortFallback') && v === undefined ? [] : e.key === 'prices' ? (v ?? {}) : v
  }
  return (settings[e.section as keyof AppSettings] as unknown as Record<string, unknown> | undefined)?.[e.key]
}

/** A setting's default: Hive's, or for a project's, Inherit. */
export function settingDefault(e: SettingEntry): unknown {
  if (e.action) return undefined
  if (e.scope === 'project') return e.provider ? 'inherit' : (DEFAULT_PROJECT_CONFIG as unknown as Record<string, unknown>)[e.key]
  if (e.assistantProvider) return ''
  if (e.id === 'providers.defaultProvider') return DEFAULT_SETTINGS.defaultProvider
  if (e.provider) {
    if (e.key === 'modelFallback' || e.key === 'effortFallback') return []
    if (e.key === 'prices') return {}
    return (defaultProviderSettings(providerDescriptor(e.provider)) as unknown as Record<string, unknown>)[e.key]
  }
  return (DEFAULT_SETTINGS[e.section as keyof AppSettings] as unknown as Record<string, unknown> | undefined)?.[e.key]
}

/** An Assistant provider field's key in its settings ("model" of assistant.claude-code.model). */
const fieldKey = (e: SettingEntry): string => e.key.slice(e.key.indexOf('.') + 1)

/** The values a select setting (or a custom one the tools set as a select) takes. */
export function settingOptions(e: SettingEntry): { value: string; label: string }[] | null {
  if (e.options) return e.options
  const providers = PROVIDERS.map((p) => ({ value: p.id, label: p.name }))
  if (e.id === 'notifications.chimeSound') return ['chime', 'bell', 'soft', 'pop'].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))
  if (e.id === 'providers.defaultProvider') return providers
  if (e.id === 'assistant.provider') return [{ value: '', label: 'Default provider' }, ...providers]
  if (e.id === 'project.defaultProvider') return [INHERIT, ...providers]
  const modes = (p: ProviderId) => providerDescriptor(p).permissionModes.map((m) => ({ value: m.value, label: m.label }))
  if (e.scope === 'project' && e.provider && e.key === 'permissionMode') return [INHERIT, ...modes(e.provider)]
  if (e.assistantProvider && fieldKey(e) === 'permissionMode') return [{ value: '', label: 'Default' }, ...modes(e.assistantProvider)]
  if (e.assistantProvider && fieldKey(e) === 'use200kContext') return [{ value: '', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
  return null
}

/** What a setting takes from a tool: a boolean, number, option, text, effort level or table; null: nothing (an action, a read-only one). */
export function settingKind(e: SettingEntry): 'boolean' | 'number' | 'select' | 'text' | 'effort' | 'table' | null {
  if (e.action || (e.readOnly && !e.sensitive)) return null
  if (e.type === 'boolean') return 'boolean'
  if (e.type === 'number' || e.type === 'range') return 'number'
  if (e.type === 'select') return 'select'
  if (e.type === 'text') return 'text'
  return e.value ?? null
}

/** What checking a value can use besides the catalog: the effort levels offered where it applies (the pickers' list). */
export interface SettingContext {
  /** The levels the effort picker offers for this setting (its provider's run model's, else the fallback list). */
  efforts?: (e: SettingEntry) => { value: string; label: string }[]
}

const MAX_TEXT = 500
const COLOR = /^#[0-9a-f]{6}$/i
const COLUMNS = ['hold', 'todo', 'doing', 'review', 'passed', 'done']
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const price = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** A table's value checked: column colours, a provider's prices, or one of its fallback lists; null puts back Hive's. */
function checkTable(e: SettingEntry, raw: unknown): { value: unknown } | { error: string } {
  if (e.id === 'board.colors') {
    if (raw === null) return { value: { ...DEFAULT_SETTINGS.board.colors } }
    if (!isObject(raw) || !Object.keys(raw).length) return { error: `${e.title} takes an object of column → colour, e.g. {"doing":"#3b82f6"} (columns: ${COLUMNS.join(', ')}), or null for Hive's.` }
    const bad = Object.entries(raw).find(([k, v]) => !COLUMNS.includes(k) || typeof v !== 'string' || !COLOR.test(v))
    if (bad) return { error: `${e.title}: "${bad[0]}" isn't a column with a #rrggbb colour (columns: ${COLUMNS.join(', ')}).` }
    return { value: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v).toLowerCase()])) }
  }
  if (e.key === 'prices') {
    if (raw === null) return { value: {} }
    if (!isObject(raw)) return { error: `${e.title} takes an object of model → {input, cachedInput, output, cacheWrite?} in USD per million tokens, or null for Hive's prices.` }
    for (const [model, p] of Object.entries(raw)) {
      if (!model.trim() || !isObject(p) || !price(p.input) || !price(p.cachedInput) || !price(p.output) || (p.cacheWrite !== undefined && !price(p.cacheWrite))) return { error: `${e.title}: "${model}" needs input, cachedInput and output (and optionally cacheWrite), each a number from 0.` }
    }
    return { value: Object.fromEntries(Object.entries(raw).map(([m, p]) => [m.trim(), { input: (p as Record<string, number>).input, cachedInput: (p as Record<string, number>).cachedInput, output: (p as Record<string, number>).output, ...((p as Record<string, number>).cacheWrite !== undefined ? { cacheWrite: (p as Record<string, number>).cacheWrite } : {}) }])) }
  }
  // A fallback list: [{ value, label, older? }]; [] or null puts back Hive's own.
  if (raw === null) return { value: [] }
  if (!Array.isArray(raw)) return { error: `${e.title} takes a list of {value, label${e.key === 'modelFallback' ? ', older?' : ''}}, or null for Hive's list.` }
  const seen = new Set<string>()
  const list: Record<string, unknown>[] = []
  for (const r of raw) {
    if (!isObject(r) || typeof r.value !== 'string' || !r.value.trim() || (r.label !== undefined && typeof r.label !== 'string')) return { error: `${e.title}: each entry needs a value (text) and a label.` }
    const v = r.value.trim()
    if (seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    list.push({ value: v, label: (typeof r.label === 'string' && r.label.trim()) || v, ...(e.key === 'modelFallback' && r.older === true ? { older: true } : {}) })
  }
  return { value: list }
}

/**
 * A value as the setting takes it, or why not: the type, the range (0 where Never turns it off), the options, an effort
 * level the pickers offer, plain text of a sensible length, a table's shape. A project's number or list takes null (or
 * "inherit") to inherit Hive's.
 */
export function checkSettingValue(e: SettingEntry, raw: unknown, ctx: SettingContext = {}): { value: unknown } | { error: string } {
  const kind = settingKind(e)
  if (!kind) return { error: `${e.title} isn't a value that can be set this way (${e.action ? 'it is a button, a status or a list' : e.readOnly}): change it in ${settingPath(e)}.` }
  const inheritable = e.scope === 'project' && !!e.inherits
  if (inheritable && (raw === null || raw === 'inherit') && (kind === 'number' || kind === 'effort' || e.key === 'worktreeCopy')) return { value: kind === 'effort' ? 'inherit' : null }
  switch (kind) {
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'on' || raw === 'true') return { value: true }
      if (raw === 'off' || raw === 'false') return { value: false }
      return { error: `${e.title} takes true or false.` }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(/[,_\s]/g, '')) : NaN
      if (!Number.isFinite(n)) return { error: `${e.title} takes a number${e.off ? ` (0 for ${e.off})` : ''}${inheritable ? ', or null to inherit' : ''}.` }
      if (n === 0 && e.off) return { value: 0 }
      const min = e.min ?? -Infinity
      const max = e.max ?? Infinity
      if (n < min || n > max) return { error: `${e.title} takes ${min} to ${max}${e.off ? `, or 0 for ${e.off}` : ''}.` }
      return { value: e.step === undefined || e.step >= 1 ? Math.round(n) : n }
    }
    case 'select': {
      const options = settingOptions(e) ?? []
      const v = String(raw ?? '')
      const hit = options.find((o) => o.value === v) ?? options.find((o) => o.label.toLowerCase() === v.toLowerCase())
      if (!hit) return { error: `${e.title} takes one of: ${options.map((o) => (o.value === '' ? '"" (default)' : o.value)).join(', ')}.` }
      return { value: hit.value }
    }
    case 'effort': {
      // As the effort picker: the levels it offers for the model that would run, or the default ("" / inherit).
      const levels = ctx.efforts?.(e) ?? []
      const v = typeof raw === 'string' ? raw.trim() : ''
      if (typeof raw !== 'string') return { error: `${e.title} takes an effort level: ${effortTakes(e, levels)}.` }
      if (v === '' || v === 'inherit') return { value: e.scope === 'project' ? 'inherit' : '' }
      const hit = levels.find((l) => l.value.toLowerCase() === v.toLowerCase()) ?? levels.find((l) => l.label.toLowerCase() === v.toLowerCase())
      if (!hit) return { error: `${e.title} takes ${effortTakes(e, levels)}.` }
      return { value: hit.value }
    }
    case 'table':
      return checkTable(e, raw)
    case 'text': {
      if (typeof raw !== 'string') return { error: `${e.title} takes text.` }
      const v = raw.trim()
      if (v.length > MAX_TEXT || (/[\r\n]/.test(v) && e.id !== 'project.worktreeCopy')) return { error: `${e.title} takes one line of text (at most ${MAX_TEXT} characters).` }
      if (e.scope === 'project' && e.provider && e.key === 'model') return { value: v || 'inherit' }
      if (e.key === 'worktreeCopy' && e.scope === 'project') return { value: v || null }
      return { value: v }
    }
  }
}

/** The effort levels a setting takes, in words. */
export function effortTakes(e: SettingEntry, levels: { value: string }[]): string {
  const base = e.scope === 'project' ? '"inherit"' : '"" (the default)'
  return levels.length ? `one of: ${levels.map((l) => l.value).join(', ')}, or ${base}` : `${base} (no levels are known for its model)`
}

/**
 * The change that sets a checked value: a patch for Hive's settings, one for a project's config (from its current one),
 * or a table replaced whole (a provider's prices or fallback list: a deep merge can't remove an entry).
 */
export function settingPatch(
  e: SettingEntry,
  value: unknown
): { settings: Record<string, unknown> } | { project: (cfg: ProjectConfig) => Partial<ProjectConfig> } | { prices: { provider: ProviderId; value: Record<string, unknown> } } | { fallback: { provider: ProviderId; kind: 'models' | 'efforts'; list: unknown[] | null } } {
  if (e.scope === 'project') {
    const provider = e.provider
    if (provider) return { project: (cfg) => ({ providers: { ...cfg.providers, [provider]: { ...projectProviderConfig(cfg, provider), [e.key]: value } } }) }
    return { project: () => ({ [e.key]: value }) as Partial<ProjectConfig> }
  }
  if (e.assistantProvider) return { settings: { assistant: { providers: { [e.assistantProvider]: { [fieldKey(e)]: value } } } } }
  if (e.id === 'providers.defaultProvider') return { settings: { defaultProvider: value } }
  if (e.provider && e.key === 'prices') return { prices: { provider: e.provider, value: value as Record<string, unknown> } }
  if (e.provider && (e.key === 'modelFallback' || e.key === 'effortFallback')) return { fallback: { provider: e.provider, kind: e.key === 'modelFallback' ? 'models' : 'efforts', list: Array.isArray(value) && value.length ? value : null } }
  if (e.provider) return { settings: { providers: { [e.provider]: { [e.key]: value } } } }
  return { settings: { [e.section]: { [e.key]: value } } }
}

/**
 * A value as the tools show it: on/off, numbers as they are, Never for an off 0, inherit, "" as (empty); a table as
 * its size in a listing (`full`: as JSON, cut at 3,000 characters).
 */
export function settingValueText(e: SettingEntry, v: unknown, full = false): string {
  if (v === undefined) return '—'
  if (v === null || v === 'inherit') return 'inherit'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return v === 0 && e.off ? `0 (${e.off})` : String(v)
  if (typeof v === 'string') return v === '' ? '(empty)' : v
  if (!full) {
    const n = Array.isArray(v) ? v.length : Object.keys(v as object).length
    return n ? `(${n} ${Array.isArray(v) ? 'entries' : 'keys'})` : Array.isArray(v) ? "(Hive's list)" : '(none)'
  }
  const json = JSON.stringify(v)
  return json.length > 3000 ? `${json.slice(0, 2999)}…` : json
}

/**
 * A change as the activity list and the tool's reply show it, old and new: a plain value as settingValueText shows it;
 * a table by what changed in it (the entries of an object whose values differ, "doing: #3b82f6"; a list's values), each
 * side cut at 200 characters, so changing one colour reads as that colour, not as "(6 keys) → (6 keys)".
 */
export function settingChangeTexts(e: SettingEntry, old: unknown, now: unknown): { oldText: string; newText: string } {
  const cut = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
  if (Array.isArray(old) || Array.isArray(now)) {
    const values = (v: unknown): string => (Array.isArray(v) && v.length ? v.map((x) => (isObject(x) && typeof x.value === 'string' ? x.value : JSON.stringify(x))).join(', ') : "(Hive's list)")
    return { oldText: cut(values(old)), newText: cut(values(now)) }
  }
  if (isObject(old) || isObject(now)) {
    const a = isObject(old) ? old : {}
    const b = isObject(now) ? now : {}
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    const side = (o: Record<string, unknown>): string => (keys.length ? keys.map((k) => `${k}: ${k in o ? (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k])) : '(none)'}`).join(', ') : settingValueText(e, o))
    return { oldText: cut(side(a)), newText: cut(side(b)) }
  }
  return { oldText: settingValueText(e, old), newText: settingValueText(e, now) }
}

/** The label of a provider's permission mode, for messages. */
export const modeName = (provider: ProviderId, mode: string): string => permissionLabel(provider, mode)
