// Other names for the same folder, as Windows gives them (#389): an 8.3 short name (GitHub's runner has its temp folder at
// C:\Users\RUNNER~1\…) and a junction. Git lists worktrees by their real, long names, so code comparing a path it was given
// with git's must compare real paths; tests use these to check it does, on any machine.
import { spawnSync } from 'child_process'
import { symlinkSync } from 'fs'

/** The 8.3 short form of an existing path, or null when it has none (the volume makes none, or every part is short). */
export function shortPath(p: string): string | null {
  try {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsVerbatimArguments: true, windowsHide: true })
    const s = r.status === 0 ? r.stdout.trim() : ''
    return s && s.toLowerCase() !== p.toLowerCase() ? s : null
  } catch {
    return null
  }
}

/** A junction at `at` to the existing folder `target`: another name for it (no admin rights needed). */
export function junction(target: string, at: string): string {
  symlinkSync(target, at, 'junction')
  return at
}
