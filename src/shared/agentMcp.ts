/**
 * Which of a project's MCP servers an agent gets (#537): all of them (the default, `mcpServers` absent), or only those
 * its settings name (`mcpServers`, saved by templates). Only servers the workspace has on and the project hasn't turned
 * off reach anyone; a name chosen here that isn't one of them reaches nobody. The built-in hive server isn't one of
 * them: every session gets it, whatever this says.
 */
import type { AgentDef } from './types'

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
