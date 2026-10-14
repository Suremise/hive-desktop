/**
 * Shortcuts used by more than one command (Settings → Keyboard Shortcuts, #795): kept by command id, never by label. A
 * command's label is its name in the language shown, read each time, so a label kept from before a change of language
 * (or two commands whose names translate alike) would make a shortcut clash with itself or hide a real clash. The
 * editor names the commands when it shows a clash.
 */

/** Each shortcut (upper-cased) used by a command, with the ids of the commands using it. */
export function shortcutUsers(entries: Iterable<{ id: string; key: string | undefined }>): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const { id, key } of entries) {
    if (!key) continue
    const k = key.toUpperCase()
    byKey.set(k, [...(byKey.get(k) ?? []), id])
  }
  return byKey
}

/** The other commands using a shortcut: never `id` itself. */
export const otherUsers = (users: Map<string, string[]>, key: string | undefined, id: string): string[] => (key ? (users.get(key.toUpperCase()) ?? []).filter((x) => x !== id) : [])
