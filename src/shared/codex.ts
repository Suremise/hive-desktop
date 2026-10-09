import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'

/**
 * Codex's side of the shared provider data: its permission presets (the /permissions menu), reasoning
 * levels and models. Plan mode is a separate toggle (Shift+Tab), not a preset. Used by both processes.
 */

export const CODEX = 'codex'

/** The presets of Codex's /permissions menu, in its order (checked with Codex 0.159). */
export const CODEX_PERMISSION_MODES: ModeOption[] = [
  { value: 'read-only', label: 'Read only', description: 'Reads workspace files; asks before any edit or internet access.' },
  { value: 'ask', label: 'Ask for approval', description: 'Reads and edits workspace files and runs commands in its sandbox; asks before internet access or edits outside the workspace.' },
  { value: 'approve-for-me', label: 'Approve for me', description: 'An automatic reviewer approves safe actions itself and only asks about ones it thinks are risky.', reviewed: true },
  { value: 'full-access', label: 'Full access', description: 'No sandbox and no approvals: edits anything and uses the internet without asking. Use only in disposable environments.', danger: true }
]

/** Command-line flags for each preset. */
export const CODEX_MODE_FLAGS: Record<string, string[]> = {
  'read-only': ['-s', 'read-only', '-a', 'on-request'],
  ask: ['-s', 'workspace-write', '-a', 'on-request'],
  // It brings its own workspace-write sandbox; Codex refuses --sandbox alongside it.
  'approve-for-me': ['--approve-for-me'],
  'full-access': ['-s', 'danger-full-access', '-a', 'never']
}

/** "gpt-6-luna" → "GPT-6 Luna", "gpt-5.6-terra" → "GPT-5.6 Terra"; anything else as it is. */
export function codexModelLabel(model: string): string {
  const m = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(model.trim())
  if (!m) return model
  const rest = (m[2] ?? '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return `GPT-${m[1]}${rest ? ` ${rest}` : ''}`
}

const models = (...ids: string[]) => ids.map((id) => ({ value: id, label: codexModelLabel(id) }))

/**
 * Models offered in the pickers when Codex can't be asked (codex debug models gives the real list, #125): the starting
 * fallback, editable in Settings, from Codex's catalogue (Sep 2026; GPT-6.1 Sol from Codex 0.160, Oct 2026). Which
 * ones an account can use depends on its plan; anything else can be typed as a custom ID.
 */
export const CODEX_MODEL_GROUPS: ModelGroup[] = [
  { label: 'GPT-6.1', models: models('gpt-6.1-sol') },
  { label: 'GPT-6', models: models('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna') },
  { label: 'Older versions', older: true, models: models('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5') }
]

export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: CODEX,
  name: 'Codex',
  assistant: 'Codex',
  company: 'OpenAI',
  cliName: 'codex',
  icon: 'codex',
  setupUrl: 'https://developers.openai.com/codex/cli',
  permissionModes: CODEX_PERMISSION_MODES,
  defaultPermissionMode: 'approve-for-me',
  assistantMode: 'approve-for-me',
  effortLevels: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
    { value: 'ultra', label: 'Ultra' }
  ],
  modelGroups: CODEX_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. gpt-6-sol',
  capabilities: {
    fixedSessionId: false,
    liveModeSwitch: 'menu',
    planModeToggle: true,
    promptCacheTtl: false,
    reportsCost: false,
    compactFocus: false,
    contextLimit: false,
    autoCompactReserve: null,
    // A pasted image path becomes [Image #n] (checked with Codex 0.159).
    imagePaste: true,
    // Codex rejects permissionDecision "ask" (and then runs the tool), so Hive asks the user itself.
    lockAsk: false,
    backgroundSessions: false,
    // Codex isn't told when a background terminal ends: it finds out only by checking during a turn.
    backgroundWakes: false,
    startupSizeRefresh: false
  },
  // Ctrl+T opens Codex's transcript view; Ctrl+G its external editor.
  reservedKeys: ['MOD+T', 'MOD+G'],
  instructionsFile: 'AGENTS.md',
  installNote:
    'The installer runs `irm https://chatgpt.com/codex/install.ps1 | iex` in PowerShell and installs to `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex`. After installing, sign in with your ChatGPT account (Plus, Pro, Business or Enterprise) or an API key, then set up its Windows sandbox once. If the CLI is installed somewhere else, set its path in Settings → Codex.',
  extensionNote:
    "You have the Codex extension for VS Code (or a similar editor). Hive doesn't use it — the extension's built-in copy moves with every extension update. Install the CLI; your extension keeps working as before.",
  signInHelp: 'Sign in again in Help → Agent Setup → Codex → Sign in (or run codex login in a terminal).',
  modelLabel: codexModelLabel,
  // Every preset is in Codex's /permissions menu, so each can be switched to in a running session.
  canSwitchLive: () => true
}
