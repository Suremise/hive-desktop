import type { AgentDef, AppSettings, EffortLevel, PermissionMode, ProjectConfig, ProjectProviderConfig, ProviderId, ProviderSettings } from './types'
import { CLAUDE_CODE, CLAUDE_DESCRIPTOR } from './claude'
import { CODEX_DESCRIPTOR } from './codex'

/**
 * Providers: the coding-agent CLIs Hive can run (Claude Code, Codex). Everything the UI and the shared
 * settings logic need to know about one lives in its descriptor, so a new provider needs a descriptor
 * here and an adapter in src/main/providers — nothing else checks which provider an agent uses.
 */

export interface ModeOption {
  value: string
  label: string
  description: string
  /** The provider's no-guardrails mode: hidden unless enabled in its settings, confirmed, and marked. */
  danger?: boolean
}

export interface ModelOption {
  value: string
  label: string
}

export interface ModelGroup {
  label: string
  older?: boolean
  models: ModelOption[]
}

export interface ProviderCapabilities {
  /** Hive chooses the session id at launch (Claude Code); otherwise the provider reports it once started. */
  fixedSessionId: boolean
  /** How a running session changes permission mode: cycling a key (Claude's Shift+Tab), a menu, or not at all. */
  liveModeSwitch: 'cycle' | 'menu' | 'none'
  /** Plan mode is a toggle separate from the permission mode (Codex). */
  planModeToggle: boolean
  /** The prompt cache expires after a known time, so resuming may re-cache (Anthropic's 5 min / 1 h). */
  promptCacheTtl: boolean
  /** The provider reports the session's API-equivalent cost itself. */
  reportsCost: boolean
  /** Compacting takes focus instructions. */
  compactFocus: boolean
  /** Models have a 1M-context variant chosen with a suffix. */
  oneMContext: boolean
  /** A pasted image path is attached as an image. */
  imagePaste: boolean
  /** Hooks can hand an edit to the CLI's own approval prompt (the "Ask me" file lock). Without it, Hive asks the user itself. */
  lockAsk: boolean
  /**
   * The CLI can move a session into its own background service (Claude Code's agent view, opened with ← on an
   * empty prompt), where Hive can no longer see or stop it. Hive turns that off unless allowBackgroundSessions.
   */
  backgroundSessions: boolean
  /**
   * The CLI starts a new turn by itself when one of the agent's background tasks ends (Claude Code's task
   * notifications). An agent with such tasks open is then shown as background, not finished; without it the
   * tasks are only counted.
   */
  backgroundWakes: boolean
}

export interface ProviderDescriptor {
  id: ProviderId
  /** Product name: "Claude Code". */
  name: string
  /** What the assistant is called in a conversation: "Claude". */
  assistant: string
  company: string
  cliName: string
  /** Icon key for the renderer (see ProviderIcon). */
  icon: string
  setupUrl: string
  permissionModes: ModeOption[]
  defaultPermissionMode: PermissionMode
  effortLevels: { value: EffortLevel; label: string }[]
  /** Models offered in pickers. Providers with account-specific catalogues fill this at runtime. */
  modelGroups: ModelGroup[]
  modelPlaceholder: string
  capabilities: ProviderCapabilities
  /** Shortcuts the provider's terminal UI uses, left to the terminal while it has focus ("MOD+K"…). */
  reservedKeys: string[]
  /** The instructions file the CLI reads in a project. */
  instructionsFile: string
  /** A line that makes instructionsFile include the shared AGENTS.md, for CLIs that don't read AGENTS.md themselves. */
  instructionsImport?: string
  /**
   * The Hive Assistant's default mode: the one where the CLI approves safe actions itself (as agents default to),
   * so it rarely asks. Not a plan mode, which blocks the MCP tools the Assistant works with.
   */
  assistantMode: PermissionMode
  /**
   * A warning for a mode the CLI may not run with a model (it then runs another), or null. A warning, not a
   * rule: which models support a mode is the CLI's to decide and can change, and Hive shows the mode it runs in.
   */
  modeCaveat?: (mode: PermissionMode, model: string) => string | null
  /** Agent Setup: how the installer works and which accounts can sign in. */
  installNote: string
  /** Agent Setup, when only an editor extension's copy was found: why Hive doesn't use it. */
  extensionNote: string
  modelLabel: (model: string) => string
  /** Whether a running session can switch to a mode without restarting (launched: the mode it started in). */
  canSwitchLive: (target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined) => boolean
}

export const DEFAULT_PROVIDER: ProviderId = CLAUDE_CODE

/** Every provider Hive knows, in display order. */
export const PROVIDERS: ProviderDescriptor[] = [CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR]

const UNKNOWN: ProviderDescriptor = {
  ...CLAUDE_DESCRIPTOR,
  id: 'unknown',
  name: 'Unknown provider',
  assistant: 'Agent',
  company: '',
  cliName: '',
  icon: 'question',
  permissionModes: [],
  modelGroups: [],
  modelLabel: (m) => m,
  canSwitchLive: () => false,
  installNote: '',
  extensionNote: ''
}

export function providerDescriptor(id: ProviderId | null | undefined): ProviderDescriptor {
  return PROVIDERS.find((p) => p.id === (id || DEFAULT_PROVIDER)) ?? { ...UNKNOWN, id: id ?? 'unknown', name: id ?? 'Unknown provider' }
}

export function isKnownProvider(id: unknown): id is ProviderId {
  return typeof id === 'string' && PROVIDERS.some((p) => p.id === id)
}

export function providerName(id: ProviderId | null | undefined): string {
  return providerDescriptor(id).name
}

// ---------------------------------------------------------------------------
// Settings resolution (global → project → agent), per provider
// ---------------------------------------------------------------------------

export function defaultProviderSettings(p: ProviderDescriptor): ProviderSettings {
  return {
    enabled: false,
    executablePath: '',
    defaultModel: '',
    defaultEffort: '',
    defaultPermissionMode: p.defaultPermissionMode,
    enableDangerousMode: false,
    extraArgs: '',
    checkUpdatesOnLaunch: true,
    allowBackgroundSessions: false,
    prices: {}
  }
}

export const DEFAULT_PROJECT_PROVIDER: ProjectProviderConfig = { model: 'inherit', effort: 'inherit', permissionMode: 'inherit', extraArgs: '' }

/** A provider's global settings, with defaults for anything missing. */
export function providerSettings(settings: Pick<AppSettings, 'providers'> | null | undefined, id: ProviderId): ProviderSettings {
  return { ...defaultProviderSettings(providerDescriptor(id)), ...settings?.providers?.[id] }
}

/** A project's settings for one provider, with Inherit for anything missing. */
export function projectProviderConfig(cfg: Pick<ProjectConfig, 'providers'> | null | undefined, id: ProviderId): ProjectProviderConfig {
  return { ...DEFAULT_PROJECT_PROVIDER, ...cfg?.providers?.[id] }
}

export function isProviderEnabled(settings: Pick<AppSettings, 'providers'> | null | undefined, id: ProviderId): boolean {
  return isKnownProvider(id) && !!settings?.providers?.[id]?.enabled
}

export function enabledProviders(settings: Pick<AppSettings, 'providers'> | null | undefined): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => isProviderEnabled(settings, p.id))
}

/** The provider a project's new agents use: its own choice, else the global default. */
export function projectDefaultProvider(cfg: Pick<ProjectConfig, 'defaultProvider'> | null | undefined, settings: Pick<AppSettings, 'defaultProvider'> | null | undefined): ProviderId {
  const own = cfg?.defaultProvider
  return own && own !== 'inherit' ? own : settings?.defaultProvider || DEFAULT_PROVIDER
}

/** The provider an agent runs: its own, else the project's default (agents from before providers are Claude Code; see workspace.projectConfig). */
export function agentProvider(agent: Pick<AgentDef, 'provider'> | null | undefined, cfg: Pick<ProjectConfig, 'defaultProvider'> | null | undefined, settings: Pick<AppSettings, 'defaultProvider'> | null | undefined): ProviderId {
  return agent?.provider || projectDefaultProvider(cfg, settings)
}

export function modeOption(provider: ProviderId, mode: PermissionMode | null | undefined): ModeOption | undefined {
  return providerDescriptor(provider).permissionModes.find((m) => m.value === mode)
}

/** The provider's warning for running this mode with this model (null when there is none, or the model isn't known). */
export function modeCaveat(provider: ProviderId, mode: PermissionMode | '' | null | undefined, model: string | null | undefined): string | null {
  return mode && model ? (providerDescriptor(provider).modeCaveat?.(mode, model) ?? null) : null
}

export function permissionLabel(provider: ProviderId, mode: PermissionMode): string {
  return modeOption(provider, mode)?.label ?? mode
}

/** Whether a mode can be used: it's one of the provider's, and not its dangerous mode unless that is enabled. */
export function modeAllowed(provider: ProviderId, mode: PermissionMode | null | undefined, settings: Pick<AppSettings, 'providers'> | null | undefined): boolean {
  const m = modeOption(provider, mode)
  return !!m && (!m.danger || providerSettings(settings, provider).enableDangerousMode)
}

/** The modes a picker offers: the provider's, without the dangerous one unless it is enabled. */
export function offeredModes(provider: ProviderId, settings: Pick<AppSettings, 'providers'> | null | undefined): ModeOption[] {
  return providerDescriptor(provider).permissionModes.filter((m) => !m.danger || providerSettings(settings, provider).enableDangerousMode)
}

export interface AgentLaunchSettings {
  provider: ProviderId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  /** Global then project extra arguments, as typed (split by the main process). */
  extraArgs: string[]
}

/** What an agent launches with: its own overrides, else the project's (for its provider), else the global defaults. */
export function agentLaunchSettings(agent: Pick<AgentDef, 'provider' | 'model' | 'effort' | 'permissionMode'> | null | undefined, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: Pick<AppSettings, 'providers' | 'defaultProvider'>): AgentLaunchSettings {
  const provider = agentProvider(agent, cfg, settings)
  const g = providerSettings(settings, provider)
  const pc = projectProviderConfig(cfg, provider)
  const fallbackMode = modeAllowed(provider, g.defaultPermissionMode, settings) ? g.defaultPermissionMode : providerDescriptor(provider).defaultPermissionMode
  const projectMode = pc.permissionMode === 'inherit' ? fallbackMode : pc.permissionMode
  let permissionMode = agent?.permissionMode ?? projectMode
  if (!modeAllowed(provider, permissionMode, settings)) permissionMode = modeAllowed(provider, projectMode, settings) ? projectMode : fallbackMode
  const model = agent?.model || (pc.model && pc.model !== 'inherit' ? pc.model : g.defaultModel || null)
  const effort = agent?.effort || (pc.effort !== 'inherit' ? pc.effort : g.defaultEffort || null)
  return { provider, model, effort, permissionMode, extraArgs: [g.extraArgs, pc.extraArgs].filter((a) => a && a.trim()) }
}
