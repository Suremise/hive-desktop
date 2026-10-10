import { fitSegments, frozenSegment, laneCards, laneSummary, segmentsThatFit, type LaneSegment } from '@shared/laneBar'
import { NO_PROJECTS, set, useStore } from '../store'
import type { Lane } from '../laneSource'
import { useNow } from '../usage'
import { cx } from '../util'
import { cardStalled } from './Board'
import { usePanelFold } from './ProgressMerge'
import { Icon, Tooltip } from './ui'

/**
 * The bottom of the Progress panel (#484): the lanes (a builder and its reviewer working through cards in order), one
 * row each, pinned to the bottom and growing upward, running ones first; past six the list scrolls (#512). A row is a
 * header (the pair, the lane, the card being worked, finished/total) and a segmented bar, one segment per card coloured
 * and patterned by where it is. An ended or abandoned lane shows its cards as it left them, muted and still (#512), never
 * the board's now. Hover a segment for the card and its round; a click opens the card. A running lane with a stalled card
 * (#521: its reviewer watching but not reviewing, its agent not watching) says so in its header. The section folds down
 * to its header bar (remembered per workspace), and isn't there at all without lanes.
 */

const foldKey = (ws: string): string => `progress-lanes-fold:${ws.toLowerCase()}`

/** The room a bar has inside the panel: the panel's width less the row's margins and padding. */
const BAR_INSET_PX = 38

const STATE_WORD: Record<Lane['state'], string | null> = { active: null, paused: 'paused', ended: 'merged', abandoned: 'abandoned' }

export function LanesSection({ lanes, width }: { lanes: Lane[]; width: number }) {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const [folded, toggle] = usePanelFold(ws ? foldKey(ws) : null)
  if (!lanes.length) return null
  return (
    <div className={cx('progress-lanes', folded && 'folded')} role="region" aria-label="Lanes">
      <button type="button" className="progress-lanes-bar" aria-expanded={!folded} onClick={toggle} title={folded ? 'Show the lanes' : 'Fold the lanes'}>
        <Icon name={folded ? 'chevron-up' : 'chevron-down'} />
        <span>Lanes</span>
        <span className="progress-lanes-count">{lanes.length}</span>
      </button>
      {!folded && (
        <div className="progress-lanes-list">
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} max={segmentsThatFit(width - BAR_INSET_PX)} />
          ))}
        </div>
      )}
    </div>
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
  return (
    <div className={cx('progress-lane', l.state)} data-lane={l.id}>
      <div className="progress-lane-top">
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
