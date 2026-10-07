import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { call } from '../api'
import { set, useStore } from '../store'
import { cx } from '../util'
import { Icon } from './ui'

/**
 * A list that shows its first few items, with a "Show all n" row under them for the rest (#352; the Progress panel's
 * Recent, and the Assistant's "Done by the Assistant", #312). Unfolded, every item shows in a box of the same height,
 * scrolling inside, so nothing around it moves; "Show fewer" folds it back, scrolled to the top. With `foldKey`, the
 * choice is remembered (`ui.panes`, as the panels' other folds are).
 */
export function ShowAllList<T>({
  items,
  few,
  keyOf,
  renderItem,
  label,
  foldKey,
  className
}: {
  items: readonly T[]
  /** How many show while folded. */
  few: number
  keyOf: (item: T) => string
  renderItem: (item: T) => ReactNode
  /** What the items are, for the box's name ("Recent runs"). */
  label: string
  /** Where the fold is remembered (a `ui.panes` key); without it, it starts folded each time. */
  foldKey?: string
  className?: string
}) {
  const stored = useStore((s) => (foldKey ? s.panes[foldKey] === 1 : false))
  const [local, setLocal] = useState(false)
  const all = (foldKey ? stored : local) && items.length > few
  const box = useRef<HTMLDivElement>(null)
  // The box's height while unfolded: the folded list's, measured from its rows when it unfolds.
  const [height, setHeight] = useState<number | null>(null)
  const id = useId()
  useLayoutEffect(() => {
    const el = box.current
    if (!all) {
      if (height !== null) setHeight(null)
      return
    }
    if (!el || height !== null) return
    // As many of the shortest of the first rows as show folded: a row opened wider (its details) doesn't stretch it.
    const rows = [...el.children].slice(0, few) as HTMLElement[]
    const shortest = Math.min(...rows.map((r) => r.offsetHeight).filter((h) => h > 0))
    if (Number.isFinite(shortest)) setHeight(shortest * few)
  }, [all, height, few])
  const toggle = (): void => {
    const next = !all
    if (foldKey) {
      set((s) => ({ panes: { ...s.panes, [foldKey]: next ? 1 : 0 } }))
      void call('ui:setPane', foldKey, next ? 1 : null)
    } else setLocal(next)
    if (!next && box.current) box.current.scrollTop = 0
  }
  const shown = all ? items : items.slice(0, few)
  return (
    <>
      <div
        ref={box}
        id={id}
        className={cx('show-all-list', all && 'all', className)}
        style={all && height !== null ? { height } : undefined}
        {...(all ? { role: 'region', 'aria-label': `${label}, all ${items.length}`, tabIndex: 0 } : {})}
      >
        {shown.map((x) => (
          <Fragment key={keyOf(x)}>{renderItem(x)}</Fragment>
        ))}
      </div>
      {items.length > few && (
        <button type="button" className="show-all-fold" aria-expanded={all} aria-controls={id} onClick={toggle}>
          <Icon name={all ? 'chevron-up' : 'chevron-down'} />
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}
