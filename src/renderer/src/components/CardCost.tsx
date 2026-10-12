import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskCard } from '@shared/types'
import { cardCostLine, partCost, partTokens, perFinished, type CardCost, type CostPart, type LaneCost } from '@shared/cardCosts'
import { call } from '../api'
import { Tooltip } from './ui'

/**
 * Cost per card and per lane in the window (#602): the card's own line in its panel, and a lane's on its bar's hover.
 * Money first; tokens on hover.
 */

/** What a cost is: said with every breakdown. */
export const COST_NOTE = 'What its agents used while they held it, as the providers reported it: ≈ is Hive’s estimate, ? or Unknown what isn’t known (never $0).'

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
            <PartLine label="Builder" part={cost.build} />
            <PartLine label="Reviewer" part={cost.review} />
            {cost.unmatched > 0 && <div className="warn-text">{cost.unmatched === 1 ? 'One agent that held it has' : `${cost.unmatched} agents that held it have`} no session Hive knows of: unknown.</div>}
            <div className="faint">{COST_NOTE}</div>
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
  if (cost === 'loading') return <div className="cost-tip faint">Working out its cost…</div>
  if (!cost) return <div className="cost-tip faint">Its cost couldn’t be worked out.</div>
  const each = perFinished(cost)
  return (
    <div className="cost-tip" data-testid="lane-cost">
      <div>
        <strong>Cost</strong> {partCost(cost.total)}
        {each && <span className="faint"> · {each}</span>}
      </div>
      <PartLine label="On cards" part={cost.onCards} />
      <PartLine label="Overhead" part={cost.overhead} />
      <div className="faint">Overhead: what the builder and reviewer used holding no card (merges, watching, compactions). ≈ is Hive’s estimate; ? or Unknown what isn’t known.</div>
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
