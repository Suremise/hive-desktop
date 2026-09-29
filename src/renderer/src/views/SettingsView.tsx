import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ChimeSound } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { DEFAULT_SETTINGS, EFFORT_LEVELS, FILE_LOCK_MODES, PERMISSION_MODES } from '@shared/defaults'
import { ModelPicker } from '../components/ModelPicker'
import * as actions from '../actions'
import { call } from '../api'
import { playChime } from '../chime'
import { Icon, IconButton, InfoTip, Switch, Tooltip } from '../components/ui'
import { UpdateStatusRow } from '../components/Updates'
import { confirm, notify, set, useStore } from '../store'
import { cx } from '../util'

type Section = keyof AppSettings | 'advanced'

interface SettingDef {
  section: Section
  key: string
  title: string
  desc: string
  tip: string
  type: 'boolean' | 'select' | 'number' | 'text' | 'range' | 'custom'
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  danger?: boolean
  render?: () => React.ReactNode
  confirmOn?: { title: string; message: string; detail?: string }
}

const SECTIONS: { id: Section; label: string; icon: string; desc: string }[] = [
  { id: 'general', label: 'General', icon: 'settings-gear', desc: 'Startup, window and tray behaviour.' },
  { id: 'updates', label: 'Updates', icon: 'cloud-download', desc: "Keeping Hive itself up to date. New versions come from Hive's GitHub releases and are verified before they install." },
  { id: 'appearance', label: 'Appearance', icon: 'symbol-color', desc: 'Theme, fonts and terminal look.' },
  { id: 'claude', label: 'Claude Code', icon: 'hubot', desc: 'The Claude Code CLI (required — the VS Code extension is not used) and the defaults every project inherits.' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', desc: 'Chimes and desktop notifications when agents finish or need you.' },
  { id: 'sessions', label: 'Sessions', icon: 'history', desc: 'Transcript backups, cache estimates and session behaviour.' },
  { id: 'agents', label: 'Agents & Worktrees', icon: 'organization', desc: 'Defaults for projects running several agents: file locks, new worktrees and merging. Projects can override them.' },
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
  // Updates
  { section: 'updates', key: 'status', title: 'Hive version', desc: '', tip: 'The version you are running and the result of the last check.', type: 'custom', render: () => <UpdateStatusRow /> },
  { section: 'updates', key: 'checkAutomatically', title: 'Check for updates automatically', desc: 'Look for a new version of Hive shortly after it starts and every 6 hours.', tip: 'When off, Hive only checks when you choose Help → Check for Updates. Development builds never update.', type: 'boolean' },
  { section: 'updates', key: 'downloadAutomatically', title: 'Download updates automatically', desc: 'Download a new version in the background as soon as it is found.', tip: 'When off, the status bar says a new version is available and you choose when to download it. Downloads are checked against the release checksum.', type: 'boolean' },
  { section: 'updates', key: 'install', title: 'Install updates', desc: 'When a downloaded update is installed.', tip: 'Automatically: the update installs when you next quit Hive (never while it is running, so your sessions are not interrupted); Restart and Update installs it straight away. Manually: it installs only when you choose Restart and Update. Either way, Hive asks before stopping agents that are working.', type: 'select', options: [{ value: 'auto', label: 'Automatically, when Hive quits' }, { value: 'manual', label: 'Manually, with Restart and Update' }] },
  { section: 'updates', key: 'prerelease', title: 'Include pre-releases', desc: 'Also offer beta versions published before a full release.', tip: 'Pre-releases get new features first and may have rough edges. Turning this off again waits for the next full release rather than going back.', type: 'boolean' },
  // Appearance
  { section: 'appearance', key: 'theme', title: 'Theme', desc: 'Colour theme for Hive.', tip: 'System follows your Windows light/dark setting.', type: 'select', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }] },
  { section: 'appearance', key: 'uiFontSize', title: 'Interface font size', desc: 'Font size for menus, lists and panels, in pixels.', tip: 'Use View → Zoom to scale everything, including the terminal.', type: 'number', min: 11, max: 18 },
  { section: 'appearance', key: 'terminalFontFamily', title: 'Terminal font', desc: 'Font family for session terminals (CSS font list).', tip: "Monospace fonts work best. Cascadia Code ships with Windows Terminal; Nerd Fonts add extra glyphs.", type: 'text' },
  { section: 'appearance', key: 'terminalFontSize', title: 'Terminal font size', desc: 'Font size for session terminals, in pixels.', tip: 'Applies to open terminals immediately.', type: 'number', min: 8, max: 28 },
  { section: 'appearance', key: 'terminalScrollback', title: 'Terminal scrollback', desc: 'Lines kept in each terminal for scrolling back.', tip: 'Higher values use more memory per running session.', type: 'number', min: 1000, max: 100000, step: 1000 },
  { section: 'appearance', key: 'terminalCursorBlink', title: 'Blinking cursor', desc: 'Blink the terminal cursor.', tip: 'Purely cosmetic.', type: 'boolean' },
  // Claude Code
  { section: 'claude', key: 'status', title: 'Installation', desc: '', tip: 'Where Hive found Claude Code and whether an update is available.', type: 'custom', render: () => <ClaudeStatus /> },
  { section: 'claude', key: 'executablePath', title: 'Claude Code CLI path', desc: 'Full path to the Claude Code CLI (claude.exe). Leave empty to detect it automatically.', tip: 'Detection checks PATH, %USERPROFILE%\\.local\\bin and npm, in that order. Copies bundled with editor extensions (VS Code, Cursor…) are never used — Hive requires the standalone CLI.', type: 'text', placeholder: 'Auto-detect' },
  { section: 'claude', key: 'checkUpdatesOnLaunch', title: 'Check for updates on launch', desc: 'Compare the installed version with the latest release when Hive starts.', tip: 'Hive never updates Claude Code without asking. Standalone installs also update themselves.', type: 'boolean' },
  { section: 'claude', key: 'defaultModel', title: 'Default model', desc: "Model for sessions unless a project overrides it. Claude Code default uses Claude Code's own choice.", tip: 'Latest aliases (fable, opus, sonnet, haiku) always pick the newest model in that family; a pinned version stays on that model. 1M context uses the larger context window where the model has one. Whether your account can use a model is only known when a session starts.', type: 'custom', render: () => <GlobalModelPicker /> },
  { section: 'claude', key: 'defaultEffort', title: 'Default effort', desc: 'Reasoning effort unless a project overrides it.', tip: 'Higher effort is more thorough but slower and uses more tokens.', type: 'select', options: [{ value: '', label: 'Claude Code default' }, ...EFFORT_LEVELS.map((l) => ({ value: l, label: l }))] },
  {
    section: 'claude',
    key: 'defaultPermissionMode',
    title: 'Default permission mode',
    desc: 'The mode sessions start in unless a project overrides it.',
    tip: PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions').map((m) => `${m.label}: ${m.description}`).join('\n'),
    type: 'select',
    options: PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions').map((m) => ({ value: m.value, label: m.label }))
  },
  {
    section: 'claude',
    key: 'enableBypassOption',
    title: 'Enable bypass permissions option',
    desc: 'Allow projects to choose "Bypass permissions", where the agent runs every action without asking.',
    tip: 'Bypass is never a global default. When turned off, projects using it return to Inherit.',
    type: 'boolean',
    danger: true,
    confirmOn: {
      title: 'Enable the bypass permissions option?',
      message: 'Projects will be able to run sessions where Claude Code executes every command, file edit and network request without asking.',
      detail: 'Recommended only for disposable environments. Each project still has to choose it, and doing so asks for confirmation.'
    }
  },
  { section: 'claude', key: 'extraArgs', title: 'Extra arguments', desc: 'Additional command-line arguments for every session.', tip: 'Projects can add more in their own settings. Example: --verbose', type: 'text', placeholder: 'e.g. --verbose' },
  // Notifications
  { section: 'notifications', key: 'chimeEnabled', title: 'Completion chime', desc: 'Play a sound when an agent finishes or needs your input.', tip: 'Projects can override this in their settings.', type: 'boolean' },
  { section: 'notifications', key: 'chimeSound', title: 'Chime sound', desc: 'Which sound to play.', tip: 'Sounds are synthesised by Hive — no audio files needed.', type: 'custom', render: () => <ChimePicker /> },
  { section: 'notifications', key: 'chimeVolume', title: 'Chime volume', desc: 'Volume of the chime.', tip: 'Independent of Windows notification sounds.', type: 'range', min: 0, max: 1, step: 0.05 },
  { section: 'notifications', key: 'desktopNotifications', title: 'Desktop notifications', desc: 'Show Windows notifications for agent events.', tip: 'Clicking a notification opens Hive at that project.', type: 'boolean' },
  { section: 'notifications', key: 'notifyOnFinished', title: 'Notify when an agent finishes', desc: 'Notify when a session completes its task.', tip: 'Triggered by Claude Code\'s Stop hook.', type: 'boolean' },
  { section: 'notifications', key: 'notifyOnWaiting', title: 'Notify when input is needed', desc: 'Notify when a session is waiting for permission or input.', tip: "Triggered by Claude Code's permission prompts.", type: 'boolean' },
  { section: 'notifications', key: 'onlyWhenUnfocused', title: 'Only when Hive is in the background', desc: 'Skip desktop notifications while you are looking at Hive.', tip: 'The chime still plays either way.', type: 'boolean' },
  // Sessions
  { section: 'sessions', key: 'backupTranscripts', title: 'Back up transcripts', desc: "Copy each session's transcript into the project's .hive/sessions folder.", tip: 'Claude Code deletes old transcripts after a while (30 days by default). Backups let you resume and review sessions later. Archived sessions are always preserved.', type: 'boolean' },
  { section: 'sessions', key: 'cacheTtl', title: 'Prompt cache lifetime', desc: 'Used to estimate whether resuming a session needs to re-cache its context.', tip: 'Auto detects the cache type from the transcript (5 minutes or 1 hour).', type: 'select', options: [{ value: 'auto', label: 'Auto-detect' }, { value: '5m', label: '5 minutes' }, { value: '1h', label: '1 hour' }] },
  { section: 'sessions', key: 'compactSuggestTokens', title: 'Suggest compacting above', desc: 'Context size, in tokens, at which the Compact button and the context count in the status bar turn orange. 0 never suggests it.', tip: 'Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript. Projects can set their own value in Project Settings. Compact is always available once the agent has finished.', type: 'number', min: 0, max: 2000000, step: 10000 },
  { section: 'sessions', key: 'confirmStop', title: 'Confirm before stopping', desc: 'Ask before stopping a running session.', tip: 'Stopped sessions can always be resumed.', type: 'boolean' },
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
  { section: 'agents', key: 'mergeStyle', title: 'Default merge style', desc: "How a worktree agent's branch is merged back, unless you choose otherwise in the Merge dialog.", tip: 'Squash makes one commit with everything the agent did. Merge keeps its individual commits plus a merge commit.', type: 'select', options: [{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge commit' }] },
  // Agent API
  { section: 'agentApi', key: 'status', title: 'Status', desc: '', tip: 'Whether the Agent API is listening.', type: 'custom', render: () => <ApiStatus /> },
  { section: 'agentApi', key: 'enabled', title: 'Enable Agent API', desc: 'Run a local HTTP API that agents and scripts can use to talk to Hive.', tip: 'Listens on 127.0.0.1 only and requires the bearer token below. See Help → Agent API Reference.', type: 'boolean' },
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

function GlobalModelPicker() {
  const value = useStore((s) => s.settings?.claude.defaultModel ?? '')
  return <ModelPicker value={value} base={{ value: '', label: 'Claude Code default' }} onChange={(v) => void update(SETTINGS.find((d) => d.key === 'defaultModel')!, v)} />
}

function getValue(s: AppSettings, def: SettingDef): unknown {
  if (def.section === 'advanced') return undefined
  return (s[def.section] as unknown as Record<string, unknown>)[def.key]
}

function defaultValue(def: SettingDef): unknown {
  if (def.section === 'advanced') return undefined
  return (DEFAULT_SETTINGS[def.section] as unknown as Record<string, unknown>)[def.key]
}

async function update(def: SettingDef, value: unknown): Promise<void> {
  if (def.section === 'advanced') return
  const patch = { [def.section]: { [def.key]: value } } as SettingsPatch
  const s = await actions.attempt('Could not save setting', () => call('settings:update', patch))
  if (s) set({ settings: s })
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
    case 'number': {
      const commit = (): void => {
        const n = Math.round(Number(draft))
        if (!Number.isFinite(n) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
          notify('warning', `${def.title} must be between ${def.min} and ${def.max}`)
          setDraft(String(value))
          return
        }
        if (n !== value) void update(def, n)
      }
      return <input className="input" type="number" min={def.min} max={def.max} step={def.step ?? 1} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    }
    case 'text': {
      const commit = (): void => {
        if (draft !== value) void update(def, draft.trim())
      }
      return <input className="input" value={draft} placeholder={def.placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    }
  }
}

function ClaudeStatus() {
  const agent = useStore((s) => s.agent)
  if (!agent || agent.checking) return <span className="muted"><Icon name="loading" spin /> Checking…</span>
  return (
    <div className="flex" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {agent.found ? (
        <Tooltip content={agent.path}>
          <span className="badge success">
            <Icon name="check" /> {agent.version} · {agent.source}
          </span>
        </Tooltip>
      ) : (
        <span className="badge error">CLI not installed</span>
      )}
      {agent.updateAvailable && <span className="badge accent">{agent.latestVersion} available</span>}
      <button className="btn small subtle" onClick={() => void actions.refreshAgent()}>
        Check now
      </button>
      <button className="btn small primary" onClick={() => set({ setupOpen: true })}>
        {agent.found ? 'Manage' : 'Install'}
      </button>
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
              <Icon name={s.icon} /> <span className="label">{s.label}</span>
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
                const modified = (d.type !== 'custom' || d.key === 'defaultModel') && getValue(settings, d) !== defaultValue(d)
                return (
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
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
