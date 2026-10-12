import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { sessionSourceId, type ConsoleSource } from '../src/shared/devConsole'
import { parseRecording, recordingName } from '../src/shared/consoleFixtures.mts'

// Recording a console source (#638), the service itself: one recording per window, only while the window still wants
// it (a start overtaken by a close, a stop or a newer start records nothing, whenever it is overtaken); a file each,
// reserved however many starts come at once; stopping writes what was captured up to then before the end line and
// nothing after; the newest recording by when it started. Hive's profile folder is a new temp folder of this file's.
vi.mock('electron', async () => {
  const { tempDir } = await import('./tempDir')
  const profile = tempDir('hive-recorder-')
  return { app: { getPath: () => profile, getVersion: () => '0.7.0-test' } }
})
// A file open can be made to fail once (a recordings folder Hive can't write to).
const openFails = vi.hoisted(() => ({ next: false }))
vi.mock('fs/promises', async (original) => {
  const fsp = await original<typeof import('fs/promises')>()
  return {
    ...fsp,
    open: (...args: Parameters<typeof fsp.open>) => {
      if (!openFails.next) return fsp.open(...args)
      openFails.next = false
      return Promise.reject(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }))
    }
  }
})
vi.mock('../src/main/providerService', () => ({ providerService: { all: () => ({ 'claude-code': { version: '2.1.296', tested: { version: '2.1.296' } } }) } }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined }), userText: (t: unknown) => String(t) }))

const { devConsole } = await import('../src/main/devConsole')
const { latestRecording, recordingOf, recordingsDir, startRecording, stopRecording } = await import('../src/main/consoleRecorder')

const HUNG_MS = 10000
const alpha = join('C:\\', 'work', 'alpha')
const A1 = sessionSourceId(alpha, 'a1')
const source: ConsoleSource = { id: A1, kind: 'session', label: 'alpha · B1', workspacePath: join('C:\\', 'work'), projectPath: alpha, agentId: 'a1', provider: 'claude-code', capturing: false, events: 0 }

let nextId = 1000
/** A window's page as the recorder sees it: an id, sent events, and its close. */
function fakePage(): WebContents & { close: () => void; sent: unknown[] } {
  const e = new EventEmitter() as EventEmitter & { id: number; destroyed: boolean; sent: unknown[] }
  e.id = nextId++
  e.destroyed = false
  e.sent = []
  return Object.assign(e, {
    isDestroyed: () => e.destroyed,
    send: (_c: string, ev: unknown) => e.sent.push(ev),
    close: () => {
      e.destroyed = true
      e.emit('destroyed')
    }
  }) as unknown as WebContents & { close: () => void; sent: unknown[] }
}

const hook = (name: string) => () => ({ kind: 'hook' as const, name, summary: name, raw: { hook_event_name: name } })
const files = (): string[] => readdirSync(recordingsDir()).filter((n) => n.endsWith('.jsonl'))
const lines = (file: string) => parseRecording(readFileSync(file, 'utf8'))
const recordingSubs = (): number => devConsole.stats().subscribers
const pages: ReturnType<typeof fakePage>[] = []
const page = (): ReturnType<typeof fakePage> => {
  const p = fakePage()
  pages.push(p)
  return p
}

afterEach(async () => {
  for (const p of pages.splice(0)) if (!p.isDestroyed()) p.close()
  await vi.waitFor(() => expect(recordingSubs()).toBe(0), { timeout: HUNG_MS })
})

describe('starting', () => {
  it('records a watched source to a file with its header, and stops with its end line', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    expect(info).toMatchObject({ recording: true, includeText: false, events: 0, kind: 'session' })
    devConsole.capture([A1], hook('Stop'))
    const done = await stopRecording(wc.id, 'stopped')
    const r = lines(info.file)
    expect(r.header).toMatchObject({ type: 'recording', hive: '0.7.0-test', text: false, clis: [{ provider: 'claude-code', version: '2.1.296', tested: '2.1.296' }] })
    expect(r.events.map((e) => e.name)).toEqual(['Stop'])
    expect(r.end).toMatchObject({ events: 1, reason: 'stopped' })
    expect(done).toMatchObject({ recording: false, events: 1, reason: 'stopped' })
  })

  it('never records for a window closed while its start was on its way, at any point', async () => {
    // Closed before the start got going.
    const early = page()
    const first = startRecording(early, source, 'c:\\work', false, () => true)
    early.close()
    await expect(first).rejects.toThrow(/cancelled/)
    // Closed after its file was made (the check after the awaits): the file ends empty, and nothing is subscribed.
    const late = page()
    let calls = 0
    const second = startRecording(late, source, 'c:\\work', true, () => {
      if (++calls === 2) late.close()
      return true
    })
    await expect(second).rejects.toThrow(/cancelled/)
    expect(recordingOf(late.id)).toBeNull()
    expect(devConsole.sourcesOf(`record:${late.id}`)).toEqual([])
    devConsole.capture([A1], hook('PreToolUse'))
    const made = files().map((n) => lines(join(recordingsDir(), n))).find((r) => r.header?.text === true && r.end?.reason === 'closed' && r.events.length === 0)
    expect(made).toBeTruthy()
  })

  it('a stop or another source while a start is on its way cancels it', async () => {
    const wc = page()
    const pending = startRecording(wc, source, 'c:\\work', false, () => true)
    const stopped = stopRecording(wc.id, 'stopped')
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(await stopped).toBeNull()
    let watching = true
    const other = startRecording(wc, source, 'c:\\work', false, () => watching)
    watching = false
    await expect(other).rejects.toThrow(/cancelled/)
    expect(recordingOf(wc.id)).toBeNull()
  })

  it('two starts at once in a window: the newer one records, once, in a file of its own', async () => {
    const wc = page()
    const before = new Set(files())
    const [a, b] = await Promise.allSettled([startRecording(wc, source, 'c:\\work', false, () => true), startRecording(wc, source, 'c:\\work', true, () => true)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(recordingOf(wc.id)?.includeText).toBe(true)
    expect(devConsole.sourcesOf(`record:${wc.id}`)).toEqual([A1])
    await stopRecording(wc.id, 'stopped')
    expect(files().filter((n) => !before.has(n))).toHaveLength(1)
  })

  it('starts in two windows in the same moment get two files', async () => {
    const [one, two] = [page(), page()]
    const [a, b] = await Promise.all([startRecording(one, source, 'c:\\work', false, () => true), startRecording(two, source, 'c:\\work', false, () => true)])
    expect(a.name).not.toBe(b.name)
    await Promise.all([stopRecording(one.id, 'stopped'), stopRecording(two.id, 'stopped')])
    expect(lines(a.file).end?.reason).toBe('stopped')
    expect(lines(b.file).end?.reason).toBe('stopped')
  })

  it("a start whose file can't be made fails, and records nothing", async () => {
    const wc = page()
    openFails.next = true
    await expect(startRecording(wc, source, 'c:\\work', false, () => true)).rejects.toThrow(/EACCES/)
    expect(recordingOf(wc.id)).toBeNull()
    expect(devConsole.sourcesOf(`record:${wc.id}`)).toEqual([])
  })
})

describe('stopping', () => {
  it('writes what was captured up to the stop, even still queued, and nothing after', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('PostToolUse'))
    devConsole.capture([A1], hook('Stop'))
    // In the same task: both are still in the recording's queue.
    const stopped = stopRecording(wc.id, 'stopped')
    devConsole.capture([A1], hook('SessionEnd'))
    await stopped
    const r = lines(info.file)
    expect(r.events.map((e) => e.name)).toEqual(['PostToolUse', 'Stop'])
    expect(r.end).toMatchObject({ events: 2, dropped: 0 })
  })

  it('a window closing ends its recording the same way', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('Stop'))
    wc.close()
    await vi.waitFor(() => expect(lines(info.file).end?.reason).toBe('closed'), { timeout: HUNG_MS })
    expect(lines(info.file).events.map((e) => e.name)).toEqual(['Stop'])
  })
})

describe('latestRecording', () => {
  it('is the one that started last, whatever the names sort to, and says whether it has text', async () => {
    const dir = recordingsDir()
    mkdirSync(dir, { recursive: true })
    // Far in the future, so this test's are the newest in the folder.
    const at = new Date(2099, 0, 2, 3, 4, 5, 6)
    const write = (n: number, text: boolean): void => {
      const h = { type: 'recording', format: 1, hive: '0.7.0-test', startedAt: new Date(at.getTime() + n).toISOString(), source: { kind: 'session', label: 'x' }, text, clis: [] }
      writeFileSync(join(dir, recordingName(at, n, 'session')), `${JSON.stringify(h)}\n`)
    }
    write(1, false)
    write(2, true)
    expect(await latestRecording()).toMatchObject({ name: recordingName(at, 2, 'session'), includeText: true })
    write(10, false)
    expect(await latestRecording()).toMatchObject({ name: recordingName(at, 10, 'session'), includeText: false })
  })
})
