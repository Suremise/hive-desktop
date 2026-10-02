/**
 * File paths in a terminal line (agents print them all the time: "Update(src/main/sessions.ts)",
 * "tests/x.test.ts:42:7", stack traces), and where they lead. The terminal links only those that
 * resolve inside a workspace project or agent worktree and exist on disk (checked by the caller).
 *
 * A line is read in one scan (scan()) into references:
 * - **Quoted text** ("src/my file.ts":12, 'docs/a b.md', `x.ts:3`) is one reference: its whole range, with a
 *   location inside or after the quotes, belongs to it. It reads as one path or none; its pieces are never links.
 * - **Runs of unquoted words**: a path with spaces in it is a run of words ("C:/ws/my app/src/app.ts:12"), read
 *   as its beginnings, longest first. A run that starts with an absolute path and isn't a file as a whole links
 *   none of its pieces ("app/src/app.ts" inside it would open some other file).
 * pathCandidates() lists every reading for the caller to look up; findPaths() then picks, from the same scan,
 * the readings that are files.
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

// --- Grammar

/** Characters a name may have: brackets and braces too (Next.js's `app/[slug]/page.tsx`); spaces only when quoted or in a run. */
const NAME = String.raw`[\w.@+~$#%[\]{}-]+`
const PATH = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])*${NAME}(?:[\\/]${NAME})*`
/** Not inside a longer word, path or URL ("https://x/y.md" is the web link's). */
const WORD_RE = new RegExp(String.raw`(?<![\w.\\/:~$@+#%{}-])${PATH}`, 'g')
/** Quoted text; an apostrophe inside a word ("it's") doesn't open one. */
const QUOTE_RE = /(?<!\w)(["'`])([^"'`\r\n]{1,260}?)\1(?!\w)/g
/** :12, :12:3, (12), (12,3), and Python's `, line 12`. */
const LOCATION = String.raw`:(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|,? line (\d+)`
const LOCATION_AT = new RegExp(`(?:${LOCATION})`, 'y')
const LOCATION_AT_END = new RegExp(`(?:${LOCATION})$`)
const HAS_EXT = /\.[A-Za-z][\w-]{0,11}$/

/** At most this many paths per line are linked, and four times as many looked up. */
const MAX_PER_LINE = 20

const isAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)
const hasFolder = (p: string): boolean => /[\\/]/.test(p)
/** A name worth looking up: it has a folder in it, or an extension. */
const pathLike = (p: string): boolean => !!p && !/^\.+$/.test(p.replace(/[\\/]/g, '')) && (hasFolder(p) || HAS_EXT.test(p))

interface Location {
  line?: number
  col?: number
  /** How many characters it takes up. */
  length: number
}

function location(m: RegExpExecArray | null): Location | null {
  if (!m) return null
  const n = (i: number): number | undefined => (m[i] ? Number(m[i]) : undefined)
  return { line: n(1) ?? n(3) ?? n(5), col: n(2) ?? n(4), length: m[0].length }
}

/** The location written at `index` in the line, if there is one. */
function locationAt(text: string, index: number): Location | null {
  LOCATION_AT.lastIndex = index
  return location(LOCATION_AT.exec(text))
}

function match(start: number, end: number, path: string, at: Location | null): PathMatch {
  const line = at?.line
  const col = at?.col
  return { start, end, path, ...(line ? { line } : {}), ...(col ? { col } : {}) }
}

// --- Scanning

/** Quoted text: one reference, which reads as one path or none. */
interface Quote {
  /** Its whole range, quotes and any location after them included. */
  from: number
  to: number
  reading: PathMatch | null
}

/** An unquoted word that may be (part of) a path, with the location written after it. */
interface Word {
  start: number
  /** Where the word ends, and where its location ends. */
  nameEnd: number
  end: number
  path: string
  at: Location | null
}

/** Quoted text in the line. A location may be inside the quotes ("x.ts:12") or after them ("x.ts":12). */
function quotes(text: string): Quote[] {
  const out: Quote[] = []
  for (const m of text.matchAll(QUOTE_RE)) {
    const content = m[2]
    const start = m.index + 1
    const contentEnd = start + content.length
    const inside = location(LOCATION_AT_END.exec(content))
    const after = inside ? null : locationAt(text, contentEnd + 1)
    const to = contentEnd + 1 + (after?.length ?? 0)
    const path = inside ? content.slice(0, -inside.length) : content
    // The link is the quoted text, and a location after the quotes with it.
    const reading = path.trim() === path && pathLike(path) ? match(start, after ? to : contentEnd, path, inside ?? after) : null
    out.push({ from: m.index, to, reading })
  }
  return out
}

/** Unquoted words outside the quotes. A sentence's full stop isn't part of a name. */
function words(text: string, quoted: readonly Quote[]): Word[] {
  const out: Word[] = []
  for (const m of text.matchAll(WORD_RE)) {
    if (quoted.some((q) => m.index < q.to && m.index + m[0].length > q.from)) continue
    const at = locationAt(text, m.index + m[0].length)
    const path = at ? m[0] : m[0].replace(/\.+$/, '')
    if (!path) continue
    const nameEnd = m.index + path.length
    out.push({ start: m.index, nameEnd, end: nameEnd + (at?.length ?? 0), path, at })
  }
  return out
}

/**
 * Words that may be one path with spaces in it. A word runs on into the next, one space on, when it has no
 * extension and no location, and either has a folder in it ("C:/ws/my" + "app/x.ts") or is a single plain word
 * just before one ("my" + "docs/x.ts": a first folder name with a space).
 */
function runs(text: string, ws: readonly Word[]): Word[][] {
  const out: Word[][] = []
  for (const w of ws) {
    const run = out[out.length - 1]
    const prev = run?.[run.length - 1]
    const continues =
      !!prev && !prev.at && !HAS_EXT.test(prev.path) && text.slice(prev.nameEnd, w.start) === ' ' && (hasFolder(prev.path) || (run.length === 1 && hasFolder(w.path)))
    if (continues) run.push(w)
    else out.push([w])
  }
  return out
}

/** The same path without brackets around it ("[src/a.ts]" → "src/a.ts"); "[slug]" in a name stays. */
function unbracketed(m: PathMatch): PathMatch | null {
  const names = m.path.split(/[\\/]/)
  const lead = m.path.startsWith('[') && !names[0].includes(']') ? 1 : 0
  const trail = m.path.endsWith(']') && !names[names.length - 1].includes('[') ? 1 : 0
  const path = m.path.slice(lead, m.path.length - trail)
  if ((!lead && !trail) || !pathLike(path)) return null
  // With a location the link runs on to its end; without, it stops before the bracket.
  return { ...m, start: m.start + lead, path, end: m.line === undefined ? m.end - trail : m.end }
}

/** How a run of words may read when it starts at its first word: its beginnings, longest first. */
function readings(text: string, run: readonly Word[]): PathMatch[] {
  const out: PathMatch[] = []
  for (let j = run.length - 1; j >= 0; j--) {
    const last = run[j]
    const path = text.slice(run[0].start, last.nameEnd)
    if ((j > 0 && !pathLike(last.path)) || !pathLike(path)) continue
    const m = match(run[0].start, last.end, path, last.at)
    out.push(m)
    const plain = unbracketed(m)
    if (plain) out.push(plain)
  }
  return out
}

/** The line's quoted references and runs of words, from one scan. */
function scan(text: string): { quoted: Quote[]; runs: Word[][] } {
  const quoted = quotes(text)
  return { quoted, runs: runs(text, words(text, quoted)) }
}

// --- Picking the links

/** Every reading in the line that may be a file, for the caller to look up before findPaths() picks among them. */
export function pathCandidates(text: string): PathMatch[] {
  const { quoted, runs: rs } = scan(text)
  const out = quoted.flatMap((q) => (q.reading ? [q.reading] : []))
  for (const run of rs) for (let i = 0; i < run.length; i++) out.push(...readings(text, run.slice(i)))
  return out.slice(0, MAX_PER_LINE * 4)
}

/** The links in a run of words: from each place, its longest reading that is a file, then on after it. */
function pickInRun(text: string, run: readonly Word[], isFile: (m: PathMatch) => boolean): PathMatch[] {
  const out: PathMatch[] = []
  let i = 0
  while (i < run.length) {
    const rest = run.slice(i)
    const hit = readings(text, rest).find(isFile)
    if (hit) {
      out.push(hit)
      i += rest.findIndex((w) => w.end >= hit.end) + 1
    } else if (rest.length > 1 && isAbsolute(rest[0].path)) break
    else i++
  }
  return out
}

/**
 * The file paths in a line of terminal text, given which candidates (pathCandidates()) are files: each quoted
 * reference that is one, and in each run of words the longest readings that are.
 */
export function findPaths(text: string, isFile: (m: PathMatch) => boolean): PathMatch[] {
  const { quoted, runs: rs } = scan(text)
  const out = quoted.flatMap((q) => (q.reading && isFile(q.reading) ? [q.reading] : []))
  for (const run of rs) out.push(...pickInRun(text, run, isFile))
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_PER_LINE)
}

// --- Where a path leads

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
