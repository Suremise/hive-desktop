// A project's agents as a table (#529): lane order (a builder, then its reviewer; running and paused lanes, in the lanes'
// order; then the rest as the project has them) and the "Waiting for" cell from a watch's label.
import { describe, expect, it } from 'vitest'
import { laneOrder, waitingFor, type TableLane } from '../src/shared/agentTable'

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
