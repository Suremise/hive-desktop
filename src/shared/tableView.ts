/**
 * What a data table shows (components/DataTable.tsx): its rows filtered, then sorted, then one page of them. Kept apart
 * from the component so the rules are tested on their own.
 */

/** How a column sorts and filters; the component adds how it looks. */
export interface ColumnRules<T> {
  key: string
  /** The value it sorts by; without one the column doesn't sort. Nulls go last. */
  sortValue?: (row: T) => string | number | null
  /**
   * Its quick filter: text the cell must contain (any case), or one of the values the rows have. `values`, for a choice:
   * a row has several (a card's labels), and passes when one of them is the one chosen.
   */
  filter?: { kind: 'text' | 'choice'; value: (row: T) => string; values?: (row: T) => string[] }
}

export interface Sort {
  key: string
  desc: boolean
}

export interface TableState {
  /** null: the rows' own order. */
  sort: Sort | null
  /** A filter's value by column key ('' or absent: none). */
  filters: Record<string, string>
  /** From 1. */
  page: number
  pageSize: number
}

export interface TableView<T> {
  /** The page's rows. */
  rows: T[]
  /** Rows before filtering. */
  total: number
  /** Rows the filters let through. */
  matched: number
  /** The page shown (kept within the pages there are) and how many there are (at least 1). */
  page: number
  pages: number
  /** The page's first and last row, from 1, among those matched (0 and 0 when none). */
  from: number
  to: number
}

export const PAGE_SIZES = [10, 20, 50, 100]

/** Whether a row passes every filter: text contains (any case), a choice equals. */
export function passes<T>(row: T, columns: ColumnRules<T>[], filters: Record<string, string>): boolean {
  for (const c of columns) {
    const want = filters[c.key]?.trim()
    if (!want || !c.filter) continue
    if (c.filter.kind === 'choice' && c.filter.values) {
      if (!c.filter.values(row).includes(want)) return false
      continue
    }
    const have = c.filter.value(row)
    if (c.filter.kind === 'choice' ? have !== want : !have.toLowerCase().includes(want.toLowerCase())) return false
  }
  return true
}

/** The rows in the sort's order; a stable sort, nulls last either way; without a sort (or its column), as given. */
export function sorted<T>(rows: T[], columns: ColumnRules<T>[], sort: Sort | null): T[] {
  const value = sort ? columns.find((c) => c.key === sort.key)?.sortValue : undefined
  if (!sort || !value) return rows
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' })
      return (sort.desc ? -c : c) || a.i - b.i
    })
    .map((x) => x.row)
}

/** One page of the rows the filters let through, in the sort's order. */
export function tableView<T>(rows: T[], columns: ColumnRules<T>[], state: TableState): TableView<T> {
  const matching = sorted(
    rows.filter((r) => passes(r, columns, state.filters)),
    columns,
    state.sort
  )
  const size = Math.max(1, state.pageSize)
  const pages = Math.max(1, Math.ceil(matching.length / size))
  const page = Math.min(Math.max(1, state.page), pages)
  const start = (page - 1) * size
  const shown = matching.slice(start, start + size)
  return { rows: shown, total: rows.length, matched: matching.length, page, pages, from: shown.length ? start + 1 : 0, to: start + shown.length }
}

/**
 * A header's click: a new column sorts ascending (descending for one whose first sort is descending, such as a date
 * or a number), the same column the other way, then back to the default order.
 */
export function nextSort(current: Sort | null, key: string, descFirst: boolean, defaultSort: Sort | null): Sort | null {
  if (!current || current.key !== key) return { key, desc: descFirst }
  if (current.desc === descFirst) return { key, desc: !descFirst }
  return defaultSort
}

/** The values a choice filter offers: those the rows have (each of a row's `values`, with them), sorted. */
export function choices<T>(rows: T[], value: (row: T) => string, values?: (row: T) => string[]): string[] {
  return [...new Set(values ? rows.flatMap(values) : rows.map(value))].filter(Boolean).sort((a, b) => a.localeCompare(b))
}

/**
 * A table's remembered sort (#250), kept in the UI's pane sizes (numbers by key) as `table-sort:<table>:<column>`:
 * 1 ascending, 2 descending. One key a table at most; none means its default order.
 */
export const sortPrefix = (table: string): string => `table-sort:${table}:`

/** The remembered sort among `panes`, if it names a column that still sorts; else null (the default order). */
export function rememberedSort(panes: Record<string, number>, table: string, sortable: string[]): Sort | null {
  const prefix = sortPrefix(table)
  for (const [k, v] of Object.entries(panes)) {
    if (!k.startsWith(prefix) || (v !== 1 && v !== 2)) continue
    const key = k.slice(prefix.length)
    if (sortable.includes(key)) return { key, desc: v === 2 }
  }
  return null
}

/** The pane keys to clear and the one to set for a new sort: nothing set when it is the default order. */
export function sortPanes(panes: Record<string, number>, table: string, sort: Sort | null, defaultSort: Sort | null): { clear: string[]; set: [string, number] | null } {
  const prefix = sortPrefix(table)
  const isDefault = sort === null ? defaultSort === null : !!defaultSort && defaultSort.key === sort.key && defaultSort.desc === sort.desc
  return { clear: Object.keys(panes).filter((k) => k.startsWith(prefix)), set: sort && !isDefault ? [prefix + sort.key, sort.desc ? 2 : 1] : null }
}
