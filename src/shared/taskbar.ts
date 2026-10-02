/**
 * The taskbar button when agents need you (the attention inbox's count): a badge over Hive's icon, the count in
 * the window title (Alt+Tab, hover), and a flash when an agent starts waiting for your input while the window
 * isn't focused. Each window shows its own workspace's count.
 */

/** The badge's text: nothing at 0, the number up to 9, then 9+. */
export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 9 ? '9+' : String(count)
}

/** The window's title, prefixed with the count when there is one: "(2) alpha — work — Hive". */
export function windowTitle(title: string, count: number): string {
  return count > 0 ? `(${count}) ${title}` : title
}

/** What the badge says to screen readers. */
export function badgeDescription(count: number): string {
  return count === 1 ? '1 agent needs you' : `${count} agents need you`
}

/** Whether a status change should flash the taskbar button: an agent starts waiting for input while the window isn't focused. */
export function shouldFlash(before: string | undefined, after: string, windowFocused: boolean, enabled: boolean): boolean {
  return enabled && !windowFocused && after === 'waiting' && before !== 'waiting'
}
