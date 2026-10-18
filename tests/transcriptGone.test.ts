// A live transcript removed or moved between the stat that sizes a read and the open that reads it (#1034): the read
// ends quietly, as when the stat finds none, rather than rejecting (an unhandled rejection in main, from a look nothing
// awaits). stat is wrapped so the file goes the moment it has been statted; the readers run on a Codex session with no
// process.
import { existsSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

/** Paths removed as soon as a stat of them returns. */
const vanish = new Set<string>()
vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  return {
    ...fs,
    stat: (async (p: string, o?: object) => {
      const st = await fs.stat(p, o as never)
      if (vanish.delete(p)) rmSync(p)
      return st
    }) as typeof fs.stat
  }
})

const base = tempDir('hive-transcript-gone-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { sessions } = await import('../src/main/sessions')
const { codex } = await import('../src/main/providers/codex/adapter')

type Reader = (l: unknown, path: string, size?: number) => Promise<unknown>
const s = sessions as unknown as { readSafeguards: Reader; readDetails: Reader; readBackground: Reader }

const line = (timestamp: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp, type: 'event_msg', payload }) + '\n'
const ROLLOUT = line('2026-10-09T10:00:00.000Z', { type: 'task_started', turn_id: 't1' }) + line('2026-10-09T10:00:01.000Z', { type: 'task_complete', turn_id: 't1' })

/** A Codex session's rollout in a file of its own, and the session reading it. */
function session(name: string): { l: unknown; rollout: string } {
  const rollout = join(base, `${name}.jsonl`)
  writeFileSync(rollout, ROLLOUT)
  const state = { provider: 'codex', runId: `run-${name}`, projectPath: join(base, 'p'), agentId: name, sessionId: '00000000-0000-4000-8000-000000000000', status: 'working', startedAt: '2026-10-09T09:00:00.000Z' }
  return { l: { state, adapter: codex, transcriptPath: rollout }, rollout }
}

describe('a transcript that goes while it is read', () => {
  it('ends the safeguard read quietly when it goes between the stat and the open', async () => {
    const { l, rollout } = session('guard')
    vanish.add(rollout)
    await expect(s.readSafeguards(l, rollout)).resolves.toBeUndefined()
    // It went after the stat, not before: the open is what found it gone.
    expect(vanish.has(rollout)).toBe(false)
    expect(existsSync(rollout)).toBe(false)
    expect((l as { guardOffset?: number }).guardOffset).toBeUndefined()
  })

  it('ends the details and background task reads quietly when it went after the stat that sized them', async () => {
    const { l, rollout } = session('details')
    const size = statSync(rollout).size
    rmSync(rollout)
    await expect(s.readDetails(l, rollout, size)).resolves.toBeUndefined()
    await expect(s.readBackground(l, rollout, size)).resolves.toBe(false)
    expect((l as { detailsOffset?: number }).detailsOffset).toBeUndefined()
    expect((l as { tasksOffset?: number }).tasksOffset).toBeUndefined()
  })

  it('still reads a transcript that stays', async () => {
    const { l, rollout } = session('stays')
    await s.readSafeguards(l, rollout)
    expect((l as { guardOffset?: number }).guardOffset).toBe(statSync(rollout).size)
  })
})
