import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo, ProjectInfo, ProviderId, TaskCard, TaskColumn, TaskPatch } from '@shared/types'
import { TASK_COLUMNS, columnColor, columnLabel, stalledReason } from '@shared/tasks'
import { enabledProviders, isProviderEnabled, projectDefaultProvider, providerName } from '@shared/providers'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, agentProviderOf, confirm, get, loadTasks, notify, revealAgent, set, useStore } from '../store'
import { selectProject } from '../actions'
import { cx, timeAgo } from '../util'
import { Icon, IconButton, InfoTip, Markdown, Modal, STATUS_TEXT, statusText, Tooltip, useContextMenu, type MenuEntry } from './ui'
import { ProviderIcon } from './ProviderIcon'

const NO_TASKS: TaskCard[] = []

/** The project and agent a card is given to, as they are now (null when the card has none). */
function cardAgent(projects: ProjectInfo[], c: TaskCard): { project: ProjectInfo | null; agent: AgentInfo | null } {
  const project = c.project ? (projects.find((p) => p.name.toLowerCase() === c.project.toLowerCase()) ?? null) : null
  return { project, agent: c.agent ? (project?.agents.find((a) => a.id === c.agent) ?? null) : null }
}

/** Why nobody is working on the card (a Doing card only), from its agent as the window knows it. */
export function cardStalled(projects: ProjectInfo[], c: TaskCard): string | null {
  const { agent } = cardAgent(projects, c)
  return stalledReason(c, agent ? { name: agent.name, running: !!agent.live } : null)
}

/** A card matches the search: its number (#12 or 12), title, description, labels, project or agent. */
function matches(c: TaskCard, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  if (/^#?\d+$/.test(s)) return c.number === Number(s.replace('#', ''))
  return [c.title, c.description, c.project, c.agentName ?? '', ...c.labels].some((x) => x.toLowerCase().includes(s))
}

async function change(n: number, patch: TaskPatch, what = 'Could not change the card'): Promise<boolean> {
  try {
    await call('tasks:update', n, patch)
    await loadTasks()
    return true
  } catch (e) {
    notify('error', what, errorMessage(e))
    return false
  }
}

async function archive(c: TaskCard, archived: boolean): Promise<void> {
  try {
    await call('tasks:archive', c.number, archived)
    await loadTasks()
  } catch (e) {
    notify('error', archived ? 'Could not archive the card' : 'Could not bring the card back', errorMessage(e))
  }
}

async function remove(c: TaskCard): Promise<boolean> {
  const ok = await confirm({ title: `Delete #${c.number}?`, message: `"${c.title}" goes to the Recycle Bin, with its comments and history. Archive it instead to keep it out of sight but searchable.`, confirmLabel: 'Delete', danger: true })
  if (!ok) return false
  try {
    await call('tasks:delete', c.number)
    await loadTasks()
    return true
  } catch (e) {
    notify('error', 'Could not delete the card', errorMessage(e))
    return false
  }
}

/** The right-click menu of a card. */
function cardMenu(c: TaskCard): MenuEntry[] {
  return [
    { label: 'Open', icon: 'go-to-file', onClick: () => set({ taskOpen: c.number }) },
    ...(c.archived
      ? []
      : [
          { label: 'Start…', icon: 'play', disabled: c.column === 'done' || !c.project, onClick: () => set({ taskStartFor: c.number }) },
          { separator: true },
          { header: true, label: 'Move to' },
          ...TASK_COLUMNS.filter((x) => x.id !== c.column).map((x) => ({ label: x.label, icon: 'arrow-right', onClick: () => void change(c.number, { column: x.id }) })),
          { separator: true }
        ]),
    { label: c.archived ? 'Bring Back' : 'Archive', icon: c.archived ? 'discard' : 'archive', onClick: () => void archive(c, !c.archived) },
    { label: 'Delete…', icon: 'trash', danger: true, onClick: () => void remove(c) }
  ]
}

/** What the card's agent is doing (Doing cards), or who has it. */
function AgentLine({ c, projects, live }: { c: TaskCard; projects: ProjectInfo[]; live: boolean }) {
  if (!c.agent) return null
  const { project, agent } = cardAgent(projects, c)
  const name = agent?.name ?? c.agentName ?? 'its agent'
  if (!agent) return <span className="task-agent faint">{name} (removed)</span>
  const status = agent.live?.status ?? 'stopped'
  const text = agent.live ? statusText(agent.live) : 'Not running'
  return (
    <Tooltip content={`${name}: ${text}. Click to show it.`}>
      <span
        className={cx('task-agent', live && 'live')}
        onClick={(e) => {
          e.stopPropagation()
          if (!project) return
          selectProject(project.path)
          revealAgent(project, agent.id)
        }}
      >
        {live && <span className={cx('dot', agent.live ? status : 'stopped')} />}
        <span className="task-agent-name">{name}</span>
        {live && <span className="faint">{agent.live ? STATUS_TEXT[status] : 'Not running'}</span>}
      </span>
    </Tooltip>
  )
}

function CardTile({
  c,
  projects,
  showProject,
  onDragStart,
  onDragOver,
  dropHere
}: {
  c: TaskCard
  projects: ProjectInfo[]
  showProject: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  dropHere: boolean
}) {
  const menu = useContextMenu()
  const { agent } = cardAgent(projects, c)
  // A Doing card whose agent has finished is waiting for someone to look: it shows like a finished agent.
  const finished = c.column === 'doing' && agent?.live?.status === 'finished'
  const stalled = cardStalled(projects, c)
  return (
    <>
      {dropHere && <div className="task-drop" />}
      <div
        className={cx('task-card', c.blocked && 'blocked', finished && 'finished', stalled && !c.blocked && 'stalled')}
        draggable={!c.archived}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onClick={() => set({ taskOpen: c.number })}
        onContextMenu={(e) => menu.open(e, cardMenu(c))}
        data-task={c.number}
      >
        <div className="task-card-top">
          <span className="task-number">#{c.number}</span>
          {showProject && c.project && <span className="task-project">{c.project}</span>}
          {!c.project && <span className="task-project faint">workspace</span>}
        </div>
        <div className="task-title">{c.title}</div>
        {c.blocked && (
          <div className="task-blocked">
            <Icon name="circle-slash" /> {c.blocked}
          </div>
        )}
        {stalled && (
          <Tooltip content="Nobody is working on it. Start it again (on this agent or another), or move it back to Todo.">
            <div className="task-stalled">
              <Icon name="debug-pause" /> Stalled: {stalled}
            </div>
          </Tooltip>
        )}
        {(c.labels.length > 0 || c.blockedBy.length > 0 || c.comments.length > 0) && (
          <div className="task-meta">
            {c.labels.map((l) => (
              <span key={l} className="task-label">
                {l}
              </span>
            ))}
            {c.blockedBy.length > 0 && (
              <Tooltip content={`Depends on ${c.blockedBy.map((n) => `#${n}`).join(', ')}`}>
                <span className="faint">
                  <Icon name="link" /> {c.blockedBy.map((n) => `#${n}`).join(' ')}
                </span>
              </Tooltip>
            )}
            {c.comments.length > 0 && (
              <span className="faint">
                <Icon name="comment" /> {c.comments.length}
              </span>
            )}
          </div>
        )}
        <AgentLine c={c} projects={projects} live={c.column === 'doing'} />
      </div>
      {menu.element}
    </>
  )
}

type DragState = { n: number; column: TaskColumn; before: number | null }

/**
 * The board: four columns of cards (one project's, or all of them). Cards drag between and within columns;
 * click opens one, right-click has the rest. With archived, the archived cards as a list instead.
 */
export function Board({ project, query, archived }: { project: string | null; query: string; archived: boolean }) {
  const all = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  const [drag, showDrag] = useState<DragState | null>(null)
  // The handlers read the drag from here, not from the last render: a dragover or drop can come before React has
  // drawn the drag's start (a quick drag), and would then be refused.
  const dragNow = useRef<DragState | null>(null)
  const setDrag = (d: DragState | null): void => {
    dragNow.current = d
    showDrag(d)
  }
  const cards = useMemo(
    () => all.filter((c) => c.archived === archived && (project === null || c.project.toLowerCase() === project.toLowerCase()) && matches(c, query)),
    [all, project, query, archived]
  )

  if (archived) {
    return (
      <div className="task-archive">
        {cards.length === 0 && <div className="empty-state">No archived cards{query ? ' match' : ''}.</div>}
        {cards.map((c) => (
          <div key={c.number} className="task-archive-row" onClick={() => set({ taskOpen: c.number })}>
            <span className="task-number">#{c.number}</span>
            <span className="grow">{c.title}</span>
            {project === null && c.project && <span className="task-project">{c.project}</span>}
            <span className="faint">{columnLabel(c.column)}</span>
            <span className="faint">{timeAgo(c.updatedAt)}</span>
            <button
              className="btn small subtle"
              onClick={(e) => {
                e.stopPropagation()
                void archive(c, false)
              }}
            >
              Bring Back
            </button>
          </div>
        ))}
      </div>
    )
  }

  const drop = async (column: TaskColumn): Promise<void> => {
    const d = dragNow.current
    setDrag(null)
    if (!d) return
    const card = all.find((c) => c.number === d.n)
    if (!card || (card.column === column && d.before === d.n)) return
    // Shown moved at once; the board is read again when the change lands.
    set((s) => ({ tasks: s.tasks.map((c) => (c.number === d.n ? { ...c, column } : c)) }))
    await change(d.n, { column, before: d.before }, 'Could not move the card')
  }

  return (
    <div className={cx('board', colored && 'colored')} onDragEnd={() => setDrag(null)}>
      {TASK_COLUMNS.map((col) => {
        const list = cards.filter((c) => c.column === col.id)
        return (
          <div
            key={col.id}
            className={cx('board-column', drag?.column === col.id && 'drag-over')}
            data-column={col.id}
            style={colored ? ({ '--col': columnColor(colors, col.id) } as React.CSSProperties) : undefined}
            onDragOver={(e) => {
              const d = dragNow.current
              if (!d) return
              e.preventDefault()
              // Below its last card (or an empty column): to the end. Gaps between cards keep the marker where it is.
              if ((e.target as HTMLElement).closest('.task-card')) return
              const tiles = (e.currentTarget as HTMLElement).querySelectorAll('.task-card')
              const last = tiles[tiles.length - 1]?.getBoundingClientRect()
              const past = !last || e.clientY > last.bottom
              if (past && (d.column !== col.id || d.before !== null)) setDrag({ ...d, column: col.id, before: null })
              else if (!past && d.column !== col.id) setDrag({ ...d, column: col.id, before: null })
            }}
            onDrop={(e) => {
              e.preventDefault()
              void drop(col.id)
            }}
          >
            <div className="board-column-header">
              <Tooltip content={col.description}>
                <span className="board-column-label">{col.label}</span>
              </Tooltip>
              <span className="count">{list.length}</span>
              {col.id === 'todo' && <IconButton icon="add" title="New card" onClick={() => set({ taskOpen: { project: project ?? '' } })} />}
            </div>
            <div className="board-column-body">
              {list.map((c) => (
                <CardTile
                  key={c.number}
                  c={c}
                  projects={projects}
                  showProject={project === null}
                  dropHere={!!drag && drag.column === col.id && drag.before === c.number && drag.n !== c.number}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', `#${c.number}`)
                    setDrag({ n: c.number, column: c.column, before: c.number })
                  }}
                  onDragOver={(e) => {
                    const d = dragNow.current
                    if (!d) return
                    e.preventDefault()
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    // The top half drops before this card, the bottom half before the next one.
                    const i = list.findIndex((x) => x.number === c.number)
                    const before = e.clientY < r.top + r.height / 2 ? c.number : (list[i + 1]?.number ?? null)
                    if (d.column !== col.id || d.before !== before) setDrag({ ...d, column: col.id, before })
                  }}
                />
              ))}
              {drag?.column === col.id && drag.before === null && <div className="task-drop" />}
              {list.length === 0 && !drag && <div className="board-empty faint">{col.id === 'todo' ? 'No cards. + adds one.' : 'Nothing here.'}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The board's toolbar: search, archived, and New Card. */
export function BoardToolbar({ project, query, setQuery, archived, setArchived }: { project: string | null; query: string; setQuery: (q: string) => void; archived: boolean; setArchived: (v: boolean) => void }) {
  const count = useStore((s) => (s.tasks ?? NO_TASKS).filter((c) => c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase())).length)
  return (
    <div className="board-toolbar">
      <div className="board-search">
        <Icon name="search" />
        <input className="input" placeholder="Search cards (#12, words, labels)" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <label className="flex muted" style={{ cursor: 'pointer' }}>
        <input type="checkbox" className="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived ({count})
      </label>
      <div className="grow" />
      <button className="btn primary" onClick={() => set({ taskOpen: { project: project ?? '' } })}>
        <Icon name="add" /> New Card
      </button>
    </div>
  )
}

/** The Board view (activity bar): every project's cards, or the one chosen in the sidebar. */
export function BoardView() {
  const project = useStore((s) => s.boardProject)
  const query = useStore((s) => s.boardQuery)
  const archived = useStore((s) => s.boardArchived)
  const workspace = useStore((s) => s.workspace)
  useEffect(() => void loadTasks(), [workspace?.path])
  if (!workspace) return <div className="empty-state">Open a workspace to see its task board.</div>
  return (
    <div className="board-view">
      <div className="board-header">
        <h1>
          Task Board{project !== null && <span className="faint"> · {project || 'workspace cards'}</span>}
        </h1>
        <span className="faint">Plan work as cards, start them on agents, and see where each one is. Only you move cards to Done.</span>
      </div>
      <BoardToolbar project={project} query={query} setQuery={(q) => set({ boardQuery: q })} archived={archived} setArchived={(v) => set({ boardArchived: v })} />
      <Board project={project} query={query} archived={archived} />
    </div>
  )
}

/** A project's Tasks tab: its cards on the board. */
export function ProjectTasksTab({ project }: { project: ProjectInfo }) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  useEffect(() => void loadTasks(), [project.path])
  return (
    <div className="board-view in-tab">
      <BoardToolbar project={project.name} query={query} setQuery={setQuery} archived={archived} setArchived={setArchived} />
      <Board project={project.name} query={query} archived={archived} />
    </div>
  )
}

/** The Board's sidebar: which project's cards to show, with how many each has open. */
export function BoardPanel() {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const chosen = useStore((s) => s.boardProject)
  const open = (name: string | null): number => tasks.filter((c) => !c.archived && c.column !== 'done' && (name === null || c.project.toLowerCase() === name.toLowerCase())).length
  const review = tasks.filter((c) => !c.archived && c.column === 'review')
  const stalled = tasks.filter((c) => cardStalled(projects, c))
  const row = (name: string | null, label: string, icon: string) => (
    <div key={label} className={cx('row', chosen === name && 'selected')} onClick={() => set({ boardProject: name })}>
      <Icon name={icon} /> <span className="label">{label}</span>
      <span className="count">{open(name) || ''}</span>
    </div>
  )
  return (
    <>
      <div className="pane-header">
        Task Board
        <InfoTip text="The workspace's cards, in .hive/tasks. Agents and the Assistant read and change them through Hive's tools; only you move cards to Done, archive or delete them." />
        <div className="actions">
          <IconButton icon="add" title="New card" onClick={() => set({ taskOpen: { project: chosen ?? '' } })} />
          <IconButton icon="refresh" title="Refresh" onClick={() => void loadTasks()} />
        </div>
      </div>
      <div className="pane-body">
        {row(null, 'All projects', 'layers')}
        {projects.map((p) => row(p.name, p.name, 'folder'))}
        {row('', 'Workspace (no project)', 'root-folder')}
        {stalled.length > 0 && (
          <>
            <div className="section-header">
              Stalled <span className="count">{stalled.length}</span>
              <InfoTip text="Cards in Doing that nobody is working on: no agent has them, or their agent was removed or isn't running." />
            </div>
            {stalled.map((c) => (
              <Tooltip key={c.number} content={cardStalled(projects, c) ?? ''}>
                <div className="row" onClick={() => set({ taskOpen: c.number })}>
                  <span className="task-number">#{c.number}</span> <span className="label">{c.title}</span>
                </div>
              </Tooltip>
            ))}
          </>
        )}
        {review.length > 0 && (
          <>
            <div className="section-header">
              Waiting for review <span className="count">{review.length}</span>
            </div>
            {review.map((c) => (
              <div key={c.number} className="row" onClick={() => set({ taskOpen: c.number })}>
                <span className="task-number">#{c.number}</span> <span className="label">{c.title}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// The card dialog: a new card, or one card in full (its fields, description, comments and history).
// ---------------------------------------------------------------------------

const refs = (v: string): number[] =>
  v
    .split(/[\s,]+/)
    .map((x) => Number(x.replace('#', '')))
    .filter((x) => Number.isInteger(x) && x > 0)

export function TaskDialog() {
  const open = useStore((s) => s.taskOpen)
  const card = useStore((s) => (typeof s.taskOpen === 'number' ? (s.tasks.find((c) => c.number === s.taskOpen) ?? null) : null))
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const isNew = open !== null && typeof open === 'object'
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [project, setProject] = useState('')
  const [agent, setAgent] = useState('')
  const [column, setColumn] = useState<TaskColumn>('todo')
  const [labels, setLabels] = useState('')
  const [blocked, setBlocked] = useState('')
  const [blockedBy, setBlockedBy] = useState('')
  const [links, setLinks] = useState('')
  const [preview, setPreview] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // The fields as the dialog opened: Save sends only what the user changed since, so a change an agent made
  // meanwhile (moving the card to Review, say) isn't put back.
  const orig = useRef<Record<string, string>>({})

  // Filled from the card when it opens (later changes by agents show in its comments and history).
  useEffect(() => {
    if (open === null) return
    const c = typeof open === 'number' ? get().tasks.find((x) => x.number === open) : null
    setTitle(c?.title ?? '')
    setDescription(c?.description ?? '')
    setProject(c ? c.project : typeof open === 'object' ? open.project : '')
    setAgent(c?.agent ?? '')
    setColumn(c?.column ?? 'todo')
    setLabels(c?.labels.join(', ') ?? '')
    setBlocked(c?.blocked ?? '')
    setBlockedBy(c?.blockedBy.map((n) => `#${n}`).join(' ') ?? '')
    setLinks(c?.links.map((n) => `#${n}`).join(' ') ?? '')
    orig.current = {
      title: c?.title ?? '',
      description: c?.description ?? '',
      project: c ? c.project : '',
      agent: c?.agent ?? '',
      column: c?.column ?? 'todo',
      labels: c?.labels.join(', ') ?? '',
      blocked: c?.blocked ?? '',
      blockedBy: c?.blockedBy.map((n) => `#${n}`).join(' ') ?? '',
      links: c?.links.map((n) => `#${n}`).join(' ') ?? ''
    }
    setPreview(!!c?.description)
    setComment('')
    setShowHistory(false)
    setTimeout(() => (c ? null : titleRef.current?.focus()), 30)
  }, [open])

  if (open === null || (!isNew && !card)) return null
  const close = (): void => set({ taskOpen: null })
  const proj = projects.find((p) => p.name === project) ?? null
  const labelList = labels
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)

  const save = async (): Promise<void> => {
    if (!title.trim()) return notify('warning', 'A card needs a title')
    setBusy(true)
    try {
      if (isNew) {
        const c = await call('tasks:create', { title, description, project, agent: agent || null, column, labels: labelList })
        const extra: TaskPatch = {}
        if (blocked.trim()) extra.blocked = blocked
        if (refs(blockedBy).length) extra.blockedBy = refs(blockedBy)
        if (refs(links).length) extra.links = refs(links)
        if (Object.keys(extra).length) await call('tasks:update', c.number, extra)
      } else if (card) {
        const was = orig.current
        const patch: TaskPatch = {}
        if (title !== was.title) patch.title = title
        if (description !== was.description) patch.description = description
        if (project !== was.project) patch.project = project
        if (agent !== was.agent) patch.agent = agent || null
        if (column !== was.column) patch.column = column
        if (labels !== was.labels) patch.labels = labelList
        if (blocked !== was.blocked) patch.blocked = blocked.trim() || null
        if (blockedBy !== was.blockedBy) patch.blockedBy = refs(blockedBy)
        if (links !== was.links) patch.links = refs(links)
        // Someone else changed a field the user also changed: the user's choice wins, but they are told.
        const now: Record<string, string> = {
          title: card.title,
          description: card.description,
          project: card.project,
          agent: card.agent ?? '',
          column: card.column,
          labels: card.labels.join(', '),
          blocked: card.blocked ?? '',
          blockedBy: card.blockedBy.map((n) => `#${n}`).join(' '),
          links: card.links.map((n) => `#${n}`).join(' ')
        }
        const clashed = Object.keys(patch).filter((k) => now[k] !== was[k])
        if (Object.keys(patch).length) await call('tasks:update', card.number, patch)
        if (clashed.length) notify('warning', `#${card.number} was also changed while you edited it`, `Your ${clashed.join(', ')} replaced the change made meanwhile (see its history).`)
      }
      await loadTasks()
      close()
    } catch (e) {
      notify('error', isNew ? 'Could not add the card' : 'Could not save the card', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const addComment = async (): Promise<void> => {
    if (!card || !comment.trim()) return
    try {
      await call('tasks:comment', card.number, comment)
      setComment('')
      await loadTasks()
    } catch (e) {
      notify('error', 'Could not add the comment', errorMessage(e))
    }
  }

  return (
    <Modal
      title={isNew ? 'New Card' : `#${card!.number}`}
      icon="checklist"
      wide
      onClose={close}
      footer={
        <>
          {card && (
            <>
              <button className="btn subtle danger-text" onClick={() => void remove(card).then((ok) => ok && close())}>
                <Icon name="trash" /> Delete
              </button>
              <button className="btn subtle" onClick={() => void archive(card, !card.archived).then(close)}>
                <Icon name={card.archived ? 'discard' : 'archive'} /> {card.archived ? 'Bring Back' : 'Archive'}
              </button>
              {!card.archived && (
                <Tooltip content={!card.project ? 'Give it a project first: its agent works there.' : card.column === 'done' ? 'It is done.' : 'Give it to an agent, with the card as its prompt.'}>
                  <button className="btn subtle" disabled={!card.project || card.column === 'done'} onClick={() => set({ taskStartFor: card.number })}>
                    <Icon name="play" /> Start…
                  </button>
                </Tooltip>
              )}
            </>
          )}
          <div className="grow" />
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !title.trim() || card?.archived} onClick={() => void save()}>
            {isNew ? 'Add Card' : 'Save'}
          </button>
        </>
      }
    >
      {card?.archived && (
        <div className="banner info">
          <Icon name="archive" /> Archived{card.archivedFor === 'project-hidden' ? ` when ${card.project} was hidden` : card.archivedFor === 'project-removed' ? ` when ${card.project} was removed from Hive` : card.archivedFor === 'done' ? ' automatically after its days in Done (Settings → Board)' : ''}. Bring it back to change it.
        </div>
      )}
      <input ref={titleRef} className="input task-title-input" placeholder="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <div className="agent-form task-form">
        <label>Project</label>
        <select
          className="select"
          value={project}
          onChange={(e) => {
            setProject(e.target.value)
            setAgent('')
          }}
        >
          <option value="">None (about the workspace)</option>
          {projects.map((p) => (
            <option key={p.path} value={p.name}>
              {p.name}
            </option>
          ))}
          {project && !proj && <option value={project}>{project} (not in the workspace)</option>}
        </select>
        <label>Agent</label>
        <select className="select" value={agent} disabled={!proj} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Nobody yet</option>
          {proj?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.live ? ` (${statusText(a.live)})` : ''}
            </option>
          ))}
          {agent && proj && !proj.agents.some((a) => a.id === agent) && <option value={agent}>{card?.agentName ?? agent} (removed)</option>}
        </select>
        <label>Column</label>
        <select className="select" value={column} onChange={(e) => setColumn(e.target.value as TaskColumn)}>
          {TASK_COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <label>Labels</label>
        <input className="input" placeholder="Comma separated, e.g. bug, ui" value={labels} onChange={(e) => setLabels(e.target.value)} />
        <label>Blocked</label>
        <input className="input" placeholder="Why it can't go on (empty: not blocked)" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
        <label>Depends on</label>
        <input className="input" placeholder="Cards to finish first, e.g. #3 #5" value={blockedBy} onChange={(e) => setBlockedBy(e.target.value)} />
        <label>Related</label>
        <input className="input" placeholder="Related cards, e.g. #7" value={links} onChange={(e) => setLinks(e.target.value)} />
      </div>
      <div className="task-section-h">
        Description
        <span className="grow" />
        <button className={cx('btn small subtle', !preview && 'active')} onClick={() => setPreview(false)}>
          Write
        </button>
        <button className={cx('btn small subtle', preview && 'active')} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="task-description" onDoubleClick={() => setPreview(false)}>
          {description.trim() ? <Markdown source={description} /> : <span className="faint">No description. Double-click to write one.</span>}
        </div>
      ) : (
        <textarea className="input task-description-input" placeholder="What to do, and how to tell it's done (Markdown). Whoever starts the card reads only this." value={description} onChange={(e) => setDescription(e.target.value)} />
      )}
      {card && (
        <>
          <div className="task-section-h">Comments ({card.comments.length})</div>
          {card.comments.map((c, i) => (
            <div key={i} className="task-comment">
              <div className="task-comment-by">
                <strong>{c.by}</strong> <span className="faint">{timeAgo(c.at)}</span>
              </div>
              <Markdown source={c.text} />
            </div>
          ))}
          {!card.archived && (
            <div className="task-comment-new">
              <textarea className="input" placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void addComment()} />
              <button className="btn small" disabled={!comment.trim()} onClick={() => void addComment()}>
                Comment
              </button>
            </div>
          )}
          <div className="task-section-h clickable" onClick={() => setShowHistory(!showHistory)}>
            <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} /> History ({card.history.length})
          </div>
          {showHistory && (
            <div className="task-history">
              {[...card.history].reverse().map((h, i) => (
                <div key={i}>
                  <span className="faint">{new Date(h.at).toLocaleString()}</span> <strong>{h.by}</strong> {h.what}
                </div>
              ))}
            </div>
          )}
          <div className="faint task-created">
            Added by {card.createdBy || 'unknown'} {timeAgo(card.createdAt)} · changed {timeAgo(card.updatedAt)}
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Start: which agent the card goes to.
// ---------------------------------------------------------------------------

type StartChoice = { kind: 'agent'; id: string } | { kind: 'new' } | { kind: 'worktree' }

export function TaskStartDialog() {
  const n = useStore((s) => s.taskStartFor)
  const card = useStore((s) => s.tasks.find((c) => c.number === s.taskStartFor) ?? null)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => (card ? (s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase()) ?? null) : null))
  const [choice, setChoice] = useState<StartChoice | null>(null)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderId | ''>('')
  const [busy, setBusy] = useState(false)

  const free = (a: AgentInfo): boolean => !a.live || a.live.status === 'ready' || a.live.status === 'finished' || a.live.status === 'stopped'
  useEffect(() => {
    if (n === null || !project) return
    const mine = card?.agent ? project.agents.find((a) => a.id === card.agent) : null
    const first = mine && free(mine) ? mine : project.agents.find((a) => free(a) && isProviderEnabled(settings, agentProviderOf(project, a)))
    setChoice(first ? { kind: 'agent', id: first.id } : { kind: 'new' })
    setName('')
    setProvider('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n])

  if (n === null || !card) return null
  const close = (): void => set({ taskStartFor: null })
  if (!project) {
    return (
      <Modal title={`Start #${card.number}`} icon="play" onClose={close} footer={<button className="btn primary" onClick={close}>OK</button>}>
        <p>{card.project ? `${card.project} isn't a project in this workspace.` : 'The card has no project.'} Give it a project first: its agent works there.</p>
      </Modal>
    )
  }
  const providers = enabledProviders(settings)
  const def = projectDefaultProvider(project.config, settings)

  const go = async (): Promise<void> => {
    if (!choice) return
    setBusy(true)
    try {
      const target =
        choice.kind === 'agent'
          ? ({ kind: 'agent', agentId: choice.id } as const)
          : ({ kind: 'new-agent', worktree: choice.kind === 'worktree', name: name.trim() || undefined, provider: provider || undefined } as const)
      const r = await call('tasks:start', card.number, target)
      close()
      set({ taskOpen: null })
      await loadTasks()
      notify('success', `#${card.number} started on ${r.agentName}`, card.title, [{ label: 'Show', command: 'agent.show', args: [project.path, r.agentId] }])
    } catch (e) {
      notify('error', `Could not start #${card.number}`, errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Start #${card.number}: ${card.title}`}
      icon="play"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!choice || busy} onClick={() => void go()}>
            <Icon name="play" /> Start
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        The agent gets the card as its prompt (title and description), and the card moves to Doing. A stopped agent starts a new conversation; an idle one gets it as its next message.
      </p>
      <div className="choice-list">
        {project.agents.map((a) => {
          const p = agentProviderOf(project, a)
          const enabled = isProviderEnabled(settings, p)
          const ok = enabled && free(a)
          return (
            <label key={a.id} className={cx('choice', choice?.kind === 'agent' && choice.id === a.id && 'selected', !ok && 'disabled')}>
              <input type="radio" disabled={!ok} checked={choice?.kind === 'agent' && choice.id === a.id} onChange={() => setChoice({ kind: 'agent', id: a.id })} />
              <div>
                <strong>
                  <ProviderIcon provider={p} /> {a.name}
                </strong>
                <div className="faint">{!enabled ? `${providerName(p)} is turned off.` : a.live ? (free(a) ? `${statusText(a.live)}: gets the card as its next message.` : `${statusText(a.live)}. Choose it once it's idle.`) : 'Stopped: starts a new conversation on the card.'}</div>
              </div>
            </label>
          )
        })}
        <label className={cx('choice', choice?.kind === 'new' && 'selected')}>
          <input type="radio" checked={choice?.kind === 'new'} onChange={() => setChoice({ kind: 'new' })} />
          <div>
            <strong>
              <Icon name="add" /> A new agent
            </strong>
            <div className="faint">Works in the project folder, next to the others.</div>
          </div>
        </label>
        <label className={cx('choice', choice?.kind === 'worktree' && 'selected', !project.isGitRepo && 'disabled')}>
          <input type="radio" disabled={!project.isGitRepo} checked={choice?.kind === 'worktree'} onChange={() => setChoice({ kind: 'worktree' })} />
          <div>
            <strong>
              <Icon name="git-branch" /> A new agent in its own worktree
            </strong>
            <div className="faint">{project.isGitRepo ? 'Its own branch and folder; merge its work back when the card is done.' : 'The project is not a git repository.'}</div>
          </div>
        </label>
      </div>
      {(choice?.kind === 'new' || choice?.kind === 'worktree') && (
        <div className="agent-form nested">
          <label>Name</label>
          <input className="input" placeholder="Default: Agent n" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Provider</label>
          <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            <option value="">Project default ({providerName(def)})</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Modal>
  )
}
