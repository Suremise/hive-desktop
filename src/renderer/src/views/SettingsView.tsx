import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ChimeSound, EffortLevel, ModelPrice, PermissionMode, ProviderId, TaskColumn } from '@shared/types'
import { DEFAULT_COLUMN_COLORS, TASK_COLUMNS, columnColor } from '@shared/tasks'
import { DEFAULT_PERSONA } from '@shared/assistant'
import { PRICES_CHECKED, SHIPPED_PRICES } from '@shared/prices'
import type { SettingsPatch } from '@shared/api'
import { DEFAULT_SETTINGS, FILE_LOCK_MODES } from '@shared/defaults'
import { PROVIDERS, defaultProviderSettings, enabledProviders, isProviderEnabled, offeredModes, permissionLabel, providerDescriptor, providerSettings, type ProviderDescriptor } from '@shared/providers'
import { usePersonas } from '../components/Assistant'
import { ModeCaveat } from '../components/AgentDialogs'
import { ModelPicker } from '../components/ModelPicker'
import { NumberField } from '../components/NumberField'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { playChime } from '../chime'
import { Icon, IconButton, InfoTip, Switch, Tooltip } from '../components/ui'
import { UpdateStatusRow } from '../components/Updates'
import { KeybindingsEditor } from '../components/Keybindings'
import { HiddenProjectsList } from '../components/ProjectRemoval'
import { choose, confirm, get, notify, set, useStore } from '../store'
import { cx } from '../util'

/** A settings section: a group of AppSettings, "providers" (turning them on), one provider's page ("provider:<id>"), or "advanced". */
type Section = keyof AppSettings | 'advanced' | 'workspace' | `provider:${string}`

interface SettingDef {
  section: Section
  /** For a provider page: the provider whose settings this reads and writes. */
  provider?: ProviderId
  key: string
  title: string
  desc: string
  tip: string
  type: 'boolean' | 'select' | 'number' | 'text' | 'range' | 'custom'
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  /** A number setting that 0 turns off: the label of its Off checkbox ("Never"). */
  off?: string
  placeholder?: string
  danger?: boolean
  render?: () => React.ReactNode
  /** Takes the full width under its title (e.g. a table). */
  wide?: boolean
  confirmOn?: { title: string; message: string; detail?: string }
}

const providerSection = (id: ProviderId): Section => `provider:${id}`

const SECTIONS: { id: Section; label: string; icon: string; desc: string; provider?: ProviderId }[] = [
  { id: 'general', label: 'General', icon: 'settings-gear', desc: 'Startup, window and tray behaviour.' },
  { id: 'updates', label: 'Updates', icon: 'cloud-download', desc: "Keeping Hive itself up to date. New versions come from Hive's GitHub releases and are verified before they install." },
  { id: 'appearance', label: 'Appearance', icon: 'symbol-color', desc: 'Theme, fonts and terminal look.' },
  { id: 'providers', label: 'Providers', icon: 'hubot', desc: 'The coding agents Hive can run. Turn on the ones you use; each has its own page below with its CLI and the defaults every project inherits.' },
  ...PROVIDERS.map((p) => ({ id: providerSection(p.id), label: p.name, icon: 'blank', provider: p.id, desc: `The ${p.name} CLI (the standalone one — copies bundled with editor extensions are not used) and the defaults every project inherits for ${p.name} agents.` })),
  { id: 'notifications', label: 'Notifications', icon: 'bell', desc: 'Chimes and desktop notifications when agents finish or need you.' },
  { id: 'sessions', label: 'Sessions', icon: 'history', desc: 'Transcript backups, cache estimates and session behaviour.' },
  { id: 'assistant', label: 'Assistant', icon: 'person', desc: "The Hive Assistant's defaults: the side panel's overseer of each workspace (Ctrl+Alt+I). Each workspace can change them in the panel's Assistant Settings." },
  { id: 'workspace', label: 'Workspace', icon: 'root-folder', desc: "The open workspace's projects that Hive leaves out: hidden, or removed from Hive with their handovers and cards packed into the folder." },
  { id: 'board', label: 'Board', icon: 'project', desc: "The task board's colours and housekeeping, the same in every workspace." },
  { id: 'agents', label: 'Agents & Worktrees', icon: 'organization', desc: 'Defaults for projects running several agents: file locks, new worktrees and merging (projects can override them), and how long background tasks count.' },
  { id: 'keybindings', label: 'Keyboard Shortcuts', icon: 'keyboard', desc: 'Change, remove or add shortcuts for any command. Projects can set their own for project and session commands (Project Settings → Keyboard Shortcuts).' },
  { id: 'agentApi', label: 'Agent API', icon: 'broadcast', desc: 'Local API and built-in MCP server that let agents interact with Hive.' },
  { id: 'advanced', label: 'Advanced', icon: 'tools', desc: 'Logs, data and resetting Hive.' }
]

const SETTINGS: SettingDef[] = [
  // General
  { section: 'general', key: 'closeToTray', title: 'Close to tray', desc: 'Closing the window keeps Hive running in the system tray so sessions continue.', tip: 'When off, closing the window quits Hive (asking first if sessions are running). Use File → Exit or the tray menu to quit.', type: 'boolean' },
  { section: 'general', key: 'minimizeToTray', title: 'Minimise to tray', desc: 'Minimising hides Hive to the system tray instead of the taskbar.', tip: 'Click the tray icon to bring Hive back.', type: 'boolean' },
  { section: 'general', key: 'startMinimized', title: 'Start in tray', desc: 'Start Hive hidden in the system tray.', tip: 'Useful together with "Launch at login".', type: 'boolean' },
  { section: 'general', key: 'launchAtLogin', title: 'Launch at login', desc: 'Start Hive automatically when you sign in to Windows.', tip: 'Hive starts hidden in the tray when launched at login.', type: 'boolean' },
  { section: 'general', key: 'reopenLastWorkspace', title: 'Reopen last workspace', desc: 'Open the workspace you used last when Hive starts.', tip: 'Sessions are never resumed automatically — only the workspace is reopened.', type: 'boolean' },
  { section: 'general', key: 'confirmOnQuit', title: 'Confirm before quitting', desc: 'When to ask before quitting stops running sessions.', tip: 'Quitting stops every running session. Their conversations are kept and can be resumed, so by default Hive only asks when an agent is in the middle of something (working, or waiting for your answer).', type: 'select', options: [{ value: 'working', label: 'When an agent is working' }, { value: 'always', label: 'Whenever sessions are running' }, { value: 'never', label: 'Never' }] },
  { section: 'general', key: 'keepAwake', title: 'Keep the PC awake while agents work', desc: "Stop Windows from sleeping while an agent is working or waiting on background tasks, so it doesn't stop mid-task.", tip: 'Hive lets the PC sleep again as soon as no agent is working. The screen can still turn off and lock. On a laptop, "When plugged in" lets it sleep on battery.', type: 'select', options: [{ value: 'plugged-in', label: 'When plugged in' }, { value: 'always', label: 'Always, on battery too' }, { value: 'never', label: 'Never' }] },
  { section: 'general', key: 'showTips', title: 'Show a tip when Hive starts', desc: 'One tip a day about something Hive can do, and a tip at the moments one helps.', tip: 'Tips show in a small card in the bottom corner and never get in the way. Help → Tips… lists them all, whether this is on or off.', type: 'boolean' },
  // Updates
  { section: 'updates', key: 'status', title: 'Hive version', desc: '', tip: 'The version you are running and the result of the last check.', type: 'custom', render: () => <UpdateStatusRow /> },
  { section: 'updates', key: 'checkAutomatically', title: 'Check for updates automatically', desc: 'Look for a new version of Hive shortly after it starts and every 6 hours.', tip: 'When off, Hive only checks when you choose Help → Check for Updates. Development builds never update.', type: 'boolean' },
  { section: 'updates', key: 'downloadAutomatically', title: 'Download updates automatically', desc: 'Download a new version in the background as soon as it is found.', tip: 'When off, the status bar says a new version is available and you choose when to download it. Downloads are checked against the release checksum.', type: 'boolean' },
  { section: 'updates', key: 'install', title: 'Install updates', desc: 'When a downloaded update is installed.', tip: 'Automatically: the update installs when you next quit Hive (never while it is running, so your sessions are not interrupted); Restart and Update installs it straight away. Manually: it installs only when you choose Restart and Update. Either way, Hive asks before stopping agents that are working.', type: 'select', options: [{ value: 'auto', label: 'Automatically, when Hive quits' }, { value: 'manual', label: 'Manually, with Restart and Update' }] },
  { section: 'updates', key: 'prerelease', title: 'Include pre-releases', desc: 'Also offer beta versions published before a full release.', tip: 'Pre-releases get new features first and may have rough edges. Turning this off again waits for the next full release rather than going back.', type: 'boolean' },
  // Keyboard shortcuts
  { section: 'keybindings', key: 'editor', title: 'Shortcuts', desc: 'Click the pencil (or double-click a shortcut), then press the new keys. Wait a moment after the first combination, or press a second one for a chord such as Ctrl+K Ctrl+S.', tip: "Shortcuts need Ctrl or Alt (or are F-keys). Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Ctrl+Z, Ctrl+Y and Shift+Tab stay with editing and the agents' terminals. Some keys go to the agent while its terminal has focus (for Claude Code: Ctrl+B, Ctrl+K, Ctrl+O, Ctrl+R, Ctrl+T and Ctrl+G).", type: 'custom', wide: true, render: () => <KeybindingsEditor /> },
  // Appearance
  { section: 'appearance', key: 'theme', title: 'Theme', desc: 'Colour theme for Hive.', tip: 'System follows your Windows light/dark setting.', type: 'select', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }] },
  { section: 'appearance', key: 'uiFontSize', title: 'Interface font size', desc: 'Font size for menus, lists and panels, in pixels.', tip: 'Use View → Zoom to scale everything, including the terminal.', type: 'number', min: 11, max: 18 },
  { section: 'appearance', key: 'terminalFontFamily', title: 'Terminal font', desc: 'Font family for session terminals (CSS font list).', tip: "Monospace fonts work best. Cascadia Code ships with Windows Terminal; Nerd Fonts add extra glyphs.", type: 'text' },
  { section: 'appearance', key: 'terminalFontSize', title: 'Terminal font size', desc: 'Font size for session terminals, in pixels.', tip: 'Applies to open terminals immediately.', type: 'number', min: 8, max: 28 },
  { section: 'appearance', key: 'terminalScrollback', title: 'Terminal scrollback', desc: 'Lines kept in each terminal for scrolling back.', tip: 'Higher values use more memory per running session.', type: 'number', min: 1000, max: 100000, step: 1000 },
  { section: 'appearance', key: 'terminalCursorBlink', title: 'Blinking cursor', desc: 'Blink the terminal cursor.', tip: 'Purely cosmetic.', type: 'boolean' },
  // Providers
  { section: 'providers', key: 'list', title: 'Providers', desc: 'Turn on the coding agents you want to use. Agents of a provider that is off stay listed but can\'t start.', tip: 'Each project agent runs one provider, chosen when you add it (Add Agent) or in its settings. A provider needs its CLI installed and signed in.', type: 'custom', wide: true, render: () => <ProvidersList /> },
  { section: 'providers', key: 'defaultProvider', title: 'Default provider', desc: 'The provider Add Agent uses for new agents (one click, with its default settings) unless the project chooses another.', tip: 'Projects can choose their own default in Project Settings. Agents keep the provider they were given; Add Agent… (▾) can choose another.', type: 'custom', render: () => <DefaultProviderPicker /> },
  ...PROVIDERS.flatMap(providerSettingDefs),
  // Notifications
  { section: 'notifications', key: 'chimeEnabled', title: 'Completion chime', desc: 'Play a sound when an agent finishes or needs your input.', tip: 'Projects can override this in their settings.', type: 'boolean' },
  { section: 'notifications', key: 'chimeSound', title: 'Chime sound', desc: 'Which sound to play.', tip: 'Sounds are synthesised by Hive — no audio files needed.', type: 'custom', render: () => <ChimePicker /> },
  { section: 'notifications', key: 'chimeVolume', title: 'Chime volume', desc: 'Volume of the chime.', tip: 'Independent of Windows notification sounds.', type: 'range', min: 0, max: 1, step: 0.05 },
  { section: 'notifications', key: 'desktopNotifications', title: 'Desktop notifications', desc: 'Show Windows notifications for agent events.', tip: 'Clicking a notification opens Hive at that project.', type: 'boolean' },
  { section: 'notifications', key: 'notifyOnFinished', title: 'Notify when an agent finishes', desc: 'Notify when a session completes its task.', tip: "Triggered when the agent's turn ends (its Stop hook), or for an agent waiting on background tasks it started, when they have ended.", type: 'boolean' },
  { section: 'notifications', key: 'notifyOnWaiting', title: 'Notify when input is needed', desc: 'Notify when a session is waiting for permission or input.', tip: "Triggered by the agent's permission prompts and questions.", type: 'boolean' },
  { section: 'notifications', key: 'taskbarCount', title: 'Show a count on the taskbar button', desc: "A badge on Hive's taskbar button, and the window title, show how many agents need you.", tip: 'The same count as the status bar: agents waiting for your input, and those that finished while you were not looking. Each window shows its own workspace.', type: 'boolean' },
  { section: 'notifications', key: 'flashOnWaiting', title: 'Flash the taskbar button when an agent needs input', desc: 'When an agent starts waiting for your answer while Hive is in the background.', tip: 'It stops when you switch to the window. Finishing agents never flash it.', type: 'boolean' },
  { section: 'notifications', key: 'onlyWhenUnfocused', title: 'Only when Hive is in the background', desc: 'Skip desktop notifications while you are looking at Hive.', tip: 'The chime still plays either way.', type: 'boolean' },
  // Sessions
  { section: 'sessions', key: 'backupTranscripts', title: 'Back up transcripts', desc: "Copy each session's transcript into the project's .hive/sessions folder.", tip: 'Agents delete old transcripts after a while (Claude Code: 30 days by default). Backups let you resume and review sessions later. Archived sessions are always preserved.', type: 'boolean' },
  { section: 'sessions', key: 'cacheTtl', title: 'Prompt cache lifetime', desc: 'Used to estimate whether resuming a session needs to re-cache its context.', tip: 'Auto detects the cache type from the transcript (5 minutes or 1 hour).', type: 'select', options: [{ value: 'auto', label: 'Auto-detect' }, { value: '5m', label: '5 minutes' }, { value: '1h', label: '1 hour' }] },
  { section: 'sessions', key: 'compactSuggestTokens', title: 'Suggest compacting above', desc: 'Context size, in tokens, at which the Compact button and the context count in the status bar turn orange. Never: the button never turns orange.', tip: 'Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript. Projects can set their own value in Project Settings. Compact is always available once the agent has finished.', type: 'number', min: 1000, max: 2000000, step: 10000, off: 'Never' },
  { section: 'sessions', key: 'transcriptWarnMB', title: 'Warn when a transcript is over', desc: "Size, in MB, at which a running conversation's transcript turns orange in its footer and Hive notifies you once.", tip: "A long conversation slows down the CLI and Hive: each turn, resume and transcript view has more to read. Compacting doesn't shrink the file, which keeps the whole history; handing the work over to a new conversation does (click the size in the footer for Hand Over to…, and choose the agent itself). Projects can set their own value in Project Settings.", type: 'number', min: 1, max: 2000, step: 10, off: 'Never' },
  { section: 'sessions', key: 'overviewRefresh', title: 'Overview updates', desc: 'How the Overview and the session lists update while agents work.', tip: 'Live updates as sessions change, at most every 15 seconds and only while the tab is shown. Each update reads the project\'s session files, so with many sessions or agents a slower choice keeps Hive lighter. Refresh always updates at once.', type: 'select', options: [{ value: 'live', label: 'Live (at most every 15 s)' }, { value: 'minute', label: 'Every minute' }, { value: 'manual', label: 'Only when I click Refresh' }] },
  { section: 'sessions', key: 'followTranscripts', title: 'Follow running sessions in the transcript viewer', desc: 'The Sessions tab shows new messages of a running session as they arrive.', tip: 'Off: the transcript shows what was there when you opened it; Refresh loads what is new. You can also switch following on in the viewer itself. The Session tab always shows the agent working.', type: 'boolean' },
  { section: 'sessions', key: 'usageCacheSize', title: 'Usage cache size', desc: 'How many transcripts Hive remembers the token use of, so the Overview and session lists open without reading them again, also after a restart.', tip: 'Kept in usage-cache.json in your Hive profile: a few KB per transcript. A transcript is read again only when it changed (for example, a session you continued outside Hive), and the cache starts afresh with each Hive version. The least recently used go first when it is full. 100 to 50,000.', type: 'number', min: 100, max: 50000, step: 100 },
  { section: 'sessions', key: 'usageCacheClear', title: 'Clear the usage cache', desc: 'Forget what the cache holds; each transcript is read again the next time it is shown.', tip: 'Only needed if the token counts look wrong. Nothing else is lost: sessions, transcripts and backups stay as they are.', type: 'custom', render: () => <ClearUsageCacheButton /> },
  { section: 'sessions', key: 'confirmStop', title: 'Confirm before stopping', desc: 'Ask before stopping a running session.', tip: 'Stopped sessions can always be resumed.', type: 'boolean' },
  // Workspace
  {
    section: 'workspace',
    key: 'hiddenProjects',
    title: 'Hidden and removed projects',
    desc: 'Restore one to bring it back with its cards (and, for a removed one, the handovers packed into its folder). A folder that has left the workspace can be forgotten.',
    tip: 'Project → Remove Project… hides a project, removes it from Hive (its folder keeps its handovers and cards in .hive/removed, so it can move to another workspace) or deletes it (to the Recycle Bin). Deleted projects are not listed here: restore the folder from the Recycle Bin and Hive sees it as a new project.',
    type: 'custom',
    wide: true,
    render: () => <HiddenProjectsList />
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
  { section: 'board', key: 'colors', title: 'Column colours', desc: 'Pick the colour of each column.', tip: 'The tint on cards is a light mix of the colour with the theme, so it works in light and dark themes. Reset puts back the default.', type: 'custom', render: () => <ColumnColors /> },
  { section: 'agents', key: 'backgroundTaskMinutes', title: 'Count background tasks for up to', desc: 'Minutes an agent waits on a background task it started (such as a test run) before Hive counts it as finished anyway.', tip: "An agent that ends its turn while a task it started is still running shows as waiting on background tasks, not finished: Claude Code carries on by itself when the task ends. Hive can't tell a test run from something that never ends, such as a dev server, so it stops counting a task after this long (a Monitor also when it expires). Codex isn't told when its background terminals end, so they are only counted and shown. 10 to 480 minutes.", type: 'number', min: 10, max: 480, step: 5 },
  // Assistant
  { section: 'assistant', key: 'provider', title: 'Provider', desc: 'The coding agent the Assistant runs, unless a workspace chooses another.', tip: 'The Assistant is independent of your project agents: a Codex Assistant can look after Claude Code agents, and the other way round.', type: 'custom', render: () => <AssistantProviderPicker /> },
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
  { section: 'assistant', key: 'typingPause', title: 'Pause after you type', desc: "Seconds after you type in an agent's terminal before the Assistant may type there (give it a task or hand its work over).", tip: "The Assistant types a task by clearing the agent's input line (Ctrl+U) and entering it, which would wipe or mix with something you were writing. During the pause it asks you instead.", type: 'number', min: 1, max: 600, off: 'No pause' },
  { section: 'assistant', key: 'enterEndsPause', title: 'Enter ends the pause', desc: 'Once you press Enter in the terminal (you sent what you typed), the Assistant may type there at once.', tip: 'Turn this off if you often type a line and then keep writing (e.g. answering a question, then adding more).', type: 'boolean' },
  { section: 'assistant', key: 'persona', title: 'Default persona', desc: 'Who the Assistant is in a new conversation, unless a workspace chooses another.', tip: 'Personas are Markdown files in each workspace (.hive/personas): edit them, or add your own, in the Hive Assistant view (the robot on the left).', type: 'custom', render: () => <AssistantPersonaPicker /> },
  ...PROVIDERS.map(
    (p): SettingDef => ({
      section: 'assistant',
      key: `provider:${p.id}`,
      title: `With ${p.name}`,
      desc: `The model, effort, permission mode${p.capabilities.contextLimit ? ', context' : ''} and extra arguments when the Assistant runs ${p.name}. Default follows ${p.name}'s own settings, except the mode: ${permissionLabel(p.id, p.assistantMode)}, where ${p.name} approves safe actions itself and only asks about risky ones.`,
      tip: "By default it uses the same model and effort as your agents. A lighter model or low effort saves tokens but makes it careless (for example, saying it will check on an agent later and never doing so). Its default mode is the one your agents default to, so it rarely asks. Hive's own tools never ask: what they may do is set by Control above.",
      type: 'custom',
      wide: true,
      render: () => <AssistantProviderDefaults provider={p.id} />
    })
  ),
  // Agent API
  { section: 'agentApi', key: 'status', title: 'Status', desc: '', tip: 'Whether the Agent API is listening.', type: 'custom', render: () => <ApiStatus /> },
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
  { section: 'agentApi', key: 'token', title: 'Access token', desc: 'Bearer token required by the Agent API.', tip: 'Stored in %APPDATA%\\Hive\\agent-api.json. Sessions receive it automatically as HIVE_API_TOKEN.', type: 'custom', render: () => <ApiToken /> },
  // Advanced
  { section: 'advanced', key: 'logs', title: 'Logs', desc: 'Open the folder containing Hive\'s log files.', tip: 'Useful when reporting a problem.', type: 'custom', render: () => <button className="btn subtle" onClick={() => void call('app:openLogs')}><Icon name="output" /> Open logs</button> },
  { section: 'advanced', key: 'data', title: 'Settings file', desc: 'Hive keeps its settings in %APPDATA%\\Hive\\config.json.', tip: 'Project settings live in each project\'s .hive folder; workspace settings in the workspace .hive folder.', type: 'custom', render: () => <DataFolder /> },
  { section: 'advanced', key: 'reset', title: 'Reset all settings', desc: 'Restore every setting on this page to its default. Workspaces and projects are not affected.', tip: 'Recent workspaces and window position are kept.', type: 'custom', danger: true, render: () => <ResetAll /> }
]

/** The settings on one provider's page, from its descriptor. */
function providerSettingDefs(p: ProviderDescriptor): SettingDef[] {
  const section = providerSection(p.id)
  const safe = p.permissionModes.filter((m) => !m.danger)
  const danger = p.permissionModes.find((m) => m.danger)
  const defs: SettingDef[] = [
    { section, provider: p.id, key: 'enabled', title: `Use ${p.name}`, desc: `Let project agents run ${p.name}.`, tip: `When off, ${p.name} agents stay listed but can't start, and Hive doesn't check for its CLI.`, type: 'custom', render: () => <ProviderToggle provider={p.id} /> },
    { section, provider: p.id, key: 'status', title: 'Installation', desc: '', tip: `Where Hive found ${p.name}, whether it is signed in and whether an update is available.`, type: 'custom', render: () => <ProviderStatus provider={p.id} /> },
    { section, provider: p.id, key: 'executablePath', title: 'CLI path', desc: `Full path to the ${p.name} CLI (${p.cliName}.exe). Leave empty to detect it automatically.`, tip: 'Detection checks PATH and the usual install folders. Copies bundled with editor extensions (VS Code, Cursor…) are never used — Hive requires the standalone CLI.', type: 'text', placeholder: 'Auto-detect' },
    { section, provider: p.id, key: 'checkUpdatesOnLaunch', title: 'Check for updates on launch', desc: 'Compare the installed version with the latest release when Hive starts.', tip: `Hive never updates ${p.name} without asking. Standalone installs may also update themselves.`, type: 'boolean' },
    { section, provider: p.id, key: 'defaultModel', title: 'Default model', desc: `Model for ${p.name} sessions unless a project overrides it. ${p.name} default uses its own choice.`, tip: 'Whether your account can use a model is only known when a session starts.', type: 'custom', render: () => <GlobalModelPicker provider={p.id} /> },
    { section, provider: p.id, key: 'defaultEffort', title: 'Default effort', desc: 'Reasoning effort unless a project overrides it.', tip: 'Higher effort is more thorough but slower and uses more tokens.', type: 'select', options: [{ value: '', label: `${p.name} default` }, ...p.effortLevels.map((l) => ({ value: l.value, label: l.label }))] },
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
    key: 'prices',
    title: 'API prices',
    desc: p.capabilities.reportsCost
      ? `${p.name} reports each session's cost itself; these prices are only used for sessions without one. USD per million tokens.`
      : `Used to estimate what ${p.name} sessions would cost at API prices (shown with ≈ on the Overview). USD per million tokens.`,
    tip: `Hive ships the published prices as of ${PRICES_CHECKED}. Change any that are out of date; Reset returns a model to Hive's price. On a subscription you are not charged these — they show how heavy the work was.`,
    type: 'custom',
    wide: true,
    render: () => <PriceTable provider={p.id} />
  })
  return defs
}

/** The price table for a provider's models: Hive's prices, with the user's overrides. */
function PriceTable({ provider }: { provider: ProviderId }) {
  const own = useStore((s) => providerSettings(s.settings, provider).prices)
  const shipped = SHIPPED_PRICES[provider] ?? {}
  const models = [...new Set([...Object.keys(shipped), ...Object.keys(own)])]
  const cols: { key: keyof ModelPrice; label: string }[] = [
    { key: 'input', label: 'Input' },
    { key: 'cachedInput', label: 'Cached input' },
    ...(Object.values(shipped).some((m) => m.cacheWrite !== undefined) ? [{ key: 'cacheWrite' as const, label: 'Cache write' }] : []),
    { key: 'output', label: 'Output' }
  ]
  const save = (next: Record<string, ModelPrice>): Promise<void> =>
    // Replaces the whole table (a deep merge can't remove a model's override).
    actions.attempt('Could not save prices', () => call('settings:setProviderPrices', provider, next)).then((s) => void (s && set({ settings: s })))
  const setPrice = (model: string, key: keyof ModelPrice, value: string): void => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return
    const current = own[model] ?? shipped[model] ?? { input: 0, cachedInput: 0, output: 0 }
    void save({ ...own, [model]: { ...current, [key]: n } })
  }
  const reset = (model: string): void => {
    const next = { ...own }
    delete next[model]
    void save(next)
  }
  return (
    <table className="table price-table">
      <thead>
        <tr>
          <th>Model</th>
          {cols.map((c) => (
            <th key={c.key} className="num">
              {c.label}
            </th>
          ))}
          <th />
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const price = own[m] ?? shipped[m]
          return (
            <tr key={m}>
              <td className="mono">
                {m} {own[m] && <span className="badge">yours</span>}
              </td>
              {cols.map((c) => (
                <td key={c.key} className="num">
                  <input className="input price-input" type="number" min={0} step={0.01} defaultValue={price?.[c.key] ?? ''} key={`${m}:${c.key}:${price?.[c.key]}`} onBlur={(e) => e.target.value !== String(price?.[c.key] ?? '') && setPrice(m, c.key, e.target.value)} />
                </td>
              ))}
              <td>{own[m] && shipped[m] && <IconButton icon="discard" title="Back to Hive's price" onClick={() => reset(m)} />}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function GlobalModelPicker({ provider }: { provider: ProviderId }) {
  const value = useStore((s) => providerSettings(s.settings, provider).defaultModel)
  const def = SETTINGS.find((d) => d.provider === provider && d.key === 'defaultModel')!
  return <ModelPicker provider={provider} value={value} base={{ value: '', label: `${providerDescriptor(provider).name} default` }} onChange={(v) => void update(def, v)} />
}

function getValue(s: AppSettings, def: SettingDef): unknown {
  if (def.section === 'advanced' || def.section === 'providers' || def.section === 'workspace') return def.key === 'defaultProvider' ? s.defaultProvider : undefined
  if (def.provider) return (providerSettings(s, def.provider) as unknown as Record<string, unknown>)[def.key]
  return (s[def.section as keyof AppSettings] as unknown as Record<string, unknown>)[def.key]
}

function defaultValue(def: SettingDef): unknown {
  if (def.section === 'advanced' || def.section === 'providers' || def.section === 'workspace') return def.key === 'defaultProvider' ? DEFAULT_SETTINGS.defaultProvider : undefined
  if (def.provider) return (defaultProviderSettings(providerDescriptor(def.provider)) as unknown as Record<string, unknown>)[def.key]
  return (DEFAULT_SETTINGS[def.section as keyof AppSettings] as unknown as Record<string, unknown>)[def.key]
}

async function saveSettings(patch: SettingsPatch): Promise<void> {
  const s = await actions.attempt('Could not save setting', () => call('settings:update', patch))
  if (s) set({ settings: s })
}

async function update(def: SettingDef, value: unknown): Promise<void> {
  if (def.section === 'advanced' || def.section === 'workspace') return
  if (def.section === 'providers') return def.key === 'defaultProvider' ? saveSettings({ defaultProvider: value as string }) : undefined
  if (def.provider) return saveSettings({ providers: { [def.provider]: { [def.key]: value } } } as SettingsPatch)
  return saveSettings({ [def.section]: { [def.key]: value } } as SettingsPatch)
}

/** Turns a provider on or off. Turning it off with agents running asks whether to stop them. */
export async function setProviderEnabled(provider: ProviderId, on: boolean): Promise<void> {
  const name = providerDescriptor(provider).name
  if (!on) {
    // Providers are app-wide: list the agents running it in every window, naming the other windows' workspaces.
    const here = get().workspace?.path.toLowerCase()
    const leaf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
    const live = (await actions.attempt('Could not list the running agents', () => call('session:live'))) ?? []
    const running = live
      .filter((s) => s.provider === provider)
      .map((s) => {
        const parent = s.projectPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
        const where = parent.toLowerCase() === here ? leaf(s.projectPath) : `${leaf(parent)}/${leaf(s.projectPath)} (another window)`
        return s.agentName ? `${where} · ${s.agentName}` : where
      })
    if (running.length) {
      const choice = await choose({
        title: `Turn off ${name}?`,
        message: `${running.length === 1 ? 'An agent is' : `${running.length} agents are`} running ${name}: ${running.join(', ')}.`,
        detail: 'Stop them now, or let them run until they are stopped. Either way no new ones start while it is off.',
        choices: [
          { label: 'Let them run', value: 'run' },
          { label: 'Stop them now', value: 'stop' }
        ]
      })
      if (!choice) return
      if (choice === 'stop') await actions.attempt(`Could not stop the ${name} agents`, () => call('provider:stopAgents', provider))
    }
  }
  await saveSettings({ providers: { [provider]: { enabled: on } } } as SettingsPatch)
}

function Control({ def, settings }: { def: SettingDef; settings: AppSettings }) {
  const value = getValue(settings, def)
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  switch (def.type) {
    case 'custom':
      return <>{def.render?.()}</>
    case 'boolean':
      return (
        <Switch
          checked={!!value}
          label={def.title}
          onChange={async (v) => {
            if (v && def.confirmOn && !(await confirm({ ...def.confirmOn, confirmLabel: 'Enable', danger: true }))) return
            void update(def, v)
          }}
        />
      )
    case 'select':
      return (
        <select className="select" value={String(value ?? '')} onChange={(e) => void update(def, e.target.value)}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'range':
      return (
        <div className="flex" style={{ width: '100%' }}>
          <input className="range" type="range" min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => void update(def, Number(e.target.value))} />
          <span className="muted" style={{ width: 40, textAlign: 'right' }}>{Math.round(Number(value) * 100)}%</span>
        </div>
      )
    case 'number':
      return (
        <NumberField
          value={Number(value)}
          min={def.min}
          max={def.max}
          step={def.step}
          label={def.title}
          off={def.off ? { label: def.off, restore: Number(defaultValue(def)) || null } : undefined}
          onCommit={(v) => update(def, v)}
        />
      )
    case 'text': {
      const commit = (): void => {
        if (draft !== value) void update(def, draft.trim())
      }
      return <input className="input" value={draft} placeholder={def.placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    }
  }
}

function ProviderToggle({ provider }: { provider: ProviderId }) {
  const on = useStore((s) => isProviderEnabled(s.settings, provider))
  return <Switch checked={on} label={`Use ${providerDescriptor(provider).name}`} onChange={(v) => void setProviderEnabled(provider, v)} />
}

function ProviderStatus({ provider }: { provider: ProviderId }) {
  const info = useStore((s) => s.providers[provider])
  if (!info || info.checking) return <span className="muted"><Icon name="loading" spin /> Checking…</span>
  const problems = (info.readiness ?? []).filter((r) => r.level !== 'info')
  return (
    <div className="flex" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {info.found ? (
        <Tooltip content={info.path}>
          <span className="badge success">
            <Icon name="check" /> {info.version} · {info.source}
          </span>
        </Tooltip>
      ) : (
        <span className="badge error">CLI not installed</span>
      )}
      {info.found &&
        problems.map((r) => (
          <span key={r.id} className={cx('badge', r.level === 'error' ? 'error' : 'accent')}>
            {r.message}
          </span>
        ))}
      {info.updateAvailable && <span className="badge accent">{info.latestVersion} available</span>}
      <button className="btn small subtle" onClick={() => void actions.refreshProviders()}>
        Check now
      </button>
      <button className="btn small primary" onClick={() => set({ setupOpen: provider })}>
        {info.found ? 'Manage' : 'Install'}
      </button>
    </div>
  )
}

/** Every provider with its on/off switch and install state. */
function ProvidersList() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return (
    <div className="provider-list">
      {PROVIDERS.map((p) => {
        const info = providers[p.id]
        const on = isProviderEnabled(settings, p.id)
        const state = !info || info.checking ? 'Checking…' : !info.found ? 'Not installed' : info.readiness?.find((r) => r.level === 'error')?.message ?? `Installed · ${info.version}`
        return (
          <div key={p.id} className={cx('provider-row', !on && 'off')}>
            <ProviderIcon provider={p.id} />
            <div className="grow">
              <div>
                <strong>{p.name}</strong> <span className="faint">by {p.company}</span>
              </div>
              <div className="faint small">{state}</div>
            </div>
            <button className="btn small subtle" onClick={() => set({ settingsSection: providerSection(p.id), settingsQuery: '' })}>
              Settings
            </button>
            <Switch checked={on} label={`Use ${p.name}`} onChange={(v) => void setProviderEnabled(p.id, v)} />
          </div>
        )
      })}
    </div>
  )
}

function AssistantProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const current = settings?.assistant.provider ?? ''
  const def = providerDescriptor(settings?.defaultProvider)
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { provider: e.target.value } })}>
      <option value="">Default provider ({def.name})</option>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {on.includes(p) ? '' : ' (off)'}
        </option>
      ))}
    </select>
  )
}

/** Hive's personas, for choosing a default before a workspace is open. */
const SHIPPED_PERSONAS = [
  { id: 'overseer', name: 'Overseer', icon: '🗼' },
  { id: 'planner', name: 'Planner', icon: '🎩' },
  { id: 'reviewer', name: 'Reviewer', icon: '🦎' },
  { id: 'orchestrator', name: 'Orchestrator', icon: '🛫' }
]

function AssistantPersonaPicker() {
  const current = useStore((s) => s.settings?.assistant.persona) || DEFAULT_PERSONA
  const own = usePersonas().filter((p) => p.bundled !== 'missing')
  const list = own.length ? own : SHIPPED_PERSONAS
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { persona: e.target.value } })}>
      {!list.some((p) => p.id === current) && <option value={current}>{current}</option>}
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.icon ? `${p.icon} ` : ''}
          {p.name}
        </option>
      ))}
    </select>
  )
}

/** The Assistant's model, effort, mode and arguments with one provider. */
function AssistantProviderDefaults({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const p = providerDescriptor(provider)
  const a = settings?.assistant.providers[provider] ?? { model: '', effort: '', permissionMode: '', extraArgs: '', use200kContext: '' as const }
  const g = providerSettings(settings, provider)
  const [args, setArgs] = useState(a.extraArgs)
  useEffect(() => setArgs(a.extraArgs), [a.extraArgs])
  const save = (patch: Partial<typeof a>): void => void saveSettings({ assistant: { providers: { [provider]: patch } } } as SettingsPatch)
  const effortName = g.defaultEffort ? (p.effortLevels.find((l) => l.value === g.defaultEffort)?.label ?? g.defaultEffort) : `${p.name}'s`
  const cliDefault = useStore((s) => s.providers[provider]?.defaultModel ?? null)
  return (
    <div className="agent-form assistant-defaults">
      <label>Model</label>
      <ModelPicker provider={provider} value={a.model} base={{ value: '', label: `${p.name} default${g.defaultModel ? ` (${p.modelLabel(g.defaultModel)})` : ''}` }} onChange={(v) => save({ model: v })} />
      <label>Effort</label>
      <select className="select" value={a.effort} onChange={(e) => save({ effort: e.target.value as EffortLevel | '' })}>
        <option value="">Default ({effortName})</option>
        {p.effortLevels.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <label>Permission mode</label>
      <select className="select" value={a.permissionMode} onChange={(e) => save({ permissionMode: e.target.value as PermissionMode | '' })}>
        <option value="">Default ({permissionLabel(provider, p.assistantMode)})</option>
        {offeredModes(provider, settings)
          .filter((m) => m.value !== p.assistantMode)
          .map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
      </select>
      <ModeCaveat provider={provider} mode={a.permissionMode || p.assistantMode} model={a.model || g.defaultModel || cliDefault} />
      {p.capabilities.contextLimit && (
        <>
          <label>Use 200K context (instead of 1M)</label>
          <select className="select" value={a.use200kContext ?? ''} onChange={(e) => save({ use200kContext: e.target.value as '' | 'on' | 'off' })}>
            <option value="">Default ({g.use200kContext ? 'On' : 'Off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </>
      )}
      <label>Extra arguments</label>
      <input className="input" value={args} placeholder="e.g. --verbose" onChange={(e) => setArgs(e.target.value)} onBlur={() => args !== a.extraArgs && save({ extraArgs: args.trim() })} />
    </div>
  )
}

function DefaultProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const def = SETTINGS.find((d) => d.key === 'defaultProvider')!
  const current = settings?.defaultProvider ?? ''
  return (
    <select className="select" value={current} onChange={(e) => void update(def, e.target.value)}>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {on.includes(p) ? '' : ' (off)'}
        </option>
      ))}
    </select>
  )
}

function ClearUsageCacheButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn subtle"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void call('session:clearUsageCache')
          .then(() => notify('info', 'Usage cache cleared', 'Each transcript is read again the next time it is shown.'))
          .catch((e) => notify('error', 'Could not clear the usage cache', errorMessage(e)))
          .finally(() => setBusy(false))
      }}
    >
      <Icon name="clear-all" /> Clear
    </button>
  )
}

/** A colour picker per board column, saved a moment after the pick settles (the picker reports every drag). */
function ColumnColors() {
  const board = useStore((st) => st.settings!.board)
  const [draft, setDraft] = useState<Partial<Record<TaskColumn, string>>>({})
  useEffect(() => {
    if (!Object.keys(draft).length) return
    const t = setTimeout(() => {
      void saveSettings({ board: { colors: draft } } as SettingsPatch)
      setDraft({})
    }, 300)
    return () => clearTimeout(t)
  }, [draft])
  return (
    <div className={cx('column-colors', !board.columnColors && 'off')}>
      {TASK_COLUMNS.map((c) => {
        const value = draft[c.id] ?? columnColor(board.colors, c.id)
        return (
          <label key={c.id} className="column-color">
            <input type="color" value={value} aria-label={`${c.label} colour`} onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))} />
            <span>{c.label}</span>
            {value.toLowerCase() !== DEFAULT_COLUMN_COLORS[c.id] && (
              <IconButton icon="discard" title={`Reset ${c.label} to its default`} onClick={() => void saveSettings({ board: { colors: { [c.id]: DEFAULT_COLUMN_COLORS[c.id] } } } as SettingsPatch)} />
            )}
          </label>
        )
      })}
    </div>
  )
}

function ChimePicker() {
  const s = useStore((st) => st.settings!)
  const sounds: { value: ChimeSound; label: string }[] = [
    { value: 'chime', label: 'Chime' },
    { value: 'bell', label: 'Bell' },
    { value: 'soft', label: 'Soft' },
    { value: 'pop', label: 'Pop' }
  ]
  return (
    <div className="flex" style={{ width: '100%' }}>
      <select className="select" value={s.notifications.chimeSound} onChange={(e) => void call('settings:update', { notifications: { chimeSound: e.target.value as ChimeSound } }).then((ns) => set({ settings: ns }))}>
        {sounds.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconButton icon="play" title="Play" onClick={() => playChime(s.notifications.chimeSound, s.notifications.chimeVolume)} />
    </div>
  )
}

function ApiStatus() {
  const api = useStore((s) => s.api)
  if (!api) return null
  return api.running ? (
    <span className="badge success">
      <Icon name="broadcast" /> Listening on {api.url}
    </span>
  ) : api.error ? (
    <span className="badge error">{api.error}</span>
  ) : (
    <span className="badge">Off</span>
  )
}

function ApiToken() {
  const api = useStore((s) => s.api)
  const [show, setShow] = useState(false)
  if (!api) return null
  return (
    <div className="token-box">
      <input className="input" readOnly value={show ? api.token : '•'.repeat(24)} />
      <IconButton icon={show ? 'eye-closed' : 'eye'} title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} />
      <IconButton
        icon="copy"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(api.token)
          notify('success', 'Token copied')
        }}
      />
      <IconButton
        icon="refresh"
        title="Regenerate"
        onClick={async () => {
          if (!(await confirm({ title: 'Regenerate token?', message: 'Programs using the current token will stop working. Running sessions pick up the new token when restarted.', confirmLabel: 'Regenerate', danger: true }))) return
          set({ api: await call('api:regenerateToken') })
        }}
      />
    </div>
  )
}

function DataFolder() {
  const info = useStore((s) => s.appInfo)
  const path = info ? `${info.userData}\\config.json` : ''
  return (
    <div className="token-box">
      <input className="input" readOnly value={path} />
      <IconButton
        icon="copy"
        title="Copy path"
        onClick={() => {
          void navigator.clipboard.writeText(path)
          notify('success', 'Path copied')
        }}
      />
    </div>
  )
}

function ResetAll() {
  return (
    <button
      className="btn danger"
      onClick={async () => {
        if (!(await confirm({ title: 'Reset all settings?', message: 'Every setting on this page returns to its default.', confirmLabel: 'Reset', danger: true }))) return
        set({ settings: await call('settings:reset') })
        notify('success', 'Settings reset')
      }}
    >
      Reset
    </button>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const section = useStore((s) => s.settingsSection) as Section
  const query = useStore((s) => s.settingsQuery)
  const [modifiedOnly, setModifiedOnly] = useState(false)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SETTINGS.filter((d) => {
      if (q && !`${d.title} ${d.desc} ${d.tip} ${d.key}`.toLowerCase().includes(q)) return false
      if (modifiedOnly && (d.type === 'custom' || getValue(settings!, d) === defaultValue(d))) return false
      if (!q && !modifiedOnly && d.section !== section) return false
      return true
    })
  }, [query, section, settings, modifiedOnly])

  if (!settings) return null
  const grouped = SECTIONS.map((s) => ({ ...s, items: visible.filter((d) => d.section === s.id) })).filter((g) => g.items.length)
  const navIcon = (s: (typeof SECTIONS)[number]): React.ReactNode => (s.provider ? <ProviderIcon provider={s.provider} /> : <Icon name={s.icon} />)

  return (
    <div className="settings">
      <div className="settings-top">
        <Icon name="search" />
        <input className="input" autoFocus placeholder="Search settings" value={query} onChange={(e) => set({ settingsQuery: e.target.value })} />
        <label className="flex muted">
          <input type="checkbox" className="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} /> Modified only
        </label>
      </div>
      <div className="settings-body">
        <div className="settings-nav">
          {SECTIONS.map((s) => (
            <div key={s.id} className={cx('row', !query && !modifiedOnly && section === s.id && 'selected')} onClick={() => {
                set({ settingsSection: s.id, settingsQuery: '' })
                setModifiedOnly(false)
              }}
            >
              {navIcon(s)} <span className={cx('label', s.provider && 'settings-sub')}>{s.label}</span>
            </div>
          ))}
        </div>
        <div className="settings-content">
          {grouped.length === 0 && <div className="empty-state">No settings match.</div>}
          {grouped.map((g) => (
            <div key={g.id} className="settings-group">
              <h2>{g.label}</h2>
              <p>{g.desc}</p>
              {g.items.map((d) => {
                const modified = (d.type !== 'custom' || d.key === 'defaultModel' || d.key === 'defaultProvider') && getValue(settings, d) !== defaultValue(d)
                return (
                  d.wide ? (
                    <div key={`${d.section}.${d.key}`} className="setting wide">
                      <div className="s-text">
                        <div className="s-title">
                          {d.title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{d.tip}</span>} />
                        </div>
                        {d.desc && <div className="s-desc">{d.desc}</div>}
                        {d.render?.()}
                      </div>
                    </div>
                  ) : (
                  <div key={`${d.section}.${d.key}`} className={cx('setting', d.danger && 'danger')}>
                    <div className="s-text">
                      <div className="s-title">
                        {modified && (
                          <Tooltip content="Modified from the default">
                            <span className="modified" />
                          </Tooltip>
                        )}
                        {d.title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{d.tip}</span>} />
                        {modified && (
                          <IconButton icon="discard" title={`Reset to default (${String(defaultValue(d) || 'empty')})`} onClick={() => void update(d, defaultValue(d))} />
                        )}
                      </div>
                      {d.desc && <div className="s-desc">{d.desc}</div>}
                    </div>
                    <div className="s-control">
                      <Control def={d} settings={settings} />
                    </div>
                  </div>
                  )
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
