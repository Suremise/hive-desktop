import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo, ArchiveBatch, BoardFold, ProjectInfo, ProviderId, TaskCard, TaskColumn, TaskDecision, TaskPatch, TaskStartTarget } from '@shared/types'
import { gitProblemText } from '@shared/gitTool'
import { TASK_COLUMNS, applyBoardFold, cardMatches, newSinceStart, archivedAt, columnColor, columnLabel, notWatchingReason, reviewStalled, stalledReason, taskOverview, type BoardFoldChange } from '@shared/tasks'
import { enabledProviders, isProviderEnabled, projectDefaultProvider, providerName } from '@shared/providers'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, agentProviderOf, choose, confirm, get, loadTasks, notify, revealAgent, set, setProjectTab, showView, useDateStyle, useStore, type ArchiveAllRequest, type DoingRequest } from '../store'
import { selectProject } from '../actions'
import { cx, timeAgo } from '../util'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { formatDateTime } from '@shared/dates'
import { returnRound } from '@shared/watch'
import { BusyButton, Icon, IconButton, InfoTip, Markdown, Modal, STATUS_TEXT, statusText, Tooltip, useBusy, useContextMenu, type MenuEntry } from './ui'
import { DataTable, type DataColumn } from './DataTable'
import { DialogList } from './Overlays'
import { reportArchived, unarchiveBatch } from '../boardBatches'
import { ProviderIcon } from './ProviderIcon'

const NO_TASKS: TaskCard[] = []
const NO_FOLD: BoardFold = {}

/** This workspace's board as the user left it (#170): its collapsed columns and folded cards. */
function useBoardFold(): BoardFold {
  return useStore((s) => (s.workspace ? s.boardFold[s.workspace.path.toLowerCase()] : undefined) ?? NO_FOLD)
}

/**
 * Changes this workspace's board fold (a view preference in Hive's own settings, never in the cards' files): shown at
 * once, and saved by main as a change to what is saved now, so another window's folds (of its workspace) are never
 * written over with what this window read earlier. Folded cards no longer on the board, archived ones included, are
 * dropped (once the board has been read).
 */
function saveFold(what: BoardFoldChange): void {
  const ws = get().workspace?.path
  if (!ws) return
  const tasks = get().tasks
  const full = { ...what, ...(tasks.length ? { known: tasks.map((c) => c.number) } : {}) }
  set({ boardFold: applyBoardFold(get().boardFold, ws, full) })
  void call('ui:changeBoardFold', full)
    .then((saved) => set({ boardFold: saved }))
    .catch(() => undefined)
}

/** Reads every workspace's board fold as saved now (a window opening a workspace another window changed). */
function loadBoardFold(): void {
  void call('ui:get')
    .then((ui) => set({ boardFold: ui.boardFold ?? {} }))
    .catch(() => undefined)
}

const collapseColumn = (col: TaskColumn, collapsed: boolean): void => saveFold({ columns: { ids: [col], collapsed } })

const foldCards = (numbers: number[], folded: boolean): void => saveFold({ cards: { numbers, folded } })

/** The project and agent a card is given to, as they are now (null when the card has none). */
function cardAgent(projects: ProjectInfo[], c: TaskCard): { project: ProjectInfo | null; agent: AgentInfo | null } {
  const project = c.project ? (projects.find((p) => p.name.toLowerCase() === c.project.toLowerCase()) ?? null) : null
  return { project, agent: c.agent ? (project?.agents.find((a) => a.id === c.agent) ?? null) : null }
}

/**
 * Why nobody is working on the card, from the agents as the window knows them: a Doing card's agent gone or stopped, or
 * an agent looping on the card (Doing or Review) whose turn ended with no card watch (#376).
 */
export function cardStalled(projects: ProjectInfo[], c: TaskCard): string | null {
  const { agent } = cardAgent(projects, c)
  return stalledReason(c, agent ? { name: agent.name, running: !!agent.live } : null) ?? notWatchingReason(c, projects.flatMap((p) => p.agents.map((a) => ({ name: a.name, project: p.name, notWatching: a.live?.notWatching }))))
}


const inProject = (c: TaskCard, project: string | null): boolean => project === null || c.project.toLowerCase() === project.toLowerCase()

/**
 * Who has a card now, so Archive All passes over it unless asked (#351): its agent working on it (in Doing, running), its
 * reviewer, or an agent (or the Assistant) watching it. Null when nobody is on it.
 */
function cardBusy(c: TaskCard, projects: ProjectInfo[], assistant: ProjectInfo | null): string | null {
  if (c.column === 'doing') {
    const { agent } = cardAgent(projects, c)
    if (agent?.live) return `${agent.name} is working on it`
  }
  if (c.review) return `${c.review.agentName} is reviewing it`
  for (const p of assistant ? [...projects, assistant] : projects) {
    const a = p.agents.find((x) => x.live?.watch?.cards.includes(c.number))
    if (a) return `${p === assistant ? 'The Assistant' : a.name} is watching it`
  }
  return null
}

/** The cards Archive All would take (#351): those of the column (or board) shown, and how many there are in all. */
function archiveScope(all: TaskCard[], r: Pick<ArchiveAllRequest, 'column' | 'project' | 'scope' | 'query'>): { shown: TaskCard[]; total: number } {
  const there = all.filter((c) => !c.archived && (r.column === null || c.column === r.column) && inProject(c, r.scope))
  return { shown: there.filter((c) => inProject(c, r.project) && cardMatches(c, r.query)), total: there.length }
}

/** The menu item that opens Archive All: a column's, or the board's (column null). Counted, and off with nothing shown. */
function archiveAllItem(all: TaskCard[], r: ArchiveAllRequest): MenuEntry {
  const { shown, total } = archiveScope(all, r)
  const where = r.column === null ? null : columnLabel(r.column)
  const label =
    shown.length < total
      ? `Archive the ${shown.length} Shown${where ? '' : ` Card${shown.length === 1 ? '' : 's'}`} (of ${total})…`
      : where
        ? `Archive All in ${where} (${total})…`
        : `Archive All Cards (${total})…`
  return { label, icon: 'archive', disabled: !shown.length, onClick: () => set({ boardArchiveAll: r }) }
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
        <Icon name="eye" />
        <span className="task-note-text">
          Reviewing: {name}
          {stalled ? ` (${reviewer ? 'not running' : 'removed'})` : ` · ${timeAgo(c.review.since)}`}
        </span>
      </div>
    </Tooltip>
  )
}

/**
 * A column's fold (#276): « on its header collapses it sideways into a strip, » on the strip expands it; the horizontal
 * convention (VS Code's panels), so it doesn't look like a card's ▾ / ▸, which folds a card to one line. Two codicon
 * chevrons drawn over each other (codicons have no double one).
 */
function Chevrons({ dir }: { dir: 'left' | 'right' }) {
  return (
    <span className="board-chevrons" aria-hidden>
      <Icon name={`chevron-${dir}`} />
      <Icon name={`chevron-${dir}`} />
    </span>
  )
}

/** A folded card's agent: a dot in its status's colour (Doing cards) or a plain one, with who and what in its tooltip. */
function FoldedAgent({ c, projects }: { c: TaskCard; projects: ProjectInfo[] }) {
  if (!c.agent) return null
  const { agent } = cardAgent(projects, c)
  const name = agent?.name ?? c.agentName ?? 'its agent'
  const live = c.column === 'doing'
  const text = !agent ? `${name} (removed)` : `${name}: ${agent.live ? statusText(agent.live) : 'Not running'}`
  return (
    <Tooltip content={text}>
      <span className="task-folded-agent" aria-label={text}>
        <span className={cx('dot', live ? (agent?.live?.status ?? 'stopped') : 'stopped')} />
      </span>
    </Tooltip>
  )
}

function CardTile({
  c,
  projects,
  showProject,
  folded,
  onDragStart,
  dropHere
}: {
  c: TaskCard
  projects: ProjectInfo[]
  showProject: boolean
  /** Folded to one line (#170): its number, title, agent and any stalled or blocked marker. */
  folded: boolean
  onDragStart: (e: React.DragEvent) => void
  dropHere: boolean
}) {
  const menu = useContextMenu()
  const { agent } = cardAgent(projects, c)
  // A Doing card whose agent has finished is waiting for someone to look: it shows like a finished agent.
  const finished = c.column === 'doing' && agent?.live?.status === 'finished'
  const stalled = cardStalled(projects, c)
  const fold = <IconButton icon={folded ? 'chevron-right' : 'chevron-down'} title={folded ? `Expand #${c.number}` : `Collapse #${c.number} to one line`} className="task-fold" expanded={!folded} onClick={() => foldCards([c.number], !folded)} />
  const props = {
    className: cx('task-card', folded && 'folded', c.blocked && 'blocked', finished && 'finished', stalled && !c.blocked && 'stalled'),
    draggable: !c.archived,
    onDragStart,
    onClick: () => set({ taskOpen: c.number }),
    onContextMenu: (e: React.MouseEvent) => menu.open(e, cardMenu(c)),
    'data-task': c.number
  }
  if (folded) {
    return (
      <>
        {dropHere && <div className="task-drop" />}
        <div {...props}>
          <div className="task-card-line">
            {fold}
            <span className="task-number">#{c.number}</span>
            <Tooltip content={c.title}>
              <span className="task-title">{c.title}</span>
            </Tooltip>
            {c.blocked && (
              <Tooltip content={`Blocked: ${c.blocked}`}>
                <span className="task-flag blocked" aria-label="Blocked">
                  <Icon name="circle-slash" />
                </span>
              </Tooltip>
            )}
            {stalled && (
              <Tooltip content={`Stalled: ${stalled}`}>
                <span className="task-flag stalled" aria-label="Stalled">
                  <Icon name="debug-pause" />
                </span>
              </Tooltip>
            )}
            <FoldedAgent c={c} projects={projects} />
          </div>
        </div>
        {menu.element}
      </>
    )
  }
  return (
    <>
      {dropHere && <div className="task-drop" />}
      <div {...props}>
        <div className="task-card-top">
          {fold}
          <span className="task-number">#{c.number}</span>
          {showProject && c.project && <span className="task-project">{c.project}</span>}
          {!c.project && <span className="task-project faint">workspace</span>}
        </div>
        <div className="task-title">{c.title}</div>
        {/* Long reasons (hashes, paths) wrap anywhere, at most three lines on the card; the whole on hover (#372). */}
        {c.blocked && (
          <Tooltip block content={`Blocked: ${c.blocked}`}>
            <div className="task-blocked">
              <Icon name="circle-slash" />
              <span className="task-note-text">{c.blocked}</span>
            </div>
          </Tooltip>
        )}
        {stalled && (
          <Tooltip block content={/ isn't watching #\d+:/.test(stalled) ? 'Nothing will wake that agent when this card changes. Show it and ask it to carry on its card loop.' : 'Nobody is working on it. Start it again (on this agent or another), or move it back to Todo.'}>
            <div className="task-stalled">
              <Icon name="debug-pause" />
              <span className="task-note-text">Stalled: {stalled}</span>
            </div>
          </Tooltip>
        )}
        <ReviewLine c={c} projects={projects} />
        {(c.labels.length > 0 || c.blockedBy.length > 0 || c.comments.length > 0 || !!c.decisions?.length) && (
          <div className="task-meta">
            {c.labels.map((l) => (
              <span key={l} className="task-label" title={l}>
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
            {!!c.decisions?.length && (
              <Tooltip content={`Decisions: ${c.decisions.length}. ${c.decisions.map((d) => (d.text.length > 80 ? `${d.text.slice(0, 79)}…` : d.text)).join(' · ')}`}>
                <span className="faint task-decision-count" aria-label={`Decisions: ${c.decisions.length}`}>
                  <Icon name="law" /> {c.decisions.length}
                </span>
              </Tooltip>
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
 * The board: six columns of cards (one project's, or all of them). Cards drag between and within columns;
 * click opens one, right-click has the rest. Each column collapses to a narrow strip and each card folds to one line
 * (#170), as the user leaves them for this workspace. With archived, the archived cards as a list instead. scope: the
 * board this is part of (a project's Tasks tab: its project), for Archive All's "the n shown (of m)" (#351).
 */
export function Board({ project, scope = null, query, archived }: { project: string | null; scope?: string | null; query: string; archived: boolean }) {
  const all = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  const fold = useBoardFold()
  const headerMenu = useContextMenu()
  const [drag, showDrag] = useState<DragState | null>(null)
  // The handlers read the drag from here, not from the last render: a dragover or drop can come before React has
  // drawn the drag's start (a quick drag), and would then be refused.
  const dragNow = useRef<DragState | null>(null)
  const setDrag = (d: DragState | null): void => {
    dragNow.current = d
    showDrag(d)
  }
  const cards = useMemo(
    () => all.filter((c) => c.archived === archived && (project === null || c.project.toLowerCase() === project.toLowerCase()) && cardMatches(c, query)),
    [all, project, query, archived]
  )
  const boardRef = useRef<HTMLDivElement>(null)

  /**
   * Where the dragged card would land with the pointer at (x, y), from what is under it now: over a card, before it
   * (its top half) or the next one; below a column's last card (or in an empty column), at the end; in a gap between
   * cards, where it was. Called on every dragover, and after each step of scrolling (the board's or the browser's), so the marker follows what
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
    // A collapsed column's strip: at its top, the true top of the board's cards there (#263), not the top of those the
    // search shows: a card the search hides would otherwise stay above it.
    if (colEl.classList.contains('collapsed')) before = all.find((c) => !c.archived && c.column === column && c.number !== d.n && (project === null || c.project.toLowerCase() === project.toLowerCase()))?.number ?? null
    else if (tile) {
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
    // Scrolled by something else (Chromium's own drag autoscroll near an edge, the wheel): what is under the pointer
    // changed too. Otherwise, when Chromium takes a column the last step to its top, no frame below moves it and the
    // marker stays a card off (#256).
    const scrolled = (): void => {
      const p = pointer.current
      if (p) placeNow.current(p.x, p.y)
    }
    document.addEventListener('dragover', over, true)
    document.addEventListener('drop', stop, true)
    document.addEventListener('dragleave', leave, true)
    document.addEventListener('scroll', scrolled, true)
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
      document.removeEventListener('scroll', scrolled, true)
      pointer.current = null
    }
  }, [dragging])

  if (archived) return <ArchivedTable cards={cards} project={project} query={query} />

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

  const folded = new Set(fold.cards ?? [])
  const columnMenu = (col: (typeof TASK_COLUMNS)[number], list: TaskCard[]): MenuEntry[] => [
    { label: 'Collapse All Cards', icon: 'collapse-all', disabled: !list.some((c) => !folded.has(c.number)), onClick: () => foldCards(list.map((c) => c.number), true) },
    { label: 'Expand All Cards', icon: 'expand-all', disabled: !list.some((c) => folded.has(c.number)), onClick: () => foldCards(list.map((c) => c.number), false) },
    { separator: true },
    { label: `Collapse ${col.label}`, icon: 'chevron-left', onClick: () => collapseColumn(col.id, true) },
    { separator: true },
    archiveAllItem(all, { column: col.id, project, scope, query })
  ]

  return (
    <div ref={boardRef} className={cx('board', colored && 'colored')} onDragEnd={() => setDrag(null)}>
      {TASK_COLUMNS.map((col) => {
        const list = cards.filter((c) => c.column === col.id)
        const columnProps = {
          'data-column': col.id,
          style: colored ? ({ '--col': columnColor(colors, col.id) } as React.CSSProperties) : undefined,
          onDragOver: (e: React.DragEvent) => {
            if (!dragNow.current) return
            e.preventDefault()
            place(e.clientX, e.clientY)
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            void drop(col.id)
          }
        }
        // Collapsed: a narrow strip with its name and count; a card dropped on it goes to its top.
        if (fold.columns?.includes(col.id)) {
          return (
            <div key={col.id} className={cx('board-column', 'collapsed', drag?.column === col.id && 'drag-over')} {...columnProps}>
              <Tooltip content={`Expand ${col.label}: ${col.description}`}>
                <button className="board-column-strip" aria-label={`Expand ${col.label}`} aria-expanded={false} onClick={() => collapseColumn(col.id, false)} onContextMenu={(e) => headerMenu.open(e, columnMenu(col, list).slice(0, 2))}>
                  <Chevrons dir="right" />
                  <span className="count">{list.length}</span>
                  <span className="board-column-label">{col.label}</span>
                </button>
              </Tooltip>
            </div>
          )
        }
        return (
          <div key={col.id} className={cx('board-column', drag?.column === col.id && 'drag-over')} {...columnProps}>
            <div className="board-column-header" onContextMenu={(e) => headerMenu.open(e, columnMenu(col, list))}>
              <Tooltip content={`Collapse ${col.label}`}>
                <button className="icon-btn board-fold" aria-label={`Collapse ${col.label}`} aria-expanded onClick={() => collapseColumn(col.id, true)}>
                  <Chevrons dir="left" />
                </button>
              </Tooltip>
              <Tooltip content={col.description}>
                <span className="board-column-label">{col.label}</span>
              </Tooltip>
              <span className="count">{list.length}</span>
              <span className="grow" />
              {col.id === 'todo' && <IconButton icon="add" title="New card" onClick={() => set({ taskOpen: { project: project ?? '' } })} />}
              <IconButton
                icon="ellipsis"
                title={`${col.label}: more`}
                onClick={(e) => {
                  const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  headerMenu.openAt(b.left, b.bottom, columnMenu(col, list))
                }}
              />
            </div>
            <div className="board-column-body">
              {list.map((c) => (
                <CardTile
                  key={c.number}
                  c={c}
                  projects={projects}
                  showProject={project === null}
                  folded={folded.has(c.number)}
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
      {headerMenu.element}
    </div>
  )
}

/** An archived card's agent, as it was named when it last had one. */
const lastAgent = (c: TaskCard): string => (c.agent ? (c.agentName ?? c.agent) : '')

const ARCHIVED_COLUMNS: DataColumn<TaskCard>[] = [
  { key: 'number', header: '#', num: true, descFirst: true, cell: (c) => <span className="task-number">#{c.number}</span>, sortValue: (c) => c.number, filter: { kind: 'text', value: (c) => `#${c.number}` } },
  { key: 'title', header: 'Title', cell: (c) => <span className="archive-title">{c.title}</span>, sortValue: (c) => c.title, filter: { kind: 'text', value: (c) => c.title } },
  { key: 'project', header: 'Project', cell: (c) => (c.project ? <span className="task-project">{c.project}</span> : <span className="faint">workspace</span>), sortValue: (c) => c.project || null, filter: { kind: 'choice', value: (c) => c.project || 'workspace' } },
  {
    key: 'labels',
    header: 'Labels',
    cell: (c) => (
      <span className="archive-labels">
        {c.labels.map((l) => (
          <span key={l} className="task-label">
            {l}
          </span>
        ))}
      </span>
    ),
    sortValue: (c) => c.labels.join(', ') || null,
    filter: { kind: 'choice', value: (c) => c.labels.join(', '), values: (c) => c.labels }
  },
  { key: 'agent', header: 'Agent', cell: (c) => lastAgent(c) || <span className="faint">–</span>, sortValue: (c) => lastAgent(c) || null, filter: { kind: 'text', value: lastAgent } },
  { key: 'column', header: 'From', cell: (c) => columnLabel(c.column), sortValue: (c) => TASK_COLUMNS.findIndex((x) => x.id === c.column), filter: { kind: 'choice', value: (c) => c.column }, choiceLabel: (v) => columnLabel(v as TaskColumn) },
  { key: 'archived', header: 'Archived', descFirst: true, cell: (c) => formatDateTime(archivedAt(c)), sortValue: (c) => archivedAt(c) },
  { key: 'created', header: 'Created', descFirst: true, cell: (c) => formatDateTime(c.createdAt), sortValue: (c) => c.createdAt },
  {
    key: 'actions',
    header: '',
    cell: (c) => (
      <Tooltip content={`Bring #${c.number} back to the end of ${columnLabel(c.column)}`}>
        <button
          className="btn small subtle"
          onClick={(e) => {
            e.stopPropagation()
            void archive(c, false)
          }}
        >
          Unarchive
        </button>
      </Tooltip>
    )
  }
]
/** In one project's view, its cards only: no project column. */
const ARCHIVED_COLUMNS_ONE_PROJECT = ARCHIVED_COLUMNS.filter((c) => c.key !== 'project')

/**
 * The archived cards (#249): a table that sorts, filters and pages (DataTable), newest archived first. A row opens its
 * card; Unarchive brings one back, or every selected one, to the end of the column it was archived from. The board's
 * search narrows the rows too. Batch picks one bulk archive (#351): its cards, and "Unarchive this batch", which brings
 * them all back where they were.
 */
function ArchivedTable({ cards: archivedCards, project, query }: { cards: TaskCard[]; project: string | null; query: string }) {
  useDateStyle()
  const all = useStore((s) => s.tasks)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bringing, setBringing] = useState(false)
  const [batches, setBatches] = useState<ArchiveBatch[]>([])
  const [batch, setBatch] = useState('')
  useEffect(() => {
    let current = true
    void call('tasks:archiveBatches')
      .then((b) => current && setBatches(b))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [all])
  // The batches that still have archived cards, newest first, each with how many.
  const kept = useMemo(
    () =>
      batches
        .map((b) => ({ b, n: all.filter((c) => c.archived && c.archivedBatch === b.id).length }))
        .filter((x) => x.n > 0)
        .reverse(),
    [batches, all]
  )
  const chosen = kept.find((x) => x.b.id === batch) ?? null
  const cards = useMemo(() => (chosen ? archivedCards.filter((c) => c.archivedBatch === chosen.b.id) : archivedCards), [archivedCards, chosen])
  const bringBatch = async (id: string): Promise<void> => {
    setBringing(true)
    try {
      // Cards that couldn't come back stay with the batch, still shown here to try again.
      if (await unarchiveBatch(id)) setBatch('')
    } finally {
      setBringing(false)
    }
  }
  // Only cards still archived (and shown) stay selected.
  const shown = useMemo(() => new Set(cards.map((c) => String(c.number))), [cards])
  const picked = [...selected].filter((k) => shown.has(k))
  const columns = project === null ? ARCHIVED_COLUMNS : ARCHIVED_COLUMNS_ONE_PROJECT
  const unarchiveSelected = async (): Promise<void> => {
    setBringing(true)
    try {
      for (const k of picked) {
        const c = cards.find((x) => String(x.number) === k)
        if (c) await archive(c, false)
      }
      setSelected(new Set())
    } finally {
      setBringing(false)
    }
  }
  if (!archivedCards.length) return <div className="empty-state">No archived cards{query ? ' match' : ''}.</div>
  return (
    <div className="task-archive">
      <div className="task-archive-actions">
        <span className="faint">
          {cards.length} archived card{cards.length === 1 ? '' : 's'}
          {picked.length ? ` · ${picked.length} selected` : ''}
        </span>
        <button className="btn small" disabled={!picked.length || bringing} onClick={() => void unarchiveSelected()}>
          <Icon name="discard" /> Unarchive Selected{picked.length ? ` (${picked.length})` : ''}
        </button>
        {kept.length > 0 && (
          <label className="archive-batch faint">
            Batch
            <select className="select" aria-label="Batch" value={chosen ? chosen.b.id : ''} onChange={(e) => setBatch(e.target.value)}>
              <option value="">All archived cards</option>
              {kept.map(({ b, n }) => (
                <option key={b.id} value={b.id}>
                  {formatDateTime(b.at)} · {b.label} · {cardsWord(n)}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && (
          <Tooltip content={`Bring the ${cardsWord(chosen.n)} archived in this batch back to their columns, where they were`}>
            <button className="btn small" disabled={bringing} onClick={() => void bringBatch(chosen.b.id)}>
              <Icon name="discard" /> Unarchive this batch ({chosen.n})
            </button>
          </Tooltip>
        )}
      </div>
      <DataTable
        id="archived-cards"
        className="archived-cards"
        rows={cards}
        columns={columns}
        rowKey={(c) => String(c.number)}
        defaultSort={{ key: 'archived', desc: true }}
        defaultPageSize={20}
        empty="No archived cards."
        onRowClick={(c) => set({ taskOpen: c.number })}
        rowLabel={(c) => `Open #${c.number} ${c.title}`}
        selection={{ selected, onChange: setSelected, label: (c) => `Select #${c.number}` }}
      />
    </div>
  )
}

/** The board's toolbar: search, archived, New Card, and its ⋯ menu (Archive All Cards…). */
export function BoardToolbar({
  project,
  scope = null,
  query,
  setQuery,
  archived,
  setArchived
}: {
  project: string | null
  scope?: string | null
  query: string
  setQuery: (q: string) => void
  archived: boolean
  setArchived: (v: boolean) => void
}) {
  const count = useStore((s) => (s.tasks ?? NO_TASKS).filter((c) => c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase())).length)
  const menu = useContextMenu()
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
      {!archived && (
        <IconButton
          icon="ellipsis"
          title="Board: more"
          className="board-more"
          onClick={(e) => {
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
            menu.openAt(b.left, b.bottom, [archiveAllItem(get().tasks, { column: null, project, scope, query })])
          }}
        />
      )}
      {menu.element}
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
    { label: 'On Hold', n: o.hold },
    { label: 'Todo', n: o.todo },
    { label: 'Doing', n: o.doing },
    { label: 'Waiting for review', n: o.review, tone: 'accent' },
    { label: 'Passed', n: o.passed },
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

const cardsWord = (n: number): string => `${n} card${n === 1 ? '' : 's'}`

/**
 * Archive All in a column, or Archive All Cards (#351): what it takes (the cards the board shows, every one when nothing
 * hides any), cards agents are on passed over unless the box is ticked, and per column for the whole board. Archived as
 * one batch; the toast's Undo (and "Unarchive this batch" in Archived) brings it back where it was.
 */
export function ArchiveAllDialog() {
  const req = useStore((s) => s.boardArchiveAll)
  const all = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const assistant = useStore((s) => s.workspace?.assistant ?? null)
  const [include, setInclude] = useState(false)
  const action = useBusy()
  const { setError } = action
  useEffect(() => {
    setInclude(false)
    setError(null)
  }, [req, setError])
  if (!req) return null
  const close = (): void => set({ boardArchiveAll: null })
  const { shown, total } = archiveScope(all, req)
  const held = shown.flatMap((c) => {
    const why = cardBusy(c, projects, assistant)
    return why ? [{ c, why }] : []
  })
  const going = include ? shown : shown.filter((c) => !held.some((h) => h.c === c))
  const filtered = shown.length < total
  const where = req.column === null ? null : columnLabel(req.column)
  const title = where ? (filtered ? `Archive the ${shown.length} Shown in ${where}?` : `Archive All in ${where}?`) : filtered ? `Archive the ${shown.length} Shown Cards?` : 'Archive All Cards?'
  const message = !going.length
    ? `Every card here is one an agent is on. Tick the box below to archive ${shown.length === 1 ? 'it' : 'them'} anyway.`
    : `Archive ${filtered ? `the ${cardsWord(going.length)} shown` : cardsWord(going.length)}${where ? ` in ${where}` : ''}${filtered ? ` (of ${total})` : ''}? You can unarchive them from Archived.`
  const perColumn = TASK_COLUMNS.flatMap((col) => {
    const n = going.filter((c) => c.column === col.id).length
    return n ? [`${col.label} ${n}`] : []
  })
  const label = where ? (filtered ? `${going.length} shown in ${where}` : `All in ${where}`) : filtered ? `${going.length} shown cards` : 'All Cards'
  // Main checks each card again as it archives it (still in the column, project and search shown, and nobody on it
  // unless the box is ticked), so a card an agent took while this was open stays.
  const run = async (): Promise<void> => {
    const r = await call(
      'tasks:archiveBatch',
      going.map((c) => c.number),
      { label, column: req.column, project: req.project, query: req.query, includeBusy: include }
    )
    await loadTasks()
    close()
    reportArchived(r)
  }
  return (
    <Modal
      title={title}
      icon={where ? 'question' : 'warning'}
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <BusyButton className={where ? 'primary' : 'danger'} autoFocus disabled={!going.length} busy={action.busy === 'archive'} busyLabel="Archiving…" onClick={() => void action.run('archive', run)}>
            {action.error ? 'Try Again' : `Archive ${cardsWord(going.length)}`}
          </BusyButton>
        </>
      }
    >
      <div className="archive-all">
        <div>{message}</div>
        {filtered && <div className="faint">Cards the search or filter hides stay on the board.</div>}
        {!where && perColumn.length > 0 && <div className="archive-all-counts">{perColumn.join(' · ')}</div>}
        {held.length > 0 && (
          <>
            <div className="archive-all-held">
              {include ? 'Archived too' : 'Skipped'}: {held.length === 1 ? 'a card an agent is on' : `${held.length} cards agents are on`}
            </div>
            <DialogList items={held.map((h) => `#${h.c.number} ${h.c.title} · ${h.why}${include ? '' : ' · skipped'}`)} />
            <label className="flex dialog-check">
              <input type="checkbox" checked={include} disabled={!!action.busy} onChange={(e) => setInclude(e.target.checked)} /> Also archive cards agents are working on
            </label>
            {include && <div className="archive-all-warning">Their agents lose their card: an archived card can't be changed or moved by them, and a watch on it ends, telling the agent it was archived.</div>}
          </>
        )}
      </div>
    </Modal>
  )
}

/** A decision being changed in the card dialog: its new words, and its words when the change began. */
interface DecisionEdit {
  id: string
  text: string
  was: string
}

/**
 * A card's decisions (#357), pinned above its comments: what the user decided, newest last, each saying who recorded it
 * (the user decides; an agent or the Assistant may write it down) and "new since start" when it came after work on the
 * card began. The user adds, changes and removes them; agents and the Assistant can only add one (hive_update_task).
 */
function Decisions({
  card,
  draft,
  setDraft,
  editing,
  setEditing,
  setBusy
}: {
  card: TaskCard
  draft: string
  setDraft: (v: string) => void
  editing: DecisionEdit | null
  setEditing: (v: DecisionEdit | null) => void
  setBusy: (busy: boolean) => void
}) {
  const action = useBusy()
  // The card dialog waits for a decision being saved before it closes.
  useEffect(() => setBusy(!!action.busy), [action.busy, setBusy])
  const list = card.decisions ?? []
  const add = (): void =>
    void action.run('add', async () => {
      await call('tasks:update', card.number, { decision: draft })
      await loadTasks()
      setDraft('')
    })
  const save = (): void => {
    if (!editing) return
    void action.run('edit', async () => {
      await call('tasks:editDecision', card.number, editing.id, editing.text)
      await loadTasks()
      setEditing(null)
    })
  }
  const removeDecision = (d: TaskDecision): void =>
    void confirm({
      title: 'Remove this decision?',
      message: `"${d.text.length > 200 ? `${d.text.slice(0, 199)}…` : d.text}" leaves #${card.number}. Its history keeps what it said.`,
      confirmLabel: 'Remove',
      busyLabel: 'Removing…',
      danger: true,
      run: async () => {
        await call('tasks:editDecision', card.number, d.id, null)
        await loadTasks()
      }
    })
  return (
    <div className="task-decisions">
      <div className="task-section-h">
        Decisions ({list.length})
        <InfoTip text="What you decided about this card: scope, wording, a default. Agents read them when they start and again before Review, and follow them where the description says otherwise; reviewers check the work against them. An agent or the Assistant can write down a decision you made; only you change or remove one." />
      </div>
      {list.map((d) => (
        <div key={d.id} className={cx('task-decision', newSinceStart(card, d) && 'new')}>
          {editing?.id === d.id ? (
            <div className="task-decision-edit">
              <textarea className="input" aria-label="Decision" value={editing.text} autoFocus onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()} />
              <div className="flex">
                <button className="btn small subtle" disabled={!!action.busy} onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <BusyButton className="small" busy={action.busy === 'edit'} busyLabel="Saving…" disabled={!editing.text.trim() || editing.text.trim() === d.text} onClick={save}>
                  Save
                </BusyButton>
              </div>
            </div>
          ) : (
            <>
              <div className="task-decision-text">{d.text}</div>
              <div className="task-decision-by faint">
                Decided by you{d.recordedBy && d.recordedBy !== 'You' ? ` · recorded by ${d.recordedBy}` : ''} · <Tooltip content={formatDateTime(d.at)}><span>{timeAgo(d.at)}</span></Tooltip>
                {d.editedAt ? ' · edited' : ''}
                {newSinceStart(card, d) && <span className="badge accent">new since start</span>}
                <span className="grow" />
                {!card.archived && (
                  <>
                    <IconButton icon="edit" title="Change this decision" onClick={() => setEditing({ id: d.id, text: d.text, was: d.text })} />
                    <IconButton icon="trash" title="Remove this decision" onClick={() => removeDecision(d)} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ))}
      {!card.archived && (
        <div className="task-decision-new">
          <textarea className="input" aria-label="New decision" placeholder="Record a decision you made about this card (agents follow it over the description)" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim() && add()} />
          {/* Easy to see once there is something to add (#432), and the dialog's Save adds it too. */}
          <div className="task-new-actions">
            {draft.trim() && <span className="faint">Save adds it too</span>}
            <BusyButton className={cx('small', draft.trim() && 'primary')} busy={action.busy === 'add'} busyLabel="Adding…" disabled={!draft.trim()} onClick={add}>
              <Icon name="law" /> Add Decision
            </BusyButton>
          </div>
        </div>
      )}
      {action.error && <div className="field-error">{action.error}</div>}
    </div>
  )
}

/** The Board view (activity bar): every project's cards, or the one chosen in the sidebar. */
export function BoardView() {
  const project = useStore((s) => s.boardProject)
  const query = useStore((s) => s.boardQuery)
  const archived = useStore((s) => s.boardArchived)
  const workspace = useStore((s) => s.workspace)
  useEffect(() => {
    void loadTasks()
    loadBoardFold()
  }, [workspace?.path])
  if (!workspace) return <div className="empty-state">Open a workspace to see its task board.</div>
  return (
    <div className="board-view">
      <div className="board-header">
        <h1>
          Task Board{project !== null && <span className="faint"> · {project || 'workspace cards'}</span>}
        </h1>
        <span className="faint">Plan work as cards, start them on agents, and see where each one is. Agents put finished work in Review, and reviewers move what passes to Passed.</span>
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
  useEffect(() => {
    void loadTasks()
    loadBoardFold()
  }, [project.path])
  return (
    <div className="board-view in-tab">
      <BoardToolbar project={project.name} scope={project.name} query={query} setQuery={setQuery} archived={archived} setArchived={setArchived} />
      <Board project={project.name} scope={project.name} query={query} archived={archived} />
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
              <InfoTip text="Cards in Doing that nobody is working on: no agent has them, or their agent was removed or isn't running. Also cards in Doing or Review that an agent in a card loop left without waiting on them." />
            </div>
            {stalled.map((c) => (
              <Tooltip key={c.number} block content={cardStalled(projects, c) ?? ''}>
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
  useDateStyle()
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
  // A decision being written, one being changed (with its words before) and whether one is being saved (#357): the
  // dialog keeps them, so closing asks before they are lost and waits for a save.
  const [decision, setDecision] = useState('')
  const [decisionEdit, setDecisionEdit] = useState<DecisionEdit | null>(null)
  const [decisionBusy, setDecisionBusy] = useState(false)
  // The drafts as they are now, for a save run again later: Move to Doing's Try Again calls the same prepare, made when
  // Save was clicked. Each is cleared here as soon as it is written, so a retry writes only what is still unsaved (#432).
  const drafts = useRef<{ decision: string; comment: string; edit: DecisionEdit | null }>({ decision: '', comment: '', edit: null })
  drafts.current = { decision, comment, edit: decisionEdit }
  const action = useBusy()
  const [showHistory, setShowHistory] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // The fields as the dialog opened: Save sends only what the user changed since, so a change an agent made
  // meanwhile (moving the card to Review, say) isn't put back.
  const orig = useRef<Record<string, string>>({})

  // Filled from the card when it opens (later changes by agents show in its comments and history), before anything is
  // drawn or answered: a render with the last card's fields (or none) would show them, and take them for edits (#288).
  const { setError: setActionError } = action
  useLayoutEffect(() => {
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
    setDecision('')
    setDecisionEdit(null)
    setShowHistory(false)
    // A new card's title takes the keyboard, unless it is already in the dialog: in a busy window the timer can fire
    // after the user has moved on to another field, and what they type next would land in the title (#229).
    setTimeout(() => {
      const t = titleRef.current
      if (!c && t && !t.closest('.dialog')?.contains(document.activeElement)) t.focus()
    }, 30)
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
  const decisionChanged = !!decisionEdit && decisionEdit.text.trim() !== decisionEdit.was
  const unsaved = edited.length > 0 || !!comment.trim() || !!decision.trim() || decisionChanged

  /** Closing (Escape, ×, outside, Cancel): asks first when something would be lost. */
  const tryClose = async (): Promise<void> => {
    if (action.busy || decisionBusy) return
    if (unsaved) {
      const what = [
        edited.length ? (isNew ? 'this new card' : 'your changes to the card') : '',
        comment.trim() ? 'the comment you are writing' : '',
        decision.trim() ? 'the decision you are writing' : '',
        decisionChanged ? 'your change to a decision' : ''
      ]
        .filter(Boolean)
        .join(' and ')
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

  /** A decision being changed to nothing: Save refuses it (removing one is its bin's, never Save's). */
  const BLANK_DECISION = "A decision can't be empty: write it again, cancel the change, or remove the decision with its bin."
  const blankEdit = (): boolean => {
    const e = drafts.current.edit
    return !!e && !e.text.trim() && e.was !== ''
  }

  /**
   * The decision being written, and a change to one, recorded (#432: Save leaves nothing typed in the dialog behind, as
   * for a comment). Read from `drafts` and cleared there once recorded, so a retry (a failure after it, Try Again in Move
   * to Doing) doesn't record it twice.
   */
  const saveDecisions = async (): Promise<void> => {
    if (!card) return
    if (blankEdit()) throw new Error(BLANK_DECISION)
    let changed = false
    const e = drafts.current.edit
    if (e && e.text.trim() !== e.was) {
      await call('tasks:editDecision', card.number, e.id, e.text)
      drafts.current.edit = null
      setDecisionEdit(null)
      changed = true
    }
    const d = drafts.current.decision
    if (d.trim()) {
      await call('tasks:update', card.number, { decision: d })
      drafts.current.decision = ''
      setDecision('')
      changed = true
    }
    if (changed) await loadTasks()
  }

  /** The comment being written, posted (Save leaves nothing in the dialog behind); from `drafts`, as above. */
  const postComment = async (): Promise<void> => {
    const c = drafts.current.comment
    if (!card || !c.trim()) return
    await call('tasks:comment', card.number, c)
    drafts.current.comment = ''
    setComment('')
    await loadTasks()
  }

  /** Save: the card's fields, and a decision and a comment being written (so nothing in the dialog is left behind). */
  const save = async (): Promise<void> => {
    // Into Doing from another column: the Move to Doing dialog asks who works on it, and saves the rest when it is
    // confirmed (Cancel there leaves this dialog open, nothing saved).
    if (card && column === 'doing' && orig.current.column !== 'doing') {
      if (!title.trim()) return action.setError('A card needs a title.')
      if (blankEdit()) return action.setError(BLANK_DECISION)
      return moveToDoing({
        n: card.number,
        project,
        agent: agent || null,
        prepare: async () => {
          await persist(true)
          await saveDecisions()
          await postComment()
        },
        done: close
      })
    }
    const r = await action.run('save', async () => {
      // Checked before anything is saved: a refused Save changes nothing.
      if (blankEdit()) throw new Error(BLANK_DECISION)
      await persist()
      await saveDecisions()
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
      onClose={() => void tryClose()}
      busy={!!action.busy || decisionBusy}
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
        {/* One line of text, wrapped to show all of a long reason (#372): Enter adds no line break. */}
        <textarea
          className="input task-blocked-input"
          rows={1}
          aria-label="Blocked"
          placeholder="Why it can't go on (empty: not blocked)"
          value={blocked}
          onChange={(e) => setBlocked(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault()
          }}
        />
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
          <Decisions card={card} draft={decision} setDraft={setDecision} editing={decisionEdit} setEditing={setDecisionEdit} setBusy={setDecisionBusy} />
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
              <textarea className="input" aria-label="New comment" placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void addComment()} />
              <div className="task-new-actions">
                {comment.trim() && <span className="faint">Save posts it too</span>}
                <BusyButton className={cx('small', comment.trim() && 'primary')} busy={action.busy === 'comment'} busyLabel="Posting…" disabled={!comment.trim()} onClick={() => void addComment()}>
                  <Icon name="comment" /> Comment
                </BusyButton>
              </div>
            </div>
          )}
          <div className="task-section-h clickable" onClick={() => setShowHistory(!showHistory)}>
            <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} /> History ({card.history.length})
          </div>
          {showHistory && (
            <div className="task-history">
              {[...card.history].reverse().map((h, i) => (
                <div key={i}>
                  <span className="faint">{formatDateTime(h.at)}</span> <strong>{h.by}</strong> {h.what}
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
  // Git that can't run makes no worktree, whatever the project folder holds (#346).
  const gitProblem = useStore((s) => gitProblemText(s.gitTool))
  const worktreeWhy = !project ? null : gitProblem ? `${gitProblem}.` : project.isGitRepo ? null : 'The project is not a git repository.'
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
  const ready = !!project && !!choice && (choice.kind === 'agent' ? !!chosen && usable(chosen) : choice.kind === 'new' || !worktreeWhy)
  const target = (): TaskStartTarget =>
    choice?.kind === 'agent' ? { kind: 'agent', agentId: choice.id } : { kind: 'new-agent', worktree: choice?.kind === 'worktree', name: name.trim() || undefined, provider: provider || undefined }
  return { settings, choice, setChoice, name, setName, provider, setProvider, reset, ready, target, worktreeWhy }
}

type StartPick = ReturnType<typeof useStartPick>

function StartChoices({ project, pick }: { project: ProjectInfo; pick: StartPick }) {
  const { settings, choice, setChoice, name, setName, provider, setProvider, worktreeWhy } = pick
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
        <label className={cx('choice', choice?.kind === 'worktree' && 'selected', !!worktreeWhy && 'disabled')}>
          <input type="radio" disabled={!!worktreeWhy} checked={choice?.kind === 'worktree'} onChange={() => setChoice({ kind: 'worktree' })} />
          <div>
            <strong>
              <Icon name="git-branch" /> A new agent in its own worktree
            </strong>
            <div className="faint">{worktreeWhy ?? 'Its own branch and folder; merge its work back when the card is done.'}</div>
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
