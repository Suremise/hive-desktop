// A workspace's metrics file has one writer at a time, across workspace lifetimes: a save still going after the
// workspace closed (held here at the write) is followed, not overtaken, by what a reopened workspace does next (a
// Reset, new records), whether it is reopened by the same window, another window, or by its path written in other case.
// The gate is a hook on fsutil's atomic write of metrics.json.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'

const gate: { hold: Promise<void> | null } = { hold: null }
vi.mock('../src/main/fsutil', async (original) => {
  const real = await original<typeof import('../src/main/fsutil')>()
  return {
    ...real,
    writeTextAtomic: async (path: string, text: string) => {
      if (gate.hold && path.endsWith('metrics.json')) {
        const h = gate.hold
        gate.hold = null
        await h
      }
      return real.writeTextAtomic(path, text)
    }
  }
})

const base = mkdtempSync(join(tmpdir(), 'hive-metrics-race-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const metrics = await import('../src/main/metrics')
const api = { route: '/v1/tasks', method: 'GET', role: 'agent' as const, outcome: 'ok' as const, requestBytes: 1, responseBytes: 1, ms: 1 }
metrics.knownRoute('/v1/tasks')

let n = 0
async function scenario(reopen: (path: string, first: ReturnType<typeof createWorkspaceService>) => Promise<ReturnType<typeof createWorkspaceService>>) {
  const path = join(base, `ws-${++n}`)
  mkdirSync(path, { recursive: true })
  const w = createWorkspaceService()
  await w.open(path)
  metrics.recordApi(metrics.metricsHandle(w), 'alpha', api)
  metrics.recordApi(metrics.metricsHandle(w), 'alpha', api)
  // The closing save is held at its write.
  let release!: () => void
  gate.hold = new Promise<void>((r) => (release = r))
  await w.close()
  await new Promise((r) => setTimeout(r, 50))
  const again = await reopen(path, w)
  metrics.resetMetrics(again)
  metrics.recordApi(metrics.metricsHandle(again), 'beta', api)
  // Long enough for a write that isn't queued behind the held one to finish first: then the held one, released, would
  // be the last to land (the bug this guards against).
  await new Promise((r) => setTimeout(r, 300))
  release()
  await metrics.flushMetrics()
  const saved = readFileSync(join(path, '.hive', 'metrics', 'metrics.json'), 'utf8')
  const q = metrics.queryMetrics(again, { scope: { kind: 'workspace' } })
  return { saved, q, again, w }
}

describe('one writer per metrics file', () => {
  it('reopened by the same window while its last save is held: Reset and new records come after it', async () => {
    const r = await scenario(async (path, w) => (await w.open(path), w))
    expect(Object.keys(r.q.projects)).toEqual(['beta'])
    expect(r.saved).not.toContain('"alpha"')
    expect(r.saved).toContain('"beta"')
    await disposeWorkspaceService(r.w)
  })

  it('reopened by another window, by its path in other case: the same order', async () => {
    const r = await scenario(async (path) => {
      const other = createWorkspaceService()
      await other.open(process.platform === 'win32' ? path.toUpperCase() : path)
      return other
    })
    expect(Object.keys(r.q.projects)).toEqual(['beta'])
    expect(r.saved).not.toContain('"alpha"')
    expect(r.saved).toContain('"beta"')
    await disposeWorkspaceService(r.again)
    await disposeWorkspaceService(r.w)
  })

  it('a handle from the closed lifetime still records nothing, even though the store is the same', async () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(path, { recursive: true })
    const w = createWorkspaceService()
    await w.open(path)
    const old = metrics.metricsHandle(w)
    await w.close()
    await w.open(path)
    metrics.recordApi(old, 'alpha', api)
    expect(Object.keys(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).projects)).toEqual([])
    await disposeWorkspaceService(w)
  })
})
