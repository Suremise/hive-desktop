import type { PermissionMode } from './types'
import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'
import { codexModelLabel } from './codex'

/**
 * GitHub Copilot's side of the shared provider data (the Copilot CLI, `copilot`): its modes, reasoning levels and models.
 * Its footer shows two things, the agent mode (Interactive, Plan, Autopilot: Shift+Tab cycles them) and the approval
 * (Manual Approval, or Allow All when launched with --allow-all), and Hive's modes are the combinations it can tell
 * apart there. Checked with Copilot CLI 1.0.93 (the #403 spike). Used by both processes.
 */

export const COPILOT = 'copilot'

export const COPILOT_PERMISSION_MODES: ModeOption[] = [
  { value: 'ask', label: 'Ask', description: 'Reads files and runs harmless commands without asking; asks before edits, other commands, MCP tools and web access.' },
  { value: 'plan', label: 'Plan', description: 'Plans the work and asks before changing anything.' },
  { value: 'autopilot', label: 'Autopilot', description: 'Carries on by itself until the task is done (up to 5 continuations), without asking. Use only where unattended changes are acceptable.', danger: true },
  { value: 'allow-all', label: 'Allow all', description: 'Approves every tool, path and web request without asking. Use only in disposable environments.', danger: true }
]

/** Command-line flags for each mode. */
export const COPILOT_MODE_FLAGS: Record<string, string[]> = {
  ask: [],
  plan: ['--plan'],
  autopilot: ['--autopilot'],
  'allow-all': ['--allow-all']
}

/**
 * The mode a footer's two parts mean ("Plan · Manual Approval"); null for one Hive has no mode for (Assisted approval).
 * Read by each part's first word: in a narrow terminal Copilot wraps its footer item by item ("← open ·Interactive ·
 * Manual · / commands" over "sidebar Approval next tab", 1.0.93).
 */
export function copilotFooterMode(screen: string): PermissionMode | null {
  const m = [...screen.matchAll(/\b(Interactive|Plan|Autopilot) ?· ?(Manual|Allow|Assisted)\b/g)].pop()
  if (!m) return null
  if (m[1] === 'Plan') return 'plan'
  if (m[1] === 'Autopilot') return 'autopilot'
  if (m[2] === 'Allow') return 'allow-all'
  return m[2] === 'Manual' ? 'ask' : null
}

/**
 * Shift+Tab cycles the agent mode (Interactive → Plan → Autopilot) and keeps the approval it was launched with, so Plan
 * and Autopilot can be reached from any mode, Ask only in a session launched without --allow-all, and Allow all only in
 * one launched with it.
 */
export function copilotCanSwitchLive(target: PermissionMode, _current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  if (target === 'plan' || target === 'autopilot') return true
  const allowAll = launched === 'allow-all'
  return target === 'allow-all' ? allowAll : target === 'ask' && !allowAll
}

const WORDS: Record<string, string> = { gpt: 'GPT', mai: 'MAI', k3: 'K3' }

/** "claude-sonnet-5.5" → "Claude Sonnet 5.5", "gpt-6-luna" → "GPT-6 Luna", "auto" → "Auto"; anything else word by word. */
export function copilotModelLabel(model: string): string {
  const m = model.trim()
  if (/^gpt-/i.test(m)) return codexModelLabel(m)
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(m)) return m
  return m
    .split('-')
    .map((w) => WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const models = (...ids: string[]) => ids.map((id) => ({ value: id, label: copilotModelLabel(id) }))

/**
 * Models offered in the pickers when Copilot can't be asked (its ACP session lists the account's own, models.ts): the
 * starting fallback, editable in Settings, from `copilot help config` (1.0.93). Copilot Free runs Auto only; the others
 * need a paid plan. Anything else can be typed as a custom ID.
 */
export const COPILOT_MODEL_GROUPS: ModelGroup[] = [
  { label: 'Auto', models: models('auto') },
  { label: 'Claude', models: models('claude-sonnet-5.5', 'claude-opus-5.5', 'claude-fable-5.1', 'claude-haiku-4.5') },
  { label: 'GPT', models: models('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5-mini') },
  { label: 'Others', models: models('gemini-3.8-flash', 'grok-4.7', 'kimi-k3', 'mai-code-1.1-flash') },
  {
    label: 'Older versions',
    older: true,
    models: models('claude-sonnet-5', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-fast', 'claude-sonnet-4.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gemini-3.7-flash', 'grok-4.6', 'grok-4.5')
  }
]

export const COPILOT_DESCRIPTOR: ProviderDescriptor = {
  id: COPILOT,
  name: 'GitHub Copilot',
  assistant: 'Copilot',
  company: 'GitHub',
  cliName: 'copilot',
  icon: 'copilot',
  setupUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  permissionModes: COPILOT_PERMISSION_MODES,
  defaultPermissionMode: 'ask',
  // Reads are approved by Copilot itself, and Hive's own tools are pre-approved (trustedHiveTools).
  assistantMode: 'ask',
  effortLevels: [
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ],
  modelGroups: COPILOT_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. claude-sonnet-5.5 or auto',
  capabilities: {
    // --session-id <uuid> names a new session; --resume <id> reopens it.
    fixedSessionId: true,
    liveModeSwitch: 'cycle',
    planModeToggle: false,
    promptCacheTtl: false,
    // Its transcript counts the session's AI credits (session.usage_checkpoint), and one credit is $0.01.
    reportsCost: true,
    // /compact takes focus instructions.
    compactFocus: true,
    contextLimit: false,
    autoCompactReserve: null,
    imagePaste: false,
    // A PreToolUse "ask" brings up Copilot's own approval dialog, even with --allow-all (checked with 1.0.93).
    lockAsk: true,
    backgroundSessions: false,
    backgroundWakes: false
  },
  reservedKeys: [],
  instructionsFile: 'AGENTS.md',
  installNote:
    'Install the GitHub Copilot CLI with WinGet (`winget install GitHub.Copilot`) or npm (`npm install -g @github/copilot`), then sign in once with `copilot login` in a terminal (or with the GitHub CLI, which Copilot also uses). Copilot Free runs the Auto model only; choosing a model needs a paid plan. If the CLI is installed somewhere else, set its path in Settings → GitHub Copilot.',
  extensionNote:
    "You have GitHub Copilot in VS Code (or a similar editor). Hive doesn't use the editor's copy — it moves with every extension update. Install the Copilot CLI; your extension keeps working as before.",
  signInHelp: 'Sign in again: run copilot login in a terminal (Help → Agent Setup → GitHub Copilot shows how).',
  modelLabel: copilotModelLabel,
  canSwitchLive: copilotCanSwitchLive
}
