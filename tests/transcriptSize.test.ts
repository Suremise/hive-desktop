import { describe, expect, it } from 'vitest'
import { transcriptSizeInfo } from '../src/shared/defaults'

const MB = 1024 * 1024

describe("a session's transcript size in the Sessions list (#671)", () => {
  it('as the footer shows it', () => {
    expect(transcriptSizeInfo(0, 20)).toEqual({ text: '0 KB', long: false })
    expect(transcriptSizeInfo(300, 20)).toEqual({ text: '1 KB', long: false })
    expect(transcriptSizeInfo(820 * 1024, 20)).toEqual({ text: '820 KB', long: false })
    expect(transcriptSizeInfo(4.1 * MB, 20)).toEqual({ text: '4.1 MB', long: false })
    expect(transcriptSizeInfo(118 * MB, 0).text).toBe('118 MB')
  })

  it('long from the limit on, and never with no limit', () => {
    expect(transcriptSizeInfo(20 * MB - 1, 20).long).toBe(false)
    expect(transcriptSizeInfo(20 * MB, 20).long).toBe(true)
    expect(transcriptSizeInfo(500 * MB, 0).long).toBe(false)
  })

  it('"—" when the file is missing or unreadable, never long', () => {
    for (const missing of [null, undefined, Number.NaN, -1]) expect(transcriptSizeInfo(missing, 1)).toEqual({ text: '—', long: false })
  })
})
