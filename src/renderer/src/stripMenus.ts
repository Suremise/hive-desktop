/**
 * The agent strip's template menus opened from a command (the palette): the strip shows the menu under its button. A
 * request waits for the strip of its project to show it (the command first goes to the Session tab).
 */
export type StripMenu = 'addFromTemplate' | 'loadTemplate'

type Request = { project: string; menu: StripMenu }
let pending: Request | null = null
const listeners = new Set<() => void>()

export function requestStripMenu(project: string, menu: StripMenu): void {
  pending = { project, menu }
  for (const l of listeners) l()
}

/** The request for this project's strip, if any, taken (so only one strip shows it). */
export function takeStripMenu(project: string, menu: StripMenu): boolean {
  if (pending?.project !== project || pending.menu !== menu) return false
  pending = null
  return true
}

export function onStripMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
