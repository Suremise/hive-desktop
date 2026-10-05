/**
 * Folders shown by their name, such as workspaces in the quit dialog: two with the same name (D:\client-a\work and
 * D:\client-b\work) need more of their path to tell them apart.
 */

const segments = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

/**
 * For each folder whose name another one shares: the fewest parent folders that tell it apart ("client-a"), keyed by
 * its path in lower case. Folders with a name of their own aren't in it. Paths differing only in case are one folder.
 */
export function distinguishingParents(paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const byName = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const p of paths) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = (segments(p).pop() ?? '').toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), p])
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const parts = group.map((p) => segments(p).slice(0, -1))
    const longest = Math.max(...parts.map((x) => x.length))
    // The fewest parents (nearest first) that are different for every folder in the group.
    let k = 1
    const parentsOf = (x: string[], n: number): string[] => x.slice(Math.max(0, x.length - n))
    while (k < longest && new Set(parts.map((x) => parentsOf(x, k).join('\\').toLowerCase())).size < group.length) k++
    group.forEach((p, i) => out.set(p.toLowerCase(), parentsOf(parts[i], k).join(p.includes('\\') ? '\\' : '/')))
  }
  return out
}
