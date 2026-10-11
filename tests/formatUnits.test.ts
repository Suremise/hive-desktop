// The window's byte and token formatters (#608): an average under 1 KB printed "160.17241379310346 B", and 12.9 billion
// tokens "12904M". Checked at each unit's boundaries, where a value that rounds up moves to the next unit.
import { describe, expect, it } from 'vitest'
import { formatBytes, formatTokens } from '../src/shared/units'

describe('formatBytes', () => {
  it('shows whole bytes below 1 KB, rounding an average', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(160.17241379310346)).toBe('160 B')
    expect(formatBytes(160.5)).toBe('161 B')
  })

  it('moves to KB at 1024, including an average that rounds up to it', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1023.6)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024 - 1)).toBe('10 KB')
    expect(formatBytes(12 * 1024)).toBe('12 KB')
    expect(formatBytes(1023 * 1024)).toBe('1023 KB')
  })

  it('moves to MB where KB would read 1024', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })
})

describe('formatTokens', () => {
  it('shows whole tokens below 1000, rounding an average', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(412.6)).toBe('413')
    expect(formatTokens(999.6)).toBe('1.0k')
  })

  it('keeps the k and M style', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(99_960)).toBe('100k')
    expect(formatTokens(450_000)).toBe('450k')
    expect(formatTokens(999_400)).toBe('999k')
    expect(formatTokens(5_500_000)).toBe('5.5M')
    expect(formatTokens(12_000_000)).toBe('12M')
  })

  it('moves to the next unit where a value would read 1000 of one', () => {
    expect(formatTokens(999_999)).toBe('1.0M')
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(999_000_000)).toBe('999M')
    expect(formatTokens(999_999_999)).toBe('1.0B')
  })

  it('has a billions tier: one decimal below 100B, whole numbers above', () => {
    expect(formatTokens(1_000_000_000)).toBe('1.0B')
    expect(formatTokens(10_000_000_000)).toBe('10.0B')
    expect(formatTokens(12_904_000_000)).toBe('12.9B')
    expect(formatTokens(150_000_000_000)).toBe('150B')
  })
})
