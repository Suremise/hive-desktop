// Pane placement (#762): any agent in any cell of a layout, empty cells allowed, kept per layout. The cells run page
// after page; without a saved placement they are the agents in order (as before).
import { describe, expect, it } from 'vitest'
import { cellPage, cellPageCount, compactCells, moveToCell, neighbourCell, orderByCells, pageCells, pageIds, placedCells, settlePlacements } from '../src/shared/paneCells'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)
/** Cells as text: "a1 . a2" (. for an empty cell), pages split by |. */
const show = (cells: (string | null)[], per: number) =>
  Array.from({ length: cellPageCount(cells, per) }, (_, p) => pageCells(cells, p, per).map((c) => c ?? '.').join(' ')).join(' | ')

describe('placedCells: where each agent is', () => {
  it('with nothing saved, the agents in order, page after page', () => {
    expect(show(placedCells(ids(5), undefined, 4), 4)).toBe('a1 a2 a3 a4 | a5 . . .')
    expect(placedCells(ids(2), null, 6)).toEqual(['a1', 'a2'])
  })

  it('a saved placement keeps empty cells between agents', () => {
    // Two agents in a grid of six, put in the corners.
    expect(show(placedCells(ids(2), ['a1', null, null, null, null, 'a2'], 6), 6)).toBe('a1 . . . . a2')
  })

  it('a new agent takes the first empty cell, else goes after the last', () => {
    expect(show(placedCells(ids(3), [null, 'a1', null, 'a2'], 4), 4)).toBe('a3 a1 . a2')
    expect(show(placedCells(ids(5), ['a1', 'a2', 'a3', 'a4'], 4), 4)).toBe('a1 a2 a3 a4 | a5 . . .')
  })

  it('an agent removed leaves its cell empty; a page left empty goes', () => {
    expect(show(placedCells(['a1', 'a3'], ['a1', 'a2', 'a3'], 4), 4)).toBe('a1 . a3 .')
    // a5 was alone on page 2 and was removed: one page.
    expect(cellPageCount(placedCells(ids(4), ['a1', 'a2', 'a3', 'a4', 'a5'], 4), 4)).toBe(1)
    // An empty page between two: it goes, the third becomes the second.
    expect(show(placedCells(['a1', 'a9'], ['a1', null, 'x', null, 'a9'], 2), 2)).toBe('a1 . | a9 .')
  })

  it('ignores what is not an agent id, and an agent named twice keeps its first cell', () => {
    expect(placedCells(ids(2), ['a2', 7, 'a2', { a: 1 }, 'a1'], 6)).toEqual(['a2', null, null, null, 'a1'])
    expect(placedCells(ids(2), 'a1,a2', 6)).toEqual(['a1', 'a2'])
  })
})

describe('moveToCell: dragging a pane onto a cell', () => {
  const cells = ['a1', 'a2', null, 'a3']
  it('onto an empty cell it moves there, leaving its own empty', () => {
    expect(moveToCell(cells, 'a1', 2, 4)).toEqual([null, 'a2', 'a1', 'a3'])
  })
  it('onto another agent the two swap', () => {
    expect(moveToCell(cells, 'a1', 3, 4)).toEqual(['a3', 'a2', null, 'a1'])
  })
  it('across pages, and past the last cell into the last page', () => {
    expect(show(moveToCell(['a1', 'a2', 'a3'], 'a1', 3, 2), 2)).toBe('. a2 | a3 a1')
    // The only agent of page 2 moves to page 1: page 2 goes.
    expect(moveToCell(['a1', null, 'a3'], 'a3', 1, 2)).toEqual(['a1', 'a3'])
  })
  it('its own cell, an unknown agent or a bad cell: nothing changes', () => {
    expect(moveToCell(cells, 'a1', 0, 4)).toEqual(cells)
    expect(moveToCell(cells, 'zz', 1, 4)).toEqual(cells)
    expect(moveToCell(cells, 'a1', -1, 4)).toEqual(cells)
    expect(moveToCell(cells, 'a1', 1.5, 4)).toEqual(cells)
  })
})

describe('neighbourCell: moving a pane from the keyboard', () => {
  it('left and right go cell by cell, across pages, up to the last page’s end', () => {
    expect(neighbourCell(0, 'left', 'columns2', 3)).toBeNull()
    expect(neighbourCell(1, 'right', 'columns2', 3)).toBe(2)
    // 3 cells in two columns: two pages, the last cell is 3.
    expect(neighbourCell(3, 'right', 'columns2', 3)).toBeNull()
    expect(neighbourCell(2, 'right', 'columns2', 3)).toBe(3)
  })
  it('up and down stay in the column of the page', () => {
    // Grid of six: 3 columns, 2 rows.
    expect(neighbourCell(1, 'down', 'grid6', 6)).toBe(4)
    expect(neighbourCell(4, 'up', 'grid6', 6)).toBe(1)
    expect(neighbourCell(1, 'up', 'grid6', 6)).toBeNull()
    expect(neighbourCell(4, 'down', 'grid6', 6)).toBeNull()
    // Page 2 of a grid of four.
    expect(neighbourCell(5, 'down', 'grid', 8)).toBe(7)
    expect(neighbourCell(1, 'down', 'columns3', 3)).toBeNull()
  })
})

describe('pages of cells', () => {
  const cells = [null, 'a1', 'a2', null, 'a3']
  it('the page an agent is on, its agents and its cells', () => {
    expect(cellPage(cells, 'a3', 4)).toBe(1)
    expect(cellPage(cells, 'nobody', 4)).toBe(0)
    expect(pageIds(cells, 0, 4)).toEqual(['a1', 'a2'])
    expect(pageCells(cells, 1, 4)).toEqual(['a3', null, null, null])
  })
  it('compactCells drops empty pages and empty cells at the end', () => {
    expect(compactCells([null, null, 'a1', null, null, null], 2)).toEqual(['a1'])
    expect(compactCells([], 4)).toEqual([])
  })
  it('the order follows the cells as they read, agents without a cell after them', () => {
    const agents = ids(4).map((id) => ({ id }))
    expect(orderByCells(agents, ['a3', null, 'a1']).map((a) => a.id)).toEqual(['a3', 'a1', 'a2', 'a4'])
    // An id named twice: every agent still once.
    expect(orderByCells(agents, ['a2', 'a2', 'a3']).map((a) => a.id)).toEqual(['a2', 'a3', 'a1', 'a4'])
  })
})

describe('settlePlacements: saved as the agents change, so each keeps its cell', () => {
  it('added agents take a cell and keep it; a removed one leaves its cell empty (add, add, remove)', () => {
    let placement = settlePlacements({ grid6: [null, 'One', 'Two'] }, ['One', 'Two', 'Three'])
    expect(placement?.grid6).toEqual(['Three', 'One', 'Two'])
    placement = settlePlacements(placement, ['One', 'Two', 'Three', 'Four'])
    expect(placement?.grid6).toEqual(['Three', 'One', 'Two', 'Four'])
    // One removed: Four stays in its cell (it doesn't take One's).
    placement = settlePlacements(placement, ['Two', 'Three', 'Four'])
    expect(placement?.grid6).toEqual(['Three', null, 'Two', 'Four'])
    // A new order changes no cell.
    expect(settlePlacements(placement, ['Four', 'Three', 'Two'])?.grid6).toEqual(['Three', null, 'Two', 'Four'])
  })
  it('every layout saved, none for one never arranged or for One at a time; nothing saved stays nothing', () => {
    const placement = settlePlacements({ columns2: ['b', 'a'], single: ['a'], grid: 'junk' }, ['a', 'b', 'c'])
    expect(placement).toEqual({ columns2: ['b', 'a', 'c'] })
    expect(settlePlacements(undefined, ['a'])).toBeUndefined()
    expect(settlePlacements(['a'], ['a'])).toBeUndefined()
  })
})
