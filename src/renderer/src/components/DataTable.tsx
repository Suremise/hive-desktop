import { useEffect, useMemo, useState } from 'react'
import { PAGE_SIZES, choices, nextSort, tableView, type ColumnRules, type Sort } from '@shared/tableView'
import { call } from '../api'
import { set, useStore } from '../store'
import { cx } from '../util'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * A table that can grow: sorting by a header, quick filters under the headers, and pages under it (with rows per page,
 * remembered per table). The same look as Hive's other tables (.table in .table-wrap, as Performance's): real table
 * markup, aria-sort on the sorted header, labelled filters and paging buttons. Only the current page is rendered.
 */

export interface DataColumn<T> extends ColumnRules<T> {
  header: string
  cell: (row: T) => React.ReactNode
  /** A number: right-aligned, tabular figures. */
  num?: boolean
  /** Its first sort is descending (dates newest first, the biggest numbers first). */
  descFirst?: boolean
  /** How a choice filter names a value (default: the value). */
  choiceLabel?: (value: string) => string
}

export function DataTable<T>({
  id,
  rows,
  columns,
  rowKey,
  defaultSort = null,
  onRowClick,
  rowLabel,
  empty,
  pageSizes = PAGE_SIZES,
  defaultPageSize = 20,
  className,
  selection
}: {
  /** Names the table for its remembered rows per page ("compactions"). */
  id: string
  rows: T[]
  columns: DataColumn<T>[]
  rowKey: (row: T, index: number) => string
  /** The order before any header is clicked (null: the rows' own). */
  defaultSort?: Sort | null
  /** Rows open something when clicked, or with Enter when focused. */
  onRowClick?: (row: T) => void
  /** A clickable row's accessible name: what clicking it does. */
  rowLabel?: (row: T) => string
  /** Said instead of the table when there are no rows at all. */
  empty: string
  pageSizes?: number[]
  defaultPageSize?: number
  className?: string
  /**
   * Rows can be selected (#249): a checkbox before each row, and one in the header for every row the filters let
   * through (on every page). `selected` holds row keys; the caller keeps it and acts on it.
   */
  selection?: { selected: ReadonlySet<string>; onChange: (selected: Set<string>) => void; label: (row: T) => string }
}) {
  const sizeKey = `table-rows:${id}`
  const saved = useStore((s) => s.panes[sizeKey])
  const pageSize = saved && pageSizes.includes(saved) ? saved : defaultPageSize
  const [sort, setSort] = useState<Sort | null>(defaultSort)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  const view = useMemo(() => tableView(rows, columns, { sort, filters, page, pageSize }), [rows, columns, sort, filters, page, pageSize])
  // Kept within the pages there are (rows went, a filter narrowed them).
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])
  const filtered = Object.values(filters).some((v) => v.trim())
  const hasFilters = columns.some((c) => c.filter)
  // Selecting every row the filters let through, not only this page's.
  const matchingKeys = useMemo(() => (selection ? tableView(rows, columns, { sort: null, filters, page: 1, pageSize: Math.max(1, rows.length) }).rows.map((r, i) => rowKey(r, i)) : []), [selection, rows, columns, filters, rowKey])
  const allSelected = !!selection && matchingKeys.length > 0 && matchingKeys.every((k) => selection.selected.has(k))
  const someSelected = !!selection && matchingKeys.some((k) => selection.selected.has(k))
  const toggle = (keys: string[], on: boolean): void => {
    if (!selection) return
    const next = new Set(selection.selected)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    selection.onChange(next)
  }

  if (!rows.length) return <div className="pane-empty data-table-empty">{empty}</div>

  const setFilter = (key: string, value: string): void => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }
  const setSize = (n: number): void => {
    set((s) => ({ panes: { ...s.panes, [sizeKey]: n } }))
    void call('ui:setPane', sizeKey, n)
    setPage(1)
  }

  return (
    <div className={cx('data-table', className)}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {selection && (
                <th className="table-select" rowSpan={hasFilters ? 2 : 1}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={`Select all ${matchingKeys.length} ${filtered ? 'matching ' : ''}rows`}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                    onChange={(e) => toggle(matchingKeys, e.target.checked)}
                  />
                </th>
              )}
              {columns.map((c) => {
                const sorted = sort?.key === c.key
                return (
                  <th key={c.key} className={cx(c.num && 'num', c.sortValue && 'sortable')} aria-sort={sorted ? (sort!.desc ? 'descending' : 'ascending') : undefined}>
                    {c.sortValue ? (
                      <button type="button" className="th-sort" onClick={() => setSort((s) => nextSort(s, c.key, !!c.descFirst, defaultSort))} title={`Sort by ${c.header.toLowerCase()}`}>
                        {c.header}
                        {sorted && <Icon name={sort!.desc ? 'chevron-down' : 'chevron-up'} />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                )
              })}
            </tr>
            {hasFilters && (
              <tr className="table-filters">
                {columns.map((c) => (
                  <th key={c.key} className={cx(c.num && 'num')}>
                    {c.filter?.kind === 'choice' ? (
                      <select className="select" aria-label={`Filter ${c.header}`} value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)}>
                        <option value="">All</option>
                        {choices(rows, c.filter.value, c.filter.values).map((v) => (
                          <option key={v} value={v}>
                            {c.choiceLabel?.(v) ?? v}
                          </option>
                        ))}
                      </select>
                    ) : c.filter ? (
                      <input className="input" aria-label={`Filter ${c.header}`} placeholder="Filter" value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)} />
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {view.rows.map((r, i) => {
              const key = rowKey(r, (view.page - 1) * pageSize + i)
              const picked = !!selection?.selected.has(key)
              return (
                <tr
                key={key}
                className={cx(onRowClick && 'clickable', picked && 'selected')}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick ? rowLabel?.(r) : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onRowClick(r)
                        }
                      }
                    : undefined
                }
              >
                {selection && (
                  <td className="table-select" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="checkbox" aria-label={selection.label(r)} checked={picked} onChange={(e) => toggle([key], e.target.checked)} onKeyDown={(e) => e.stopPropagation()} />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.num && 'num')}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
              )
            })}
            {view.matched === 0 && (
              <tr className="table-no-match">
                <td colSpan={columns.length + (selection ? 1 : 0)}>
                  No rows match the filters.{' '}
                  {filtered && (
                    <button type="button" className="btn small subtle" onClick={() => (setFilters({}), setPage(1))}>
                      Clear filters
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Also on one page while there are more rows than the fewest per page, so a bigger size can be made smaller again. */}
      {(view.pages > 1 || view.matched > Math.min(...pageSizes)) && (
        <div className="table-paging" role="navigation" aria-label="Pages">
          <label className="table-page-size">
            Rows per page
            <select className="select" value={pageSize} onChange={(e) => setSize(Number(e.target.value))}>
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="faint table-range">
            {view.from}–{view.to} of {view.matched}
          </span>
          <div className="grow" />
          <PageButton label="«" title="First page" disabled={view.page === 1} onClick={() => setPage(1)} />
          <IconButton icon="chevron-left" title="Previous page" disabled={view.page === 1} onClick={() => setPage(view.page - 1)} />
          <span className="table-page">
            Page {view.page} of {view.pages}
          </span>
          <IconButton icon="chevron-right" title="Next page" disabled={view.page === view.pages} onClick={() => setPage(view.page + 1)} />
          <PageButton label="»" title="Last page" disabled={view.page === view.pages} onClick={() => setPage(view.pages)} />
        </div>
      )}
    </div>
  )
}

/** First and last page: the codicons have no double chevron, so a character, styled as the icon buttons beside it. */
function PageButton({ label, title, disabled, onClick }: { label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content={title}>
      <button type="button" className="icon-btn table-page-end" aria-label={title} disabled={disabled} onClick={onClick}>
        {label}
      </button>
    </Tooltip>
  )
}

/**
 * A table cell of deliberate lines (#241): the value, and under it a smaller, fainter detail, neither of which wraps,
 * so a narrow table scrolls inside its section (.table-wrap) rather than breaking a value mid-phrase. In a number
 * column both lines align right. A missing detail still takes its line (`sub` null), so rows keep one height.
 */
export function CellLines({ main, sub, subWarn }: { main: React.ReactNode; sub?: React.ReactNode; subWarn?: boolean }) {
  return (
    <span className="cell-lines">
      <span className="cell-main">{main}</span>
      <span className={cx('cell-sub', subWarn && 'warn-text')} aria-hidden={sub ? undefined : true}>
        {sub || ' '}
      </span>
    </span>
  )
}
