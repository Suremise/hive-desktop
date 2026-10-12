import { mkdir, open, readdir, stat, type FileHandle } from 'original-fs/promises'
import { join } from 'path'
import { app, type WebContents } from 'electron'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from '../shared/devConsole'
import { RECORDING_FORMAT, newestRecordingsFirst, parseRecording, recordingName, type RecordingEnd, type RecordingHeader } from '../shared/consoleFixtures.mts'
import type { ProviderId } from '../shared/types'
import { devConsole } from './devConsole'
import { providerService } from './providerService'
import { createLogger, userText } from './logger'

/**
 * Recording a developer console source to a file (#366 decision 4, #638): JSON Lines in Hive's own folder
 * (`console-recordings`), a header (Hive's and the CLIs' versions, whether text is kept), each event as the console
 * captured it, and an end line. Redacted as capture is, unless the user opted in to text for this recording (secrets
 * stay masked).
 *
 * One recording per window, of a source the window watches, and only while it does: each window's starts and stops run
 * one at a time, and every stop, a close of the window or a newer start cancels a start still on its way (a generation
 * number, checked again after each await, with the window still open, in its workspace and watching that source). A
 * file is reserved with an exclusive open before a start succeeds, and each recording cleans up only itself. Stopping
 * writes what was captured up to then (the subscription's queue drained) before the end line; nothing after joins it.
 */

/** A recording stops by itself past this size or this many events. */
export const RECORD_MAX_BYTES = 50 * 1024 * 1024
export const RECORD_MAX_EVENTS = 100_000
/** How often a recording's window hears how far it has got. */
const PROGRESS_MS = 500

interface Recording {
  info: ConsoleRecordingInfo
  wc: WebContents
  wcId: number
  source: string
  /** The workspace (lower case) it was started in. */
  workspace: string
  fh: FileHandle
  /** Its writes, one after another; the end line goes after them all. */
  writes: Promise<void>
  /** Its end line is written (or being written): nothing more joins it. */
  closed: boolean
  /** A write failed: it is being stopped, as failed. */
  failed: boolean
  /** Why, for the user. */
  error?: string
  /** Bytes delivered and not yet written. */
  pending: number
  sentAt: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Each window's recording, and its starts and stops in order. */
interface Slot {
  wc: WebContents
  /** Raised by every start, stop and close: a start that finds it raised again was cancelled meanwhile. */
  gen: number
  rec: Recording | null
  /** The window's last start or stop: the next waits for it. */
  queue: Promise<unknown>
}

const slots = new Map<number, Slot>()
const log = createLogger('console')

export const recordingsDir = (): string => join(app.getPath('userData'), 'console-recordings')
const subscriberId = (wcId: number): string => `record:${wcId}`

/** The window's slot; the first time, its close is hooked (before anything waits), cancelling and stopping. */
function slotOf(wc: WebContents): Slot {
  let slot = slots.get(wc.id)
  if (!slot) {
    const id = wc.id
    const s: Slot = { wc, gen: 0, rec: null, queue: Promise.resolve() }
    slots.set(id, s)
    wc.once('destroyed', () => {
      s.gen++
      if (s.rec) detach(s.rec)
      void serial(s, () => finish(s, 'closed')).finally(() => slots.delete(id))
    })
    slot = s
  }
  return slot
}

/** Runs a window's start or stop after its previous one. */
function serial<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
  const run = slot.queue.then(fn, fn)
  slot.queue = run.catch(() => undefined)
  return run
}

/** Tells the recording's window how far it has got (at most every PROGRESS_MS), and always when it stops. */
function report(r: Recording, now = false): void {
  if (r.wc.isDestroyed()) return
  const send = (): void => {
    r.timer = null
    r.sentAt = Date.now()
    if (!r.wc.isDestroyed()) r.wc.send('hive:event', { type: 'console-recording', recording: { ...r.info } })
  }
  if (now) {
    if (r.timer) clearTimeout(r.timer)
    send()
  } else if (!r.timer && !r.closed)
    r.timer = setTimeout(() => {
      // Progress only while it records: its ending sends the last word itself, after its file is finished.
      if (r.closed) r.timer = null
      else send()
    }, Math.max(0, PROGRESS_MS - (Date.now() - r.sentAt)))
}

/** Writes all of a text, however many writes it takes (a write may take only part of it). */
export async function writeAll(fh: FileHandle, text: string): Promise<number> {
  const buf = Buffer.from(text, 'utf8')
  let at = 0
  while (at < buf.length) {
    const { bytesWritten } = await fh.write(buf, at, buf.length - at, null)
    if (bytesWritten <= 0) throw new Error('The recording file took nothing more')
    at += bytesWritten
  }
  return buf.length
}

/** A recording that couldn't be written: stopped as failed, with the reason the user sees; its file is kept as it is. */
function writeFailed(slot: Slot, r: Recording, e: unknown): void {
  if (r.failed) return
  r.failed = true
  r.error = e instanceof Error ? e.message : String(e)
  log.warn(`developer console recording ${userText(r.info.name)} failed`, e)
  void stopThis(slot, r, 'failed')
}

/** Appends delivered events to this recording (and no other), stopping it at its bound or when a write fails. */
function append(slot: Slot, r: Recording, events: ConsoleEvent[], dropped: number): void {
  if (r.closed) return
  const text = events.map((e) => `${JSON.stringify({ type: 'event', ...e })}\n`).join('')
  r.info.dropped += dropped
  const size = Buffer.byteLength(text)
  r.pending += size
  r.writes = r.writes.then(async () => {
    try {
      if (!text || r.failed) return
      // Counted once in the file, never before.
      r.info.bytes += await writeAll(r.fh, text)
      r.info.events += events.length
      report(r)
    } catch (e) {
      writeFailed(slot, r, e)
    } finally {
      r.pending -= size
    }
  })
  // Its bound counts what is on its way too, so it never runs past it.
  if (r.info.bytes + r.pending >= RECORD_MAX_BYTES || r.info.events + events.length >= RECORD_MAX_EVENTS) void stopThis(slot, r, 'limit')
}

/** Stops this recording if it is still the window's: never one started after it. */
function stopThis(slot: Slot, r: Recording, reason: RecordingEnd['reason']): Promise<ConsoleRecordingInfo | null> {
  return serial(slot, async () => (slot.rec === r ? finish(slot, reason) : null))
}

/** Ends a recording's capture now: what was captured for it until this moment is delivered to it, nothing after. */
function detach(r: Recording): void {
  devConsole.unsubscribe(subscriberId(r.wcId), { drain: true })
}

/** Ends the window's recording (inside its queue): drains what was captured for it, writes the end line, closes it. */
async function finish(slot: Slot, reason: RecordingEnd['reason']): Promise<ConsoleRecordingInfo | null> {
  const r = slot.rec
  if (!r) return null
  slot.rec = null
  // What was captured up to now is delivered to it first (if a stop or close hasn't already); after this, nothing joins it.
  detach(r)
  r.closed = true
  if (r.timer) clearTimeout(r.timer)
  r.timer = null
  await r.writes
  // A write that failed makes it a failed recording, whatever stopped it; so does an end line or close that fails.
  let ended = r.failed ? 'failed' : reason
  const endedAt = new Date().toISOString()
  try {
    const end: RecordingEnd = { type: 'end', at: endedAt, events: r.info.events, dropped: r.info.dropped, reason: ended, ...(r.error ? { error: r.error } : {}) }
    r.info.bytes += await writeAll(r.fh, `${JSON.stringify(end)}\n`)
  } catch (e) {
    ended = 'failed'
    r.error ??= e instanceof Error ? e.message : String(e)
  }
  try {
    await r.fh.close()
  } catch (e) {
    ended = 'failed'
    r.error ??= e instanceof Error ? e.message : String(e)
  }
  Object.assign(r.info, { recording: false, endedAt, reason: ended, ...(r.error ? { error: r.error } : {}) })
  if (ended === 'failed') log.warn(`developer console: recording ${userText(r.info.name)} failed after ${r.info.events} events: ${userText(r.error)}`)
  else log.info(`developer console: recording ${r.info.name} ended (${ended}, ${r.info.events} events)`)
  report(r, true)
  return { ...r.info }
}

/**
 * Starts recording a source for a window: its events from now on, with text only if asked. `stillWanted` says whether
 * the window still wants it (open, in that workspace, watching that source): checked before the start and after each
 * of its awaits, so a start overtaken by a stop, a close or another source never records.
 */
export function startRecording(wc: WebContents, source: ConsoleSource, workspace: string, includeText: boolean, stillWanted: () => boolean): Promise<ConsoleRecordingInfo> {
  const cancelled = (): Error => {
    log.info('developer console: recording not started (cancelled: the window closed, stopped watching that source or started another)')
    return new Error('The recording was cancelled: the console stopped watching that source')
  }
  if (wc.isDestroyed()) return Promise.reject(cancelled())
  const slot = slotOf(wc)
  const gen = ++slot.gen
  return serial(slot, async () => {
    // The window's own wish first, then whether it is still open and this start still its newest.
    const wanted = (): boolean => stillWanted() && !wc.isDestroyed() && slot.gen === gen
    if (!wanted()) throw cancelled()
    if (slot.rec) await finish(slot, 'stopped')
    const dir = recordingsDir()
    await mkdir(dir, { recursive: true })
    // The file is reserved by an exclusive open: two starts at once never share one.
    const at = new Date()
    let fh: FileHandle | null = null
    let name = ''
    for (let n = 1; !fh; n++) {
      name = recordingName(at, n, source.kind)
      try {
        fh = await open(join(dir, name), 'wx')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw e
      }
    }
    const installs = providerService.all()
    const header: RecordingHeader = {
      type: 'recording',
      format: RECORDING_FORMAT,
      hive: app.getVersion(),
      startedAt: at.toISOString(),
      source: { kind: source.kind, label: source.label, ...(source.provider ? { provider: source.provider } : {}) },
      text: includeText,
      clis: (Object.keys(installs) as ProviderId[]).map((id) => ({ provider: id, version: installs[id]?.version ?? null, tested: installs[id]?.tested?.version ?? null }))
    }
    const head = `${JSON.stringify(header)}\n`
    try {
      await writeAll(fh, head)
    } catch (e) {
      // The file is kept as it is (part of a header at most); the start fails and says why.
      await fh.close().catch(() => undefined)
      throw e
    }
    if (!wanted()) {
      // Overtaken while its file was made: it ends at once, empty, and records nothing.
      const end: RecordingEnd = { type: 'end', at: new Date().toISOString(), events: 0, dropped: 0, reason: 'closed' }
      await writeAll(fh, `${JSON.stringify(end)}\n`).catch(() => undefined)
      await fh.close().catch(() => undefined)
      throw cancelled()
    }
    const info: ConsoleRecordingInfo = { name, file: join(dir, name), label: source.label, kind: source.kind, ...(source.provider ? { provider: source.provider } : {}), includeText, startedAt: header.startedAt, events: 0, bytes: Buffer.byteLength(head), dropped: 0, recording: true }
    const r: Recording = { info, wc, wcId: wc.id, source: source.id, workspace, fh, writes: Promise.resolve(), closed: false, failed: false, pending: 0, sentAt: 0, timer: null }
    slot.rec = r
    devConsole.subscribe(subscriberId(wc.id), [source.id], { includeText, deliver: (events, dropped) => append(slot, r, events, dropped) })
    log.info(`developer console: recording ${source.kind} to ${name}${includeText ? ' (with text)' : ''}`)
    report(r, true)
    return { ...info }
  })
}

/** Stops a window's recording (and cancels a start on its way), writing its end line. Null when it wasn't recording. */
export function stopRecording(wcId: number, reason: RecordingEnd['reason']): Promise<ConsoleRecordingInfo | null> {
  const slot = slots.get(wcId)
  if (!slot) return Promise.resolve(null)
  slot.gen++
  // The recording ends at this call: its capture is cut here, its end line written in turn.
  if (slot.rec) detach(slot.rec)
  return serial(slot, () => finish(slot, reason))
}

/** A window's recording going on now. */
export function recordingOf(wcId: number): ConsoleRecordingInfo | null {
  const r = slots.get(wcId)?.rec
  return r ? { ...r.info } : null
}

/**
 * Stops the recordings (and cancels the starts on their way) whose window says so: it left the workspace it recorded
 * in, or no longer watches the source.
 */
export function stopRecordingsWhere(leaving: (wc: WebContents, workspace: string | null, source: string | null) => boolean, reason: RecordingEnd['reason']): void {
  for (const [id, slot] of slots) {
    const r = slot.rec
    if (slot.wc.isDestroyed() || leaving(slot.wc, r?.workspace ?? null, r?.source ?? null)) void stopRecording(id, reason)
  }
}

/** Reads a recording's header and its newest lines: all of a small one; the head and the last part of a large one. */
export async function readRecordingText(file: string, tailBytes = 512 * 1024): Promise<string> {
  const size = (await stat(file)).size
  const fh = await open(file, 'r')
  try {
    const read = async (at: number, length: number): Promise<string> => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, at)
      return buf.subarray(0, bytesRead).toString('utf8')
    }
    if (size <= tailBytes * 2) return await read(0, size)
    const head = (await read(0, 64 * 1024)).split('\n')[0]
    const tail = await read(size - tailBytes, tailBytes)
    // The tail starts mid-line: its first, partial line goes.
    return `${head}\n${tail.slice(tail.indexOf('\n') + 1)}`
  } finally {
    await fh.close()
  }
}

/** The newest recording in Hive's folder, by when it started (one going on as it is now), or null. */
export async function latestRecording(): Promise<ConsoleRecordingInfo | null> {
  const dir = recordingsDir()
  const going = new Map([...slots.values()].flatMap((s) => (s.rec ? [[s.rec.info.name, s.rec.info] as const] : [])))
  for (const name of newestRecordingsFirst(await readdir(dir).catch(() => [] as string[]))) {
    const now = going.get(name)
    if (now) return { ...now }
    const file = join(dir, name)
    try {
      const r = parseRecording(await readRecordingText(file, 64 * 1024))
      if (!r.header) continue
      const size = (await stat(file)).size
      return {
        name,
        file,
        label: r.header.source.label,
        kind: r.header.source.kind,
        ...(r.header.source.provider ? { provider: r.header.source.provider } : {}),
        includeText: r.header.text,
        startedAt: r.header.startedAt,
        ...(r.end ? { endedAt: r.end.at, reason: r.end.reason } : {}),
        events: r.end?.events ?? r.events.length,
        bytes: size,
        dropped: r.end?.dropped ?? 0,
        recording: false
      }
    } catch {
      // Unreadable: the next newest.
    }
  }
  return null
}

export { isRecordingName } from '../shared/consoleFixtures.mts'
