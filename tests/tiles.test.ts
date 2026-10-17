import { describe, expect, it } from 'vitest'
import { REPLY_START_MAX, TILES_PER_PAGE, isUrgent, replyStart, tileOrder, tilePageCount, tilePageOf, tilePageShown, tilesOnPage, urgentByPage } from '../src/shared/tiles'
import type { AgentState } from '../src/shared/agentState'

describe('the Tiles view (#976)', () => {
  const states: AgentState[] = ['idle', 'working', 'waiting', 'idle', 'stalled', 'working']

  it('keeps the panes order by default, and sorts by urgency on request (the panes order within a state)', () => {
    expect(tileOrder(states, 'panes')).toEqual([0, 1, 2, 3, 4, 5])
    expect(tileOrder(states, 'urgency')).toEqual([2, 4, 1, 5, 0, 3])
  })

  it('counts waiting and stalled as urgent', () => {
    expect((['waiting', 'stalled', 'working', 'idle'] as AgentState[]).map(isUrgent)).toEqual([true, true, false, false])
  })

  it('holds 12 tiles a page: 12 agents on one page, 13 to 24 on two', () => {
    expect(TILES_PER_PAGE).toBe(12)
    expect([0, 1, 12, 13, 24].map(tilePageCount)).toEqual([1, 1, 1, 2, 2])
    expect(tilePageOf(11)).toBe(0)
    expect(tilePageOf(12)).toBe(1)
    const ids = Array.from({ length: 13 }, (_, i) => i)
    expect(tilesOnPage(ids, 0)).toHaveLength(12)
    expect(tilesOnPage(ids, 1)).toEqual([12])
  })

  it('shows a page there is: one past the end (agents removed) is the last', () => {
    expect(tilePageShown(1, 13)).toBe(1)
    expect(tilePageShown(1, 12)).toBe(0)
    expect(tilePageShown(-1, 30)).toBe(0)
    expect(tilePageShown(Number.NaN, 30)).toBe(0)
  })

  it('counts the urgent tiles on each page, for the page control', () => {
    const many: AgentState[] = [...Array<AgentState>(12).fill('idle'), 'waiting', 'stalled', 'working']
    expect(urgentByPage(many)).toEqual([0, 2])
    expect(urgentByPage(['waiting'])).toEqual([1])
  })

  it("takes the start of a reply: Markdown's marks out, whitespace run together, cut short", () => {
    expect(replyStart('## Done\n\nMerged **#12** into `main`.\n')).toBe('Done Merged #12 into main.')
    expect(replyStart('   \n')).toBeUndefined()
    expect(replyStart(null)).toBeUndefined()
    const long = replyStart('word '.repeat(200))!
    expect(long.length).toBeLessThanOrEqual(REPLY_START_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})
