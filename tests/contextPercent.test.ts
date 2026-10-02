import { describe, expect, it } from 'vitest'
import { contextPercent } from '../src/shared/defaults'

describe('context as a percentage of the window', () => {
  it('only from a window the CLI reported, rounded, at most 100', () => {
    expect(contextPercent(84_000, 200_000)).toBe(42)
    expect(contextPercent(84_000, 1_000_000)).toBe(8)
    expect(contextPercent(84_000, null)).toBeNull()
    expect(contextPercent(84_000, 0)).toBeNull()
    expect(contextPercent(250_000, 200_000)).toBe(100)
    expect(contextPercent(0, 200_000)).toBe(0)
  })
})
