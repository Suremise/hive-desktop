// The usage history's import and what relies on it (#1106 round 2): an import that couldn't finish isn't recorded as done
// (nothing retired, its fallbacks kept) and the next try imports what is left; a record's kept usage wins over a stale
// backup that counted less; a session deleted before the import reached it, or whose use can't be recorded, keeps what
// it used; the Overview reads a running session from the history, not its transcript.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { priceUsage } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionListItem, SessionUsage } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-usage-backfill-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { newUsageParser } = await import('../src/main/usageParsers')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const at = new Date(T0).toISOString()
let n = 0
const newId = (): string => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`

const transcript = (sid: string, outputs: number[]): string =>
  JSON.stringify({ type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: 'Task' } }) + '\n' + outputs.map((o, i) => JSON.stringify({ type: 'assistant', sessionId: sid, requestId: `r${i}`, timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: o } } }) + '\n').join('')
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const backup = (id: string): string => join(p, '.hive', 'sessions', `${id}.jsonl`)
const keptUsage = (sid: string, outputs: number[]): SessionUsage => {
  const parser = newUsageParser('claude-code', sid)!
  parser.feed(transcript(sid, outputs))
  return { ...priceUsage(parser.result(), DEFAULT_SETTINGS), lastPrompt: null }
}
const outputOf = (items: SessionListItem[], id: string): number | undefined => items.find((i) => i.id === id)?.usage?.outputTokens
const cliLookup = vi.spyOn(sessions, 'providerTranscript')
const cache = join(base, 'profile', 'usage-cache.json')

describe("the usage history's import", () => {
  const stale = newId()
  const keptOnly = newId()
  const deleted = newId()
  const deletedEarly = newId()

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    mkdirSync(join(base, 'profile'), { recursive: true })
    writeFileSync(cache, '{"version":"0.9.3","entries":[]}')
    cliLookup.mockImplementation(async () => null)
    // A record whose backup is stale (10) while its kept usage counted 500; one with only its kept usage; a deleted one.
    write(backup(stale), transcript(stale, [10]))
    write(
      join(p, '.hive', 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          { id: stale, agent: 'claude-code', agentId: 'c1', name: 'stale backup', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(stale, [500]) },
          { id: keptOnly, agent: 'claude-code', agentId: 'c1', name: 'kept only', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(keptOnly, [70]) },
          { id: deletedEarly, agent: 'claude-code', agentId: 'c1', name: 'deleted before the import', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(deletedEarly, [40]) }
        ],
        deleted: [deleted],
        deletedUsage: [{ id: deleted, provider: 'claude-code', agentId: 'c1', name: 'deleted', cwd: p, usage: keptUsage(deleted, [300]) }]
      })
    )
    usageHistory.start()
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    cliLookup.mockRestore()
    await disposeWorkspaceService(w)
    await usageHistory.stop()
  })

  it('a session deleted before the import reaches it keeps what it used (its kept usage recorded first)', async () => {
    await run(() => sessions.delete(p, deletedEarly))
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((s) => s.id === deletedEarly)).toBe(false)
    expect(outputOf(await run(() => sessions.keptUsage(p)), deletedEarly)).toBe(40)
  })

  it("isn't recorded as done when a session fails to import: nothing is retired, and the next try imports what is left", async () => {
    const h = usageHistory as unknown as { importKept: (...a: unknown[]) => Promise<unknown> }
    const real = h.importKept.bind(usageHistory)
    // The deleted session's import fails (the worker ended, a write another Hive held).
    const fail = vi.spyOn(h, 'importKept').mockImplementation((host, k, ...rest) => ((k as { id: string }).id === deleted ? Promise.reject(new Error('the usage worker ended')) : real(host, k, ...rest)))
    await run(() => usageHistory.opened(w))
    fail.mockRestore()
    expect(usageHistory.progressOf(wsPath).importing).toBe(true)
    expect(usageHistory.backfilled(wsPath)).toBe(false)
    expect(existsSync(cache)).toBe(true)
    // Meanwhile the deleted session still counts, from what an older Hive kept.
    expect(outputOf(await run(() => sessions.keptUsage(p)), deleted)).toBe(300)
    // Tried again (the next open, or the ten-minute tick): what is left is imported, and it's done.
    await run(() => usageHistory.opened(w))
    expect(usageHistory.backfilled(wsPath)).toBe(true)
    expect(existsSync(cache)).toBe(false)
    const items = await run(() => sessions.usageItems(p))
    expect(outputOf(items, deleted)).toBe(300)
    expect(outputOf(items, keptOnly)).toBe(70)
  })

  it("a record's kept usage wins over a stale backup that counted less", async () => {
    expect(outputOf(await run(() => sessions.usageItems(p)), stale)).toBe(500)
  })

  it("a session whose use can't be recorded isn't deleted, nor its copies", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'keep me', lastActiveAt: at }))
    write(backup(id), transcript(id, [20]))
    const busy = vi.spyOn(usageHistory, 'ingest').mockResolvedValue({ status: 'busy' })
    const err = await run(() => sessions.delete(p, id)).catch((e) => e)
    busy.mockRestore()
    expect(String(err)).toMatch(/couldn't read what the session used/)
    expect(existsSync(backup(id))).toBe(true)
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((s) => s.id === id)).toBe(true)
  })

  it("reads a running session from the history: its transcript isn't read for the Overview", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'running', lastActiveAt: at }))
    write(backup(id), transcript(id, [15]))
    await usageHistory.ingest(p, id, { priority: 1, keepState: 'running' })
    const s = sessions as unknown as { live: Map<string, unknown> }
    s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-r', projectPath: p, agentId: 'c1', sessionId: id, status: 'working' } })
    const reads = vi.spyOn(sessions, 'anyTranscript')
    const usageFor = vi.spyOn(sessions as unknown as { usageFor: () => Promise<unknown> }, 'usageFor')
    try {
      expect(outputOf(await run(() => sessions.usageItems(p)), id)).toBe(15)
      expect(reads).not.toHaveBeenCalled()
      expect(usageFor).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      usageFor.mockRestore()
      s.live.clear()
    }
  })
})
