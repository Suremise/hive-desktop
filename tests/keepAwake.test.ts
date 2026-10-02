import { describe, expect, it } from 'vitest'
import { agentsWorking, keepAwakeText, shouldKeepAwake } from '../src/shared/keepAwake'
import type { SessionStatus } from '../src/shared/types'

const states = (...s: SessionStatus[]) => s.map((status) => ({ status }))

describe('keeping the PC awake', () => {
  it('counts agents working or waiting on background tasks, not those waiting for you or idle', () => {
    expect(agentsWorking(states('working', 'background', 'waiting', 'finished', 'ready', 'starting'))).toBe(2)
    expect(agentsWorking([])).toBe(0)
  })

  it('holds it while one works: on mains by default, on battery only when set to always', () => {
    expect(shouldKeepAwake(1, 'plugged-in', false)).toBe(true)
    expect(shouldKeepAwake(1, 'plugged-in', true)).toBe(false)
    expect(shouldKeepAwake(1, 'always', true)).toBe(true)
    expect(shouldKeepAwake(3, 'never', false)).toBe(false)
    expect(shouldKeepAwake(0, 'always', false)).toBe(false)
  })

  it('says so in the status bar', () => {
    expect(keepAwakeText(1)).toBe('Keeping the PC awake: 1 agent working')
    expect(keepAwakeText(2)).toBe('Keeping the PC awake: 2 agents working')
  })
})
