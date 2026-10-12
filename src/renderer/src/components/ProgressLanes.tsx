import { useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_LANE_ROWS, RUNS_KEEP_PX, draggedLaneRows, fitSegments, frozenSegment, keyedLaneRows, laneCards, laneRowsNow, laneSummary, segmentsThatFit, type LaneSegment } from '@shared/laneBar'
import { call } from '../api'
import { NO_PROJECTS, get, set, useStore } from '../store'
import type { Lane } from '../laneSource'
import { useNow } from '../usage'
import { cx } from '../util'
import { cardStalled } from './Board'
import { usePanelFold } from './ProgressMerge'
import { Icon, Tooltip } from './ui'
import { LaneCostTip, useLaneCost } from './CardCost'

/**
 * The bottom of the Progress panel (#484): the lanes (a builder and its reviewer working through cards in order), one
 * row each, pinned to the bottom and growing upward, running ones first; up to four show, then the list scrolls (#569).
 * The section's top edge is a handle: drag it (or focus it and press Up and Down) for more or fewer, in whole lanes,
 * double-click for the default; the choice is kept per workspace, and a panel too short for it shows the whole lanes
 * that fit while the runs keep their room (measured as the panel changes: a resize, zoom, a merge card). A row is a header (the pair, the lane, the card being
 * worked, finished/total) and a segmented bar, one segment per card coloured and patterned by where it is. An ended or
 * abandoned lane shows its cards as it left them, muted and still (#512), never the board's now. Hover a segment for the
 * card and its round; a click opens the card. A running lane with a stalled card (#521: its reviewer watching but not
 * reviewing, its agent not watching) says so in its header. The section folds down to its header bar (remembered per
 * workspace, keeping the chosen height), and isn't there at all without lanes.
 */

const foldKey = (ws: string): string => `progress-lanes-fold:${ws.toLowerCase()}`
const rowsKey = (ws: string): string => `progress-lanes-rows:${ws.toLowerCase()}`

/** The room a bar has inside the panel: the panel's width less the row's margins and padding. */
const BAR_INSET_PX = 38
/** A lane's height with its margin, until one is measured. */
const PITCH_PX = 61

const STATE_WORD: Record<Lane['state'], string | null> = { active: null, paused: 'paused', ended: 'merged', abandoned: 'abandoned' }

export function LanesSection({ lanes, width }: { lanes: Lane[]; width: number }) {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const [folded, toggle] = usePanelFold(ws ? foldKey(ws) : null)
  const key = ws ? rowsKey(ws) : null
  const kept = useStore((s) => (key ? s.panes[key] : undefined))
  const list = useRef<HTMLDivElement>(null)
  // Measured as the panel changes (a resize, zoom, a merge card, lanes coming and going): a lane's height with its
  // margin, so the list shows whole lanes, and the room the lanes could have: the list and the runs above share the
  // panel's height, less what the runs keep. That sum doesn't change as the lanes shown do, so it settles at once.
  const [pitch, setPitch] = useState(PITCH_PX)
  const [room, setRoom] = useState<number | null>(null)
  const open = lanes.length > 0 && !folded
  useLayoutEffect(() => {
    const el = list.current
    const body = el?.closest('.progress-panel')?.querySelector<HTMLElement>('.progress-body')
    if (!open || !el || !body) return
    const row = el.querySelector<HTMLElement>('.progress-lane')
    const measure = (): void => {
      if (row) {
        const h = row.getBoundingClientRect().height + parseFloat(getComputedStyle(row).marginBottom || '0')
        if (h > 0) setPitch((was) => (Math.abs(was - h) < 0.1 ? was : h))
      }
      const r = el.clientHeight + body.getBoundingClientRect().height - RUNS_KEEP_PX
      setRoom((was) => (was !== null && Math.abs(was - r) < 1 ? was : r))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    watch.observe(body)
    if (row) watch.observe(row)
    return () => watch.disconnect()
  }, [open, lanes, width])
  if (!lanes.length) return null
  const { chosen, shown, max } = laneRowsNow(kept, lanes.length, room, pitch)
  return (
    <div className={cx('progress-lanes', folded && 'folded')} role="region" aria-label="Lanes">
      {!folded && key && <LanesEdge rowsKey={key} chosen={chosen} shown={shown} max={max} count={lanes.length} pitch={pitch} />}
      <button type="button" className="progress-lanes-bar" aria-expanded={!folded} onClick={toggle} title={folded ? 'Show the lanes' : 'Fold the lanes'}>
        <Icon name={folded ? 'chevron-up' : 'chevron-down'} />
        <span>Lanes</span>
        <span className="progress-lanes-count">{lanes.length}</span>
      </button>
      {!folded && (
        // Whole lanes, the next one's top at the bottom edge; all of them, with the list's padding, when they fit.
        <div className="progress-lanes-list" ref={list} style={shown < lanes.length ? { maxHeight: shown * pitch } : undefined}>
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} max={segmentsThatFit(width - BAR_INSET_PX)} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The section's top edge (#569): a window splitter (WAI-ARIA) whose value is the lanes shown now and whose maximum is
 * the most that fit (the runs above keep RUNS_KEEP_PX), not the choice kept. Dragging snaps to whole lanes from what
 * shows; a double-click goes back to the default; focused, Up and Down change it by a lane, Home and End to one and to
 * all that fit. A drag or key sets the choice to what it shows, also where a short panel had shown fewer than chosen.
 */
function LanesEdge({ rowsKey: key, chosen, shown, max, count, pitch }: { rowsKey: string; chosen: number; shown: number; max: number; count: number; pitch: number }) {
  const [dragging, setDragging] = useState(false)
  const put = (rows: number | null): void => {
    set((s) => {
      const panes = { ...s.panes }
      if (rows === null) delete panes[key]
      else panes[key] = rows
      return { panes }
    })
  }
  const save = (): void => void call('ui:setPane', key, get().panes[key] ?? null)
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    let last = chosen
    setDragging(true)
    document.body.classList.add('pane-resizing-v')
    const move = (ev: PointerEvent): void => {
      const rows = draggedLaneRows(shown, ev.clientY - startY, pitch, max)
      if (rows === last) return
      last = rows
      put(rows)
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing-v')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    put(null)
    save()
  }
  return (
    <div
      className={cx('progress-lanes-edge', dragging && 'dragging')}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Lanes shown"
      aria-valuemin={1}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={`${shown} of ${count} ${count === 1 ? 'lane' : 'lanes'} shown`}
      tabIndex={0}
      title={`Drag to show more or fewer lanes; double-click for ${DEFAULT_LANE_ROWS}`}
      onPointerDown={start}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const rows = keyedLaneRows(shown, e.key, max)
        if (rows === null) return
        e.preventDefault()
        // Against the choice kept: on a short panel showing fewer than chosen, End keeps what fits.
        if (rows === chosen) return
        put(rows)
        save()
      }}
    />
  )
}

function LaneRow({ lane: l, max }: { lane: Lane; max: number }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // Read again each minute: a card waiting in Review becomes stalled with time (#521).
  useNow(60_000)
  const cards = l.frozen ? l.frozen.map(frozenSegment) : laneCards(l.cards, tasks)
  let stalled: { n: number; why: string } | null = null
  for (const n of l.frozen ? [] : l.cards) {
    const c = tasks.find((t) => t.number === n)
    const why = c ? cardStalled(projects, c) : null
    if (why) {
      stalled = { n, why }
      break
    }
  }
  const { finished, total, current } = laneSummary(cards)
  // A lane that ended without a record of its cards doesn't know how many were finished (#512).
  const unknown = cards.some((c) => c.state === 'unrecorded')
  const segments = fitSegments(cards, max)
  const pair = l.reviewer ? `${l.builder.name} / ${l.reviewer.name}` : l.builder.name
  const word = STATE_WORD[l.state]
  // Its cost on the hover of its top line (#602), read when the hover first shows.
  const cost = useLaneCost(l.id)
  return (
    <div className={cx('progress-lane', l.state)} data-lane={l.id}>
      <Tooltip block content={<LaneCostTip cost={cost.cost} />}>
        <div className="progress-lane-top" onMouseEnter={cost.load}>
          <span className="progress-lane-pair">{pair}</span>
          {l.name && <span className="progress-lane-name faint">· {l.name}</span>}
          <div className="grow" />
          {word && <span className={cx('progress-lane-state', l.state)}>{word}</span>}
          {stalled && (
            <Tooltip content={`#${stalled.n}: ${stalled.why}`}>
              <span className="progress-lane-state stalled">stalled</span>
            </Tooltip>
          )}
          {current !== null && !l.frozen && <span className="progress-lane-current">#{current}</span>}
          <span className="progress-lane-count faint">
            {unknown ? '–' : finished}/{total}
          </span>
        </div>
      </Tooltip>
      <div className="lane-bar" role="list" aria-label={unknown ? `${pair}: ${total} cards, not recorded` : `${pair}: ${finished} of ${total} cards finished`}>
        {segments.map((s) => (
          <Segment key={s.kind === 'card' ? s.number : `${s.kind}-${s.numbers[0]}`} segment={s} />
        ))}
      </div>
    </div>
  )
}

/** One segment: a card (a click opens it), or the finished cards folded together, or the rest of a long lane. */
function Segment({ segment: s }: { segment: LaneSegment }) {
  if (s.kind !== 'card')
    return (
      <Tooltip content={s.label} focus>
        <span role="listitem" tabIndex={0} className={cx('lane-seg', s.kind)} aria-label={s.label}>
          {s.kind === 'finished' ? `✓ ${s.numbers.length}` : `+${s.numbers.length}`}
        </span>
      </Tooltip>
    )
  return (
    <Tooltip content={s.label} focus>
      <button type="button" role="listitem" className={cx('lane-seg', s.state, s.failed && 'failed')} data-card={s.number} aria-label={s.label} onClick={() => set({ taskOpen: s.number })} />
    </Tooltip>
  )
}
