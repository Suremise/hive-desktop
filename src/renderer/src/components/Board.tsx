import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo, ProjectInfo, ProviderId, TaskCard, TaskColumn, TaskPatch, TaskStartTarget } from '@shared/types'
import { TASK_COLUMNS, columnColor, columnLabel, reviewStalled, stalledReason, taskOverview } from '@shared/tasks'
import { enabledProviders, isProviderEnabled, projectDefaultProvider, providerName } from '@shared/providers'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, agentProviderOf, choose, confirm, get, loadTasks, notify, revealAgent, set, setProjectTab, showView, useStore, type DoingRequest } from '../store'
import { selectProject } from '../actions'
import { cx, timeAgo } from '../util'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { returnRound } from '@shared/watch'
import { BusyButton, Icon, IconButton, InfoTip, Markdown, Modal, STATUS_TEXT, statusText, Tooltip, useBusy, useContextMenu, type MenuEntry } from './ui'
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

// Cards being archived from the menu: a second click while one runs is ignored.
const archiving = new Set<number>()

async function archive(c: TaskCard, archived: boolean): Promise<void> {
  if (archiving.has(c.number)) return
  archiving.add(c.number)
  try {
    await call('tasks:archive', c.number, archived)
    await loadTasks()
  } catch (e) {
    notify('error', archived ? 'Could not archive the card' : 'Could not bring the card back', errorMessage(e))
  } finally {
    archiving.delete(c.number)
  }
}

/** Deletes a card after asking; the question stays open, with a spinner, until it's done. */
function remove(c: TaskCard): Promise<boolean> {
  return confirm({
    title: `Delete #${c.number}?`,
    message: `"${c.title}" goes to the Recycle Bin, with its comments and history. Archive it instead to keep it out of sight but searchable.`,
    confirmLabel: 'Delete',
    busyLabel: 'Deleting…',
    danger: true,
    run: async () => {
      await call('tasks:delete', c.number)
      await loadTasks()
    }
  })
}

/** The right-click menu of a card. */
function cardMenu(c: TaskCard): MenuEntry[] {
  return [
    { label: 'Open', icon: 'go-to-file', onClick: () => set({ taskOpen: c.number }) },
    ...(c.archived
      ? []
      : [
          { label: 'Start…', icon: 'play', disabled: !c.project, onClick: () => set({ taskStartFor: c.number }) },
          { separator: true },
          { header: true, label: 'Move to' },
          ...TASK_COLUMNS.filter((x) => x.id !== c.column).map((x) => ({ label: x.label, icon: 'arrow-right', onClick: () => (x.id === 'doing' ? moveToDoing({ n: c.number, project: c.project, agent: c.agent }) : void change(c.number, { column: x.id })) })),
          // A failed card still in Review goes back to its reviewer for the next round (#214).
          ...(returnRound(c) ? [{ label: 'Review (next round)', icon: 'refresh', onClick: () => void change(c.number, { column: 'review' }) }] : []),
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

/** Who is reviewing the card now (TaskCard.review): click to show it; in amber when it has gone or isn't running. */
function ReviewLine({ c, projects }: { c: TaskCard; projects: ProjectInfo[] }) {
  if (!c.review) return null
  const project = c.project ? (projects.find((p) => p.name.toLowerCase() === c.project.toLowerCase()) ?? null) : null
  const reviewer = project?.agents.find((a) => a.id === c.review!.agent) ?? null
  const name = reviewer?.name ?? c.review.agentName
  const stalled = reviewStalled(c, reviewer ? { name: reviewer.name, running: !!reviewer.live } : null)
  return (
    <Tooltip content={stalled ? `${name} started reviewing it ${timeAgo(c.review.since)}, and ${stalled.charAt(0).toLowerCase()}${stalled.slice(1)}` : `${name} is reviewing it (since ${timeAgo(c.review.since)}). Click to show it.`}>
      <div
        className={cx('task-review', stalled && 'stalled')}
        onClick={(e) => {
          if (!project || !reviewer) return
          e.stopPropagation()
          selectProject(project.path)
          revealAgent(project, reviewer.id)
        }}
      >
        <Icon name="eye" /> Reviewing: {name}
        {stalled ? ` (${reviewer ? 'not running' : 'removed'})` : ` · ${timeAgo(c.review.since)}`}
      </div>
    </Tooltip>
  )
}

function CardTile({
  c,
  projects,
  showProject,
  onDragStart,
  dropHere
}: {
  c: TaskCard
  projects: ProjectInfo[]
  showProject: boolean
  onDragStart: (e: React.DragEvent) => void
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
        <ReviewLine c={c} projects={projects} />
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
  const boardRef = useRef<HTMLDivElement>(null)

  /**
   * Where the dragged card would land with the pointer at (x, y), from what is under it now: over a card, before it
   * (its top half) or the next one; below a column's last card (or in an empty column), at the end; in a gap between
   * cards, where it was. Called on every dragover, and after each step of scrolling, so the marker follows what
   * scrolling brings under the pointer.
   */
  const place = (x: number, y: number): void => {
    const d = dragNow.current
    if (!d) return
    const at = document.elementFromPoint(x, y) as HTMLElement | null
    const colEl = at?.closest<HTMLElement>('.board-column')
    const column = colEl?.dataset.column as TaskColumn | undefined
    if (!at || !colEl || !column || !boardRef.current?.contains(colEl)) return
    const list = cards.filter((c) => c.column === column)
    const tile = at.closest<HTMLElement>('.task-card')
    let before: number | null
    if (tile) {
      const n = Number(tile.dataset.task)
      const r = tile.getBoundingClientRect()
      const i = list.findIndex((c) => c.number === n)
      before = y < r.top + r.height / 2 ? n : (list[i + 1]?.number ?? null)
    } else {
      const tiles = colEl.querySelectorAll('.task-card')
      const last = tiles[tiles.length - 1]?.getBoundingClientRect()
      if (!last || y > last.bottom || d.column !== column) before = null
      else return
    }
    if (d.column !== column || d.before !== before) setDrag({ ...d, column, before })
  }
  const placeNow = useRef(place)
  placeNow.current = place

  // While a card is dragged: near the top or bottom of a column's cards (or over its heading), that column scrolls;
  // near the board's sides, the board does. Every frame, so it keeps going with the pointer held still (dragover
  // doesn't come at a steady rate, or at all without a move). Stops when the drag ends, is dropped or cancelled, or
  // the pointer leaves the board.
  const dragging = !!drag
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!dragging) return
    const over = (e: DragEvent): void => {
      pointer.current = boardRef.current?.contains(e.target as Node) ? { x: e.clientX, y: e.clientY } : null
    }
    const stop = (): void => {
      pointer.current = null
    }
    // Out of the window: no more dragovers, so the last place would go on scrolling.
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) stop()
    }
    document.addEventListener('dragover', over, true)
    document.addEventListener('drop', stop, true)
    document.addEventListener('dragleave', leave, true)
    let frame = 0
    let last = performance.now()
    const step = (now: number): void => {
      // As far as the time since the last frame allows: as fast however often the window draws.
      const ms = now - last
      last = now
      const p = pointer.current
      const board = boardRef.current
      if (p && board) {
        let moved = false
        const body = (document.elementFromPoint(p.x, p.y) as HTMLElement | null)?.closest('.board-column')?.querySelector<HTMLElement>('.board-column-body')
        if (body && body.scrollHeight > body.clientHeight) {
          const r = body.getBoundingClientRect()
          const top = body.scrollTop
          body.scrollTop = clampScroll(top, frameStep(edgeSpeed(p.y, r.top, r.bottom), ms), body.scrollHeight - body.clientHeight)
          moved = body.scrollTop !== top
        }
        if (board.scrollWidth > board.clientWidth) {
          const r = board.getBoundingClientRect()
          const left = board.scrollLeft
          board.scrollLeft = clampScroll(left, frameStep(edgeSpeed(p.x, r.left, r.right), ms), board.scrollWidth - board.clientWidth)
          moved ||= board.scrollLeft !== left
        }
        if (moved) placeNow.current(p.x, p.y)
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('drop', stop, true)
      document.removeEventListener('dragleave', leave, true)
      pointer.current = null
    }
  }, [dragging])

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
    // Into Doing from another column: who works on it is asked first, and the card stays put until then (Cancel).
    if (column === 'doing' && card.column !== 'doing') return moveToDoing({ n: card.number, project: card.project, agent: card.agent, before: d.before })
    // Shown moved at once; the board is read again when the change lands.
    set((s) => ({ tasks: s.tasks.map((c) => (c.number === d.n ? { ...c, column } : c)) }))
    await change(d.n, { column, before: d.before }, 'Could not move the card')
  }

  return (
    <div ref={boardRef} className={cx('board', colored && 'colored')} onDragEnd={() => setDrag(null)}>
      {TASK_COLUMNS.map((col) => {
        const list = cards.filter((c) => c.column === col.id)
        return (
          <div
            key={col.id}
            className={cx('board-column', drag?.column === col.id && 'drag-over')}
            data-column={col.id}
            style={colored ? ({ '--col': columnColor(colors, col.id) } as React.CSSProperties) : undefined}
            onDragOver={(e) => {
              if (!dragNow.current) return
              e.preventDefault()
              place(e.clientX, e.clientY)
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

/**
 * The board at a glance, on the Workspace Overview (every card; each number opens the Task Board) and a project's
 * Overview (its cards only; each number opens its Tasks tab).
 */
export function TaskStrip({ project }: { project: ProjectInfo | null }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const o = useMemo(() => taskOverview(tasks, project?.name ?? null, (c) => !!cardStalled(projects, c)), [tasks, projects, project?.name])
  const open = (): void => {
    if (project) return setProjectTab(project.path, 'tasks')
    set({ boardProject: null, boardArchived: false, boardQuery: '' })
    showView('board')
  }
  if (!o.total) {
    if (!project) return null
    return (
      <div className="board-strip" data-project={project.name}>
        <Icon name="project" />
        <span>No cards for this project.</span>
        <button className="board-strip-item" onClick={open}>
          Open Tasks
        </button>
      </div>
    )
  }
  const items: { label: string; n: number; tone?: string }[] = [
    { label: 'Todo', n: o.todo },
    { label: 'Doing', n: o.doing },
    { label: 'Waiting for review', n: o.review, tone: 'accent' },
    { label: 'Done', n: o.done },
    { label: 'Stalled', n: o.stalled, tone: 'warning' },
    { label: 'Blocked', n: o.blocked, tone: 'error' }
  ]
  return (
    <div className="board-strip" data-project={project?.name}>
      <Icon name="project" />
      {items.map((x) => (
        <button key={x.label} className={cx('board-strip-item', x.n > 0 && x.tone)} onClick={open}>
          <span className="n">{x.n}</span> {x.label}
        </button>
      ))}
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
        <span className="faint">Plan work as cards, start them on agents, and see where each one is. Agents put finished work in Review for you.</span>
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
        <InfoTip text="The workspace's cards, in .hive/tasks. Agents and the Assistant read, change and move them through Hive's tools (finished work goes to Review); only you archive or delete them." />
        <div className="actions">
          <IconButton icon="add" title="New card" onClick={() => set({ taskOpen: { project: chosen ?? '' } })} />
          <IconButton icon="refresh" title="Refresh" onClick={() => void loadTasks()} />
        </div>
      </div>
      <div className="pane-body">
        {row(null, 'All projects', 'layers')}
        {projects.map((p) => row(p.name, p.name, 'folder'))}
        {row('', 'Workspace', 'root-folder')}
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
  const action = useBusy()
  const [showHistory, setShowHistory] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // The fields as the dialog opened: Save sends only what the user changed since, so a change an agent made
  // meanwhile (moving the card to Review, say) isn't put back.
  const orig = useRef<Record<string, string>>({})

  // Filled from the card when it opens (later changes by agents show in its comments and history).
  const { setError: setActionError } = action
  useEffect(() => {
    if (open === null) return
    setActionError(null)
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
      project: c ? c.project : typeof open === 'object' ? open.project : '',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (open === null || (!isNew && !card)) return null
  const close = (): void => set({ taskOpen: null })
  const proj = projects.find((p) => p.name === project) ?? null
  const labelList = labels
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  const fields: Record<string, string> = { title, description, project, agent, column, labels, blocked, blockedBy, links }
  // Edits not saved yet: the fields as they opened, or a comment being written.
  const edited = Object.keys(fields).filter((k) => fields[k] !== (orig.current[k] ?? ''))
  const unsaved = edited.length > 0 || !!comment.trim()

  /** Closing (Escape, ×, outside, Cancel): asks first when something would be lost. */
  const tryClose = async (): Promise<void> => {
    if (action.busy) return
    if (unsaved) {
      const what = [edited.length ? (isNew ? 'this new card' : 'your changes to the card') : '', comment.trim() ? 'the comment you are writing' : ''].filter(Boolean).join(' and ')
      const choice = await choose({
        title: 'Discard unsaved changes?',
        message: `Closing loses ${what}.`,
        choices: [
          { label: 'Discard', value: 'discard' },
          { label: 'Keep Editing', value: 'keep' }
        ]
      })
      if (choice !== 'discard') return
    }
    close()
  }

  /**
   * Saves the card (creates a new one); the dialog's fields become the saved ones. hold: all but its column and agent,
   * which the Move to Doing dialog sets (they stay unsaved here until it has).
   */
  const persist = async (hold = false): Promise<void> => {
    if (!title.trim()) throw new Error('A card needs a title.')
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
      if (agent !== was.agent && !hold) patch.agent = agent || null
      if (column !== was.column && !hold) patch.column = column
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
      // A card that changes project leaves its agent; one of the new project's agents is given it afterwards.
      const give = patch.project !== undefined && patch.agent ? patch.agent : null
      if (give) delete patch.agent
      if (Object.keys(patch).length) await call('tasks:update', card.number, patch)
      if (give) await call('tasks:update', card.number, { agent: give })
      if (clashed.length) notify('warning', `#${card.number} was also changed while you edited it`, `Your ${clashed.join(', ')} replaced the change made meanwhile (see its history).`)
    }
    orig.current = hold ? { ...fields, agent: orig.current.agent, column: orig.current.column } : { ...fields }
    await loadTasks()
  }

  /** The comment being written, posted (Save leaves nothing in the dialog behind). */
  const postComment = async (): Promise<void> => {
    if (!card || !comment.trim()) return
    await call('tasks:comment', card.number, comment)
    setComment('')
    await loadTasks()
  }

  /** Save: the card's fields, and a comment being written (so nothing in the dialog is left behind). */
  const save = async (): Promise<void> => {
    // Into Doing from another column: the Move to Doing dialog asks who works on it, and saves the rest when it is
    // confirmed (Cancel there leaves this dialog open, nothing saved).
    if (card && column === 'doing' && orig.current.column !== 'doing') {
      if (!title.trim()) return action.setError('A card needs a title.')
      return moveToDoing({
        n: card.number,
        project,
        agent: agent || null,
        prepare: async () => {
          await persist(true)
          await postComment()
        },
        done: close
      })
    }
    const r = await action.run('save', async () => {
      await persist()
      await postComment()
    })
    if (r) close()
  }

  /** Start…: unsaved edits are saved first, so the agent gets the card as shown (a failed save starts nothing). */
  const start = async (): Promise<void> => {
    if (!card) return
    if (edited.length && !(await action.run('start', () => persist()))) return
    set({ taskStartFor: card.number })
  }

  const addComment = async (): Promise<void> => {
    if (!card || !comment.trim()) return
    const r = await action.run('comment', async () => {
      await call('tasks:comment', card.number, comment)
      await loadTasks()
    })
    if (r) setComment('')
  }

  return (
    <Modal
      title={isNew ? 'New Card' : `#${card!.number}`}
      icon="checklist"
      wide
      movable
      onClose={() => void tryClose()}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          {card && (
            <>
              <button className="btn subtle danger-text" onClick={() => void remove(card).then((ok) => ok && close())}>
                <Icon name="trash" /> Delete
              </button>
              <BusyButton
                className="subtle"
                busy={action.busy === 'archive'}
                busyLabel={card.archived ? 'Bringing back…' : 'Archiving…'}
                onClick={() =>
                  void action
                    .run('archive', async () => {
                      await call('tasks:archive', card.number, !card.archived)
                      await loadTasks()
                    })
                    .then((r) => r && close())
                }
              >
                <Icon name={card.archived ? 'discard' : 'archive'} /> {card.archived ? 'Bring Back' : 'Archive'}
              </BusyButton>
              {!card.archived && (
                <Tooltip content={!card.project ? 'Give it a project first: its agent works there.' : edited.length ? 'Save your changes, then give it to an agent with the card as its prompt.' : 'Give it to an agent, with the card as its prompt.'}>
                  <BusyButton className="subtle" busy={action.busy === 'start'} busyLabel="Saving…" disabled={!card.project || !title.trim()} onClick={() => void start()}>
                    <Icon name="play" /> {edited.length ? 'Save and Start…' : 'Start…'}
                  </BusyButton>
                </Tooltip>
              )}
            </>
          )}
          <div className="grow" />
          <button className="btn subtle" onClick={() => void tryClose()}>
            Cancel
          </button>
          <BusyButton className="primary" busy={action.busy === 'save'} busyLabel={isNew ? 'Adding…' : 'Saving…'} disabled={!title.trim() || card?.archived} onClick={() => void save()}>
            {isNew ? 'Add Card' : 'Save'}
          </BusyButton>
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
              <BusyButton className="small" busy={action.busy === 'comment'} busyLabel="Posting…" disabled={!comment.trim()} onClick={() => void addComment()}>
                Comment
              </BusyButton>
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

/** An agent that can take a card now: stopped, or running and idle (Start checks again). */
const freeAgent = (a: AgentInfo): boolean => !a.live || a.live.status === 'ready' || a.live.status === 'finished' || a.live.status === 'stopped'

/**
 * Who starts a card, as the Start and Move to Doing dialogs ask it: an existing agent that can take it (the card's
 * own first), a new agent, or a new agent in its own worktree. Agents are as the window knows them now, so one that
 * gets busy while the dialog is open can no longer be chosen (and Start refuses it in any case).
 */
function useStartPick(project: ProjectInfo | null) {
  const settings = useStore((s) => s.settings)
  const [choice, setChoice] = useState<StartChoice | null>(null)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderId | ''>('')
  const usable = (a: AgentInfo): boolean => !!project && freeAgent(a) && isProviderEnabled(settings, agentProviderOf(project, a))
  /** Back to the first choice: the card's own agent if it can take it, else the first that can, else a new agent. */
  const reset = (agentId: string | null): void => {
    const mine = agentId && project ? project.agents.find((a) => a.id === agentId) : null
    const first = mine && usable(mine) ? mine : project?.agents.find(usable)
    setChoice(first ? { kind: 'agent', id: first.id } : { kind: 'new' })
    setName('')
    setProvider('')
  }
  const chosen = choice?.kind === 'agent' ? (project?.agents.find((a) => a.id === choice.id) ?? null) : null
  const ready = !!project && !!choice && (choice.kind === 'agent' ? !!chosen && usable(chosen) : choice.kind === 'new' || project.isGitRepo)
  const target = (): TaskStartTarget =>
    choice?.kind === 'agent' ? { kind: 'agent', agentId: choice.id } : { kind: 'new-agent', worktree: choice?.kind === 'worktree', name: name.trim() || undefined, provider: provider || undefined }
  return { settings, choice, setChoice, name, setName, provider, setProvider, reset, ready, target }
}

type StartPick = ReturnType<typeof useStartPick>

function StartChoices({ project, pick }: { project: ProjectInfo; pick: StartPick }) {
  const { settings, choice, setChoice, name, setName, provider, setProvider } = pick
  const providers = enabledProviders(settings)
  const def = projectDefaultProvider(project.config, settings)
  return (
    <>
      <div className="choice-list">
        {project.agents.map((a) => {
          const p = agentProviderOf(project, a)
          const enabled = isProviderEnabled(settings, p)
          const ok = enabled && freeAgent(a)
          return (
            <label key={a.id} className={cx('choice', choice?.kind === 'agent' && choice.id === a.id && 'selected', !ok && 'disabled')}>
              <input type="radio" disabled={!ok} checked={choice?.kind === 'agent' && choice.id === a.id} onChange={() => setChoice({ kind: 'agent', id: a.id })} />
              <div>
                <strong>
                  <ProviderIcon provider={p} /> {a.name}
                </strong>
                <div className="faint">{!enabled ? `${providerName(p)} is turned off.` : a.live ? (freeAgent(a) ? `${statusText(a.live)}: gets the card as its next message.` : `${statusText(a.live).replace(/…$/, '')}. Choose it once it's idle.`) : 'Stopped: starts a new conversation on the card.'}</div>
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
    </>
  )
}

/** Starts a card (the Start and Move to Doing dialogs) and says so, with Show. */
async function startCard(card: TaskCard, project: ProjectInfo, target: TaskStartTarget): Promise<void> {
  const r = await call('tasks:start', card.number, target)
  notify('success', `#${card.number} started on ${r.agentName}`, card.title, [{ label: 'Show', command: 'agent.show', args: [project.path, r.agentId] }])
}

export function TaskStartDialog() {
  const n = useStore((s) => s.taskStartFor)
  const card = useStore((s) => s.tasks.find((c) => c.number === s.taskStartFor) ?? null)
  const project = useStore((s) => (card ? (s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase()) ?? null) : null))
  const pick = useStartPick(project)
  const action = useBusy()
  const { setError: setStartError } = action

  useEffect(() => {
    if (n === null || !project) return
    pick.reset(card?.agent ?? null)
    setStartError(null)
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

  const go = async (): Promise<void> => {
    if (!pick.ready) return
    // The dialog stays open (no closing, a spinner) until the agent has the card; a failure shows here.
    const r = await action.run('start', () => startCard(card, project, pick.target()))
    if (!r) return
    close()
    set({ taskOpen: null })
    await loadTasks()
  }

  return (
    <Modal
      title={`Start #${card.number}: ${card.title}`}
      icon="play"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <BusyButton className="primary" busy={action.busy === 'start'} busyLabel={pick.choice?.kind === 'worktree' ? 'Creating the worktree…' : 'Starting…'} disabled={!pick.ready} onClick={() => void go()}>
            <Icon name="play" /> {action.error ? 'Try Again' : 'Start'}
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        The agent gets the card as its prompt (title and description), and the card moves to Doing. A stopped agent starts a new conversation; an idle one gets it as its next message.
      </p>
      <StartChoices project={project} pick={pick} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Move to Doing: nobody yet, an agent, or an agent that starts on it.
// ---------------------------------------------------------------------------

type DoingMode = 'nobody' | 'assign' | 'start'

const doingProject = (req: DoingRequest): ProjectInfo | null => (req.project ? (get().workspace?.projects.find((p) => p.name.toLowerCase() === req.project.toLowerCase()) ?? null) : null)

/**
 * Moves a card into Doing from another column the way the user means it: the Move to Doing dialog asks (nobody yet,
 * an agent, or an agent that starts on it). A card with no project in this workspace can only go there with its
 * agent as it is, so it moves at once. Reordering within Doing never comes here.
 */
export function moveToDoing(req: DoingRequest): void {
  if (doingProject(req)) return set({ taskDoing: req })
  void (async () => {
    try {
      await req.prepare?.()
      await call('tasks:update', req.n, { column: 'doing', ...(req.before !== undefined ? { before: req.before } : {}) })
      await loadTasks()
      req.done?.()
    } catch (e) {
      notify('error', 'Could not move the card', errorMessage(e))
      await loadTasks()
    }
  })()
}

export function MoveToDoingDialog() {
  const req = useStore((s) => s.taskDoing)
  const card = useStore((s) => (s.taskDoing ? (s.tasks.find((c) => c.number === s.taskDoing!.n) ?? null) : null))
  const project = useStore((s) => (s.taskDoing?.project ? (s.workspace?.projects.find((p) => p.name.toLowerCase() === s.taskDoing!.project.toLowerCase()) ?? null) : null))
  const [mode, setMode] = useState<DoingMode>('nobody')
  const [assignee, setAssignee] = useState('')
  const pick = useStartPick(project)
  const action = useBusy()
  const { setError } = action

  useEffect(() => {
    if (!req) return
    // The card's agent (or the one the card editor has) is the default: assigned, nothing started.
    const own = req.agent && project?.agents.some((a) => a.id === req.agent) ? req.agent : null
    setMode(own ? 'assign' : 'nobody')
    setAssignee(own ?? project?.agents[0]?.id ?? '')
    pick.reset(own)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  if (!req || !card || !project) return null
  const close = (): void => set({ taskDoing: null })
  const assignable = project.agents.some((a) => a.id === assignee)
  const ready = mode === 'nobody' || (mode === 'assign' ? assignable : pick.ready)
  const before = req.before !== undefined ? { before: req.before } : {}
  const holder = req.agent ? (project.agents.find((a) => a.id === req.agent)?.name ?? card.agentName ?? 'its agent') : null

  const go = async (): Promise<void> => {
    if (!ready) return
    const r = await action.run(mode, async () => {
      await req.prepare?.()
      if (mode === 'start') {
        await startCard(card, project, pick.target())
        // Start doesn't place the card: where it was dropped, if it still can be (the order only).
        if (req.before !== undefined) await call('tasks:update', card.number, before).catch(() => undefined)
      } else {
        await call('tasks:update', card.number, { column: 'doing', agent: mode === 'assign' ? assignee : null, ...before })
      }
    })
    if (!r) return
    close()
    await loadTasks()
    req.done?.()
  }

  const row = (m: DoingMode, icon: string, title: string, text: string, disabled = false) => (
    <label className={cx('choice', mode === m && 'selected', disabled && 'disabled')}>
      <input type="radio" name="doing-mode" disabled={disabled} checked={mode === m} onChange={() => setMode(m)} />
      <div>
        <strong>
          <Icon name={icon} /> {title}
        </strong>
        <div className="faint">{text}</div>
      </div>
    </label>
  )
  const label = action.error ? 'Try Again' : mode === 'start' ? 'Start' : 'Move to Doing'

  return (
    <Modal
      title={`Move #${card.number} to Doing`}
      icon="arrow-right"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <BusyButton className="primary" busy={!!action.busy} busyLabel={mode === 'start' ? (pick.choice?.kind === 'worktree' ? 'Creating the worktree…' : 'Starting…') : 'Moving…'} disabled={!ready} onClick={() => void go()}>
            {mode === 'start' && <Icon name="play" />} {label}
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        <strong>{card.title}</strong> · {project.name}
      </p>
      <div className="choice-list doing-modes">
        {row('nobody', 'circle-large-outline', 'Nobody yet', holder ? `Moves it with no agent. Takes it from ${holder}.` : 'Moves it with no agent.')}
        {row('assign', 'person', 'Assign an agent', project.agents.length ? 'Gives it to an agent of the project. Nothing is sent to the agent and nothing starts.' : 'The project has no agents yet.', !project.agents.length)}
        {mode === 'assign' && (
          <div className="agent-form nested doing-sub">
            <label>Agent</label>
            <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {project.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.live ? statusText(a.live) : 'Stopped'})
                </option>
              ))}
            </select>
          </div>
        )}
        {row('start', 'play', 'Assign and start', 'The agent gets the card as its prompt: a stopped one starts a new conversation, an idle one gets it as its next message.')}
        {mode === 'start' && (
          <div className="doing-sub">
            <StartChoices project={project} pick={pick} />
          </div>
        )}
      </div>
    </Modal>
  )
}
