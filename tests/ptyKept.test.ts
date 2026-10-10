// What ptyHost keeps per terminal key after its process has gone (#489, from #486): the pane's last size, so the next
// process in that terminal (a restart, a resume) starts at it, and a quiet exit's output, for the process that
// continues there. Both stay bounded however many keys come and go, never dropping a running terminal's, and a
// removed agent's or project's are forgotten at once.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { agentPtyKey } from '../src/shared/defaults'
import { forgetPtys, keptPtyCounts, killPty, PTY_COLS, PTY_ROWS, resizePty, setPtyKeptLimitsForTests, spawnPty, startSize } from '../src/main/ptyHost'

vi.mock('../src/main/events', () => ({ emit: () => undefined, sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [] }))

const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('HIVE_')) env[k] = v
const DEFAULT = { cols: PTY_COLS, rows: PTY_ROWS }

describe('the sizes kept for terminals', () => {
  const running = 'session:c:\\proj\\running#a-live'
  afterAll(() => killPty(running))

  it('stay bounded as new keys keep coming, keeping the newest and a running terminal\u2019s', async () => {
    // A terminal with a process, sized first, so it is the oldest when the others come.
    const started = new Promise<void>((resolve) => {
      spawnPty(running, { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), env, onData: () => resolve() })
      setTimeout(resolve, 3000)
    })
    resizePty(running, 150, 40)
    await started
    for (let i = 0; i < 1000; i++) resizePty(agentPtyKey(`C:\\ws${i}\\p`, `a-${i}`), 80 + (i % 50), 24)
    // 200 stopped terminals' sizes, plus the running one's on top.
    expect(keptPtyCounts().sizes).toBe(201)
    // The newest are kept; the oldest went; the running terminal's stayed though it was set first.
    expect(startSize(agentPtyKey('C:\\ws999\\p', 'a-999'))).toEqual({ cols: 80 + (999 % 50), rows: 24 })
    expect(startSize(agentPtyKey('C:\\ws0\\p', 'a-0'))).toEqual(DEFAULT)
    expect(startSize(running)).toEqual({ cols: 150, rows: 40 })
  }, 20000)

  it('give a restarted terminal its pane\u2019s last size', () => {
    const key = agentPtyKey('C:\\keep\\p', 'a-keep')
    resizePty(key, 120, 30)
    resizePty(key, 133, 37)
    for (let i = 0; i < 50; i++) resizePty(agentPtyKey('C:\\other\\p', `a-${i}`), 90, 25)
    expect(startSize(key)).toEqual({ cols: 133, rows: 37 })
  })

  it("forget a removed agent's, and all of a removed project's, but no other project's", () => {
    const one = agentPtyKey('C:\\ws\\site', 'a-1')
    const two = agentPtyKey('C:\\ws\\site', 'a-2')
    const other = agentPtyKey('C:\\ws\\site-two', 'a-1')
    for (const k of [one, two, other]) resizePty(k, 100, 30)
    forgetPtys(one)
    expect(startSize(one)).toEqual(DEFAULT)
    expect(startSize(two)).toEqual({ cols: 100, rows: 30 })
    forgetPtys(agentPtyKey('C:\\ws\\site', ''))
    expect(startSize(two)).toEqual(DEFAULT)
    // site-two's key starts with "site" too, but not with site's prefix (which ends in #).
    expect(startSize(other)).toEqual({ cols: 100, rows: 30 })
  })
})

describe.runIf(process.platform === 'win32')('more running terminals than the bound', () => {
  afterAll(() => setPtyKeptLimitsForTests())

  it('are all kept while they run, and trimmed to the most recent stopped ones as they exit, with no resize after', async () => {
    setPtyKeptLimitsForTests({ sizes: 3, carried: 20 })
    forgetPtys('session:c:\\burst')
    const keys = Array.from({ length: 6 }, (_, i) => agentPtyKey('C:\\burst\\p', `a-${i}`))
    const exits = keys.map(
      (key, i) =>
        new Promise<void>((resolve) => {
          spawnPty(key, { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), env, onExit: () => resolve() })
          resizePty(key, 100 + i, 30)
        })
    )
    // Running, each keeps its size although six is over the bound.
    for (const [i, key] of keys.entries()) expect(startSize(key)).toEqual({ cols: 100 + i, rows: 30 })
    for (const key of keys) killPty(key)
    await Promise.all(exits)
    // Stopped, at most three stopped terminals' sizes remain: the three set last.
    expect(keptPtyCounts().sizes).toBeLessThanOrEqual(3)
    expect(keys.slice(3).map((k) => startSize(k))).toEqual([3, 4, 5].map((i) => ({ cols: 100 + i, rows: 30 })))
    expect(keys.slice(0, 3).every((k) => startSize(k).cols === PTY_COLS)).toBe(true)
  }, 60000)
})

describe.runIf(process.platform === 'win32')('the output kept from quiet exits', () => {
  it('stays bounded as terminals come and go', async () => {
    for (let i = 0; i < 24; i++) {
      await new Promise<void>((resolve) => spawnPty(`task:quiet-${i}`, { file: process.execPath, args: ['-e', `console.log('run ${i}')`], cwd: process.cwd(), env, quietExit: true, onExit: () => resolve() }))
    }
    expect(keptPtyCounts().carried).toBeLessThanOrEqual(20)
  }, 120000)
})
