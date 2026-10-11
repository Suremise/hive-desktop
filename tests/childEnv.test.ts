// A session's environment (#567): Hive's own HIVE_ variables are dropped from it, but the user's setting for how many
// heavy test runs go at once (HIVE_TEST_HEAVY_SLOTS) reaches the test runs agents start, which is where they all start.
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { heavySlots } from './e2e/slots.mjs'

vi.mock('@lydell/node-pty', () => ({ spawn: () => undefined }))
vi.mock('../src/main/events', () => ({ sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [{ envToStrip: ['CLAUDECODE'] }] }))

const { childEnv } = await import('../src/main/ptyHost')

const set = (vars: Record<string, string>): void => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("a session's environment", () => {
  it('keeps the test-slot count, so the runners an agent starts use it', () => {
    set({ HIVE_TEST_HEAVY_SLOTS: '4' })
    const env = childEnv()
    expect(env.HIVE_TEST_HEAVY_SLOTS).toBe('4')
    expect(heavySlots(env)).toBe(4)
  })

  it("still drops Hive's own HIVE_ variables, the test copies' settings among them, and a session's identity", () => {
    set({ HIVE_TEST_HEAVY_SLOTS: '4', HIVE_API_TOKEN: 'secret', HIVE_AGENT_ID: 'a-1', HIVE_TEST_QUIET: '1', HIVE_TEST_HEAVY_DIR: 'C:/pool', HIVE_USER_DATA: 'C:/profile', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1' })
    const env = childEnv()
    for (const k of ['HIVE_API_TOKEN', 'HIVE_AGENT_ID', 'HIVE_TEST_QUIET', 'HIVE_TEST_HEAVY_DIR', 'HIVE_USER_DATA', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE']) expect(env[k], k).toBeUndefined()
    expect(Object.keys(env).filter((k) => k.startsWith('HIVE_'))).toEqual(['HIVE_TEST_HEAVY_SLOTS'])
  })

  it('is the default count when the user set none, and what the session is given wins', () => {
    vi.stubEnv('HIVE_TEST_HEAVY_SLOTS', undefined)
    expect(heavySlots(childEnv())).toBe(2)
    set({ HIVE_TEST_HEAVY_SLOTS: '4' })
    expect(childEnv({ HIVE_TEST_HEAVY_SLOTS: '1' }).HIVE_TEST_HEAVY_SLOTS).toBe('1')
  })
})
