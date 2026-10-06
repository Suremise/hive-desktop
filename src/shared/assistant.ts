import type { AppSettings, ProjectConfig, ProjectProviderConfig, ProviderId } from './types'
import { DEFAULT_SETTINGS, projectAgents } from './defaults'
import { PROVIDERS } from './providers'

/**
 * The Hive Assistant: one per workspace, its overseer. It runs like a project's agent (same terminal, hooks,
 * status, usage and quit handling) from a home folder Hive never lists as a project, .hive/assistant, and
 * works in the workspace folder. Settings → Assistant holds its defaults; the home's one agent holds the
 * workspace's own choices (Assistant Settings), over them.
 */

/** The Assistant's home in a workspace's .hive folder. */
export const ASSISTANT_DIR = 'assistant'
/** Its agent's id (the home's only agent). */
export const ASSISTANT_AGENT_ID = 'assistant'
export const ASSISTANT_NAME = 'Assistant'
/** Where the workspace's personas are, in its .hive folder. */
export const PERSONAS_DIR = 'personas'
export const DEFAULT_PERSONA = 'overseer'

/** Hive's tools that only read: the Assistant uses them without being asked each time (the ones that write still ask). */
export const ASSISTANT_TRUSTED_TOOLS = [
  'hive_list_projects',
  'hive_project_status',
  'hive_session_usage',
  'hive_list_shared_notes',
  'hive_read_shared_note',
  'hive_read_latest_handover',
  'hive_list_skills'
]

/**
 * The Assistant's config as its sessions see it: Settings → Assistant stands in for "the project's" settings
 * (provider, model, effort, mode, arguments), an unset mode is the provider's assistantMode, and the home
 * always has exactly its one agent, keeping the workspace's overrides from the file.
 */
export function assistantProjectConfig(cfg: ProjectConfig, settings: Pick<AppSettings, 'assistant'>): ProjectConfig {
  const a = settings.assistant
  const providers = {} as Record<ProviderId, ProjectProviderConfig>
  for (const p of PROVIDERS) {
    const s = a?.providers?.[p.id]
    providers[p.id] = { model: s?.model || 'inherit', effort: s?.effort || 'inherit', permissionMode: s?.permissionMode || p.assistantMode, extraArgs: s?.extraArgs ?? '', use200kContext: s?.use200kContext || 'inherit' }
  }
  const own = projectAgents(cfg).find((x) => x.id === ASSISTANT_AGENT_ID)
  return {
    ...cfg,
    defaultProvider: a?.provider || 'inherit',
    providers,
    agents: [{ ...own, id: ASSISTANT_AGENT_ID, name: ASSISTANT_NAME }],
    layout: 'auto',
    // Settings → Assistant's, so compactThreshold() gives the Assistant its own (0: never), as it does a project its own.
    compactSuggestTokens: a?.compactSuggestTokens ?? DEFAULT_SETTINGS.assistant.compactSuggestTokens,
    fileLocks: 'off',
    worktreeSetup: ''
  }
}

/** The persona a new Assistant conversation takes: the workspace's choice, else Settings → Assistant's. */
export function assistantPersona(agent: { persona?: string } | null | undefined, settings: Pick<AppSettings, 'assistant'> | null | undefined): string {
  return agent?.persona || settings?.assistant?.persona || DEFAULT_PERSONA
}

/** A persona file's header (name, description, icon) and its instructions. */
export function parsePersona(text: string): { name?: string; description?: string; icon?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text.trim() }
  const out: { name?: string; description?: string; icon?: string; body: string } = { body: text.slice(m[0].length).trim() }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description|icon):\s*(.*)$/.exec(line.trim())
    if (kv) out[kv[1] as 'name' | 'description' | 'icon'] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/** A new persona's file: a header and a starting point for its instructions. */
export function newPersonaText(name: string): string {
  return `---\nname: ${name}\ndescription: What this persona is for, in one line.\nicon: 🐝\n---\n\nYou are ${name}, the Hive Assistant for this workspace.\n\nDescribe the role, how it behaves and how it reports back.\n`
}

/** A persona id from a name: lower case, words joined by hyphens. */
export function personaId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
