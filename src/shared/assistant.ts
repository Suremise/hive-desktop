import type { AppSettings, LiveSessionState, ProjectConfig, ProjectProviderConfig, ProviderId } from './types'
import { DEFAULT_SETTINGS, projectAgents } from './defaults'
import { PROVIDERS } from './providers'
import { columnLabel } from './tasks'

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
/** The mode (a persona file) new conversations use unless Settings or the workspace chooses another (#259). */
export const DEFAULT_PERSONA = 'coordinator'

export { RETIRED_PERSONAS } from './defaults'

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

/**
 * A persona (mode) file's header (name, description, icon, and summary: its habits in a few lines, on one line or as
 * an indented `summary: |` block) and its instructions.
 */
export function parsePersona(text: string): { name?: string; description?: string; icon?: string; summary?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text.trim() }
  const out: { name?: string; description?: string; icon?: string; summary?: string; body: string } = { body: text.slice(m[0].length).trim() }
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description|icon|summary):\s*(.*)$/.exec(lines[i].trim())
    if (!kv) continue
    let value = kv[2]
    // A block: the indented lines that follow.
    if (/^[|>][-+]?$/.test(value.trim())) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      value = block.join('\n').trim()
    }
    out[kv[1] as 'name' | 'description' | 'icon' | 'summary'] = value.replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/**
 * A mode's habits in a few lines, for the message that switches the Assistant to it: its summary, else (a persona the
 * user wrote without one) the first lines of its instructions, headings left out.
 */
export function modeSummary(p: { summary?: string; body: string }): string {
  if (p.summary?.trim()) return p.summary.trim()
  const lines = p.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  let out = ''
  for (const l of lines) {
    if (out && `${out} ${l}`.length > 400) break
    out = out ? `${out} ${l}` : l
  }
  return out.length > 400 ? `${out.slice(0, 399)}…` : out
}

/**
 * What Hive types into a running Assistant when the user switches its mode: the mode and its habits, marked as Hive's
 * (not a task), and always Hive's last sentence (never the file's): a mode can't change what the Assistant may do.
 */
export function modeMessage(name: string, summary: string): string {
  return `[Hive] Mode: ${name} (chosen by the user). ${summary.replace(/\s+/g, ' ').trim()} Your tools and permissions are unchanged.`
}

/** A new mode's file: a header and a starting point for its instructions. */
export function newPersonaText(name: string): string {
  return `---\nname: ${name}\ndescription: What this mode is for, in one line.\nicon: 🐝\nsummary: |\n  Its habits in a few lines: what Hive tells the Assistant when you switch to it.\n---\n\nYou are in **${name}** mode.\n\nDescribe how the Assistant works in it: what it puts first, its habits and the shape of what it hands back.\n`
}

/** A persona id from a name: lower case, words joined by hyphens. */
export function personaId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * The Assistant panel's status line (#312), from what Hive knows of its session: "Working", "Idle", "Waiting for you",
 * "Waiting for #271, #273 → Review (watch until 22:22)". A card watch's cards are kept apart (`cards`, between `text`
 * and `after`) so each can be a chip that opens its card. `tone`: attention when it needs the user, busy while it works,
 * calm while it is idle or waits on cards or tasks, off when it isn't running. `approvals`: the titles of Hive's questions
 * its actions wait on (stopping a busy agent…), shown under the line: waiting for the user's answer comes first, over
 * working, idle and a card watch; sign-in and an error keep their words, with it added.
 */
export interface AssistantStatusLine {
  text: string
  cards: number[]
  after: string
  tone: 'attention' | 'busy' | 'calm' | 'off'
}

export function assistantStatusLine(live: Pick<LiveSessionState, 'status' | 'statusMessage' | 'backgroundTasks' | 'question' | 'watch'> | null | undefined, time: (iso: string) => string, approvals: readonly string[] = []): AssistantStatusLine {
  const line = (text: string, tone: AssistantStatusLine['tone'], cards: number[] = [], after = ''): AssistantStatusLine => ({ text, cards, after, tone })
  if (!live || live.status === 'stopped') return line('Not running', 'off')
  const approval = approvals.length === 1 ? `Waiting for your approval: ${approvals[0]}` : approvals.length ? `Waiting for your approval (${approvals.length} questions)` : ''
  if (approval && live.status !== 'signin' && live.status !== 'error') return line(approval, 'attention')
  const n = live.backgroundTasks ?? 0
  const tasks = `${n} background task${n === 1 ? '' : 's'}`
  // A question it doesn't stop for: it works on meanwhile, and the user is wanted.
  const asks = live.question && live.status !== 'waiting' ? ' · has a question for you' : ''
  const base = ((): AssistantStatusLine => {
    switch (live.status) {
      case 'waiting':
        return line('Waiting for you', 'attention')
      case 'signin':
        return line('Waiting for you to sign in', 'attention')
      case 'error':
        return line(live.statusMessage ? `Error: ${live.statusMessage}` : 'Error', 'attention')
      case 'watching':
        if (live.watch) {
          const until = time(live.watch.limitAt)
          // An agent watch (#416): its label names the agents.
          if (live.watch.agents) return line(`${live.watch.label}${until ? ` (watch until ${until})` : ''}`, 'calm')
          return line('Waiting for ', 'calm', live.watch.cards, `${live.watch.column ? ` → ${columnLabel(live.watch.column)}` : ''}${until ? ` (watch until ${until})` : ''}`)
        }
        return line('Waiting on cards', 'calm')
      case 'background':
        return line(`Waiting on ${tasks}`, 'calm')
      case 'starting':
        return line(live.statusMessage || 'Starting…', 'busy')
      case 'working':
        return line(live.statusMessage || 'Working', 'busy')
      default:
        return line(n ? `Idle · ${tasks} running` : 'Idle', 'calm')
    }
  })()
  const also = approval ? ' · waiting for your approval' : asks
  return also ? { ...base, after: `${base.after}${also}`, tone: 'attention' } : base
}
