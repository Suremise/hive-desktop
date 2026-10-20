// Where each agent's pane is in a layout (#762): any agent in any cell, empty cells allowed, kept per layout.
import { SESSION_LAYOUTS, layoutColumns, layoutPanes } from './defaults'
import type { SessionLayout } from './types'

/**
 * A layout's cells in order, page after page (`perPage` a page): an agent's id, or null for an empty cell. Saved per
 * layout in project.json's `placement` once the user moves a pane; until then the panes follow the agents' order.
 */
export type PaneCells = (string | null)[]

/** The most cells a saved placement keeps (24 agents with as many gaps). */
const CELLS_MAX = 48

/** The cells without empty pages (a page whose agents all moved away goes) and without empty cells at the end. */
export function compactCells(cells: readonly (string | null)[], perPage: number): PaneCells {
  const n = Math.max(1, perPage)
  const out: PaneCells = []
  for (let k = 0; k < cells.length; k += n) {
    const page = cells.slice(k, k + n)
    if (page.some((id) => id !== null)) out.push(...page, ...Array<null>(n - page.length).fill(null))
  }
  while (out.length && out.at(-1) === null) out.pop()
  return out
}

/**
 * The cells a project's panes show, from its agents (`ids`, in order) and the placement saved for the layout. With none
 * saved, the agents in order (each page filled in turn). Saved, each agent keeps its cell; agents it doesn't name (added
 * since) take the first empty cell, else go after the last; agents gone leave their cell empty.
 */
export function placedCells(ids: readonly string[], saved: unknown, perPage: number): PaneCells {
  if (!Array.isArray(saved)) return [...ids]
  const known = new Set(ids)
  const seen = new Set<string>()
  const cells = compactCells(
    saved.slice(0, CELLS_MAX).map((v) => {
      if (typeof v !== 'string' || !known.has(v) || seen.has(v)) return null
      seen.add(v)
      return v
    }),
    perPage
  )
  for (const id of ids) {
    if (seen.has(id)) continue
    const k = cells.indexOf(null)
    if (k >= 0) cells[k] = id
    else cells.push(id)
  }
  return compactCells(cells, perPage)
}

/** How many pages the cells take (at least one). */
export function cellPageCount(cells: readonly (string | null)[], perPage: number): number {
  return Math.max(1, Math.ceil(cells.length / Math.max(1, perPage)))
}

/** The page an agent's cell is on (0 is page 1; 0 for an agent not placed). */
export function cellPage(cells: readonly (string | null)[], id: string | null | undefined, perPage: number): number {
  const k = id ? cells.indexOf(id) : -1
  return k < 0 ? 0 : Math.floor(k / Math.max(1, perPage))
}

/** One page's cells, `perPage` of them (the empty ones null). */
export function pageCells(cells: readonly (string | null)[], page: number, perPage: number): PaneCells {
  const n = Math.max(1, perPage)
  const out = cells.slice(page * n, (page + 1) * n)
  return [...out, ...Array<null>(n - out.length).fill(null)]
}

/** The agents on one page, in their cells' order. */
export function pageIds(cells: readonly (string | null)[], page: number, perPage: number): string[] {
  return pageCells(cells, page, perPage).filter((id): id is string => id !== null)
}

/**
 * The cells with an agent moved to cell `target` (across pages too): onto an empty cell it moves there, leaving its own
 * empty; onto another agent's, the two swap. A target past the last cell (an empty cell of the last page) is allowed.
 */
export function moveToCell(cells: readonly (string | null)[], id: string, target: number, perPage: number): PaneCells {
  const from = cells.indexOf(id)
  if (from < 0 || target < 0 || target === from || !Number.isInteger(target)) return [...cells]
  const out: PaneCells = [...cells]
  while (out.length <= target) out.push(null)
  const other = out[target]
  out[target] = id
  out[from] = other
  return compactCells(out, perPage)
}

/**
 * The agents in the cells' reading order, page after page (#762), those not in a cell after them in their order: the
 * project's order once its panes are placed, which Tiles' "Same as panes" and the layouts without a placement follow.
 */
export function orderByCells<T extends { id: string }>(agents: readonly T[], cells: readonly (string | null)[]): T[] {
  // Each agent once, whatever the cells name twice.
  const placed = [...new Set(cells)].flatMap((id) => agents.find((a) => a.id === id) ?? [])
  return [...placed, ...agents.filter((a) => !placed.includes(a))]
}

/**
 * Every saved placement with the agents as they are now (`ids`): agents added take their cell (the first empty one, else
 * after the last) and keep it from then on, removed ones leave theirs empty (#762). Saved whenever the agents change, so
 * an agent's cell never depends on the order or on agents added or removed later. None saved: none.
 */
export function settlePlacements(placement: unknown, ids: readonly string[]): Partial<Record<SessionLayout, PaneCells>> | undefined {
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) return undefined
  const out: Partial<Record<SessionLayout, PaneCells>> = {}
  for (const l of SESSION_LAYOUTS) {
    const saved = (placement as Record<string, unknown>)[l.value]
    if (l.value !== 'single' && Array.isArray(saved)) out[l.value] = placedCells(ids, saved, l.panes)
  }
  return out
}

/** A direction a pane moves in from the keyboard. */
export type CellDirection = 'left' | 'right' | 'up' | 'down'

/**
 * The cell next to cell `k` in a layout, or null at an edge. Left and right go cell by cell in reading order, across pages
 * at their ends (as Move Left / Move Right do), up to the last page's last cell; up and down stay in the page's column.
 */
export function neighbourCell(k: number, dir: CellDirection, layout: SessionLayout, count: number): number | null {
  const n = layoutPanes(layout)
  const cols = layoutColumns(layout)
  const last = Math.max(1, Math.ceil(count / n)) * n - 1
  const pos = k % n
  if (dir === 'left') return k > 0 ? k - 1 : null
  if (dir === 'right') return k < last ? k + 1 : null
  if (dir === 'up') return pos - cols >= 0 ? k - cols : null
  return pos + cols < n ? k + cols : null
}
