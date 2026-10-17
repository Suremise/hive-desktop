// A session's environment (#567, #589): Hive's own HIVE_ variables are dropped from it. SESSION_SETTINGS names the ones a
// session keeps on purpose, none today: the test-slot count is the test folder's config.json, which needs no passing on.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lydell/node-pty', () => ({ spawn: () => undefined }))
vi.mock('../src/main/events', () => ({ sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [{ envToStrip: ['CLAUDECODE'] }] }))

const { childEnv, SESSION_SETTINGS } = await import('../src/main/ptyHost')

const set = (vars: Record<string, string>): void => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("a session's environment", () => {
  it("drops every HIVE_ variable while the list is empty: Hive's own, the test copies' settings and the slot count, and a session's identity", () => {
    expect([...SESSION_SETTINGS]).toEqual([])
    set({ HIVE_TEST_HEAVY_SLOTS: '4', HIVE_API_TOKEN: 'secret', HIVE_AGENT_ID: 'a-1', HIVE_TEST_QUIET: '1', HIVE_TEST_HEAVY_DIR: 'C:/pool', HIVE_USER_DATA: 'C:/profile', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crashpad_1_X', HIVE_TEST_SOMETHING_ELSE: 'x' })
    const env = childEnv()
    expect(Object.keys(env).filter((k) => k.startsWith('HIVE_'))).toEqual([])
    // Hive's crash handler (#985) too: an app the agent starts keeps its crashes to itself.
    for (const k of ['CLAUDECODE', 'ELECTRON_RUN_AS_NODE', 'CHROME_CRASHPAD_PIPE_NAME']) expect(env[k], k).toBeUndefined()
  })

  it('keeps a name added to the list, and only that one; what the session is given wins', () => {
    set({ HIVE_KEPT_FOR_TEST: 'yes', HIVE_API_TOKEN: 'secret' })
    SESSION_SETTINGS.add('HIVE_KEPT_FOR_TEST')
    try {
      const env = childEnv()
      expect(Object.keys(env).filter((k) => k.startsWith('HIVE_'))).toEqual(['HIVE_KEPT_FOR_TEST'])
      expect(childEnv({ HIVE_KEPT_FOR_TEST: 'given' }).HIVE_KEPT_FOR_TEST).toBe('given')
    } finally {
      SESSION_SETTINGS.delete('HIVE_KEPT_FOR_TEST')
    }
    expect(childEnv().HIVE_KEPT_FOR_TEST).toBeUndefined()
  })
})
