// How the window shows token counts and sizes (#608): pure, so unit tests reach them without the renderer.

/** Token units, largest first: the unit, its suffix, and from how many of it whole numbers are shown. */
const TOKEN_UNITS = [[1e9, 'B', 100], [1e6, 'M', 10], [1e3, 'k', 100]] as const

/** "950", "12.3k", "450k", "5.5M", "12M", "12.9B", "150B"; an average is rounded, and a value that would show as 1000 of a
 *  unit is shown in the next (999,999 is "1.0M", not "1000k"). */
export function formatTokens(n: number): string {
  const r = Math.round(n)
  let i = TOKEN_UNITS.findIndex(([unit]) => r >= unit)
  if (i < 0) return String(r)
  if (i > 0 && Math.round(r / TOKEN_UNITS[i][0]) >= 1000) i--
  const [unit, suffix, whole] = TOKEN_UNITS[i]
  const v = r / unit
  return `${v.toFixed(Number(v.toFixed(1)) >= whole ? 0 : 1)}${suffix}`
}

/** "160 B", "1.5 KB", "12 KB", "3.4 MB": whole bytes (an average is rounded), and a value that would show as 1024 of a unit
 *  is shown in the next (1,048,575 bytes is "1.0 MB", not "1024 KB"). */
export function formatBytes(n: number): string {
  const b = Math.round(n)
  const kb = b / 1024
  if (b < 1024) return `${b} B`
  if (Math.round(kb) < 1024) return `${kb.toFixed(Number(kb.toFixed(1)) >= 10 ? 0 : 1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
