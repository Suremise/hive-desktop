// A window's startup (#295): it listens for events, then loads its snapshot (ui:get), which can be older than a change
// another window made meanwhile. The tips and project preferences that arrive before the snapshot is applied are handled
// again after it, so the older snapshot doesn't undo them. Here in the order App.tsx does it, with the tips' own rules.
import { describe, expect, it } from 'vitest'
import { startupReplay } from '../src/renderer/src/startupReplay'
import { applyTipsChange, EMPTY_TIPS_STATE, type TipsState } from '../src/shared/tips'
import type { HiveEvent } from '../src/shared/types'

/** A window's store, as App.tsx's handleEvent and its startup set it. */
function windowStore() {
  const store = { tips: EMPTY_TIPS_STATE as TipsState, panes: {} as Record<string, unknown>, settings: 'old' }
  const handle = (e: HiveEvent): void => {
    if (e.type === 'tips-changed') store.tips = e.tips
    else if (e.type === 'ui-pref-changed') store[e.pref as 'panes'] = { ...store[e.pref as 'panes'], [e.project]: e.value }
    else if (e.type === 'settings-changed') store.settings = 'new'
  }
  return { store, handle }
}

describe('a window starting while another changes things', () => {
  const old: TipsState = { ...EMPTY_TIPS_STATE, shownOn: '2000-01-01' }
  const today = applyTipsChange(old, { shownOn: '2026-10-06' })

  it("keeps a tips change that arrived before the older snapshot (the day's tip isn't shown again)", () => {
    const { store, handle } = windowStore()
    const early = startupReplay(handle)
    const event = { type: 'tips-changed', tips: today } as HiveEvent
    handle(event)
    early.note(event)
    expect(store.tips.shownOn).toBe('2026-10-06')
    // The snapshot, read before that change, applied after it.
    store.tips = old
    early.settle()
    expect(store.tips.shownOn).toBe('2026-10-06')
  })

  it("keeps a project preference that arrived before the snapshot, with the snapshot's others", () => {
    const { store, handle } = windowStore()
    const early = startupReplay(handle)
    const event = { type: 'ui-pref-changed', pref: 'panes', project: 'alpha', value: { layout: 'columns' } } as unknown as HiveEvent
    handle(event)
    early.note(event)
    store.panes = { beta: { layout: 'single' } }
    early.settle()
    expect(store.panes).toEqual({ beta: { layout: 'single' }, alpha: { layout: 'columns' } })
  })

  it('replays in order, only those events, only once, and nothing after the snapshot', () => {
    const { store, handle } = windowStore()
    const seen: string[] = []
    const early = startupReplay<HiveEvent>((e) => {
      seen.push(e.type)
      handle(e)
    })
    const first = { type: 'tips-changed', tips: old } as HiveEvent
    const second = { type: 'tips-changed', tips: today } as HiveEvent
    for (const e of [first, { type: 'settings-changed' } as HiveEvent, second]) early.note(e)
    early.settle()
    expect(seen).toEqual(['tips-changed', 'tips-changed'])
    expect(store.tips.shownOn).toBe('2026-10-06')
    early.note(first)
    early.settle()
    expect(seen).toHaveLength(2)
    expect(store.settings).toBe('old')
  })
})
