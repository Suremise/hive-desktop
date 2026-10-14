import { useCallback, useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import { cardCostLine, partCost, partTokens, perFinished, type CardCost, type CostPart, type LaneCost } from '@shared/cardCosts'
import { call } from '../api'
import { Tooltip } from './ui'

/**
 * Cost per card and per lane in the window (#602): the card's own line in its panel, and a lane's on its bar's hover.
 * Money first; tokens on hover.
 */

/** What a cost is: said with every breakdown (in English until the Performance view, E8d, shows COST_NOTE_TEXT). */
export const COST_NOTE = 'What its agents used while they held it, as the providers reported it: ≈ is Hive’s estimate, ? or Unknown what isn’t known (never $0).' // i18n-ignore: the Performance view's (E8d converts it to COST_NOTE_TEXT)
export const COST_NOTE_TEXT = msg({ id: 'board.costs.note', defaultMessage: 'What its agents used while they held it, as the providers reported it: ≈ is Hive’s estimate, ? or Unknown what isn’t known (never $0).', description: "Under a card's cost breakdown (its hover): what the cost is. ≈, ? and Unknown are how costs show: keep ≈ and ?, and use the same word for Unknown as the costs do." })

function PartLine({ label, part }: { label: string; part: CostPart }) {
  if (!part.priced && !part.unpriced) return null
  return (
    <div>
      <strong>{label}</strong> {partCost(part)}: <span className="faint">{partTokens(part)}</span>
    </div>
  )
}

/** "cost: ≈ $1.84 · 2 rounds" under a card's panel, with its builder's and reviewer's parts and tokens on hover. */
export function CardCostLine({ card }: { card: TaskCard }) {
  const [cost, setCost] = useState<CardCost | null>(null)
  // Again whenever the card changes (a move, a verdict): read from the usage cache, so it's cheap.
  useEffect(() => {
    let live = true
    call('costs:cards', { numbers: [card.number] })
      .then((list) => live && setCost(list[0] ?? null))
      .catch(() => live && setCost(null))
    return () => {
      live = false
    }
  }, [card.number, card.updatedAt])
  if (!cost) return null
  return (
    <div className="faint task-cost">
      <Tooltip
        content={
          <div className="cost-tip">
            <PartLine label={tr(msg({ id: 'board.costs.builder', defaultMessage: 'Builder', description: "In a card's cost hover, before what the agent that built it used. Keep it short." }))} part={cost.build} />
            <PartLine label={tr(msg({ id: 'board.costs.reviewer', defaultMessage: 'Reviewer', description: "In a card's cost hover, before what the agent that reviewed it used. Keep it short." }))} part={cost.review} />
            {cost.unmatched > 0 && <div className="warn-text">{tr(msg({ id: 'board.costs.unmatched', defaultMessage: '{n, plural, one {One agent that held it has} other {# agents that held it have}} no session Hive knows of: unknown.', description: "In a card's cost hover: some agents that held the card have no session Hive knows of, so what they used is unknown." }), { n: cost.unmatched })}</div>}
            <div className="faint">{tr(COST_NOTE_TEXT)}</div>
          </div>
        }
      >
        <span data-testid="card-cost">{cardCostLine(cost)}</span>
      </Tooltip>
    </div>
  )
}

/** A lane's cost in words, for its hover. */
export function LaneCostTip({ cost }: { cost: LaneCost | null | 'loading' }) {
  if (cost === 'loading') return <div className="cost-tip faint">{tr(msg({ id: 'board.costs.laneLoading', defaultMessage: 'Working out its cost…', description: "A lane's cost hover (Progress panel) while Hive works the cost out." }))}</div>
  if (!cost) return <div className="cost-tip faint">{tr(msg({ id: 'board.costs.laneFailed', defaultMessage: 'Its cost couldn’t be worked out.', description: "A lane's cost hover (Progress panel) when Hive couldn't work the cost out." }))}</div>
  const each = perFinished(cost)
  return (
    <div className="cost-tip" data-testid="lane-cost">
      <div>
        <strong>{tr(msg({ id: 'board.costs.cost', defaultMessage: 'Cost', description: "A lane's cost hover (Progress panel), before what its agents used in all. Keep it short." }))}</strong> {partCost(cost.total)}
        {each && <span className="faint"> · {each}</span>}
      </div>
      <PartLine label={tr(msg({ id: 'board.costs.onCards', defaultMessage: 'On cards', description: "A lane's cost hover (Progress panel), before what its agents used while holding a card. Keep it short." }))} part={cost.onCards} />
      <PartLine label={tr(msg({ id: 'board.costs.overhead', defaultMessage: 'Overhead', description: "A lane's cost hover (Progress panel), before what its agents used holding no card (merges, watching). Keep it short." }))} part={cost.overhead} />
      <div className="faint">{tr(msg({ id: 'board.costs.overheadNote', defaultMessage: 'Overhead: what the builder and reviewer used holding no card (merges, watching, compactions). ≈ is Hive’s estimate; ? or Unknown what isn’t known.', description: "Under a lane's cost breakdown (its hover, Progress panel): what Overhead is. Use the same word for Overhead as above it, and for Unknown as the costs do; keep ≈ and ?." }))}</div>
    </div>
  )
}

/** A lane's cost, read when its hover first shows and again after 30 seconds. */
export function useLaneCost(id: string): { cost: LaneCost | null | 'loading'; load: () => void } {
  const [cost, setCost] = useState<LaneCost | null | 'loading'>('loading')
  const at = useRef(0)
  const load = useCallback(() => {
    if (Date.now() - at.current < 30_000) return
    at.current = Date.now()
    call('costs:lanes', [id])
      .then((list) => setCost(list[0] ?? null))
      .catch(() => setCost(null))
  }, [id])
  return { cost, load }
}
