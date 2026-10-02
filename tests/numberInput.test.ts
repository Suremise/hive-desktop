import { describe, expect, it } from 'vitest'
import { parseNumberDraft, rangeText } from '../src/shared/numberInput'

describe('number settings', () => {
  const range = { min: 1000, max: 100000 }

  it('treats a cleared box as an unfinished edit, not 0', () => {
    expect(parseNumberDraft('', range)).toEqual({ kind: 'blank' })
    expect(parseNumberDraft('   ', range, { off: true })).toEqual({ kind: 'blank' })
  })

  it('rejects text a number box could not read, which it reports as empty', () => {
    expect(parseNumberDraft('', range, { badInput: true })).toEqual({ kind: 'invalid', message: 'Enter a number. Between 1,000 and 100,000.' })
    expect(parseNumberDraft('abc', range).kind).toBe('invalid')
  })

  it('rejects values out of range with the range in words', () => {
    expect(parseNumberDraft('999', range)).toEqual({ kind: 'invalid', message: 'Between 1,000 and 100,000.' })
    expect(parseNumberDraft('100001', range).kind).toBe('invalid')
    expect(parseNumberDraft('0', range)).toEqual({ kind: 'invalid', message: 'Between 1,000 and 100,000.' })
  })

  it('accepts 0 where it is the Off value, even below the minimum', () => {
    expect(parseNumberDraft('0', range, { off: true })).toEqual({ kind: 'value', value: 0 })
  })

  it('rounds and accepts values in range', () => {
    expect(parseNumberDraft(' 5000.4 ', range)).toEqual({ kind: 'value', value: 5000 })
    expect(parseNumberDraft('1000', range)).toEqual({ kind: 'value', value: 1000 })
  })

  it('words open ranges', () => {
    expect(rangeText({ min: 1 })).toBe('1 or more')
    expect(rangeText({ max: 5 })).toBe('5 or less')
  })
})
