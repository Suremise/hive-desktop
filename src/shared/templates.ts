// Agent templates (#126): a project's agents and layout saved under a name, to load into any project (replacing its
// agents) or to add one agent from. What a template holds and what it leaves out (sessions, worktree paths and branches,
// setup state, the Assistant's persona: those belong to the project), checked as untrusted input when read.
import { MAX_AGENTS, ROLE_MAX, SESSION_LAYOUTS, projectAgents } from './defaults'
import { isKnownProvider } from './providers'
import type { AgentDef, EffortLevel, PageLayout, PermissionMode, ProviderId } from './types'

/** The format's version: a template made by a newer Hive (a higher one) is refused rather than half read. */
export const TEMPLATE_VERSION = 1
/** A template's name is at most this long. */
export const TEMPLATE_NAME_MAX = 60
/** Where a template is kept: for every project of the workspace, or for one project (its .hive, private to it). */
export type TemplateScope = 'workspace' | 'project'
export const TEMPLATE_SCOPES: readonly TemplateScope[] = ['workspace', 'project']

/** One agent of a template: its settings and role, and whether it works in a worktree of its own. */
export interface TemplateAgent {
  name: string
  role?: string
  provider: ProviderId
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  use200kContext?: boolean
  /** Its own new worktree (true) or the project folder. */
  worktree: boolean
}

export interface AgentTemplate {
  version: number
  name: string
  /** When it was saved (ISO). */
  savedAt: string
  /** The project's one layout (#134). */
  layout: PageLayout
  agents: TemplateAgent[]
}

/** A template as listed: where it is kept and what it holds, or why it can't be used. */
export interface TemplateEntry {
  scope: TemplateScope
  /** Its file's name in that scope's folder (how it is named in calls). */
  file: string
  name: string
  savedAt: string | null
  layout: PageLayout
  agents: TemplateAgent[]
  /** It can't be used (damaged, made by a newer Hive…): why. */
  problem?: string
}

/**
 * A template of a project's agents and layout. `provider` gives each agent's provider as it runs now (stored on the
 * agent since 0.2, else the project's or the app's default), so a template is the same wherever it is loaded.
 */
export function templateFrom(name: string, agents: AgentDef[], layout: PageLayout, provider: (a: AgentDef) => ProviderId, now = new Date()): AgentTemplate {
  return {
    version: TEMPLATE_VERSION,
    name: name.trim(),
    savedAt: now.toISOString(),
    layout,
    agents: projectAgents({ agents }).map((a) => ({
      name: a.name,
      ...(a.role ? { role: a.role } : {}),
      provider: a.provider || provider(a),
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}),
      ...(typeof a.use200kContext === 'boolean' ? { use200kContext: a.use200kContext } : {}),
      worktree: !!a.worktree
    }))
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
/** A model, effort or mode as a CLI names it: short, no spaces or control characters. */
const setting = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:/[\]-]{1,100}$/.test(v)

/** A template read from a file (untrusted): the template, or why it can't be used. */
export function readTemplate(raw: unknown): AgentTemplate | string {
  if (!isObj(raw)) return "It isn't a Hive agent template."
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return "It isn't a Hive agent template (no version)."
  if (version > TEMPLATE_VERSION) return 'It was made by a newer version of Hive: update Hive to use it.'
  if (!text(raw.name, TEMPLATE_NAME_MAX)) return `Its name is missing or longer than ${TEMPLATE_NAME_MAX} characters.`
  if (!Array.isArray(raw.agents) || !raw.agents.length) return 'It has no agents.'
  if (raw.agents.length > MAX_AGENTS) return `It has ${raw.agents.length} agents; a project can have up to ${MAX_AGENTS}.`
  const agents: TemplateAgent[] = []
  for (const [i, a] of raw.agents.entries()) {
    const which = `Agent ${i + 1}`
    if (!isObj(a) || !text(a.name, 60)) return `${which} has no name (or one over 60 characters).`
    const name = a.name.trim()
    if (agents.some((x) => x.name.toLowerCase() === name.toLowerCase())) return `Two agents are called "${name}".`
    if (!isKnownProvider(a.provider)) return `${name} runs a coding agent this Hive doesn't know (${typeof a.provider === 'string' ? a.provider.slice(0, 40) : 'none'}).`
    if (a.role !== undefined && (typeof a.role !== 'string' || a.role.length > ROLE_MAX)) return `${name}'s role is over ${ROLE_MAX} characters.`
    for (const k of ['model', 'effort', 'permissionMode'] as const) if (a[k] !== undefined && !setting(a[k])) return `${name}'s ${k} isn't one Hive can use.`
    if (a.use200kContext !== undefined && typeof a.use200kContext !== 'boolean') return `${name}'s context setting isn't one Hive can use.`
    const role = typeof a.role === 'string' ? a.role.replace(/\s+/g, ' ').trim() : ''
    agents.push({
      name,
      ...(role ? { role } : {}),
      provider: a.provider,
      ...(a.model ? { model: a.model as string } : {}),
      ...(a.effort ? { effort: a.effort as string } : {}),
      ...(a.permissionMode ? { permissionMode: a.permissionMode as string } : {}),
      ...(typeof a.use200kContext === 'boolean' ? { use200kContext: a.use200kContext } : {}),
      worktree: a.worktree === true
    })
  }
  const layout: PageLayout = raw.layout === 'auto' || SESSION_LAYOUTS.some((l) => l.value === raw.layout) ? (raw.layout as PageLayout) : 'auto'
  const savedAt = typeof raw.savedAt === 'string' && Number.isFinite(Date.parse(raw.savedAt)) ? raw.savedAt : ''
  return { version, name: raw.name.trim(), savedAt, layout, agents }
}

/** A template's file name, from its name: lower case, safe on every file system ("Build and review.json" → "build-and-review.json"). */
export function templateFile(name: string, n = 1): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'template'
  return `${base}${n > 1 ? `-${n}` : ''}.json`
}

/** A file name Hive could have made: what calls may name (never a path). */
export const isTemplateFile = (file: unknown): file is string => typeof file === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*\.json$/.test(file) && file.length <= 64

/** A name not yet taken (case aside): itself, else "Builder 2", "Builder 3"… */
export function uniqueName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}
