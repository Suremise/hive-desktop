import { createWriteStream, type WriteStream } from 'original-fs'
import { mkdir, open, readdir, stat } from 'original-fs/promises'
import { join } from 'path'
import { app, type WebContents } from 'electron'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from '../shared/devConsole'
import { RECORDING_FORMAT, parseRecording, type RecordingEnd, type RecordingHeader } from '../shared/consoleFixtures.mts'
import type { ProviderId } from '../shared/types'
import { devConsole } from './devConsole'
import { providerService } from './providerService'
import { createLogger, userText } from './logger'

/**
 * Recording a developer console source to a file (#366 decision 4, #638): JSON Lines in Hive's own folder
 * (`console-recordings`), a header (Hive's and the CLIs' versions, whether text is kept), each event as the console
 * captured it, and an end line. Redacted as capture is, unless the user opted in to text for this recording (secrets
 * stay masked). One recording per window, of the source it watches; it stops when asked, when the window closes or
 * leaves its workspace, or at its bound.
 */

/** A recording stops by itself past this size or this many events. */
export const RECORD_MAX_BYTES = 50 * 1024 * 1024
export const RECORD_MAX_EVENTS = 100_000
/** How often a recording's window hears how far it has got. */
const PROGRESS_MS = 500

interface Active {
  info: ConsoleRecordingInfo
  wc: WebContents
  /** The workspace (lower case) it was started in. */
  workspace: string
  stream: WriteStream
  sentAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const active = new Map<number, Active>()
const log = createLogger('console')

export const recordingsDir = (): string => join(app.getPath('userData'), 'console-recordings')
const subscriberId = (wc: WebContents): string => `record:${wc.id}`
const NAME = /^console-\d{8}-\d{6}(?:-\d+)?-[a-z]+\.jsonl$/

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Tells the recording's window how far it has got (at most every PROGRESS_MS), and always when it stops. */
function report(a: Active, now = false): void {
  if (a.wc.isDestroyed()) return
  const send = (): void => {
    a.timer = null
    a.sentAt = Date.now()
    if (!a.wc.isDestroyed()) a.wc.send('hive:event', { type: 'console-recording', recording: { ...a.info } })
  }
  if (now) {
    if (a.timer) clearTimeout(a.timer)
    send()
  } else if (!a.timer) a.timer = setTimeout(send, Math.max(0, PROGRESS_MS - (Date.now() - a.sentAt)))
}

/** Starts recording a source for a window (the one it watches): its events from now on, with text only if asked. */
export async function startRecording(wc: WebContents, source: ConsoleSource, workspace: string, includeText: boolean): Promise<ConsoleRecordingInfo> {
  if (active.has(wc.id)) await stopRecording(wc.id, 'stopped')
  const dir = recordingsDir()
  await mkdir(dir, { recursive: true })
  const taken = new Set(await readdir(dir).catch(() => [] as string[]))
  const base = `console-${stamp(new Date())}`
  let name = `${base}-${source.kind}.jsonl`
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}-${source.kind}.jsonl`
  const file = join(dir, name)
  const startedAt = new Date().toISOString()
  const installs = providerService.all()
  const header: RecordingHeader = {
    type: 'recording',
    format: RECORDING_FORMAT,
    hive: app.getVersion(),
    startedAt,
    source: { kind: source.kind, label: source.label, ...(source.provider ? { provider: source.provider } : {}) },
    text: includeText,
    clis: (Object.keys(installs) as ProviderId[]).map((id) => ({ provider: id, version: installs[id]?.version ?? null, tested: installs[id]?.tested?.version ?? null }))
  }
  const stream = createWriteStream(file, { flags: 'wx' })
  const head = `${JSON.stringify(header)}\n`
  stream.write(head)
  const info: ConsoleRecordingInfo = { name, file, label: source.label, kind: source.kind, ...(source.provider ? { provider: source.provider } : {}), includeText, startedAt, events: 0, bytes: Buffer.byteLength(head), dropped: 0, recording: true }
  const a: Active = { info, wc, workspace, stream, sentAt: 0, timer: null }
  active.set(wc.id, a)
  stream.on('error', (e) => {
    log.warn(`developer console recording ${userText(name)} failed`, e)
    void stopRecording(wc.id, 'stopped')
  })
  devConsole.subscribe(subscriberId(wc), [source.id], {
    includeText,
    deliver: (events: ConsoleEvent[], dropped: number) => {
      if (active.get(wc.id) !== a) return
      const text = events.map((e) => `${JSON.stringify({ type: 'event', ...e })}\n`).join('')
      a.stream.write(text)
      info.events += events.length
      info.bytes += Buffer.byteLength(text)
      info.dropped += dropped
      if (info.bytes >= RECORD_MAX_BYTES || info.events >= RECORD_MAX_EVENTS) void stopRecording(wc.id, 'limit')
      else report(a)
    }
  })
  wc.once('destroyed', () => void stopRecording(wc.id, 'closed'))
  log.info(`developer console: recording ${source.kind} to ${name}${includeText ? ' (with text)' : ''}`)
  report(a, true)
  return { ...info }
}

/** Stops a window's recording, writing its end line. Null when it wasn't recording. */
export async function stopRecording(wcId: number, reason: RecordingEnd['reason']): Promise<ConsoleRecordingInfo | null> {
  const a = active.get(wcId)
  if (!a) return null
  active.delete(wcId)
  if (!a.wc.isDestroyed()) devConsole.unsubscribe(subscriberId(a.wc))
  else devConsole.unsubscribe(`record:${wcId}`)
  const endedAt = new Date().toISOString()
  const end: RecordingEnd = { type: 'end', at: endedAt, events: a.info.events, dropped: a.info.dropped, reason }
  const line = `${JSON.stringify(end)}\n`
  Object.assign(a.info, { recording: false, endedAt, reason, bytes: a.info.bytes + Buffer.byteLength(line) })
  await new Promise<void>((resolve) => {
    if (a.stream.destroyed) return resolve()
    a.stream.end(line, () => resolve())
    a.stream.once('error', () => resolve())
  })
  report(a, true)
  return { ...a.info }
}

/** A window's recording going on now. */
export function recordingOf(wcId: number): ConsoleRecordingInfo | null {
  const a = active.get(wcId)
  return a ? { ...a.info } : null
}

/** Stops the recordings whose window says so (closed, or left the workspace it recorded in). */
export function stopRecordingsWhere(leaving: (wc: WebContents, workspace: string) => boolean, reason: RecordingEnd['reason']): void {
  for (const [id, a] of active) if (a.wc.isDestroyed() || leaving(a.wc, a.workspace)) void stopRecording(id, reason)
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

/** The newest recording in Hive's folder (a window's, going on, first), or null. */
export async function latestRecording(): Promise<ConsoleRecordingInfo | null> {
  const going = [...active.values()].sort((a, b) => b.info.startedAt.localeCompare(a.info.startedAt))[0]
  if (going) return { ...going.info }
  const dir = recordingsDir()
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort().reverse()
  for (const name of names) {
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

/** Whether a file name is one of Hive's recordings (so a window may show it, and nothing else, in its folder). */
export const isRecordingName = (name: string): boolean => NAME.test(name)
