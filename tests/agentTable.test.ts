// A project's agents as a table (#529): lane order (a builder, then its reviewer; running and paused lanes, in the lanes'
// order; then the rest as the project has them) and the "Waiting for" cell from a watch's label.
import { describe, expect, it } from 'vitest'
import { agentCardText, cardsText, laneOrder, waitingFor, type TableLane } from '../src/shared/agentTable'
import { agentRowCards } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'

const agents = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3', 'Solo'].map((id) => ({ id }))
const lane = (b: string, r: string | null, state: TableLane['state'] = 'active'): TableLane => ({ state, builder: { agentId: b }, reviewer: r ? { agentId: r } : null })
const ids = (l: { id: string }[]): string => l.map((a) => a.id).join(',')

describe('the agents table order', () => {
  it('without lanes is the project order', () => {
    expect(ids(laneOrder(agents, []))).toBe('B1,B2,B3,R1,R2,R3,Solo')
  })
  it('puts each lane’s builder and reviewer together, in the lanes’ order, then the rest', () => {
    expect(ids(laneOrder(agents, [lane('B2', 'R2'), lane('B1', 'R1', 'paused')]))).toBe('B2,R2,B1,R1,B3,R3,Solo')
  })
  it('leaves out ended and abandoned lanes', () => {
    expect(ids(laneOrder(agents, [lane('B3', 'R3', 'ended'), lane('B2', 'R2', 'abandoned'), lane('B1', 'R1')]))).toBe('B1,R1,B2,B3,R2,R3,Solo')
  })
  it('places an agent once (a reviewer of two lanes goes with the first), a lane without a reviewer alone, an agent not in the project nowhere', () => {
    expect(ids(laneOrder(agents, [lane('B1', 'R1'), lane('B2', 'R1'), lane('B3', null), lane('Gone', 'R3')]))).toBe('B1,R1,B2,B3,R3,R2,Solo')
  })
})

describe('the Waiting for cell', () => {
  it('is the watch without its words', () => {
    expect(waitingFor({ label: 'Waiting for #506, #509 → Review' })).toBe('#506, #509 → Review')
    expect(waitingFor({ label: 'Waiting for B6 to finish' })).toBe('B6 to finish')
    expect(waitingFor(undefined)).toBe('')
  })
})

describe("an agent's Card cell (#572: the confirms, the quit dialog and the status bar too)", () => {
  const card = (over: Partial<TaskCard>): TaskCard => ({ number: 7, title: 'A card', description: '', project: 'alpha', agent: null, column: 'todo', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-10-06T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-06T00:00:00.000Z', ...over })

  it('names the first card, and how many more', () => {
    expect(cardsText([])).toBe('')
    expect(cardsText([{ number: 4, title: 'Attention inbox' }])).toBe('#4 Attention inbox')
    expect(cardsText([{ number: 4, title: 'Attention inbox' }, { number: 5, title: 'Next' }])).toBe('#4 Attention inbox +1')
  })

  it("is the card it works on in Doing, else the one it reviews, of its own project; '' for none", () => {
    const board = [
      card({ number: 1, title: 'Build it', column: 'doing', agent: 'b1' }),
      card({ number: 2, title: 'Check it', column: 'review', agent: 'b2', review: { agent: 'r1', agentName: 'R1', since: '2026-10-06T00:00:00.000Z' } }),
      card({ number: 3, title: 'Elsewhere', column: 'doing', agent: 'b1', project: 'beta' }),
      card({ number: 4, title: 'Old', column: 'doing', agent: 'b3', archived: true })
    ]
    expect(agentCardText(board, 'alpha', 'b1')).toBe('#1 Build it')
    expect(agentCardText(board, 'Alpha', 'r1')).toBe('reviewing #2 Check it')
    expect(agentCardText(board, 'beta', 'b1')).toBe('#3 Elsewhere')
    expect(agentCardText(board, 'alpha', 'b3')).toBe('')
    expect(agentCardText(board, 'alpha', 'nobody')).toBe('')
  })
})

describe("an agent's row in the focus view's strip (#1021: its card chip)", () => {
  const card = (number: number, over: Partial<TaskCard>): TaskCard => ({ number, title: `Card ${number}`, description: '', project: 'alpha', agent: null, column: 'todo', order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-10-17T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-17T00:00:00.000Z', ...over })
  const review = (agent: string) => ({ agent, agentName: agent, since: '2026-10-17T00:00:00.000Z' })
  const rows = (cards: TaskCard[], agent: string): string => agentRowCards(cards, 'ALPHA', agent).map((r) => `${r.card.number}${r.reviewing ? 'r' : ''}`).join(',')

  it('names what it works on, then reviews, then holds in Review, then in Passed', () => {
    const board = [card(1, { agent: 'b1', column: 'passed' }), card(2, { agent: 'b1', column: 'review', review: review('r1') }), card(3, { agent: 'b2', column: 'review', review: review('b1') }), card(4, { agent: 'b1', column: 'doing' })]
    expect(rows(board, 'b1')).toBe('4,3r,2,1')
    expect(rows(board.slice(0, 3), 'b1')).toBe('3r,2,1')
    expect(rows(board.slice(0, 2), 'b1')).toBe('2,1')
    expect(rows(board, 'r1')).toBe('2r')
  })

  it('leaves out Todo, On Hold and Done, archived cards and other projects', () => {
    const board = [card(1, { agent: 'b1', column: 'todo' }), card(2, { agent: 'b1', column: 'hold' }), card(3, { agent: 'b1', column: 'done' }), card(4, { agent: 'b1', column: 'passed', archived: true }), card(5, { agent: 'b1', column: 'doing', project: 'beta' })]
    expect(rows(board, 'b1')).toBe('')
  })
})
