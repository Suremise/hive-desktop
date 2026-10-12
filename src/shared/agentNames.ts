// Agent names are unique across the workspace (#702): two projects' agents called B1 can't be told apart on the board,
// in notifications or by the Assistant. Adding, renaming and loading a template refuse a name another agent of the
// workspace has, suggesting one with the project's prefix (B1 in amberlight: AB1); names from before stay, flagged once.

/** An agent of the workspace, by name: its project's folder name, and its id. */
export interface NamedAgent {
  project: string
  name: string
  id?: string
}

/** The longest agent name a template keeps, and what a load's names may be. */
export const AGENT_NAME_MAX = 60

const key = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase()

/** Whether two agent names are the same (case and spacing aside). */
export const sameAgentName = (a: string, b: string): boolean => key(a) === key(b)

/** The agent already called `name` (case aside), other than `self` (an agent being renamed): null when it is free. */
export function nameTaken(name: string, agents: readonly NamedAgent[], self?: { project: string; id: string }): NamedAgent | null {
  return agents.find((a) => sameAgentName(a.name, name) && !(self && a.id === self.id && a.project.toLowerCase() === self.project.toLowerCase())) ?? null
}

/** The project's initials, upper case: hive → H, hive-desktop → HD, amberLight → AL. */
export function projectPrefix(project: string): string {
  const words = project.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.map((w) => w[0]).join('').toUpperCase() || 'P'
}

/** A short code (B1, R2, QA, b1): a prefix joins it, in capitals (AMB1); a word gets the project in brackets. */
const isCode = (name: string): boolean => /^([A-Z0-9]{1,6}|[A-Za-z]{1,4}\d{1,3})$/.test(name)

/**
 * A free name for an agent called `name` in `project` (#702): the project's prefix in front of a short code (B1 in
 * amberlight: AB1, then AMB1, AMBB1…), a word with the project after it ("Builder (amberlight)"), else numbered.
 */
export function suggestAgentName(name: string, project: string, taken: readonly string[]): string {
  const used = new Set(taken.map(key))
  const free = (n: string): boolean => !used.has(key(n)) && n.length <= AGENT_NAME_MAX
  const clean = name.replace(/\s+/g, ' ').trim()
  const word = project.replace(/[^A-Za-z0-9]+/g, '').toUpperCase()
  const prefixes = [projectPrefix(project), ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(0, i + 2))]
  const tries = isCode(clean) ? prefixes.map((p) => `${p}${clean.toUpperCase()}`) : [`${clean} (${project})`]
  const found = tries.find(free)
  if (found) return found
  const stem = tries[0]
  for (let n = 2; ; n++) if (free(`${stem} ${n}`)) return `${stem} ${n}`
}

/** "There is already an agent called "B1" in amberlight…": the refusal, with a free name to use instead. */
export function nameTakenMessage(name: string, owner: NamedAgent, suggestion: string): string {
  return `There is already an agent called "${owner.name}" in ${owner.project}. Agent names are unique across the workspace: try "${suggestion}".`
}

/** Why a name can't be used for an agent (empty, too long), or null. */
export function agentNameProblem(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Enter a name.'
  if (clean.length > AGENT_NAME_MAX) return `A name is at most ${AGENT_NAME_MAX} characters.`
  return null
}

/** The names more than one agent of the workspace has, each with those agents (projects in order): duplicates from before #702. */
export function duplicateAgentNames(agents: readonly NamedAgent[]): { name: string; agents: NamedAgent[] }[] {
  const groups = new Map<string, NamedAgent[]>()
  for (const a of agents) groups.set(key(a.name), [...(groups.get(key(a.name)) ?? []), a])
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({ name: g[0].name, agents: [...g].sort((x, y) => x.project.localeCompare(y.project, undefined, { sensitivity: 'base' })) }))
}

/** The workspace's agents by name, from its projects as the window has them. */
export function workspaceAgentList(projects: readonly { name: string; agents: readonly { name: string; id: string }[] }[] | null | undefined): NamedAgent[] {
  return (projects ?? []).flatMap((p) => p.agents.map((a) => ({ project: p.name, name: a.name, id: a.id })))
}
