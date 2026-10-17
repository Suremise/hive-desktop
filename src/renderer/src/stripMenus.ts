/**
 * The session page's menus opened from a command (the palette): the agent strip's template menus under their buttons,
 * and an agent's ⋯ menu under its pane's ⋯ (`agent`). A request waits for the strip or pane of its project (and agent)
 * to show it (the command first goes to the Session tab).
 */
export type StripMenu = 'addFromTemplate' | 'loadTemplate' | 'agentMenu'

type Request = { project: string; menu: StripMenu; agent?: string }
let pending: Request | null = null
const listeners = new Set<() => void>()

export function requestStripMenu(project: string, menu: StripMenu, agent?: string): void {
  pending = { project, menu, agent }
  for (const l of listeners) l()
}

/** The request for this project's strip (or this agent's pane), if any, taken (so only one shows it). */
export function takeStripMenu(project: string, menu: StripMenu, agent?: string): boolean {
  if (pending?.project !== project || pending.menu !== menu || pending.agent !== agent) return false
  pending = null
  return true
}

export function onStripMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
