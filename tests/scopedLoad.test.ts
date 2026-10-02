// What a view keeps after a load finishes: results and errors belong to the scope (project, workspace, search) they
// were loaded for. A failed refresh of the same scope keeps the last results; a failure for a new scope has none.
import { describe, expect, it } from 'vitest'
import { settle, type Scoped } from '../src/shared/scoped'

const empty: Scoped<string[]> = { scope: 'alpha', data: null, error: null, at: 0 }

describe('settle', () => {
  it('a load sets the results for its scope and clears an error', () => {
    const failed = { ...empty, error: 'boom' }
    expect(settle(failed, 'alpha', { data: ['a'] }, 100)).toEqual({ scope: 'alpha', data: ['a'], error: null, at: 100 })
  })

  it('a failed refresh of the same scope keeps the last results, from when they were loaded', () => {
    const loaded = settle(empty, 'alpha', { data: ['a'] }, 100)
    expect(settle(loaded, 'alpha', { error: 'boom' }, 200)).toEqual({ scope: 'alpha', data: ['a'], error: 'boom', at: 100 })
  })

  it("a failure for another scope has no results: the last scope's aren't its own", () => {
    const loaded = settle(empty, 'alpha', { data: ['alpha-only'] }, 100)
    expect(settle(loaded, 'beta', { error: 'boom' }, 200)).toEqual({ scope: 'beta', data: null, error: 'boom', at: 0 })
  })

  it("a load for another scope replaces the last scope's results", () => {
    const loaded = settle(empty, 'alpha', { data: ['alpha-only'] }, 100)
    expect(settle(loaded, 'beta', { data: ['b'] }, 200)).toEqual({ scope: 'beta', data: ['b'], error: null, at: 200 })
  })
})
