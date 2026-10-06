import type { PermissionMode } from './types'
import type { ModeCaveatFacts, ModeOption, ModelGroup, ModelOption, ProviderDescriptor } from './providers'

/**
 * Claude Code's side of the shared provider data: its permission modes, effort levels and models,
 * and how to read its mode from hooks and from the terminal footer. Used by both processes.
 */

export const CLAUDE_CODE = 'claude-code'

export const CLAUDE_PERMISSION_MODES: ModeOption[] = [
  { value: 'manual', label: 'Manual', description: 'Asks before file edits and shell commands unless you have pre-approved them.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Makes file edits in the working folder without asking; still asks before shell commands.' },
  { value: 'plan', label: 'Plan', description: 'Read-only: explores and proposes a plan, changes nothing until you approve.' },
  { value: 'auto', label: 'Auto', description: 'A safety classifier approves low-risk actions itself and only asks about risky ones.' },
  { value: 'dontAsk', label: "Don't ask", description: 'Never prompts. Anything not pre-approved is refused instead of asked about.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks and allows everything — any edit, command or network call. Use only in disposable environments.', danger: true }
]

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** Friendly model name: "opus" → "Opus", "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function claudeModelLabel(model: string): string {
  const oneM = /\[1m\]$/i.test(model)
  const id = model.replace(/\[1m\]$/i, '').trim()
  const named = /^claude-([a-z]+)-(\d+)-(\d{1,2})(?:-\d{8})?$/i.exec(id) // claude-opus-5-5 (not a date)
  const legacy = /^claude-(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/i.exec(id) // claude-3-5-sonnet-20241022
  const major = /^claude-([a-z]+)-(\d+)(?:-\d{8})?$/i.exec(id) // claude-opus-4-20250514
  let out = id
  if (named) out = `${cap(named[1])} ${named[2]}.${named[3]}`
  else if (legacy) out = `${cap(legacy[3])} ${legacy[1]}.${legacy[2]}`
  else if (major) out = `${cap(major[1])} ${major[2]}`
  else if (/^[a-z]+$/i.test(id)) out = cap(id)
  return oneM ? `${out} (1M)` : out
}

const pinned = (...ids: string[]): ModelOption[] => ids.map((id) => ({ value: id, label: claudeModelLabel(id) }))

/**
 * Models offered in the pickers when Claude Code can't be asked (its initialize reply gives the real list, #125): the
 * starting fallback, editable in Settings. Aliases follow new releases; full IDs pin a version. Whether an account can
 * use a model is only known when a session starts, and anything else can be typed as a custom ID.
 */
export const CLAUDE_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'Latest (follows new releases)',
    models: [
      { value: 'fable', label: 'Fable (latest)' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'haiku', label: 'Haiku (latest)' }
    ]
  },
  { label: 'Pinned versions', models: pinned('claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5') },
  {
    label: 'Older versions',
    older: true,
    models: pinned('claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1')
  }
]

/**
 * The model without its 1M-context suffix. Current models have the 1M window without it; only Opus 4.6 and
 * Sonnet 4.6 need "[1m]" (typed as a custom model ID), and Claude Code rejects it when 1M is turned off.
 */
export const baseModel = (model: string): string => model.replace(/\[1m\]$/i, '')

export const isOlderModel = (model: string): boolean => CLAUDE_MODEL_GROUPS.some((g) => g.older && g.models.some((m) => m.value === baseModel(model)))

// ---------------------------------------------------------------------------
// Permission modes in a running session
// ---------------------------------------------------------------------------

/** The modes Claude Code's Shift+Tab cycles through, in order (checked with Claude Code 2.1.284). */
export const MODE_CYCLE: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']

const MODES = String.raw`(manual\s*mode|accept\s*edits|plan\s*mode|auto\s*mode|bypass\s*permissions|don['’]?t\s*ask)`
/**
 * A mode in the footer: after Claude Code's mode symbol (⏵⏵ or ⏸), or followed by its hint ("(shift+tab to
 * cycle)" or "·"). Manual shows only "⏸ manual mode on" (Claude Code 2.1.286), so the symbol is needed.
 */
const FOOTER_MODE = new RegExp(String.raw`[⏵⏸][\s⏵⏸]*${MODES}\s*on\b|${MODES}\s*on\s*(?:\(|·)`, 'gi')

/**
 * The permission mode in Claude Code's footer ("⏵⏵ auto mode on (shift+tab to cycle)"), from the terminal's
 * rendered screen (TerminalScreen; the output stream misses footers redrawn in part, as without colours), or text with
 * control sequences replaced by spaces. The last one wins; null when there is none.
 */
export function footerMode(text: string): PermissionMode | null {
  let last: string | null = null
  for (const m of text.matchAll(FOOTER_MODE)) last = (m[1] ?? m[2]).toLowerCase().replace(/\s+/g, '')
  if (!last) return null
  if (last.startsWith('manual')) return 'manual'
  if (last.startsWith('accept')) return 'acceptEdits'
  if (last.startsWith('plan')) return 'plan'
  if (last.startsWith('auto')) return 'auto'
  if (last.startsWith('bypass')) return 'bypassPermissions'
  return 'dontAsk'
}

/** The permission_mode Claude Code sends with hooks ("default" is Manual). */
export function hookMode(v: unknown): PermissionMode | null {
  if (v === 'default' || v === 'manual') return 'manual'
  return CLAUDE_PERMISSION_MODES.some((m) => m.value === v) ? (v as PermissionMode) : null
}

/**
 * Whether a running session can switch to a mode with Shift+Tab. Don't ask leaves the cycle once left;
 * Bypass is only in it for a session launched in Bypass. Anything else needs a restart.
 */
export function canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  if (target === current) return true
  if (MODE_CYCLE.includes(target)) return true
  return target === 'bypassPermissions' && launched === 'bypassPermissions'
}

/**
 * Auto with a model Claude Code doesn't run in Auto. Its initialize reply says per model, for the installed version and
 * the account (supportsAutoMode, absent for Haiku 4.5 with 2.1.289, #129); such a session runs in Manual instead (2.1.286
 * and 2.1.289; claude-real checks it against the installed CLI). Without the reply's word, the guess from 2.1.286.
 */
export function claudeModeCaveat(mode: string, model: string, known?: ModeCaveatFacts): string | null {
  if (mode !== 'auto') return null
  const unsupported = known?.supportsAuto !== undefined ? !known.supportsAuto : /haiku/i.test(model)
  if (!unsupported) return null
  const name = known?.label ?? (/haiku/i.test(model) ? 'Haiku' : claudeModelLabel(model))
  return known?.supportsAuto === false
    ? `Claude Code doesn't offer Auto with ${name}: it runs in Manual instead (asking before edits and commands), and Hive shows that mode.`
    : `Claude Code may not offer Auto with ${name}. If it doesn't, it runs in Manual (asking before edits and commands), and Hive shows that mode.`
}

export const CLAUDE_DESCRIPTOR: ProviderDescriptor = {
  id: CLAUDE_CODE,
  name: 'Claude Code',
  assistant: 'Claude',
  company: 'Anthropic',
  cliName: 'claude',
  icon: 'claude',
  setupUrl: 'https://code.claude.com/docs/en/setup',
  permissionModes: CLAUDE_PERMISSION_MODES,
  defaultPermissionMode: 'auto',
  // Plan mode would block the hive tools.
  assistantMode: 'auto',
  modeCaveat: claudeModeCaveat,
  effortLevels: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ],
  modelGroups: CLAUDE_MODEL_GROUPS,
  modelPlaceholder: 'Full model ID, e.g. claude-opus-5-5 or claude-opus-4-6[1m]',
  capabilities: {
    fixedSessionId: true,
    liveModeSwitch: 'cycle',
    planModeToggle: false,
    promptCacheTtl: true,
    reportsCost: true,
    compactFocus: true,
    contextLimit: true,
    autoCompactReserve: 33_000,
    imagePaste: true,
    lockAsk: true,
    backgroundSessions: true,
    backgroundWakes: true
  },
  reservedKeys: ['MOD+B', 'MOD+K', 'MOD+O', 'MOD+R', 'MOD+T', 'MOD+G'],
  instructionsFile: 'CLAUDE.md',
  instructionsImport: '@AGENTS.md',
  installNote:
    'The installer runs `irm https://claude.ai/install.ps1 | iex` in PowerShell and installs to `%USERPROFILE%\\.local\\bin`. After installing, sign in with your Claude account (Pro, Max, Team or Enterprise) or an Anthropic Console account. If the CLI is installed somewhere else, set its path in Settings → Claude Code.',
  extensionNote:
    "You have the Claude Code extension for VS Code (or a similar editor). Hive doesn't use it — the extension's built-in copy moves with every extension update and can't be updated on its own. Install the CLI; your extension keeps working as before.",
  signInHelp: 'Type /login in one of its agents’ terminals (that agent then carries on by itself), or use Help → Agent Setup → Claude Code → Sign in.',
  modelLabel: claudeModelLabel,
  canSwitchLive
}
