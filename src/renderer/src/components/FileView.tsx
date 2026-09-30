import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileContent, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { confirm, notify } from '../store'
import { cx, formatBytes, imageUrl, timeAgo } from '../util'
import { CodeEditor } from './Editors'
import { PaneResizer, usePaneSize } from './Resizer'
import { Icon, Markdown, Tooltip } from './ui'

// ---------------------------------------------------------------------------
// Previewer registry: which views a file gets besides the text editor.
// Adding a format means adding an entry here.
// ---------------------------------------------------------------------------

interface PreviewProps {
  text: string
  /** Project folder, for resolving relative links and images. */
  root: string
  abs: string
  rel: string
  onOpenRel: (rel: string) => void
}

interface Previewer {
  id: string
  label: string
  icon: string
  match: RegExp
  /** Views that need the file's text; others (images, PDF) load it from disk themselves. */
  needsText: boolean
  /** Whether the text can also be edited (adds Edit and, for markdown, Split). */
  editable: boolean
  /** Open in this view by default instead of the editor. */
  preferred: boolean
  split?: boolean
  render: (p: PreviewProps) => React.ReactNode
}

const PREVIEWERS: Previewer[] = [
  { id: 'markdown', label: 'Preview', icon: 'open-preview', match: /\.(md|markdown|mdx)$/i, needsText: true, editable: true, preferred: true, split: true, render: (p) => <MarkdownPreview {...p} /> },
  { id: 'csv', label: 'Table', icon: 'table', match: /\.(csv|tsv)$/i, needsText: true, editable: true, preferred: true, render: (p) => <CsvPreview {...p} /> },
  { id: 'html', label: 'Preview', icon: 'open-preview', match: /\.html?$/i, needsText: true, editable: true, preferred: false, split: true, render: (p) => <HtmlPreview {...p} /> },
  { id: 'svg', label: 'Image', icon: 'file-media', match: /\.svg$/i, needsText: true, editable: true, preferred: true, render: (p) => <SvgPreview {...p} /> },
  { id: 'image', label: 'Image', icon: 'file-media', match: /\.(png|jpe?g|gif|webp|bmp|ico)$/i, needsText: false, editable: false, preferred: true, render: (p) => <ImagePreview {...p} /> },
  { id: 'pdf', label: 'PDF', icon: 'file-pdf', match: /\.pdf$/i, needsText: false, editable: false, preferred: true, render: (p) => <PdfPreview {...p} /> }
]

const previewerFor = (name: string): Previewer | undefined => PREVIEWERS.find((p) => p.match.test(name))

type Mode = 'edit' | 'preview' | 'split'

// Unsaved edits survive switching files, tabs and projects while Hive is open.
interface Draft {
  text: string
  base: FileContent
  /** The folder the file was opened from (project or worktree) and its path in it, for saving and renames. */
  root: string
  rel: string
}
const drafts = new Map<string, Draft>()
const draftListeners = new Set<() => void>()
/** Open editors reload after saveAllDrafts, so they don't keep showing the saved text as unsaved. */
const savedListeners = new Set<() => void>()
const absOf = (root: string, rel: string): string => `${root}\\${rel.replace(/\//g, '\\')}`
export const hasDraft = (abs: string): boolean => drafts.has(abs.toLowerCase())

// The main process is told which files have unsaved edits, so quitting can ask about them.
draftListeners.add(() => void call('files:setUnsaved', unsavedFiles().map((f) => f.abs)))

/** Files with unsaved edits. */
export function unsavedFiles(): { root: string; rel: string; abs: string }[] {
  return [...drafts.values()].map((d) => ({ root: d.root, rel: d.rel, abs: absOf(d.root, d.rel) }))
}

/** Unsaved files at rel or inside it (a folder), in root. */
export function draftsUnder(root: string, rels: string[]): string[] {
  const r = root.toLowerCase()
  return [...drafts.values()]
    .filter((d) => d.root.toLowerCase() === r && rels.some((x) => d.rel.toLowerCase() === x.toLowerCase() || d.rel.toLowerCase().startsWith(x.toLowerCase() + '/')))
    .map((d) => d.rel)
}

/** After a rename or move in the Files tab: the unsaved edits of from (a file, or files in a folder) follow it to to. */
export function moveDrafts(root: string, from: string, to: string): void {
  if (from === to) return
  const f = from.toLowerCase()
  for (const [key, d] of [...drafts]) {
    if (d.root.toLowerCase() !== root.toLowerCase()) continue
    const rel = d.rel.toLowerCase()
    if (rel !== f && !rel.startsWith(f + '/')) continue
    drafts.delete(key)
    const moved = { ...d, rel: to + d.rel.slice(from.length) }
    drafts.set(absOf(root, moved.rel).toLowerCase(), moved)
  }
  draftListeners.forEach((l) => l())
}

/** Drops unsaved edits: all of them, or those of the given files in root (e.g. after deleting them). */
export function discardDrafts(root?: string, rels?: string[]): void {
  const under = root && rels ? new Set(draftsUnder(root, rels).map((r) => absOf(root, r).toLowerCase())) : null
  let changed = false
  for (const key of [...drafts.keys()]) {
    if (under && !under.has(key)) continue
    drafts.delete(key)
    changed = true
  }
  if (changed) draftListeners.forEach((l) => l())
}

/**
 * Saves every unsaved file. A file changed on disk since it was opened is not overwritten: it is
 * returned with the other failures, and its edits are kept.
 */
export async function saveAllDrafts(): Promise<{ saved: number; failed: { abs: string; message: string }[] }> {
  const failed: { abs: string; message: string }[] = []
  let saved = 0
  for (const [key, d] of [...drafts]) {
    try {
      await call('files:write', d.root, d.rel, d.text, d.base.modified || null, d.base.bom)
      drafts.delete(key)
      saved++
    } catch (e) {
      failed.push({ abs: absOf(d.root, d.rel), message: `${d.rel}: ${errorMessage(e).includes('CONFLICT') ? 'changed on disk since you opened it' : errorMessage(e)}` })
    }
  }
  draftListeners.forEach((l) => l())
  savedListeners.forEach((l) => l())
  return { saved, failed }
}
export function useDraftVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const l = (): void => setV((x) => x + 1)
    draftListeners.add(l)
    return () => void draftListeners.delete(l)
  }, [])
  return v
}
function setDraft(abs: string, d: Draft | null): void {
  const key = abs.toLowerCase()
  const had = drafts.has(key)
  if (d) drafts.set(key, d)
  else drafts.delete(key)
  if (had !== !!d) draftListeners.forEach((l) => l())
}
const modeMemory = new Map<string, Mode>()

const joinRel = (dir: string, rel: string): string => {
  const parts = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/**
 * The Files tab's right pane for a file: a Monaco editor for any text file, plus preview views from
 * the registry. Ctrl+S saves; saving is refused if the file changed on disk since it was opened.
 */
export function FileView({
  project,
  rel,
  changeTick,
  onOpenRel,
  toolbarExtra
}: {
  project: ProjectInfo
  rel: string
  /** Bumped by the Files tab when the file's folder changed on disk. */
  changeTick: number
  onOpenRel: (rel: string) => void
  toolbarExtra?: React.ReactNode
}) {
  const abs = `${project.path}\\${rel.replace(/\//g, '\\')}`
  const name = rel.split('/').pop()!
  const pv = previewerFor(name)
  const splitRatio = usePaneSize('fileSplit', 0.5)
  const [content, setContent] = useState<FileContent | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  const [mode, setModeState] = useState<Mode>(() => modeMemory.get(abs) ?? (pv?.preferred ? 'preview' : 'edit'))
  const setMode = (m: Mode): void => {
    modeMemory.set(abs, m)
    setModeState(m)
  }
  const dirty = !!content && content.kind === 'text' && text !== content.text
  const textRef = useRef(text)
  textRef.current = text
  const contentRef = useRef(content)
  contentRef.current = content

  const load = useCallback(
    async (keepDraft: boolean): Promise<void> => {
      if (pv && !pv.needsText) {
        setContent({ kind: 'binary', text: '', size: 0, modified: '', bom: false })
        return
      }
      try {
        const c = await call('files:read', project.path, rel)
        const d = keepDraft ? drafts.get(abs.toLowerCase()) : undefined
        setContent(d ? d.base : c)
        setText(d ? d.text : c.text)
        setChangedOnDisk(!!d && d.base.modified !== c.modified)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [project.path, rel, abs, pv]
  )

  useEffect(() => {
    setContent(null)
    setChangedOnDisk(false)
    setModeState(modeMemory.get(abs) ?? (pv?.preferred ? 'preview' : 'edit'))
    void load(true)
  }, [abs, load, pv])

  // Keep the draft in step with the editor so it survives unmounting.
  useEffect(() => {
    if (!content || content.kind !== 'text') return
    setDraft(abs, text !== content.text ? { text, base: content, root: project.path, rel } : null)
  }, [text, content, abs, project.path, rel])

  // Saved or discarded from elsewhere (the quit dialog, Save All): pick up what's on disk now.
  useEffect(() => {
    const onSaved = (): void => {
      if (!drafts.has(abs.toLowerCase()) && contentRef.current?.kind === 'text' && textRef.current !== contentRef.current.text) void load(false)
    }
    savedListeners.add(onSaved)
    return () => void savedListeners.delete(onSaved)
  }, [abs, load])

  // Changes on disk: reload silently when there are no edits, otherwise offer a choice.
  const firstTick = useRef(changeTick)
  useEffect(() => {
    if (changeTick === firstTick.current) return
    const c = contentRef.current
    if (!c || c.kind !== 'text') {
      if (pv && !pv.needsText) setContent({ kind: 'binary', text: '', size: 0, modified: new Date().toISOString(), bom: false })
      return
    }
    void call('files:read', project.path, rel)
      .then((disk) => {
        if (disk.modified === c.modified) return
        if (textRef.current === c.text) {
          setContent(disk)
          setText(disk.text)
        } else setChangedOnDisk(true)
      })
      .catch(() => setError('This file no longer exists on disk. Save to recreate it.'))
  }, [changeTick, project.path, rel, pv])

  const save = async (force = false): Promise<void> => {
    const c = contentRef.current
    if (!c || c.kind !== 'text') return
    const t = textRef.current
    try {
      const r = await call('files:write', project.path, rel, t, force ? null : c.modified, c.bom)
      setContent({ ...c, text: t, modified: r.modified, size: r.size })
      setChangedOnDisk(false)
      setError(null)
    } catch (e) {
      if (errorMessage(e).includes('CONFLICT')) {
        setChangedOnDisk(true)
        notify('warning', `${name} changed on disk`, 'Reload it, or overwrite it with your version.')
      } else notify('error', `Could not save ${name}`, errorMessage(e))
    }
  }

  const reloadFromDisk = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: 'Discard your changes?', message: `Reload ${name} from disk and discard your unsaved changes?`, confirmLabel: 'Reload', danger: true }))) return
    setDraft(abs, null)
    await load(false)
    setChangedOnDisk(false)
  }

  const canEdit = !pv || pv.editable
  const modes: { id: Mode; label: string; icon: string }[] = [
    ...(pv ? [{ id: 'preview' as Mode, label: pv.label, icon: pv.icon }] : []),
    ...(pv?.split ? [{ id: 'split' as Mode, label: 'Split', icon: 'split-horizontal' }] : []),
    ...(pv && canEdit ? [{ id: 'edit' as Mode, label: 'Edit', icon: 'edit' }] : [])
  ]
  const effectiveMode: Mode = !pv ? 'edit' : !canEdit ? 'preview' : mode

  const header = (
    <div className="editor-toolbar">
      <Icon name={pv?.icon ?? 'file'} />
      <span className="path" title={abs}>
        <strong>{name}</strong>
        {dirty && <span className="dirty-dot" title="Unsaved changes"> ●</span>} {rel.includes('/') && <span className="faint">{rel.slice(0, rel.lastIndexOf('/'))}</span>}
      </span>
      {content && content.modified && content.kind === 'text' && (
        <span className="faint small">
          {formatBytes(content.size)} · {timeAgo(content.modified)}
        </span>
      )}
      {modes.length > 1 && (
        <div className="segmented">
          {modes.map((m) => (
            <button key={m.id} className={cx(effectiveMode === m.id && 'active')} onClick={() => setMode(m.id)}>
              <Icon name={m.icon} /> {m.label}
            </button>
          ))}
        </div>
      )}
      {toolbarExtra}
      {content?.kind === 'text' && canEdit && (
        <Tooltip content="Save (Ctrl+S)">
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> Save
          </button>
        </Tooltip>
      )}
    </div>
  )

  if (error && !content) {
    return (
      <>
        {header}
        <div className="empty-state">
          <Icon name="error" />
          {error}
        </div>
      </>
    )
  }
  if (!content) return <>{header}</>

  if (content.kind === 'too-large' || (content.kind === 'binary' && (!pv || pv.needsText))) {
    return (
      <>
        {header}
        <div className="empty-state">
          <Icon name={content.kind === 'binary' ? 'file-binary' : 'file'} />
          {content.kind === 'binary' ? 'This is a binary file.' : `This file is too large to open here (${formatBytes(content.size)}).`}
          <p className="hint">Open it in its default app instead.</p>
          <button className="btn subtle" onClick={() => void actions.attempt('Could not open file', () => call('files:open', project.path, rel))}>
            <Icon name="link-external" /> Open
          </button>
        </div>
      </>
    )
  }

  const previewProps: PreviewProps = { text, root: project.path, abs, rel, onOpenRel }
  const editor = (
    <CodeEditor
      key={abs}
      value={text}
      language={languageFor(name)}
      onChange={setText}
      onSave={() => void save()}
      wordWrap={/\.(md|markdown|mdx|txt)$/i.test(name)}
    />
  )
  return (
    <>
      {header}
      {changedOnDisk && (
        <div className="banner warn">
          <Icon name="warning" /> {name} has changed on disk since you opened it.
          <button className="btn small" onClick={() => void reloadFromDisk()}>
            Reload
          </button>
          <button className="btn small" style={{ marginLeft: 0 }} onClick={() => void save(true)}>
            Overwrite with mine
          </button>
        </div>
      )}
      {error && content && <div className="banner warn"><Icon name="warning" /> {error}</div>}
      <div className={cx('editor-host', effectiveMode === 'split' && 'split-view')}>
        {effectiveMode === 'edit' && editor}
        {effectiveMode === 'preview' && pv && <div className="preview-pane">{pv.render(previewProps)}</div>}
        {effectiveMode === 'split' && pv && (
          <>
            <div className="split-half" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
              {editor}
              <PaneResizer paneKey="fileSplit" ratio />
            </div>
            <div className="split-half preview-pane">{pv.render(previewProps)}</div>
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

const MD_LANG: Record<string, string> = { ts: 'x.ts', typescript: 'x.ts', js: 'x.js', javascript: 'x.js', py: 'x.py', python: 'x.py', sh: 'x.sh', bash: 'x.sh', shell: 'x.sh', ps1: 'x.ps1', powershell: 'x.ps1', yml: 'x.yml' }

/** decodeURIComponent, but a path such as "50%.png" (not valid percent-encoding) is kept as written instead of throwing. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function MarkdownPreview({ text, root, rel, onOpenRel }: PreviewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const source = useMemo(() => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), [text])

  // Relative images load from the project; code blocks are coloured by Monaco.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? ''
      if (!src || /^(https?:|data:|hive-img:)/i.test(src)) continue
      const target = joinRel(dir, safeDecode(src.split(/[?#]/)[0]))
      img.setAttribute('src', imageUrl(`${root}\\${target.replace(/\//g, '\\')}`))
    }
    const blocks = [...el.querySelectorAll('pre > code')] as HTMLElement[]
    if (!blocks.length) return
    void import('../monaco').then(({ monaco }) => {
      // Token colours are only registered once a theme is set, which may not have happened yet.
      monaco.editor.setTheme(document.documentElement.dataset.theme === 'light' ? 'hive-light' : 'hive-dark')
      for (const code of blocks) {
        const lang = /language-([\w+#-]+)/.exec(code.className)?.[1]
        if (!lang || code.dataset.colorized) continue
        const id = languageFor(MD_LANG[lang.toLowerCase()] ?? `x.${lang}`)
        const langId = id === 'plaintext' ? lang.toLowerCase() : id
        void monaco.editor.colorize(code.textContent ?? '', langId, { tabSize: 2 }).then((html) => {
          code.innerHTML = html
          code.dataset.colorized = '1'
        })
      }
    })
  })
  return (
    <div className="scroll-page md-preview" ref={ref}>
      {source.trim() ? (
        <Markdown
          source={source}
          onLink={(href) => {
            if (/^(https?:|mailto:|#)/i.test(href)) return false
            onOpenRel(joinRel(dir, safeDecode(href.split('#')[0])))
            return true
          }}
        />
      ) : (
        <div className="empty-state">This file is empty.</div>
      )}
    </div>
  )
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes. */
function parseDelimited(text: string, sep: string, maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      if (rows.length >= maxRows) return rows
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function CsvPreview({ text, rel }: PreviewProps) {
  const MAX = 5000
  const rows = useMemo(() => {
    const firstLine = text.slice(0, text.indexOf('\n') >>> 0)
    const sep = /\.tsv$/i.test(rel) ? '\t' : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
    return parseDelimited(text, sep, MAX + 1)
  }, [text, rel])
  if (!rows.length) return <div className="empty-state">This file is empty.</div>
  const [head, ...body] = rows
  return (
    <div className="csv-preview">
      <table>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX).map((r, i) => (
            <tr key={i}>
              <td className="rownum">{i + 1}</td>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX && <div className="faint" style={{ padding: 10 }}>Showing the first {MAX.toLocaleString()} rows. Switch to Edit to see everything.</div>}
    </div>
  )
}

function HtmlPreview({ text }: PreviewProps) {
  // Sandboxed with no permissions: scripts, forms and navigation are all blocked.
  return <iframe className="html-preview" sandbox="" srcDoc={text} title="HTML preview" />
}

function SvgPreview({ text }: PreviewProps) {
  // Rendered as an <img>, so scripts inside the SVG never run.
  const url = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, [text])
  return (
    <div className="image-preview checker">
      <img src={url} alt="" />
    </div>
  )
}

function ImagePreview({ abs }: PreviewProps) {
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [bust] = useState(() => Date.now())
  return (
    <div className={cx('image-preview checker', actual && 'actual')} onClick={() => setActual(!actual)} title={actual ? 'Click to fit' : 'Click for actual size'}>
      <img src={`${imageUrl(abs)}?t=${bust}`} alt="" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {size && (
        <span className="image-size">
          {size.w} × {size.h}
        </span>
      )}
    </div>
  )
}

function PdfPreview({ abs }: PreviewProps) {
  // Chromium's PDF viewer doesn't run in a sandboxed frame; the source is hive-img:, which only serves images and PDFs from the workspace.
  // eslint-disable-next-line react/iframe-missing-sandbox
  return <iframe className="pdf-preview" src={imageUrl(abs)} title="PDF preview" />
}
