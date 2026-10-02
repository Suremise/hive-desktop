/**
 * File paths in a terminal line (agents print them all the time: "Update(src/main/sessions.ts)",
 * "tests/x.test.ts:42:7", stack traces), and where they lead. The terminal links only those that
 * resolve inside a workspace project or agent worktree and exist on disk (checked by the caller).
 */

export interface PathMatch {
  /** Where the link starts and ends in the line (end exclusive), including any :line:col. */
  start: number
  end: number
  path: string
  line?: number
  col?: number
}

/** A folder a link may lead into: a project, or an agent's worktree (`agentId`). */
export interface LinkRoot {
  path: string
  project: string
  agentId: string | null
}

export interface LinkTarget {
  /** The project and, for a worktree, its agent: the Files tab shows that folder. */
  project: string
  agentId: string | null
  /** The folder the path is in (`project` or the worktree), and the path within it, with forward slashes. */
  root: string
  rel: string
}

const SEG = String.raw`[\w.@+~$-]+`
const PATH = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])*${SEG}(?:[\\/]${SEG})*`
// :12, :12:3, (12), (12,3), and Python's `File "x.py", line 12`.
const LOCATION = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|"?,? line (\d+))?`
// Not inside a longer word, path or URL ("https://x/y.md" is the web link's).
const PATH_RE = new RegExp(String.raw`(?<![\w.\\/:~$@+-])(${PATH})${LOCATION}`, 'g')
const HAS_EXT = /\.[A-Za-z][\w-]{0,11}$/

/** At most this many paths per line are looked up. */
const MAX_PER_LINE = 20

/** The file paths in a line of terminal text: anything with a folder in it, or a name with an extension. */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  for (const m of text.matchAll(PATH_RE)) {
    let path = m[1]
    let end = m.index + m[0].length
    const num = (s: string | undefined): number | undefined => (s ? Number(s) : undefined)
    const line = num(m[2] ?? m[4] ?? m[6])
    const col = num(m[3] ?? m[5])
    // A sentence's full stop isn't part of the name.
    if (line === undefined) {
      const trimmed = path.replace(/\.+$/, '')
      end -= path.length - trimmed.length
      path = trimmed
    }
    if (!path || /^\.+$/.test(path.replace(/[\\/]/g, ''))) continue
    if (!/[\\/]/.test(path) && !HAS_EXT.test(path)) continue
    out.push({ start: m.index, end, path, ...(line !== undefined && line > 0 ? { line } : {}), ...(col !== undefined && col > 0 ? { col } : {}) })
    if (out.length >= MAX_PER_LINE) break
  }
  return out
}

const isAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)

/** `path` against `base` (both Windows paths), with . and .. resolved and backslashes. */
export function joinPath(base: string, path: string): string {
  const full = isAbsolute(path) ? path : `${base.replace(/[\\/]+$/, '')}\\${path}`
  const parts: string[] = []
  for (const seg of full.split(/[\\/]+/)) {
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('\\')
}

/**
 * Where a printed path leads: the innermost project or worktree it's in (a worktree may sit inside
 * its project folder), relative paths taken from `base` (the agent's folder). Null outside them all.
 */
export function resolveLink(path: string, base: string, roots: readonly LinkRoot[]): LinkTarget | null {
  const abs = joinPath(base, path)
  const lower = abs.toLowerCase()
  let best: LinkRoot | null = null
  let bestPath = ''
  for (const r of roots) {
    const root = joinPath(r.path, '.')
    if (lower.startsWith(root.toLowerCase() + '\\') && root.length > bestPath.length) {
      best = r
      bestPath = root
    }
  }
  if (!best) return null
  const rel = abs.slice(bestPath.length + 1).replace(/\\/g, '/')
  // The Files tab doesn't show git's own folder.
  if (/^\.git(\/|$)/i.test(rel)) return null
  return { project: best.project, agentId: best.agentId, root: best.path, rel }
}
