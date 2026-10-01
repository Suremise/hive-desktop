// An agent's footer usage after switching conversations: the previous one's numbers never show for the new one, with
// late answers (in any order) and failed refreshes.
import { describe, expect, it } from 'vitest'
import { afterRefresh, usageFor, type HeldUsage } from '../src/shared/liveUsage'
import type { SessionUsage } from '../src/shared/types'

const usage = (contextTokens: number): SessionUsage => ({ contextTokens }) as SessionUsage
const A = 'D:\\ws\\alpha#session-a'
const B = 'D:\\ws\\alpha#session-b'

describe('live usage', () => {
  it("shows a session's own usage, and nothing (pending) for another until its own arrives", () => {
    const held = afterRefresh(null, A, { usage: usage(84_000) })
    expect(usageFor(held, A).usage?.contextTokens).toBe(84_000)
    // Switched to B: A's numbers are not B's.
    expect(usageFor(held, B)).toEqual({ usage: null, pending: true })
    const b = afterRefresh(held, B, { usage: usage(1_000) })
    expect(usageFor(b, B).usage?.contextTokens).toBe(1_000)
  })

  it("ignores A's late answer once B is shown, in either order", () => {
    // B's answer first, then A's (a refresh started before the switch) arrives late.
    let held: HeldUsage | null = afterRefresh(null, B, { usage: usage(1_000) })
    held = afterRefresh(held, A, { usage: usage(84_000) })
    expect(usageFor(held, B)).toEqual({ usage: null, pending: true })
    // Whatever B reads next shows, never A's.
    held = afterRefresh(held, B, { usage: usage(2_000) })
    expect(usageFor(held, B).usage?.contextTokens).toBe(2_000)
  })

  it('a failed refresh keeps the same session\'s numbers, marked stale, and never shows another\'s', () => {
    const a = afterRefresh(null, A, { usage: usage(84_000) })
    const failedA = afterRefresh(a, A, { failed: true })
    expect(usageFor(failedA, A).usage).toMatchObject({ contextTokens: 84_000, stale: true })
    // B's first read fails: B shows nothing of A's.
    const failedB = afterRefresh(a, B, { failed: true })
    expect(usageFor(failedB, B)).toEqual({ usage: null, pending: true })
    // A read that works afterwards is fresh again.
    expect(usageFor(afterRefresh(failedA, A, { usage: usage(90_000) }), A).usage).toEqual(usage(90_000))
  })

  it('a session with no usage yet is read (not pending) and shows nothing', () => {
    const held = afterRefresh(null, B, { usage: null })
    expect(usageFor(held, B)).toEqual({ usage: null, pending: false })
    expect(usageFor(held, null)).toEqual({ usage: null, pending: false })
  })
})
