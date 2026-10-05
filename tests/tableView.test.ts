import { describe, expect, it } from 'vitest'
import { choices, nextSort, passes, sorted, tableView, type ColumnRules, type TableState } from '../src/shared/tableView'

interface Row {
  when: string | null
  trigger: string
  before: number
}
const rows: Row[] = Array.from({ length: 45 }, (_, i) => ({ when: i === 7 ? null : `2026-10-${String((i % 28) + 1).padStart(2, '0')} 10:${String(i).padStart(2, '0')}`, trigger: i % 3 === 0 ? 'manual' : 'auto', before: (i * 37) % 101 }))
const columns: ColumnRules<Row>[] = [
  { key: 'when', sortValue: (r) => r.when, filter: { kind: 'text', value: (r) => r.when ?? '' } },
  { key: 'trigger', sortValue: (r) => r.trigger, filter: { kind: 'choice', value: (r) => r.trigger } },
  { key: 'before', sortValue: (r) => r.before },
  { key: 'plain' }
]
const state = (s: Partial<TableState> = {}): TableState => ({ sort: null, filters: {}, page: 1, pageSize: 10, ...s })

describe('tableView', () => {
  it('pages the rows: the page, how many pages, the range shown', () => {
    expect(tableView(rows, columns, state())).toMatchObject({ total: 45, matched: 45, page: 1, pages: 5, from: 1, to: 10 })
    const last = tableView(rows, columns, state({ page: 5 }))
    expect(last).toMatchObject({ page: 5, from: 41, to: 45 })
    expect(last.rows).toEqual(rows.slice(40))
    // A page past the end (a filter just narrowed the rows) shows the last there is; one page when everything fits.
    expect(tableView(rows, columns, state({ page: 9 })).page).toBe(5)
    expect(tableView(rows, columns, state({ pageSize: 50 }))).toMatchObject({ pages: 1, from: 1, to: 45 })
  })

  it('rows per page changes the pages', () => {
    expect(tableView(rows, columns, state({ pageSize: 20 }))).toMatchObject({ pages: 3, from: 1, to: 20 })
    expect(tableView(rows, columns, state({ pageSize: 20, page: 3 }))).toMatchObject({ from: 41, to: 45 })
  })

  it('filters before paging: text contains (any case), a choice equals; blank filters are none', () => {
    const manual = tableView(rows, columns, state({ filters: { trigger: 'manual' } }))
    expect(manual.matched).toBe(15)
    expect(manual.rows.every((r) => r.trigger === 'manual')).toBe(true)
    expect(tableView(rows, columns, state({ filters: { when: '10:4' } })).matched).toBe(5)
    expect(passes(rows[0], columns, { when: '  ' })).toBe(true)
    expect(passes({ when: null, trigger: 'auto', before: 1 }, columns, { when: '2026' })).toBe(false)
    // A filter on a column without one is ignored.
    expect(tableView(rows, columns, state({ filters: { plain: 'x' } })).matched).toBe(45)
  })

  it('no rows, and no matches', () => {
    expect(tableView([], columns, state())).toMatchObject({ total: 0, matched: 0, page: 1, pages: 1, from: 0, to: 0, rows: [] })
    expect(tableView(rows, columns, state({ filters: { when: 'nowhere' } }))).toMatchObject({ total: 45, matched: 0, from: 0, to: 0 })
  })

  it('sorts before paging, both ways, nulls last, ties in their own order', () => {
    const up = sorted(rows, columns, { key: 'before', desc: false }).map((r) => r.before)
    expect(up).toEqual([...up].sort((a, b) => a - b))
    const down = tableView(rows, columns, state({ sort: { key: 'before', desc: true }, pageSize: 100 })).rows.map((r) => r.before)
    expect(down).toEqual([...down].sort((a, b) => b - a))
    for (const desc of [false, true]) expect(sorted(rows, columns, { key: 'when', desc }).at(-1)?.when).toBeNull()
    const byTrigger = sorted(rows, columns, { key: 'trigger', desc: false })
    expect(byTrigger.filter((r) => r.trigger === 'auto')).toEqual(rows.filter((r) => r.trigger === 'auto'))
    // No sort, or a column that doesn't sort: as given.
    expect(sorted(rows, columns, null)).toBe(rows)
    expect(sorted(rows, columns, { key: 'plain', desc: false })).toBe(rows)
  })

  it('a header click: ascending (or descending first), the other way, then the default order', () => {
    const def = { key: 'when', desc: true }
    expect(nextSort(def, 'before', false, def)).toEqual({ key: 'before', desc: false })
    expect(nextSort({ key: 'before', desc: false }, 'before', false, def)).toEqual({ key: 'before', desc: true })
    expect(nextSort({ key: 'before', desc: true }, 'before', false, def)).toEqual(def)
    expect(nextSort(null, 'when', true, null)).toEqual({ key: 'when', desc: true })
    expect(nextSort({ key: 'when', desc: true }, 'when', true, null)).toEqual({ key: 'when', desc: false })
    expect(nextSort({ key: 'when', desc: false }, 'when', true, null)).toBeNull()
  })

  it("a choice filter offers the rows' values", () => {
    expect(choices(rows, (r) => r.trigger)).toEqual(['auto', 'manual'])
  })
})
