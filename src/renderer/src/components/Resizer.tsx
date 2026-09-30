import { useState } from 'react'
import { call } from '../api'
import { get, set, useStore } from '../store'
import { cx } from '../util'

/** Saved size of a resizable pane: a width in pixels, or a fraction for split views. */
export function usePaneSize(key: string, fallback: number): number {
  return useStore((s) => s.panes[key]) ?? fallback
}

/** Saves one pane's size only: another window may have changed the others. */
function save(key: string): void {
  void call('ui:setPane', key, get().panes[key] ?? null)
}

/**
 * Drag handle on the right edge of a pane (or its left edge, for a pane on the right of the window).
 * `ratio` panes store their share of the parent's width; the others store a width in pixels, limited so
 * the pane next to them keeps at least `keep` pixels. Double-click resets to the default.
 */
export function PaneResizer({ paneKey, min = 200, max = 700, keep = 320, ratio = false, edge = 'right' }: { paneKey: string; min?: number; max?: number; keep?: number; ratio?: boolean; edge?: 'left' | 'right' }) {
  const [dragging, setDragging] = useState(false)

  const start = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const pane = e.currentTarget.parentElement
    const container = pane?.parentElement
    if (!pane || !container) return
    const box = container.getBoundingClientRect()
    const startX = e.clientX
    const startW = pane.getBoundingClientRect().width
    setDragging(true)
    document.body.classList.add('pane-resizing')
    const move = (ev: MouseEvent): void => {
      const w = startW + (edge === 'left' ? startX - ev.clientX : ev.clientX - startX)
      const value = ratio
        ? Math.max(0.2, Math.min(0.8, w / box.width))
        : Math.round(Math.max(min, Math.min(max, box.width - keep, w)))
      set((s) => ({ panes: { ...s.panes, [paneKey]: value } }))
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      save(paneKey)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const reset = (): void => {
    set((s) => {
      const panes = { ...s.panes }
      delete panes[paneKey]
      return { panes }
    })
    save(paneKey)
  }

  return <div className={cx('pane-resizer', edge === 'left' && 'left-edge', dragging && 'dragging')} onMouseDown={start} onDoubleClick={reset} />
}
