import { useEffect } from 'react'
import { columnLabel } from '@shared/tasks'
import { partCost, partTokens, type CardCost } from '@shared/cardCosts'
import { call } from '../api'
import { InfoTip, LoadFailed, Tooltip } from '../components/ui'
import { CellLines, DataTable, type DataColumn } from '../components/DataTable'
import { COST_NOTE } from '../components/CardCost'
import { set } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { formatDateTime } from '@shared/dates'

/**
 * Performance's Cards table (#602): each card held in the range, with what it cost and its rounds, sortable. A card's
 * whole cost, as Provider usage counts each session's whole usage. A row opens its card.
 */

/** Cost as a sort value: unknown sorts last (null), never as $0. */
const costSort = (c: CardCost): number | null => (c.total.priced ? c.total.cost : null)

function CostCell({ c }: { c: CardCost }) {
  return (
    <Tooltip
      content={
        <div className="cost-tip">
          <div>
            <strong>Builder</strong> {partCost(c.build)}: <span className="faint">{partTokens(c.build)}</span>
          </div>
          <div>
            <strong>Reviewer</strong> {partCost(c.review)}: <span className="faint">{partTokens(c.review)}</span>
          </div>
          <div className="faint">{COST_NOTE}</div>
        </div>
      }
    >
      <span>
        <CellLines main={partCost(c.total)} sub={c.total.unpriced && c.total.priced ? `+ ${c.total.unpriced} unknown` : ''} subWarn />
      </span>
    </Tooltip>
  )
}

const COLUMNS = (withProject: boolean): DataColumn<CardCost>[] => [
  {
    key: 'card',
    header: 'Card',
    cell: (c) => (
      <span className="perf-card-title">
        #{c.number} {c.title}
      </span>
    ),
    sortValue: (c) => c.number,
    filter: { kind: 'text', value: (c) => `#${c.number} ${c.title}` }
  },
  ...(withProject ? [{ key: 'project', header: 'Project', cell: (c: CardCost) => c.project || '—', sortValue: (c: CardCost) => c.project.toLowerCase(), filter: { kind: 'choice' as const, value: (c: CardCost) => c.project } }] : []),
  { key: 'column', header: 'Column', cell: (c) => columnLabel(c.column), sortValue: (c) => c.column, filter: { kind: 'choice', value: (c) => c.column }, choiceLabel: (v) => columnLabel(v as CardCost['column']) },
  { key: 'rounds', header: 'Rounds', num: true, descFirst: true, cell: (c) => (c.rounds ? String(c.rounds) : '—'), sortValue: (c) => c.rounds, headerTip: 'Review rounds: each failed review is one, and the one under way or passed the next. None before it first went to Review.' },
  { key: 'build', header: 'Builder', num: true, descFirst: true, cell: (c) => partCost(c.build), sortValue: (c) => (c.build.priced ? c.build.cost : null) },
  { key: 'review', header: 'Reviewer', num: true, descFirst: true, cell: (c) => partCost(c.review), sortValue: (c) => (c.review.priced ? c.review.cost : null) },
  { key: 'cost', header: 'Cost', num: true, descFirst: true, cell: (c) => <CostCell c={c} />, sortValue: costSort },
  { key: 'held', header: 'Last held', descFirst: true, className: 'nowrap', cell: (c) => (c.lastHeld ? formatDateTime(c.lastHeld) : '—'), sortValue: (c) => c.lastHeld }
]

const WITH_PROJECT = COLUMNS(true)
const WITHOUT_PROJECT = COLUMNS(false)

export function CardsTable({ workspacePath, project, from, to, rangeLabel, refreshAt }: { workspacePath: string; project: string | null; from: number; to: number; rangeLabel: string; refreshAt: number }) {
  const key = `${workspacePath}|${project?.toLowerCase() ?? ''}|${rangeLabel}`
  const loaded = useScopedLoad<CardCost[]>(key)
  const { load } = loaded
  // With the page: when its scope or range changes, and each time it refreshes.
  useEffect(() => {
    load(key, () => call('costs:cards', { project, from, to }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load, refreshAt])
  return (
    <>
      <h2 className="section">
        Cards{' '}
        <InfoTip text={`Each card its agents held in the last ${rangeLabel}: what its builder used while it was in Doing and its reviewer from the review's start to its verdict, as the providers reported it (each card's whole cost, as Provider usage counts whole sessions). ≈ is Hive's estimate; Unknown is what isn't known, never $0. Tokens on hover. What a lane's agents used holding no card is its overhead, on the lane's hover in the Progress panel.`} />
      </h2>
      {loaded.error && !loaded.data && <LoadFailed what="the cost of cards" error={loaded.error} onRetry={() => load(key, () => call('costs:cards', { project, from, to }))} />}
      {loaded.data && (
        <DataTable
          id="perf-cards"
          rows={loaded.data}
          columns={project ? WITHOUT_PROJECT : WITH_PROJECT}
          rowKey={(c) => String(c.number)}
          defaultSort={{ key: 'cost', desc: true }}
          onRowClick={(c) => set({ taskOpen: c.number })}
          rowLabel={(c) => `Open #${c.number}`}
          empty={`No card was held in the last ${rangeLabel}.`}
        />
      )}
    </>
  )
}
