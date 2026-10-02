import { describe, expect, it } from 'vitest'
import { CRASH_LOOP_MS, crashResponse, reloadedMessage } from '../src/main/rendererWatch'

describe('a crashed window', () => {
  it('reloads, unless it crashed again within a minute of the last', () => {
    const now = Date.parse('2026-10-02T12:00:00Z')
    expect(crashResponse(null, now)).toBe('reload')
    expect(crashResponse(now - CRASH_LOOP_MS + 1000, now)).toBe('ask')
    expect(crashResponse(now - CRASH_LOOP_MS, now)).toBe('reload')
  })

  it('says the agents kept running, and what unsaved edits were lost', () => {
    expect(reloadedMessage(0)).toBe('Your agents kept running.')
    expect(reloadedMessage(1)).toBe('Your agents kept running. Unsaved changes to one file were lost.')
    expect(reloadedMessage(3)).toBe('Your agents kept running. Unsaved changes to 3 files were lost.')
  })
})
