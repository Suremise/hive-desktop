import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, ProjectInfo, SessionImage, SessionImageGroup, UnusedWorktree } from '@shared/types'
import { holdsWork } from '@shared/unusedWorktrees'
import { formatDateTime, formatTime } from '@shared/dates'
import * as actions from '../actions'
import { call } from '../api'
import { discardDrafts, draftsUnder, FileView, hasDraft, moveDrafts, useDraftVersion } from '../components/FileView'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { pasteIntoTerminal } from '../components/TerminalView'
import { Icon, IconButton, InfoTip, LoadFailed, Modal, StaleNote, Tooltip, useContextMenu, type MenuEntry } from '../components/ui'
import { confirm, filesListeners, focusedAgentId, get, notify, openInSessionsTab, projectKey, set, setProjectTab, showAgent, UNUSED_ROOT, unusedRoot, useDateStyle, useStore } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { cx, formatBytes, HIVE_FILES_MIME, IMAGE_EXT, imageUrl, quotePath, timeAgo } from '../util'

const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const absOf = (project: ProjectInfo, rel: string): string => (rel ? `${project.path}\\${rel.replace(/\//g, '\\')}` : project.path)
const isUnder = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(dir + '/')

/** Starts live file events for the project while mounted and calls onChange with the changed folders. */
function useFileEvents(projectPath: string, onChange: (dirs: string[]) => void): void {
  const ref = useRef(onChange)
  ref.current = onChange
  useEffect(() => {
    // Live updates only: without a watch the tree still loads, and Refresh reads it again.
    void call('files:watch', projectPath).catch(() => undefined)
    const listener = (p: string, dirs: string[]): void => {
      if (p.toLowerCase() === projectPath.toLowerCase()) ref.current(dirs)
    }
    filesListeners.add(listener)
    return () => {
      filesListeners.delete(listener)
      void call('files:unwatch', projectPath).catch(() => undefined)
    }
  }, [projectPath])
}

/**
 * Pastes paths into the project's running session and switches to it. Images from outside
 * .hive/images are copied there first, like images dropped on the terminal.
 */
async function insertIntoSession(project: ProjectInfo, paths: string[]): Promise<void> {
  const t = sessionTarget(project)
  const agentId = t.agentId
  if (!project.live || !agentId) return
  const out: string[] = []
  for (const p of paths) {
    const keep = IMAGE_EXT.test(p) && !/[\\/]\.hive[\\/]images[\\/]/i.test(p)
    const saved = keep ? await actions.attempt('Could not add image', () => call('session:saveImage', t.path, p, agentId)) : null
    out.push(quotePath(saved || p))
  }
  const text = out.join(' ') + ' '
  setProjectTab(t.path, 'session')
  const owner = get().workspace?.projects.find((x) => x.path === t.path)
  if (owner) showAgent(owner, agentId)
  // A real paste, so Claude Code attaches image paths instead of treating them as typed text.
  const key = projectKey(t.path, agentId)
  if (!pasteIntoTerminal(key, text)) await call('pty:write', key, text)
}

/**
 * A project as a tab sees it: the folder shown (the project folder, or a worktree agent's worktree)
 * and, as `live`, the session that Insert into Session pastes into — the worktree's agent, else the
 * focused agent if it works in the project folder, else the first agent (none in a project without agents).
 */
type ViewProject = ProjectInfo & { target?: { path: string; agentId: string | null } }

function sessionTarget(p: ViewProject): { path: string; agentId: string | null } {
  return p.target ?? { path: p.path, agentId: null }
}

export function projectView(project: ProjectInfo, rootAgent?: string): ViewProject {
  const wt = project.agents.find((a) => a.id === rootAgent && a.worktree)
  if (wt) return { ...project, path: wt.worktree!.path, branch: wt.worktree!.branch, live: wt.live, target: { path: project.path, agentId: wt.id } }
  const focused = project.agents.find((a) => a.id === focusedAgentId(project))
  const agent = focused && !focused.worktree ? focused : project.agents[0]
  return { ...project, live: agent?.live ?? null, target: { path: project.path, agentId: agent?.id ?? null } }
}

/**
 * Picks whose folder a tab shows when agents work in worktrees. Renders nothing otherwise. Changes also lists the
 * project's unused worktrees (#400, `unused`): all of them (`unused`), or one to show (`unused:<folder>`).
 */
export function RootSelector({ project, value, onChange, unused }: { project: ProjectInfo; value: string | undefined; onChange: (agentId: string) => void; unused?: UnusedWorktree[] }) {
  const worktrees = project.agents.filter((a) => a.worktree)
  const spare = unused ?? []
  if (!worktrees.length && !spare.length) return null
  const known = worktrees.some((a) => a.id === value) || (!!spare.length && (value === UNUSED_ROOT || spare.some((w) => unusedRoot(w.path) === value)))
  return (
    <div className="root-row">
      <Tooltip content={spare.length ? 'Show the project folder, the worktree a worktree agent works in, or an unused worktree' : 'Show the project folder, or the worktree a worktree agent works in'}>
        <select className="select root-select" value={known ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Project folder</option>
          {worktrees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}'s worktree · {a.worktree!.branch}
            </option>
          ))}
          {spare.length > 0 && (
            <optgroup label="Unused worktrees (no agent uses them now)">
              <option value={UNUSED_ROOT}>All unused worktrees ({spare.length})</option>
              {spare
                .filter((w) => w.branch)
                .map((w) => (
                  <option key={w.path} value={unusedRoot(w.path)}>
                    {w.branch} · {w.check.removable ? 'merged, clean' : holdsWork(w) ? 'holds work' : 'not checked'}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
      </Tooltip>
    </div>
  )
}

export function FilesTab({ project }: { project: ProjectInfo }) {
  const root = useStore((s) => s.filesRoot[project.path])
  useStore((s) => s.focusedAgent[project.path])
  const view = projectView(project, root)
  // A file to show (a terminal's file link), once the folder it's in is the one shown.
  const shown = view.path === project.path ? '' : root
  const jump = useStore((s) => (s.filesJump?.project === project.path && s.filesJump.root === shown ? s.filesJump : null))
  const selector = <RootSelector project={project} value={root} onChange={(id) => set((s) => ({ filesRoot: { ...s.filesRoot, [project.path]: id } }))} />
  return <FilesBrowser key={view.path} project={view} selector={selector} jump={jump} />
}

type Goto = { rel: string; line?: number; col?: number; nonce: number }

const copyText = (text: string): void => void navigator.clipboard.writeText(text)

function fileIcon(e: FileEntry, open: boolean): string {
  if (e.isDir) return open ? 'folder-opened' : 'folder'
  const n = e.name.toLowerCase()
  if (IMAGE_EXT.test(n) || /\.(svg|ico)$/.test(n)) return 'file-media'
  if (n.endsWith('.md')) return 'markdown'
  if (n.endsWith('.json')) return 'json'
  if (/\.(zip|7z|gz|tar|rar)$/.test(n)) return 'file-zip'
  if (/\.(pdf)$/.test(n)) return 'file-pdf'
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|cs|go|rs|java|c|cpp|h|css|scss|html|sh|ps1|yml|yaml|toml|xml|sql)$/.test(n)) return 'file-code'
  return 'file'
}

const GIT_TEXT: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Copied' }

// Cut/copy between tabs and projects. Paste into another project always copies.
let fileClipboard: { mode: 'copy' | 'cut'; project: string; rels: string[] } | null = null

type Editing = { kind: 'new-file' | 'new-folder'; parent: string } | { kind: 'rename'; rel: string }
type Row = { entry: FileEntry; depth: number } | { edit: true; depth: number; isDir: boolean }

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function FilesBrowser({ project, selector, jump }: { project: ProjectInfo; selector: React.ReactNode; jump: Goto | null }) {
  const listWidth = usePaneSize('files', 360)
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [filter, setFilter] = useState('')
  // The filter searches the whole folder by path. Its matches belong to the folder and the filter: never shown for
  // another. A failed search is said, with Retry, rather than "No files match".
  const q = filter.trim()
  const filtering = !!q
  const findKey = filtering ? JSON.stringify([project.path, q]) : ''
  const find = useScopedLoad<FileEntry[]>(findKey)
  const results = filtering ? find.data : null
  const findError = filtering ? find.error : null
  const [findTry, setFindTry] = useState(0)
  const [git, setGit] = useState<Record<string, string>>({})
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [, setClipVersion] = useState(0)
  useDraftVersion()
  const treeRef = useRef<HTMLDivElement>(null)
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const menu = useContextMenu()
  const hoverTimer = useRef<number | undefined>(undefined)

  const loadDir = useCallback(
    async (rel: string): Promise<void> => {
      try {
        const entries = await call('files:list', project.path, rel)
        setDirs((d) => ({ ...d, [rel]: entries }))
      } catch {
        // The folder is gone: forget it and everything below it.
        setDirs((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !isUnder(k, rel) || rel === '')))
        setExpanded((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !isUnder(k, rel))))
      }
    },
    [project.path]
  )

  const loadGit = useCallback(() => {
    void call('git:status', project.path)
      .then((s) => {
        const map: Record<string, string> = {}
        for (const f of s.files) {
          if (f.status === 'D') continue
          const st = f.status === '?' ? 'U' : f.status
          map[f.path] = st
          // Folders take the colour of the first change inside them, modified winning over new.
          for (let p = parentOf(f.path); p; p = parentOf(p)) if (!map[p] || st === 'M') map[p] = st
        }
        setGit(map)
      })
      // Only the tree's change colours: without git's status the files are still all there.
      .catch(() => setGit({}))
  }, [project.path])

  const reloadAll = useCallback(() => {
    for (const rel of Object.keys(dirsRef.current)) void loadDir(rel)
    if (!dirsRef.current['']) void loadDir('')
    loadGit()
  }, [loadDir, loadGit])

  useEffect(() => {
    setDirs({})
    setExpanded({})
    setSelected([])
    void loadDir('')
    loadGit()
  }, [project.path, loadDir, loadGit])

  const gitTimer = useRef<number | undefined>(undefined)
  // Per-folder change counters, so the open file can notice it changed on disk.
  const [dirTicks, setDirTicks] = useState<Record<string, number>>({})
  useFileEvents(project.path, (changed) => {
    setDirTicks((t) => Object.fromEntries([...Object.entries(t), ...changed.map((d) => [d, (t[d] ?? 0) + 1])]))
    for (const d of changed) if (dirsRef.current[d]) void loadDir(d)
    window.clearTimeout(gitTimer.current)
    gitTimer.current = window.setTimeout(loadGit, 400)
  })

  const { load: loadFind } = find
  useEffect(() => {
    if (!findKey) return
    const path = project.path
    const t = window.setTimeout(() => loadFind(findKey, () => call('files:find', path, q)), 180)
    return () => window.clearTimeout(t)
    // The key holds the folder and the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findKey, findTry, loadFind])

  const rows = useMemo<Row[]>(() => {
    // Filtering: the matches, none while they're found.
    if (filtering) return (results ?? []).map((entry) => ({ entry, depth: 0 }))
    const out: Row[] = []
    const walk = (rel: string, depth: number): void => {
      if (editing && editing.kind !== 'rename' && editing.parent === rel) out.push({ edit: true, depth, isDir: editing.kind === 'new-folder' })
      for (const entry of dirs[rel] ?? []) {
        out.push({ entry, depth })
        if (entry.isDir && expanded[entry.relPath]) walk(entry.relPath, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [dirs, expanded, editing, filtering, results])

  const entries = useMemo(() => rows.flatMap((r) => ('entry' in r ? [r.entry] : [])), [rows])
  const byRel = useMemo(() => new Map(entries.map((e) => [e.relPath, e])), [entries])
  const selEntries = selected.map((r) => byRel.get(r)).filter((e): e is FileEntry => !!e)
  const focus = selected[selected.length - 1] ?? null

  const expand = (rel: string, open = true): void => {
    setExpanded((x) => ({ ...x, [rel]: open }))
    if (open && !dirsRef.current[rel]) void loadDir(rel)
  }

  /** Folder that new files and pastes go into: the selected folder, or the selected file's folder. */
  const targetDir = (): string => {
    const e = focus ? byRel.get(focus) : null
    if (!e) return ''
    return e.isDir ? e.relPath : parentOf(e.relPath)
  }

  const select = (rel: string, e?: React.MouseEvent | React.KeyboardEvent): void => {
    if (e?.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.relPath === anchor)
      const b = entries.findIndex((x) => x.relPath === rel)
      if (a >= 0 && b >= 0) {
        const range = entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.relPath)
        // Keep the clicked row last so it is the focus.
        setSelected([...range.filter((r) => r !== rel), rel])
        return
      }
    }
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelected((s) => (s.includes(rel) ? s.filter((r) => r !== rel) : [...s, rel]))
      setAnchor(rel)
      return
    }
    setSelected([rel])
    setAnchor(rel)
  }

  // The row to scroll to once it's in the tree (its folders may still be loading).
  const scrollTo = useRef<string | null>(null)
  const scrollToRow = (): void => {
    const rel = scrollTo.current
    const row = rel !== null ? treeRef.current?.querySelector(`[data-rel="${CSS.escape(rel)}"]`) : null
    if (!row) return
    scrollTo.current = null
    row.scrollIntoView({ block: 'nearest' })
  }
  const reveal = (rel: string): void => {
    for (let p = parentOf(rel); p; p = parentOf(p)) expand(p)
    setSelected([rel])
    setAnchor(rel)
    scrollTo.current = rel
    window.setTimeout(scrollToRow, 50)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(scrollToRow, [rows])

  // A terminal's file link: show the file, then go to its line.
  const [goto, setGoto] = useState<Goto | null>(null)
  useEffect(() => {
    if (!jump) return
    setFilter('')
    reveal(jump.rel)
    setGoto(jump)
    set({ filesJump: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce])

  const startNew = (isDir: boolean, parent = targetDir()): void => {
    setFilter('')
    if (parent) expand(parent)
    setEditing({ kind: isDir ? 'new-folder' : 'new-file', parent })
  }

  const commitEdit = async (value: string): Promise<void> => {
    const ed = editing
    setEditing(null)
    if (!ed || !value.trim()) return
    if (ed.kind === 'rename') {
      const old = byRel.get(ed.rel)
      if (!old || value.trim() === old.name) return
      const rel = await actions.attempt('Could not rename', () => call('files:rename', project.path, ed.rel, value))
      if (rel) {
        moveDrafts(project.path, ed.rel, rel)
        await loadDir(parentOf(ed.rel))
        if (old.isDir) {
          // Carry expanded state over to the new name.
          setExpanded((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [isUnder(k, ed.rel) ? rel + k.slice(ed.rel.length) : k, v])))
          setDirs((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !isUnder(k, ed.rel))))
          if (expanded[ed.rel]) void loadDir(rel)
        }
        reveal(rel)
      }
      return
    }
    const rel = await actions.attempt(ed.kind === 'new-folder' ? 'Could not create folder' : 'Could not create file', () =>
      call('files:create', project.path, ed.parent, value, ed.kind === 'new-folder')
    )
    if (rel) {
      // "a/b/file.txt" also creates the folders in between: open and refresh each of them.
      const chain: string[] = []
      for (let p = parentOf(rel); p && p !== ed.parent; p = parentOf(p)) chain.unshift(p)
      await loadDir(ed.parent)
      for (const p of chain) {
        setExpanded((x) => ({ ...x, [p]: true }))
        await loadDir(p)
      }
      reveal(rel)
    }
  }

  const trashSelected = async (items = selEntries): Promise<void> => {
    if (!items.length) return
    const what = items.length === 1 ? `"${items[0].name}"${items[0].isDir ? ' and everything in it' : ''}` : `${items.length} items`
    const rels = items.map((i) => i.relPath)
    const dirty = draftsUnder(project.path, rels)
    const lost = dirty.length ? ` Unsaved changes to ${dirty.length === 1 ? dirty[0] : `${dirty.length} files`} will be lost.` : ''
    const ok = await confirm({ title: 'Move to Recycle Bin?', message: `Move ${what} to the Recycle Bin?`, detail: `You can restore it from the Recycle Bin.${lost}`, confirmLabel: 'Move to Recycle Bin', danger: true })
    if (!ok) return
    const done = await actions.attempt('Could not delete', () => call('files:trash', project.path, rels).then(() => true))
    if (done) discardDrafts(project.path, rels)
    setSelected([])
    for (const d of new Set(items.map((i) => parentOf(i.relPath)))) void loadDir(d)
    loadGit()
  }

  const setClipboard = (mode: 'copy' | 'cut', items = selEntries): void => {
    if (!items.length) return
    fileClipboard = { mode, project: project.path, rels: items.map((i) => i.relPath) }
    setClipVersion((v) => v + 1)
  }

  const paste = async (dest = targetDir()): Promise<void> => {
    const clip = fileClipboard
    if (!clip) return
    let out: string[] | undefined
    if (clip.project !== project.path) {
      const sources = clip.rels.map((r) => `${clip.project}\\${r.replace(/\//g, '\\')}`)
      out = await actions.attempt('Could not paste', () => call('files:import', project.path, sources, dest))
    } else if (clip.mode === 'cut') {
      out = await actions.attempt('Could not move', () => call('files:move', project.path, clip.rels, dest))
      if (out) {
        clip.rels.forEach((r, i) => moveDrafts(project.path, r, out![i]))
        for (const d of new Set(clip.rels.map(parentOf))) void loadDir(d)
      }
    } else {
      out = await actions.attempt('Could not copy', () => call('files:copy', project.path, clip.rels, dest))
    }
    if (clip.mode === 'cut') fileClipboard = null
    setClipVersion((v) => v + 1)
    if (dest) expand(dest)
    await loadDir(dest)
    loadGit()
    if (out?.length) setSelected(out)
  }

  const duplicate = async (items = selEntries): Promise<void> => {
    const created: string[] = []
    const byDir = new Map<string, string[]>()
    for (const i of items) byDir.set(parentOf(i.relPath), [...(byDir.get(parentOf(i.relPath)) ?? []), i.relPath])
    for (const [dir, rels] of byDir) {
      const out = await actions.attempt('Could not duplicate', () => call('files:copy', project.path, rels, dir))
      if (out) created.push(...out)
      await loadDir(dir)
    }
    if (created.length) setSelected(created)
  }

  const open = (e: FileEntry): void => {
    if (e.isDir) expand(e.relPath, !expanded[e.relPath])
    else openExternally(e.relPath)
  }
  const openExternally = (rel: string): void => void actions.attempt('Could not open file', () => call('files:open', project.path, rel))

  const menuFor = (e: FileEntry | null): MenuEntry[] => {
    const items = e ? (selected.includes(e.relPath) ? selEntries : [e]) : []
    const dest = e ? (e.isDir ? e.relPath : parentOf(e.relPath)) : ''
    const abs = items.map((i) => absOf(project, i.relPath))
    const pasteItem: MenuEntry = { label: 'Paste', icon: 'clippy', keybinding: 'Ctrl+V', disabled: !fileClipboard, onClick: () => void paste(dest) }
    if (!e) {
      return [
        { label: 'New File…', icon: 'new-file', onClick: () => startNew(false, '') },
        { label: 'New Folder…', icon: 'new-folder', onClick: () => startNew(true, '') },
        { separator: true },
        pasteItem,
        { separator: true },
        { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
        { label: 'Refresh', icon: 'refresh', onClick: reloadAll }
      ]
    }
    const single = items.length === 1
    return [
      ...(e.isDir && single
        ? [
            { label: 'New File…', icon: 'new-file', onClick: () => startNew(false, e.relPath) },
            { label: 'New Folder…', icon: 'new-folder', onClick: () => startNew(true, e.relPath) },
            { separator: true }
          ]
        : []),
      ...(!e.isDir && single ? [{ label: 'Open in Default App', icon: 'link-external', onClick: () => open(e) }] : []),
      { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('files:reveal', project.path, e.relPath) },
      ...(project.live ? [{ label: 'Insert Path into Session', icon: 'terminal', onClick: () => void insertIntoSession(project, abs) }] : []),
      { separator: true },
      { label: 'Cut', icon: 'blank', keybinding: 'Ctrl+X', onClick: () => setClipboard('cut', items) },
      { label: 'Copy', icon: 'copy', keybinding: 'Ctrl+C', onClick: () => setClipboard('copy', items) },
      pasteItem,
      { label: 'Duplicate', icon: 'files', onClick: () => void duplicate(items) },
      { separator: true },
      { label: 'Copy Path', icon: 'blank', keybinding: 'Shift+Alt+C', onClick: () => copyText(abs.join('\n')) },
      { label: 'Copy Relative Path', icon: 'blank', onClick: () => copyText(items.map((i) => i.relPath).join('\n')) },
      { separator: true },
      ...(single ? [{ label: 'Rename…', icon: 'tag', keybinding: 'F2', onClick: () => setEditing({ kind: 'rename', rel: e.relPath }) }] : []),
      { label: 'Delete', icon: 'trash', keybinding: 'Del', danger: true, onClick: () => void trashSelected(items) }
    ]
  }

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (editing || (ev.target as HTMLElement).tagName === 'INPUT') return
    const mod = ev.ctrlKey || ev.metaKey
    const idx = focus ? entries.findIndex((x) => x.relPath === focus) : -1
    const cur = idx >= 0 ? entries[idx] : null
    const moveTo = (i: number): void => {
      const t = entries[Math.max(0, Math.min(entries.length - 1, i))]
      if (!t) return
      select(t.relPath, ev.shiftKey ? ev : undefined)
      treeRef.current?.querySelector(`[data-rel="${CSS.escape(t.relPath)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    let handled = true
    if (ev.key === 'ArrowDown') moveTo(idx + 1)
    else if (ev.key === 'ArrowUp') moveTo(idx < 0 ? 0 : idx - 1)
    else if (ev.key === 'Home') moveTo(0)
    else if (ev.key === 'End') moveTo(entries.length - 1)
    else if (ev.key === 'ArrowRight' && cur?.isDir && !filtering) {
      if (!expanded[cur.relPath]) expand(cur.relPath)
      else moveTo(idx + 1)
    } else if (ev.key === 'ArrowLeft' && cur && !filtering) {
      if (cur.isDir && expanded[cur.relPath]) expand(cur.relPath, false)
      else if (parentOf(cur.relPath)) select(parentOf(cur.relPath))
    } else if (ev.key === 'Enter' && cur?.isDir) open(cur)
    else if (ev.key === 'F2' && cur) setEditing({ kind: 'rename', rel: cur.relPath })
    else if (ev.key === 'Delete') void trashSelected()
    else if (mod && ev.key.toLowerCase() === 'c' && !ev.shiftKey) setClipboard('copy')
    else if (mod && ev.key.toLowerCase() === 'x') setClipboard('cut')
    else if (mod && ev.key.toLowerCase() === 'v') void paste()
    else if (mod && ev.key.toLowerCase() === 'a') setSelected(entries.map((x) => x.relPath))
    else if (ev.shiftKey && ev.altKey && ev.key.toLowerCase() === 'c') copyText(selEntries.map((x) => absOf(project, x.relPath)).join('\n'))
    else if (ev.key === 'Escape') {
      if (fileClipboard?.mode === 'cut') {
        fileClipboard = null
        setClipVersion((v) => v + 1)
      } else setSelected([])
    } else handled = false
    if (handled) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

  // ---- drag and drop ----
  const onDragStart = (ev: React.DragEvent, e: FileEntry): void => {
    const items = selected.includes(e.relPath) ? selEntries : [e]
    if (!selected.includes(e.relPath)) setSelected([e.relPath])
    const paths = items.map((i) => absOf(project, i.relPath))
    ev.dataTransfer.setData(HIVE_FILES_MIME, JSON.stringify({ project: project.path, rels: items.map((i) => i.relPath), paths }))
    ev.dataTransfer.setData('text/plain', paths.map(quotePath).join(' '))
    ev.dataTransfer.effectAllowed = 'copyMove'
  }

  const dragOverDir = (ev: React.DragEvent, dir: string): void => {
    const dt = ev.dataTransfer
    const internal = dt.types.includes(HIVE_FILES_MIME)
    if (!internal && !dt.types.includes('Files')) return
    ev.preventDefault()
    ev.stopPropagation()
    dt.dropEffect = internal && !ev.ctrlKey ? 'move' : 'copy'
    if (dropTarget !== dir) {
      setDropTarget(dir)
      // Hovering over a closed folder opens it, like Explorer.
      window.clearTimeout(hoverTimer.current)
      if (dir && !expanded[dir]) hoverTimer.current = window.setTimeout(() => expand(dir), 700)
    }
  }

  const dropOn = async (ev: React.DragEvent, dir: string): Promise<void> => {
    ev.preventDefault()
    ev.stopPropagation()
    setDropTarget(null)
    window.clearTimeout(hoverTimer.current)
    const internal = ev.dataTransfer.getData(HIVE_FILES_MIME)
    let out: string[] | undefined
    if (internal) {
      const data = JSON.parse(internal) as { project: string; rels?: string[]; paths: string[] }
      if (data.project === project.path && data.rels && !ev.ctrlKey) {
        out = await actions.attempt('Could not move', () => call('files:move', project.path, data.rels!, dir))
        if (out) {
          data.rels.forEach((r, i) => moveDrafts(project.path, r, out![i]))
          for (const d of new Set(data.rels.map(parentOf))) void loadDir(d)
        }
      } else if (data.project === project.path && data.rels) {
        out = await actions.attempt('Could not copy', () => call('files:copy', project.path, data.rels!, dir))
      } else out = await actions.attempt('Could not copy', () => call('files:import', project.path, data.paths, dir))
    } else {
      const sources = [...ev.dataTransfer.files].map((f) => window.hive.pathForFile(f)).filter(Boolean)
      if (sources.length) out = await actions.attempt('Could not copy files in', () => call('files:import', project.path, sources, dir))
    }
    if (dir) expand(dir)
    await loadDir(dir)
    loadGit()
    if (out?.length) setSelected(out)
  }

  const cutSet = fileClipboard?.mode === 'cut' && fileClipboard.project === project.path ? new Set(fileClipboard.rels) : null
  const one = selEntries.length === 1 ? selEntries[0] : null

  return (
    <div className="split">
      <div className="split-list files-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="files" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Files
          <InfoTip text="Everything in the project folder. Drag files in from Explorer to copy them here, or drag files onto the Session tab to paste their paths into the session. Deleted files go to the Recycle Bin." />
          <div className="actions">
            <IconButton icon="new-file" title="New File…" onClick={() => startNew(false)} />
            <IconButton icon="new-folder" title="New Folder…" onClick={() => startNew(true)} />
            <IconButton icon="refresh" title="Refresh" onClick={reloadAll} />
            <IconButton icon="collapse-all" title="Collapse All" onClick={() => setExpanded({})} />
          </div>
        </div>
        {selector}
        <div className="files-filter">
          <Icon name="search" />
          <input
            className="input"
            placeholder="Find files by name or path"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('')
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                treeRef.current?.focus()
                if (entries[0]) select(entries[0].relPath)
              }
            }}
          />
          {filter && <IconButton icon="close" title="Clear" onClick={() => setFilter('')} />}
        </div>
        <div
          className={cx('pane-body file-tree', dropTarget === '' && 'drop-root')}
          tabIndex={0}
          ref={treeRef}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => menu.open(e, menuFor(null))}
          onClick={(e) => e.target === e.currentTarget && setSelected([])}
          onDragOver={(e) => dragOverDir(e, '')}
          onDragLeave={(e) => e.currentTarget === e.target && setDropTarget(null)}
          onDrop={(e) => void dropOn(e, '')}
        >
          {findError && <LoadFailed inline what="the matching files" error={findError} onRetry={() => setFindTry((n) => n + 1)} />}
          {filtering && !results && !findError && (
            <div className="pane-empty">
              <Icon name="loading" spin /> Searching…
            </div>
          )}
          {results && results.length === 0 && !findError && <div className="pane-empty">No files match “{filter}”.</div>}
          {!filtering && dirs[''] && dirs[''].length === 0 && !editing && <div className="pane-empty">This project folder is empty.</div>}
          {rows.map((r, i) =>
            'edit' in r ? (
              <NameInput key={`edit-${i}`} depth={r.depth} icon={r.isDir ? 'folder' : 'file'} initial="" onDone={(v) => void commitEdit(v)} />
            ) : editing?.kind === 'rename' && editing.rel === r.entry.relPath ? (
              <NameInput key={r.entry.relPath} depth={r.depth} icon={fileIcon(r.entry, false)} initial={r.entry.name} onDone={(v) => void commitEdit(v)} />
            ) : (
              <FileRow
                key={r.entry.relPath}
                entry={r.entry}
                depth={r.depth}
                flat={filtering}
                open={!!expanded[r.entry.relPath]}
                selected={selected.includes(r.entry.relPath)}
                git={git[r.entry.relPath]}
                cut={!!cutSet?.has(r.entry.relPath)}
                dropTarget={dropTarget === r.entry.relPath}
                onClick={(ev) => {
                  select(r.entry.relPath, ev)
                  if (r.entry.isDir && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey) expand(r.entry.relPath, !expanded[r.entry.relPath])
                }}
                hasDraft={!r.entry.isDir && hasDraft(absOf(project, r.entry.relPath))}
                onContextMenu={(ev) => {
                  if (!selected.includes(r.entry.relPath)) setSelected([r.entry.relPath])
                  menu.open(ev, menuFor(r.entry))
                }}
                onDragStart={(ev) => onDragStart(ev, r.entry)}
                onDragOver={(ev) => dragOverDir(ev, r.entry.isDir ? r.entry.relPath : parentOf(r.entry.relPath))}
                onDrop={(ev) => void dropOn(ev, r.entry.isDir ? r.entry.relPath : parentOf(r.entry.relPath))}
              />
            )
          )}
        </div>
      </div>
      <div className="split-main">
        {one && !one.isDir ? (
          <FileView
            // A fresh instance per file, so no state (text, drafts, mode) leaks from one file to the next.
            key={`${project.path}:${one.relPath}`}
            project={project}
            rel={one.relPath}
            changeTick={dirTicks[parentOf(one.relPath)] ?? 0}
            onOpenRel={reveal}
            goto={goto?.rel === one.relPath && goto.line ? { line: goto.line, col: goto.col, nonce: goto.nonce } : undefined}
            toolbarExtra={
              <>
                <IconButton icon="link-external" title="Open in Default App" onClick={() => openExternally(one.relPath)} />
                <IconButton icon="folder-opened" title="Reveal in File Explorer" onClick={() => void call('files:reveal', project.path, one.relPath)} />
                {project.live && <IconButton icon="terminal" title="Insert Path into Session" onClick={() => void insertIntoSession(project, [absOf(project, one.relPath)])} />}
              </>
            }
          />
        ) : (
          <FileDetails project={project} entry={one} count={selEntries.length} git={one ? git[one.relPath] : undefined} onOpen={open} onRename={(e) => setEditing({ kind: 'rename', rel: e.relPath })} onDelete={() => void trashSelected()} />
        )}
      </div>
      {menu.element}
    </div>
  )
}

function FileRow(props: {
  entry: FileEntry
  depth: number
  flat: boolean
  open: boolean
  selected: boolean
  git?: string
  cut: boolean
  dropTarget: boolean
  hasDraft: boolean
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}) {
  const { entry: e, depth, flat, open, git } = props
  return (
    <div
      data-rel={e.relPath}
      className={cx('row', 'file-row', props.selected && 'selected', props.cut && 'cut', e.ignored && 'ignored', props.dropTarget && e.isDir && 'drop-target')}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={e.relPath}
      draggable
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      {e.isDir && !flat ? <Icon name={open ? 'chevron-down' : 'chevron-right'} className="twistie" /> : <span className="twistie" />}
      <Icon name={fileIcon(e, open)} className={cx('file-icon', e.isDir && 'dir')} />
      <span className={cx('label', git && `git-${git}`)}>{e.name}</span>
      {props.hasDraft && <span className="dirty-dot" title="Unsaved changes">●</span>}
      {flat && <span className="desc">{parentOf(e.relPath)}</span>}
      {git && !e.isDir && <span className={cx('git-status', git)}>{git}</span>}
      {git && e.isDir && <span className={cx('git-dot', `git-${git}`)} />}
    </div>
  )
}

/** Inline name box for new files/folders and rename. Enter or blur commits, Esc cancels. */
function NameInput({ depth, icon, initial, onDone }: { depth: number; icon: string; initial: string; onDone: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name without its extension, like VS Code.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  const finish = (v: string): void => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <div className="row file-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="twistie" />
      <Icon name={icon} className="file-icon" />
      <input
        ref={ref}
        className="input inline-name"
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(e.currentTarget.value)
          if (e.key === 'Escape') finish(initial ? initial : '')
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

function FileDetails({
  project,
  entry,
  count,
  git,
  onOpen,
  onRename,
  onDelete
}: {
  project: ProjectInfo
  entry: FileEntry | null
  count: number
  git?: string
  onOpen: (e: FileEntry) => void
  onRename: (e: FileEntry) => void
  onDelete: () => void
}) {
  useDateStyle()
  if (count > 1) {
    return (
      <div className="empty-state">
        <Icon name="files" />
        {count} items selected
        <p className="hint">Drag them onto a folder to move them (hold Ctrl to copy), or onto the Session tab to paste their paths.</p>
      </div>
    )
  }
  if (!entry) {
    return (
      <div className="empty-state">
        <Icon name="files" />
        Select a file or folder
        <p className="hint">
          Select a file to view or edit it. Right-click for more. <kbd>F2</kbd> renames, <kbd>Del</kbd> moves to the Recycle Bin, <kbd>Ctrl+C</kbd> / <kbd>Ctrl+X</kbd> / <kbd>Ctrl+V</kbd> copy, cut and paste.
        </p>
      </div>
    )
  }
  const abs = absOf(project, entry.relPath)
  return (
    <div className="file-details">
      <div className="file-details-head">
        <Icon name={fileIcon(entry, false)} />
        <div style={{ minWidth: 0 }}>
          <h2>{entry.name}</h2>
          <div className="faint path">{entry.relPath}</div>
        </div>
      </div>
      <table className="kv">
        <tbody>
          <tr><td>Type</td><td>{entry.isDir ? 'Folder' : entry.name.includes('.') ? `${entry.name.split('.').pop()!.toUpperCase()} file` : 'File'}</td></tr>
          {!entry.isDir && <tr><td>Size</td><td>{formatBytes(entry.size)}</td></tr>}
          {entry.modified && <tr><td>Modified</td><td>{formatDateTime(entry.modified)} <span className="faint">({timeAgo(entry.modified)})</span></td></tr>}
          {git && <tr><td>Git</td><td><span className={cx('git-status', git)}>{git}</span> {GIT_TEXT[git] ?? git}{entry.isDir ? ' (contains changes)' : ''}</td></tr>}
          {entry.ignored && <tr><td>Git</td><td className="faint">Ignored</td></tr>}
        </tbody>
      </table>
      <div className="btns">
        {!entry.isDir && (
          <button className="btn primary" onClick={() => onOpen(entry)}>
            <Icon name="link-external" /> Open
          </button>
        )}
        <button className="btn subtle" onClick={() => void call('files:reveal', project.path, entry.relPath)}>
          <Icon name="folder-opened" /> Reveal
        </button>
        {project.live && (
          <button className="btn subtle" onClick={() => void insertIntoSession(project, [abs])}>
            <Icon name="terminal" /> Insert into Session
          </button>
        )}
      </div>
      <div className="btns">
        <button className="btn subtle" onClick={() => onRename(entry)}>
          <Icon name="tag" /> Rename
        </button>
        <button className="btn subtle danger-text" onClick={onDelete}>
          <Icon name="trash" /> Delete
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const imageTime = (img: SessionImage): string => formatDateTime(img.modified)

/**
 * A project's Images tab, and the Hive Assistant's Images (`assistant`: its home's .hive/images, grouped by
 * conversation). Clicking a group's name opens that session's transcript.
 */
export function ImagesTab({ project: owner, assistant = false }: { project: ProjectInfo; assistant?: boolean }) {
  useStore((s) => s.focusedAgent[owner.path])
  useDateStyle()
  const project = projectView(owner)
  const noun = assistant ? 'conversation' : 'session'
  // This project's images only. A failed read: said in place of the images (or over this project's last ones), not
  // "No images yet".
  const loaded = useScopedLoad<SessionImageGroup[]>(project.path)
  const groups = loaded.data
  const error = loaded.error
  const [viewing, setViewing] = useState<SessionImage | null>(null)
  // An image open in the viewer is the last project's.
  useEffect(() => setViewing(null), [project.path])
  const menu = useContextMenu()

  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('images:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load])
  useFileEvents(project.path, (dirs) => {
    if (dirs.some((d) => d === '.hive' || d.startsWith('.hive/images'))) load()
  })

  // Same order as on screen: current sessions first, archived last.
  const all = useMemo(() => [...(groups ?? []).filter((g) => !g.archived), ...(groups ?? []).filter((g) => g.archived)].flatMap((g) => g.images), [groups])

  const remove = async (img: SessionImage): Promise<void> => {
    const ok = await confirm({ title: 'Move to Recycle Bin?', message: `Move "${img.name}" to the Recycle Bin?`, detail: 'The transcript will still mention its path.', confirmLabel: 'Move to Recycle Bin', danger: true })
    if (!ok) return
    await actions.attempt('Could not delete image', () => call('images:trash', project.path, img.path))
    if (viewing?.path === img.path) {
      const i = all.findIndex((x) => x.path === img.path)
      setViewing(all[i + 1] ?? all[i - 1] ?? null)
    }
    load()
  }

  /** All of a session's images, after asking; none go if one can't (another program has it open), and none while it runs. */
  const removeGroup = async (g: SessionImageGroup): Promise<void> => {
    const n = g.images.length
    const ok = await confirm({
      title: `Move ${n} image${n === 1 ? '' : 's'} to the Recycle Bin?`,
      message: `Move the ${n === 1 ? 'image' : `${n} images`} of "${g.name ?? g.sessionId.slice(0, 8)}" to the Recycle Bin?`,
      detail: `The ${noun} keeps its transcript, which still mentions their paths. You can restore them from the Recycle Bin.`,
      confirmLabel: 'Move to Recycle Bin',
      danger: true
    })
    if (!ok) return
    const done = await actions.attempt('Could not delete the images', () => call('images:trashGroup', project.path, g.sessionId))
    if (done !== undefined) {
      if (viewing && g.images.some((i) => i.path === viewing.path)) setViewing(null)
      notify('success', `Moved ${done} image${done === 1 ? '' : 's'} to the Recycle Bin.`)
    }
    load()
  }
  /** The session's transcript: the Sessions tab, or the Assistant's conversations. */
  const openTranscript = (sessionId: string): void => {
    if (assistant) set({ assistantSection: 'conversations', sessionsJump: { project: owner.path, id: sessionId, nonce: Date.now() } })
    else openInSessionsTab(owner.path, sessionId)
  }

  /** The image's session (its folder) is running. */
  const running = (img: SessionImage): boolean => {
    const id = img.path.split(/[\\/]/).slice(-2)[0]
    return owner.agents.some((a) => a.live?.sessionId === id)
  }
  const menuFor = (img: SessionImage): MenuEntry[] => [
    { label: 'View', icon: 'eye', onClick: () => setViewing(img) },
    ...(project.live ? [{ label: 'Insert into Session', icon: 'terminal', onClick: () => void insertIntoSession(project, [img.path]) }] : []),
    { separator: true },
    { label: 'Copy Image', icon: 'copy', onClick: () => void actions.attempt('Could not copy image', () => call('images:copy', img.path)) },
    { label: 'Copy Path', icon: 'blank', onClick: () => copyText(img.path) },
    { label: 'Open', icon: 'link-external', onClick: () => void call('app:openPath', img.path) },
    { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('app:showInFolder', img.path) },
    { separator: true },
    // Not while its session runs (it may paste more): main refuses it too.
    running(img) ? { label: 'Delete', icon: 'trash', disabled: true, detail: `Its ${noun} is running` } : { label: 'Delete', icon: 'trash', danger: true, onClick: () => void remove(img) }
  ]

  if (!groups) return error ? <LoadFailed what="the images" error={error} onRetry={load} /> : <div className="empty-state"><Icon name="loading" spin />Loading…</div>
  if (!groups.length && !error) {
    return (
      <div className="empty-state" style={{ paddingTop: '15vh' }}>
        <Icon name="file-media" />
        No images yet
        <p className="hint">
          {assistant ? (
            <>
              Paste a screenshot into the Assistant's panel with <kbd>Ctrl+V</kbd>, or drag an image onto it. Hive keeps a copy of each one here, grouped by conversation.
            </>
          ) : (
            <>
              Paste a screenshot into a session with <kbd>Ctrl+V</kbd>, or drag an image onto the terminal. Hive keeps a copy of each one here, grouped by session.
            </>
          )}
        </p>
      </div>
    )
  }

  const current = groups.filter((g) => !g.archived)
  const archived = groups.filter((g) => g.archived)
  const renderGroup = (g: SessionImageGroup): React.ReactNode => (
    <section key={g.sessionId} className="image-group">
      <div className="image-group-head">
        <Icon name="comment-discussion" />
        <Tooltip content={`Open this ${noun}'s transcript`}>
          <button className="image-group-name" onClick={() => openTranscript(g.sessionId)}>
            {g.name ?? `${assistant ? 'Conversation' : 'Session'} ${g.sessionId.slice(0, 8)}`}
          </button>
        </Tooltip>
        {owner.agents.some((a) => a.live?.sessionId === g.sessionId) && <span className="badge accent">Running</span>}
        {g.archived && <span className="badge">archived</span>}
        <span className="faint">
          {g.images.length} image{g.images.length === 1 ? '' : 's'} · last {timeAgo(g.images[0].modified)}
        </span>
        <IconButton icon="trash" title={`Delete This ${assistant ? 'Conversation' : 'Session'}'s Images…`} disabled={owner.agents.some((a) => a.live?.sessionId === g.sessionId)} onClick={() => void removeGroup(g)} />
      </div>
      <div className="image-grid">
        {g.images.map((img) => (
          <Tooltip key={img.path} content={`${imageTime(img)} · ${formatBytes(img.size)}`}>
            <div
              className="thumb"
              draggable
              onClick={() => setViewing(img)}
              onContextMenu={(e) => menu.open(e, menuFor(img))}
              onDragStart={(e) => {
                e.dataTransfer.setData(HIVE_FILES_MIME, JSON.stringify({ project: project.path, paths: [img.path] }))
                e.dataTransfer.setData('text/plain', quotePath(img.path))
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <img src={imageUrl(img.path)} loading="lazy" alt={img.name} draggable={false} />
              <span className="thumb-caption">{formatTime(img.modified)}</span>
            </div>
          </Tooltip>
        ))}
      </div>
    </section>
  )

  return (
    <div className="scroll-page images-page">
      <div className="images-toolbar">
        <h2>Images</h2>
        <InfoTip
          text={
            assistant
              ? "Kept in the Assistant's home, .hive/images. Click a conversation's name to read it."
              : "Kept in the project's .hive/images. Drag one onto the Session tab to send it again; click a session's name to read it."
          }
        />
        <span className="faint">
          {all.length} in {groups.length} {noun}
          {groups.length === 1 ? '' : 's'}
        </span>
        <div className="grow" />
        <IconButton icon="refresh" title="Refresh" onClick={load} />
        <IconButton icon="folder-opened" title="Open Images Folder" onClick={() => void call('app:openPath', `${project.path}\\.hive\\images`)} />
      </div>
      <p className="hint images-desc">{assistant ? 'Images pasted or dropped into the Assistant, by conversation.' : "Images pasted or dropped into this project's agents' sessions, by session."}</p>
      {error && <StaleNote what="the images" error={error} at={loaded.at} onRetry={load} />}
      {current.map(renderGroup)}
      {archived.length > 0 && (
        <>
          <h3 className="images-archived">
            <Icon name="archive" /> Archived {noun}s
          </h3>
          {archived.map(renderGroup)}
        </>
      )}
      {viewing && (
        <ImageViewer
          image={viewing}
          images={all}
          live={!!project.live}
          // Worked out for the image shown, so it follows navigation and its session starting or stopping (main refuses too).
          deleteBlocked={running(viewing) ? `Its ${noun} is running` : null}
          onNavigate={setViewing}
          onClose={() => setViewing(null)}
          onInsert={(img) => {
            setViewing(null)
            void insertIntoSession(project, [img.path])
          }}
          onDelete={(img) => void remove(img)}
        />
      )}
      {menu.element}
    </div>
  )
}

function ImageViewer({
  image,
  images,
  live,
  deleteBlocked,
  onNavigate,
  onClose,
  onInsert,
  onDelete
}: {
  image: SessionImage
  images: SessionImage[]
  live: boolean
  /** Why this image can't be deleted now (its session is running), or null. */
  deleteBlocked: string | null
  onNavigate: (img: SessionImage) => void
  onClose: () => void
  onInsert: (img: SessionImage) => void
  onDelete: (img: SessionImage) => void
}) {
  const i = images.findIndex((x) => x.path === image.path)
  // The list is newest first, so "previous" (left) is the newer image.
  const prev = images[i - 1]
  const next = images[i + 1]
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
      else if (e.key === 'ArrowRight' && next) onNavigate(next)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onNavigate])
  return (
    <Modal
      title={`${imageTime(image)} · ${image.name}`}
      icon="file-media"
      onClose={onClose}
      wide
      // Sized to the image, with its own controls: it stays put (#133).
      movable={false}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>
            {i + 1} of {images.length} · {formatBytes(image.size)}
          </span>
          <Tooltip content={deleteBlocked}>
            <button className="btn subtle danger-text" disabled={!!deleteBlocked} aria-description={deleteBlocked ?? undefined} onClick={() => onDelete(image)}>
              <Icon name="trash" /> Delete
            </button>
          </Tooltip>
          <button className="btn subtle" onClick={() => void call('app:showInFolder', image.path)}>
            <Icon name="folder-opened" /> Reveal
          </button>
          <button className="btn subtle" onClick={() => copyText(image.path)}>
            Copy Path
          </button>
          <button className="btn subtle" onClick={() => void actions.attempt('Could not copy image', () => call('images:copy', image.path))}>
            <Icon name="copy" /> Copy Image
          </button>
          {live && (
            <button className="btn primary" onClick={() => onInsert(image)}>
              <Icon name="terminal" /> Insert into Session
            </button>
          )}
        </>
      }
    >
      <div className="image-viewer">
        <IconButton icon="chevron-left" title="Newer (←)" disabled={!prev} onClick={() => prev && onNavigate(prev)} />
        <div className="image-frame">
          <img src={imageUrl(image.path)} alt={image.name} />
        </div>
        <IconButton icon="chevron-right" title="Older (→)" disabled={!next} onClick={() => next && onNavigate(next)} />
      </div>
    </Modal>
  )
}
