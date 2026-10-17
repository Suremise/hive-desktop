import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AgentState } from '@shared/agentState'
import { agentDoingCards, agentReviewCards } from '@shared/tasks'
import { cardsText } from '@shared/agentTable'
import { compactThreshold, pageEndIndex, transcriptWarnLimit } from '@shared/defaults'
import { fractionDone, runStatusLine } from '@shared/progress'
import { providerName } from '@shared/providers'
import { isUrgent, TILES_PER_PAGE, tilePageCount, tilePageOf, tilesOnPage, urgentByPage } from '@shared/tiles'
import { fmt, msg, tr } from '@shared/i18n'
import type { AgentInfo, ProjectInfo, ProgressRun } from '@shared/types'
import { formatSize } from '@shared/units'
import { agentProviderOf, closeTile, openTile, projectKey, showTilePage, tileAgents, tileFocusOf, tilePage, useLanguage, useStore } from '../store'
import * as actions from '../actions'
import { commandKeybinding, keyIsBound } from '../commands'
import { deferredFocus } from '../deferredFocus'
import { useLiveUsage, useNow } from '../usage'
import { cx, formatKeybinding, formatTokens } from '../util'
import { AddAgentButton, agentDragProps, dropAgent, FAILED_TO_START, moveItems, PAGE_HOVER_MS, SWAP_WITH, swapDrop, useAgentDrag } from './AgentPanes'
import { StateMark } from './StateMark'
import { Icon, statusText, Tooltip, useContextMenu } from './ui'

/**
 * The Session tab's Tiles view (#976; #975's toggle switches to it): a tile per agent, 12 to a page, in the order Settings
 * → Sessions → Tile order chooses, so a whole team fits on one screen. A tile shows what Hive already has (the state, the
 * status, the card, a progress run, the start of the latest reply, badges for background tasks and warnings): no CLI is
 * asked anything, and no terminal is drawn for it. Clicking one (or Enter) opens its focus view: the agent's live pane
 * large, the other agents in a strip beside it; Esc (outside the terminal), Back to Tiles or the Tiles toggle go back.
 * ProjectView places the pane (the agents' area beside the strip); the toolbar above shows the pages (TilePager).
 * In the panes' order, a tile is dragged like a pane header (#993): onto another tile the two swap, onto a page button it
 * goes to that page's end; its menu and Move Agent Left/Right move it from the keyboard. By urgency, the order is Hive's.
 */
export function AgentTiles({ project }: { project: ProjectInfo }) {
  useLanguage()
  const focus = useStore((s) => tileFocusOf(project, s))
  return focus ? <TileStrip project={project} focus={focus} /> : <TileGrid project={project} />
}

/** The project's agents in tile order with their states, kept up to date. */
function useTiles(project: ProjectInfo): ReturnType<typeof tileAgents> {
  const tasks = useStore((s) => s.tasks)
  const startFailures = useStore((s) => s.startFailures)
  const settings = useStore((s) => s.settings)
  return useMemo(() => tileAgents(project, { tasks, startFailures, settings }), [project, tasks, startFailures, settings])
}

/** Whether the user orders the tiles (Tile order "Same as panes", #993): By urgency, the order is computed. */
function useMovable(project: ProjectInfo): boolean {
  const order = useStore((s) => s.settings?.sessions.tileOrder ?? 'panes')
  return order === 'panes' && project.agents.length > 1
}

/**
 * A tile moved from the keyboard (#993): it takes the keyboard back whenever it is drawn again (it may have left its page,
 * and the workspace's own refreshes can redraw it), until the user presses something else.
 */
let refocusTile: { id: string; may: () => boolean } | null = null

/** Moves a tile one place (its menu, Move Agent Left/Right): the grid shows the page it lands on, the keyboard staying on it. */
function moveTile(project: ProjectInfo, id: string, delta: -1 | 1): void {
  const to = project.agents.findIndex((a) => a.id === id) + delta
  if (to < 0 || to >= project.agents.length) return
  refocusTile = { id, may: deferredFocus(() => document.querySelector(tileSelector(id))) }
  actions.nudgeAgent(delta, project.path, id)
  showTilePage(project, tilePageOf(to))
}

const tileSelector = (id: string): string => `.agent-tile[data-agent="${CSS.escape(id)}"]`

/**
 * Back on the grid, the keyboard goes to this agent's tile once it is drawn (for up to a second), unless the user chose
 * another place meanwhile. Timers, not animation frames: those wait while the window is behind others.
 */
export function focusTileAfter(id: string | null): void {
  if (!id) return
  const find = (): HTMLElement | null => document.querySelector<HTMLElement>(tileSelector(id))
  const may = deferredFocus(find)
  let tries = 0
  const go = (): void => {
    const el = find()
    if (el) {
      if (may()) el.focus()
    } else if (tries++ < 40) setTimeout(go, 25)
  }
  setTimeout(go, 0)
}

/** Back to the grid from the focus view, the keyboard on its agent's tile. */
const back = (project: ProjectInfo): void => focusTileAfter(closeTile(project))

const NOT_RUNNING = msg({ id: 'panes.tiles.notRunning', defaultMessage: 'Not running', description: "An agent's status on its tile (the Tiles view) and in the focus view's strip: its session isn't running." })

/** An agent's status in words: its session's, why its launch failed, or that it isn't running. */
function useStatus(project: ProjectInfo, a: AgentInfo): string {
  const failure = useStore((s) => (a.live ? undefined : s.startFailures[projectKey(project.path, a.id)]))
  if (a.live) return statusText(a.live)
  if (failure) return tr(FAILED_TO_START, { why: failure.reason.split('\n')[0] })
  return tr(NOT_RUNNING)
}

/** Its progress run still going (the newest), if it has one. */
function agentRun(runs: readonly ProgressRun[], project: ProjectInfo, a: AgentInfo): ProgressRun | undefined {
  const path = project.path.toLowerCase()
  return runs.find((r) => r.agentId === a.id && r.projectPath?.toLowerCase() === path && (r.state === 'running' || r.state === 'stale'))
}

/** The grid of tiles: the page shown, arrows moving between tiles (one tab stop), Enter opening one. */
function TileGrid({ project }: { project: ProjectInfo }) {
  const tiles = useTiles(project)
  const page = useStore((s) => tilePage(project, s))
  const shown = tilesOnPage(tiles, page)
  const pages = tilePageCount(tiles.length)
  const grid = useRef<HTMLDivElement>(null)
  const movable = useMovable(project)
  const menu = useContextMenu()
  // Move Agent Left/Right (whatever its keys) with the keyboard on a tile moves that tile (#993).
  useEffect(() => {
    if (!movable) return
    return actions.onTileNudge((delta) => {
      const el = document.activeElement
      const id = grid.current?.contains(el) ? (el as HTMLElement).closest<HTMLElement>('.agent-tile')?.dataset.agent : undefined
      if (!id) return false
      moveTile(project, id, delta)
      return true
    })
  }, [movable, project])
  // The tile that holds the grid's one tab stop: the last one the keyboard was on, while it is on this page.
  const [current, setCurrent] = useState<string | null>(null)
  const stop = shown.some((t) => t.a.id === current) ? current : (shown[0]?.a.id ?? null)
  if (!project.agents.length)
    return (
      <div className="agent-tiles empty-state">
        <Icon name="layout" />
        {tr(msg({ id: 'panes.tiles.empty', defaultMessage: 'No agents yet. Each agent you add gets a tile here.', description: 'The Tiles view of a project with no agents.' }))}
        <div>
          <AddAgentButton project={project} />
        </div>
      </div>
    )
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const els = [...(grid.current?.querySelectorAll<HTMLElement>('.agent-tile') ?? [])]
    const at = els.indexOf(document.activeElement as HTMLElement)
    // A key the window's shortcuts take is theirs (the user may bind an arrow, or end a chord with one), which it runs.
    if (at < 0 || keyIsBound(e.nativeEvent)) return
    // As many columns as tiles in the first row.
    const cols = Math.max(1, els.filter((el) => el.offsetTop === els[0].offsetTop).length)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: els.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    els[Math.max(0, Math.min(els.length - 1, to))]?.focus()
  }
  return (
    <div className="agent-tiles">
      <div
        ref={grid}
        className="tile-grid"
        role="group"
        aria-label={tr(msg({ id: 'panes.tiles.label', defaultMessage: "{pages, plural, one {The project's agents} other {The project's agents, page {page, number} of {pages, number}}}", description: 'Accessible name of the Tiles view\'s grid of tiles: the page shown ({page}) of how many ({pages}).' }), { page: page + 1, pages })}
        onKeyDown={onKeyDown}
      >
        {shown.map(({ a, state }) => (
          <Tile
            key={a.id}
            project={project}
            a={a}
            state={state}
            tabStop={a.id === stop}
            movable={movable}
            onFocus={() => setCurrent(a.id)}
            onMenu={(x, y, keyboard) => menu.openAt(x, y, moveItems(project, a, (delta) => moveTile(project, a.id, delta)).filter((m) => !('separator' in m)), keyboard)}
          />
        ))}
      </div>
      {menu.element}
    </div>
  )
}

/**
 * One agent's tile: a button that opens its focus view. `movable`: another agent dragged onto it swaps with it, and its
 * menu (`onMenu`) moves it (#993).
 */
function Tile({ project, a, state, tabStop, movable, onFocus, onMenu }: { project: ProjectInfo; a: AgentInfo; state: AgentState; tabStop: boolean; movable: boolean; onFocus: () => void; onMenu: (x: number, y: number, keyboard: boolean) => void }) {
  const tasks = useStore((s) => s.tasks)
  const runs = useStore((s) => s.progressRuns)
  const settings = useStore((s) => s.settings)
  const flash = useStore((s) => s.paneFlash)
  const status = useStatus(project, a)
  const usage = useLiveUsage(project, a.id)
  const now = useNow()
  const live = a.live
  const urgent = isUrgent(state)
  const doing = agentDoingCards(tasks, project.name, a.id)
  const reviewing = doing.length ? [] : agentReviewCards(tasks, project.name, a.id)
  const run = agentRun(runs, project, a)
  const done = run ? fractionDone(run) : null
  // Badges: background tasks, and the footer's warnings (its context past the Compact threshold, a long transcript).
  const tasksRunning = live?.backgroundTasks ?? 0
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const ctxOver = !!live && threshold > 0 && (usage?.contextTokens ?? 0) >= threshold
  const sizeLimit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
  const longTranscript = live?.transcriptBytes !== undefined && sizeLimit > 0 && live.transcriptBytes >= sizeLimit * 1024 * 1024
  const dragging = useAgentDrag(project)
  const [over, setOver] = useState(false)
  useEffect(() => setOver(false), [dragging])
  const ref = useRef<HTMLButtonElement>(null)
  // Moved from the keyboard: the keyboard back on it, unless the user chose another place since.
  useEffect(() => {
    if (refocusTile?.id !== a.id) return
    if (!refocusTile.may()) refocusTile = null
    else if (document.activeElement !== ref.current) ref.current?.focus()
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('agent-tile', state, urgent && 'urgent', !!flash && flash.key === projectKey(project.path, a.id) && 'flash', dragging === a.id && 'dragging')}
      data-agent={a.id}
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      onClick={() => openTile(project, a.id)}
      {...(movable ? agentDragProps(project, a) : {})}
      onContextMenu={(e) => {
        if (!movable) return
        e.preventDefault()
        // From the keyboard (the menu key, Shift+F10): below the tile's name, on its first entry.
        const keyboard = e.button !== 2
        const r = e.currentTarget.getBoundingClientRect()
        onMenu(keyboard ? r.left + 8 : e.clientX, keyboard ? r.top + 24 : e.clientY, keyboard)
      }}
    >
      {/* While another agent is dragged (#993): dropped here, the two swap. */}
      {movable && dragging && dragging !== a.id && (
        <span
          className={cx('pane-drop', 'tile-drop', over && 'over')}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            swapDrop(project, a.id)
          }}
        >
          <span>
            <Icon name="arrow-swap" /> {tr(SWAP_WITH, { agent: a.name })}
          </span>
        </span>
      )}
      <span className="tile-head">
        <StateMark state={state} />
        <span className="tile-name">{a.name}</span>
        <span className="tile-provider">{providerName(agentProviderOf(project, a))}</span>
      </span>
      <span className="tile-status">{status}</span>
      {doing.length > 0 && <span className="tile-card">{cardsText(doing)}</span>}
      {reviewing.length > 0 && <span className="tile-card">{tr(msg({ id: 'panes.tiles.reviewing', defaultMessage: 'Reviewing {card}', description: 'On an agent\'s tile: the card it reviews ({card}: "#12 Its title").' }), { card: cardsText(reviewing) })}</span>}
      {run && (
        <span className="tile-progress">
          <span className="tile-progress-text">
            {run.title} · {runStatusLine(run, now, tr)}
          </span>
          <span className={cx('tile-bar', done === null && 'moving')} role="progressbar" aria-label={run.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={done === null ? undefined : Math.round(done * 100)}>
            <i style={done === null ? undefined : { width: `${Math.round(done * 100)}%` }} />
          </span>
        </span>
      )}
      {live?.replyStart && <span className="tile-reply">{live.replyStart}</span>}
      {(tasksRunning > 0 || ctxOver || longTranscript) && (
        <span className="tile-badges">
          {tasksRunning > 0 && (
            <span className="tile-badge">
              <Icon name="server-process" /> {tr(msg({ id: 'panes.tiles.background', defaultMessage: '{n, plural, one {# background task} other {# background tasks}}', description: "A badge on an agent's tile: background tasks it started that still run." }), { n: tasksRunning })}
            </span>
          )}
          {ctxOver && (
            <span className="tile-badge warn">
              <Icon name="warning" /> {tr(msg({ id: 'panes.tiles.context', defaultMessage: 'Context {tokens}', description: 'A warning badge on an agent\'s tile: its context is past the Compact threshold ({tokens}: "210K").' }), { tokens: formatTokens(usage?.contextTokens ?? 0) })}
            </span>
          )}
          {longTranscript && (
            <span className="tile-badge warn">
              <Icon name="warning" /> {tr(msg({ id: 'panes.tiles.transcript', defaultMessage: 'Transcript {size}', description: 'A warning badge on an agent\'s tile: its transcript is past the size Hive flags ({size}: "24 MB").' }), { size: formatSize(live!.transcriptBytes!) })}
            </span>
          )}
        </span>
      )}
    </button>
  )
}

/**
 * The focus view's strip (#976): Back to Tiles, then every agent in tile order (its mark, name and status), the one shown
 * marked; choosing another shows it. Esc, outside the terminal (where it is the CLI's), goes back to the grid.
 */
function TileStrip({ project, focus }: { project: ProjectInfo; focus: string }) {
  const tiles = useTiles(project)
  const key = commandKeybinding('session.backToTiles')
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      const t = e.target as Element | null
      // The terminal's, a field's, or an open menu's Escape (dialogs take theirs before it gets here).
      if (t?.closest?.('.terminal-host, input, textarea, select, [contenteditable="true"]') || document.querySelector('.menu')) return
      e.preventDefault()
      back(project)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [project])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('button')]
    const at = els.indexOf(document.activeElement as HTMLElement)
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: els.length - 1 }[e.key]
    if (at < 0 || to === undefined) return
    e.preventDefault()
    els[Math.max(0, Math.min(els.length - 1, to))]?.focus()
  }
  return (
    <nav className="tile-strip" aria-label={tr(msg({ id: 'panes.tiles.stripLabel', defaultMessage: "The project's agents", description: "Accessible name of the focus view's strip of agents (the Tiles view, one agent's pane large)." }))} onKeyDown={onKeyDown}>
      <Tooltip content={tr(msg({ id: 'panes.tiles.backTip', defaultMessage: 'Back to the tiles (Esc outside the terminal{key, select, none {} other {, or {key}}})', description: "Tooltip of the focus view's Back to Tiles button: the keys that do it too ({key}: \"Ctrl+Alt+Escape\"; none: leave that branch empty)." }), { key: key ? formatKeybinding(key) : 'none' })}>
        <button type="button" className="tile-strip-back" onClick={() => back(project)}>
          <Icon name="arrow-left" /> {tr(msg({ id: 'panes.tiles.back', defaultMessage: 'Tiles', description: "The focus view's button back to the grid of tiles. Use the Panes | Tiles toggle's word." }))}
        </button>
      </Tooltip>
      {tiles.map(({ a, state }) => (
        <StripItem key={a.id} project={project} a={a} state={state} active={a.id === focus} />
      ))}
    </nav>
  )
}

function StripItem({ project, a, state, active }: { project: ProjectInfo; a: AgentInfo; state: AgentState; active: boolean }) {
  const status = useStatus(project, a)
  return (
    <button type="button" className={cx('tile-strip-item', state, isUrgent(state) && 'urgent', active && 'active')} data-agent={a.id} aria-current={active || undefined} onClick={() => openTile(project, a.id)}>
      <StateMark state={state} />
      <span className="tile-strip-name">{a.name}</span>
      <span className="tile-strip-status">{status}</span>
    </button>
  )
}

/**
 * The Tiles view's pages in the session toolbar (#976), like the panes' page buttons: a button a page, each counting the
 * urgent tiles (waiting or stalled) on it while another page is shown. Nothing with one page.
 */
export function TilePager({ project }: { project: ProjectInfo }) {
  useLanguage()
  const tiles = useTiles(project)
  const page = useStore((s) => tilePage(project, s))
  const focus = useStore((s) => tileFocusOf(project, s))
  const pages = tilePageCount(tiles.length)
  const movable = useMovable(project)
  const dragging = useAgentDrag(project)
  const [dropPage, setDropPage] = useState<number | null>(null)
  // A dragged tile held over another page's button: that page shows after a moment, to drop on one of its tiles.
  const hover = useRef<{ page: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    setDropPage(null)
    if (hover.current) clearTimeout(hover.current.timer)
    hover.current = null
  }, [dragging])
  if (pages < 2) return null
  const urgent = urgentByPage(tiles.map((t) => t.state))
  const pageKb = commandKeybinding('agent.nextPage')
  return (
    <div className="segmented page-switch tile-pages">
      {Array.from({ length: pages }, (_, i) => {
        const counted = i !== page && urgent[i] > 0
        // A tile dropped here goes to this page's last place (#993): not a target where it already is.
        const end = pageEndIndex(project.agents.length, i, TILES_PER_PAGE)
        const moves = movable && !!dragging && end !== project.agents.findIndex((a) => a.id === dragging)
        return (
          <Tooltip
            key={i}
            content={tr(
              msg({
                id: 'panes.tiles.pageTip',
                defaultMessage: 'Page {page, number} of the tiles{urgent, plural, =0 {} one {: # agent waiting for you or stalled} other {: # agents waiting for you or stalled}}{key, select, none {} other { ({key} for the next page)}}',
                description: "Tooltip of a page button of the Tiles view (the session toolbar): which page, how many of its agents are waiting for the user or stalled ({urgent}), and the shortcut for the next page ({key}: \"Ctrl+Alt+PageDown\"; none: leave that branch empty)."
              }),
              { page: i + 1, urgent: counted ? urgent[i] : 0, key: pageKb ? formatKeybinding(pageKb) : 'none' }
            )}
          >
            <button
              type="button"
              className={cx(page === i && !focus && 'active', moves && dropPage === i && 'drop-target')}
              // Its count of urgent tiles, said as well as shown (a screen reader hears the name, not the badge).
              aria-label={tr(msg({ id: 'panes.tiles.pageButton', defaultMessage: 'Tile page {page, number}{urgent, plural, =0 {} one {, # agent waiting for you or stalled} other {, # agents waiting for you or stalled}}', description: 'Accessible name of a page button of the Tiles view (the session toolbar): which page, and while another page is shown how many of its agents are waiting for the user or stalled ({urgent}; 0: nothing after the page).' }), { page: i + 1, urgent: counted ? urgent[i] : 0 })}
              aria-current={(page === i && !focus) || undefined}
              onClick={() => {
                closeTile(project)
                showTilePage(project, i)
              }}
              onDragOver={(e) => {
                if (!movable || !dragging) return
                if (moves) e.preventDefault()
                setDropPage(moves ? i : null)
                if (i !== page && hover.current?.page !== i) {
                  if (hover.current) clearTimeout(hover.current.timer)
                  hover.current = { page: i, timer: setTimeout(() => showTilePage(project, i), PAGE_HOVER_MS) }
                }
              }}
              onDragLeave={() => {
                setDropPage(null)
                if (hover.current?.page === i) {
                  clearTimeout(hover.current.timer)
                  hover.current = null
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (hover.current) clearTimeout(hover.current.timer)
                hover.current = null
                if (!moves) return
                dropAgent(project, end)
                showTilePage(project, i)
              }}
            >
              {i + 1}
              {counted && (
                <span className="tile-page-count" aria-hidden="true">
                  {fmt.number(urgent[i])}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
