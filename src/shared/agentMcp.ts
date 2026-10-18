/**
 * Which of a project's MCP servers an agent gets (#537): all of them (the default, `mcpServers` absent), or only those
 * its settings name (`mcpServers`, saved by templates). Only servers on in the project reach anyone (mcpOnInProject);
 * a name chosen here that isn't one of them reaches nobody. The built-in hive server isn't one of them: every session
 * gets it, whatever this says.
 */
import type { AgentDef, McpServerInfo, ProjectConfig } from './types'

/**
 * Whether a workspace MCP server is on in a project (#1093): only when it is on in the workspace (its master switch,
 * workspace.json's mcp.enabled) and on in the project (the project's own choice, its MCP tab: project.json's
 * mcp.enabled). Turning the workspace off keeps the projects' choices. A list Hive can't read (a hand-edited file) turns
 * nothing on.
 */
export function mcpOnInProject(name: string, workspaceOn: readonly string[], project: Partial<ProjectConfig['mcp']> | null | undefined): boolean {
  const has = (list: unknown): boolean => Array.isArray(list) && list.includes(name)
  return has(workspaceOn) && has(project?.enabled)
}

/** The names in a list from a config file (a hand-edited file may hold anything). */
const listed = (list: unknown): string[] => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [])

/**
 * A project's choices moved to #1093's model, so what ran before still runs and nothing else starts: before, a server
 * was on in a project when the project turned it on, or the workspace had it on for all projects (`allProjects`), unless
 * the project turned it off (`disabled`, which won). Now it is on in the project wherever it ran there.
 */
export function migratedProjectMcp(allProjects: readonly string[], project: Partial<ProjectConfig['mcp']> | null | undefined): string[] {
  const off = listed(project?.disabled)
  return [...new Set([...listed(project?.enabled), ...listed(allProjects)])].filter((n) => !off.includes(n)).sort()
}

/** The workspace's switches moved to #1093's model: on for every server that ran anywhere (on for all projects, or turned on in a project). */
export function migratedWorkspaceMcp(allProjects: readonly string[], projects: readonly (Partial<ProjectConfig['mcp']> | null | undefined)[]): string[] {
  const on = new Set(listed(allProjects))
  for (const p of projects) for (const n of listed(p?.enabled)) if (!listed(p?.disabled).includes(n)) on.add(n)
  return [...on].sort()
}

/** A listed server (mcp:list, listMcp) on in a project: a valid definition, on there (mcpOnInProject). */
export const serverOnIn = (m: Pick<McpServerInfo, 'name' | 'def' | 'globallyEnabled'>, project: Partial<ProjectConfig['mcp']> | null | undefined): boolean =>
  !!m.def && mcpOnInProject(m.name, m.globallyEnabled ? [m.name] : [], project)

/** The most servers an agent's choice names. */
export const AGENT_MCP_MAX = 50

/** A workspace MCP server's name (its .hive/mcp/<name>.json); `hive` is Hive's own. */
export const isMcpServerName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && name !== 'hive'

/**
 * An agent's choice as saved: undefined for all of the project's servers, else the names (trimmed, each once, in the
 * order given; empty: none of them). Throws with what is wrong.
 */
export function cleanMcpServers(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error("MCP servers is a list of the project's server names.")
  const out: string[] = []
  for (const v of raw) {
    const name = typeof v === 'string' ? v.trim() : ''
    if (!isMcpServerName(name)) throw new Error(`"${String(v).slice(0, 70)}" isn't an MCP server's name${name === 'hive' ? ' (the built-in hive server is always given)' : ''}.`)
    if (!out.includes(name)) out.push(name)
  }
  if (out.length > AGENT_MCP_MAX) throw new Error(`An agent can be given at most ${AGENT_MCP_MAX} MCP servers.`)
  return out
}

/**
 * Whether an agent gets the project's server `name`. A choice Hive can't read (a hand-edited project.json) gives none:
 * never more than was asked for.
 */
export function agentGetsMcp(agent: Pick<AgentDef, 'mcpServers'> | null | undefined, name: string): boolean {
  const only: unknown = agent?.mcpServers
  if (only === undefined || only === null) return true
  return Array.isArray(only) && only.includes(name)
}

/** Whether the agent has a choice of its own (only some servers), not all of the project's. */
export const agentChoosesMcp = (agent: Pick<AgentDef, 'mcpServers'> | null | undefined): boolean => agent?.mcpServers !== undefined && agent?.mcpServers !== null

/**
 * The agent's choice in words: "all of the project's", "only github, notes" or "none of the project's". `on`: the
 * project's servers that are on, to say which chosen ones aren't ("only notes (not on here)").
 */
export function agentMcpText(agent: Pick<AgentDef, 'mcpServers'> | null | undefined, on?: readonly string[]): string {
  if (!agentChoosesMcp(agent)) return "all of the project's"
  const names = Array.isArray(agent!.mcpServers) ? agent!.mcpServers.filter((n) => typeof n === 'string') : []
  if (!names.length) return "none of the project's"
  return `only ${names.map((n) => (on && !on.includes(n) ? `${n} (not on here)` : n)).join(', ')}`
}
