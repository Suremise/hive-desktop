import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findPaths, resolveLink, type LinkRoot, type LinkTarget } from '@shared/fileLinks'
import { call } from './api'
import { get, isAssistantPath, set, setProjectTab, showView } from './store'

/** The workspace's projects and agent worktrees, where file links may lead. */
function linkRoots(): LinkRoot[] {
  const out: LinkRoot[] = []
  for (const p of get().workspace?.projects ?? []) {
    out.push({ path: p.path, project: p.path, agentId: null })
    for (const a of p.agents) if (a.worktree) out.push({ path: a.worktree.path, project: p.path, agentId: a.id })
  }
  return out
}

/** The folder an agent's relative paths are from: its worktree or project; the Assistant's are the workspace's. */
function linkBase(projectPath: string, agentId: string | undefined): string | null {
  const s = get()
  if (isAssistantPath(projectPath)) return s.workspace?.path ?? null
  const p = s.workspace?.projects.find((x) => x.path === projectPath)
  return p?.agents.find((a) => a.id === agentId)?.worktree?.path ?? p?.path ?? null
}

/** Whether a file exists, remembered for a few seconds so hovering doesn't ask main on every move. */
const known = new Map<string, { ok: boolean; at: number }>()
const KNOWN_MS = 5000

async function existing(targets: LinkTarget[]): Promise<boolean[]> {
  const key = (t: LinkTarget): string => `${t.root}|${t.rel}`.toLowerCase()
  const now = Date.now()
  const ask = new Map<string, LinkTarget[]>()
  for (const t of targets) {
    const k = known.get(key(t))
    if (k && now - k.at < KNOWN_MS) continue
    ask.set(t.root, [...(ask.get(t.root) ?? []), t])
  }
  await Promise.all(
    [...ask].map(async ([root, ts]) => {
      const ok = await call('files:areFiles', root, ts.map((t) => t.rel)).catch(() => ts.map(() => false))
      ts.forEach((t, i) => known.set(key(t), { ok: !!ok[i], at: now }))
    })
  )
  if (known.size > 2000) for (const [k, v] of known) if (now - v.at >= KNOWN_MS) known.delete(k)
  return targets.map((t) => !!known.get(key(t))?.ok)
}

/** Shows a file in its project's Files tab (the worktree's folder for a worktree), at a line. */
export function openFileLink(t: LinkTarget, line?: number, col?: number): void {
  set((s) => ({
    selectedProject: t.project,
    filesRoot: { ...s.filesRoot, [t.project]: t.agentId ?? '' },
    filesJump: { project: t.project, root: t.agentId ?? '', rel: t.rel, line, col, nonce: Date.now() }
  }))
  showView('projects')
  setProjectTab(t.project, 'files')
}

/** A line's text, and the terminal column each character starts in (wide characters take two). */
function lineText(line: IBufferLine, cols: number): { text: string; colOf: number[] } {
  let text = ''
  const colOf: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) colOf.push(x)
    text += chars
  }
  colOf.push(cols)
  return { text, colOf }
}

/**
 * Ctrl+click on a file path in a session's terminal opens it in the Files tab at its line. Only paths
 * to files that exist in a workspace project or worktree are linked; a plain click stays a click.
 */
export function fileLinkProvider(term: Terminal, context: () => { projectPath?: string; agentId?: string }, host: () => HTMLElement | null): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { projectPath, agentId } = context()
      const base = projectPath ? linkBase(projectPath, agentId) : null
      const line = term.buffer.active.getLine(y - 1)
      if (!base || !line) return callback(undefined)
      const { text, colOf } = lineText(line, term.cols)
      const roots = linkRoots()
      const found = findPaths(text).flatMap((m) => {
        const target = resolveLink(m.path, base, roots)
        return target ? [{ m, target }] : []
      })
      if (!found.length) return callback(undefined)
      void existing(found.map((f) => f.target)).then((ok) => {
        const links: ILink[] = found
          .filter((_, i) => ok[i])
          .map(({ m, target }) => ({
            text: text.slice(m.start, m.end),
            range: { start: { x: colOf[m.start] + 1, y }, end: { x: colOf[m.end - 1] + 1, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => {
              if (e.ctrlKey || e.metaKey) openFileLink(target, m.line, m.col)
            },
            hover: () => host()?.setAttribute('title', 'Open in Files · Ctrl+click'),
            leave: () => host()?.removeAttribute('title')
          }))
        callback(links.length ? links : undefined)
      })
    }
  }
}
