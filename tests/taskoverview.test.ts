// The board at a glance (Workspace and project Overviews): what taskOverview counts, for one project or all.
import { describe, expect, it } from 'vitest'
import { taskOverview } from '../src/shared/tasks'
import type { TaskCard, TaskColumn } from '../src/shared/types'

let n = 0
const card = (project: string, column: TaskColumn, patch: Partial<TaskCard> = {}): TaskCard => ({ number: ++n, title: `#${n}`, project, column, archived: false, blocked: null, agent: null, order: n, labels: [], ...patch }) as TaskCard
const cards = [
  card('alpha', 'todo'),
  card('Alpha', 'todo', { blocked: 'waiting' }),
  card('alpha', 'doing', { agent: 'gone' }),
  card('alpha', 'review'),
  card('alpha', 'hold'),
  card('alpha', 'passed', { agent: 'gone' }),
  card('alpha', 'done', { blocked: 'old reason' }),
  card('alpha', 'todo', { archived: true }),
  card('beta', 'done'),
  card('', 'todo')
]
const stalled = (c: TaskCard): boolean => c.column === 'doing'

describe('taskOverview', () => {
  it("counts one project's cards (any case), not archived ones, and blocked ones that aren't done", () => {
    expect(taskOverview(cards, 'alpha', stalled)).toEqual({ total: 7, hold: 1, todo: 2, doing: 1, review: 1, passed: 1, done: 1, stalled: 1, blocked: 1 })
  })

  it('counts every card for the whole board, workspace cards included', () => {
    expect(taskOverview(cards, null, stalled)).toEqual({ total: 9, hold: 1, todo: 3, doing: 1, review: 1, passed: 1, done: 2, stalled: 1, blocked: 1 })
  })

  it('a project without cards has none', () => {
    expect(taskOverview(cards, 'gamma', stalled).total).toBe(0)
    expect(taskOverview([], 'alpha', stalled)).toEqual({ total: 0, hold: 0, todo: 0, doing: 0, review: 0, passed: 0, done: 0, stalled: 0, blocked: 0 })
  })
})
