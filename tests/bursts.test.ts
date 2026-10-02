import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chimeAllowed, FINISH_GROUP_MAX_MS, FINISH_GROUP_MS, FinishBatcher, finishedNotice, type Finish } from '../src/shared/bursts'

const finish = (project: string, agent: string): Finish => ({ projectPath: `C:\\ws\\${project}`, project, agent, title: `${project} · ${agent} finished`, body: `${agent} is done.` })

describe('chimes', () => {
  it('at most one every 2 seconds', () => {
    expect(chimeAllowed(null, 1000)).toBe(true)
    expect(chimeAllowed(1000, 2500)).toBe(false)
    expect(chimeAllowed(1000, 3000)).toBe(true)
  })
})

describe('finished notifications', () => {
  it('one alone reads as before', () => {
    expect(finishedNotice([finish('hive', 'Claude')])).toEqual({ title: 'hive · Claude finished', body: 'Claude is done.' })
  })

  it('several in one project are named; across projects, counted per project', () => {
    expect(finishedNotice([finish('hive', 'Claude'), finish('hive', 'Codex'), finish('hive', 'Agent 3')])).toEqual({ title: '3 agents finished in hive', body: 'Claude, Codex, Agent 3' })
    expect(finishedNotice([finish('hive', 'Claude'), finish('web', 'One'), finish('hive', 'Codex')])).toEqual({ title: '3 agents finished', body: 'hive (2), web (1)' })
  })

  describe('grouping', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('finishes within a few seconds of each other go together, once they stop coming', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      b.add(finish('hive', 'A'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      b.add(finish('hive', 'B'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      expect(sent).toEqual([])
      vi.advanceTimersByTime(500)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B']])
      // A later one is a new group.
      b.add(finish('web', 'C'))
      vi.advanceTimersByTime(FINISH_GROUP_MS)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B'], ['C']])
    })

    it('a steady stream is told at least every 10 seconds', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      for (let i = 0; i < 8; i++) {
        b.add(finish('hive', `Agent ${i}`))
        vi.advanceTimersByTime(2000)
      }
      expect(sent.length).toBeGreaterThanOrEqual(1)
      expect(sent[0].length).toBe(FINISH_GROUP_MAX_MS / 2000)
    })
  })
})
