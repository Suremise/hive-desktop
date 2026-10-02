import { describe, expect, it } from 'vitest'
import { badgeDescription, badgeText, shouldFlash, windowTitle } from '../src/shared/taskbar'

describe('taskbar button', () => {
  it('the badge: nothing at 0, the number, 9+ above 9', () => {
    expect([0, 1, 9, 10, 42].map(badgeText)).toEqual(['', '1', '9', '9+', '9+'])
    expect(badgeDescription(1)).toBe('1 agent needs you')
    expect(badgeDescription(3)).toBe('3 agents need you')
  })

  it('the title starts with the count when there is one', () => {
    expect(windowTitle('alpha — work — Hive', 2)).toBe('(2) alpha — work — Hive')
    expect(windowTitle('work — Hive', 0)).toBe('work — Hive')
  })

  it('flashes when an agent comes to ask you something while the window is in the background, not on repeats', () => {
    // Asked: waiting, or a question it works on beside (asksYou); finishing isn't asking.
    expect(shouldFlash(false, true, false, true)).toBe(true)
    expect(shouldFlash(true, true, false, true)).toBe(false)
    expect(shouldFlash(false, false, false, true)).toBe(false)
    expect(shouldFlash(false, true, true, true)).toBe(false)
    expect(shouldFlash(false, true, false, false)).toBe(false)
  })
})
