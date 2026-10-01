import { open, stat } from 'fs/promises'
import type { ProviderId, Transcript, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '../shared/types'
import { TRANSCRIPT_WINDOW, assertSessionId } from '../shared/defaults'
import { provider } from './providers'
import { searchItems, transcriptMarkdown } from './providers/conversation'
import type { ConversationParserLike } from './providers/types'
import { sessions } from './sessions'
import { workspace } from './workspace'

/**
 * The Sessions tab's transcript viewer. Parsed transcripts are cached and followed incrementally
 * (providers only append), so re-reading a live session costs only the new lines. Each provider has its
 * own parser into the same items.
 */

interface Entry {
  path: string
  provider: ProviderId
  parser: ConversationParserLike
  size: number
  used: number
}

const MAX_CACHED = 6
/** How much of a transcript is read at a time. */
const READ_CHUNK = 4 * 1024 * 1024
/** Tool input and output longer than this are shortened in transcript:read; transcript:tool has the full text. */
const DISPLAY_LIMIT = 4000
const cache = new Map<string, Entry>()

async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

const pending = new Map<string, Promise<unknown>>()

/**
 * One read at a time per transcript: two overlapping reads (the 2-second poll and a search, say) would
 * otherwise both feed the same new bytes to the parser and duplicate messages.
 */
async function parsed(projectPath: string, sessionId: string): Promise<Entry> {
  // A project, or the Hive Assistant's home (its conversations are browsed the same way).
  projectPath = workspace.assertSessionHost(projectPath)
  // The id becomes part of a file name, so only accept plain ids (UUIDs).
  assertSessionId(sessionId)
  const key = `${projectPath.toLowerCase()}|${sessionId}`
  const run = (pending.get(key) ?? Promise.resolve()).then(
    () => parseNow(projectPath, sessionId, key),
    () => parseNow(projectPath, sessionId, key)
  )
  const tail = run.catch(() => undefined)
  pending.set(key, tail)
  void tail.then(() => {
    if (pending.get(key) === tail) pending.delete(key)
  })
  return run
}

async function parseNow(projectPath: string, sessionId: string, key: string): Promise<Entry> {
  const path = await sessions.anyTranscript(projectPath, sessionId)
  if (!path) throw new Error('This session has no transcript yet.')
  const size = (await stat(path)).size
  let e = cache.get(key)
  // A different file (the provider deleted it and Hive's backup is used) or a shorter one means start again.
  if (!e || e.path !== path || size < e.parser.offset) {
    const id = await sessions.sessionProvider(projectPath, sessionId)
    e = { path, provider: id, parser: provider(id).conversationParser(projectPath), size: 0, used: 0 }
    cache.set(key, e)
  }
  e.used = Date.now()
  if (size !== e.size) {
    // In pieces, so a long transcript opened for the first time doesn't take its whole size in memory at once.
    let chunk = READ_CHUNK
    while (e.parser.offset < size) {
      const before = e.parser.offset
      const end = Math.min(size, before + chunk)
      e.parser.feed(await readRange(path, before, end))
      if (e.parser.offset > before) continue
      // One line longer than the piece (a large image): read a bigger piece; at the end, a line still being written.
      if (end === size) break
      chunk *= 2
    }
    e.size = size
  }
  if (cache.size > MAX_CACHED) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].used - b[1].used)[0]
    cache.delete(oldest[0])
  }
  return e
}

const clip = (s: string): string => (s.length > DISPLAY_LIMIT ? s.slice(0, DISPLAY_LIMIT) : s)

function forDisplay(item: TranscriptItem): TranscriptItem {
  if (item.kind !== 'tool') return item
  const t = item.tool
  const tool: TranscriptTool = { ...t, input: clip(t.input), result: t.result === null ? null : clip(t.result) }
  if (t.input.length > DISPLAY_LIMIT) tool.inputLength = t.input.length
  if (t.result && t.result.length > DISPLAY_LIMIT) tool.resultLength = t.result.length
  return { ...item, tool }
}

export const transcripts = {
  /**
   * The conversation from item `from` on (by default the latest TRANSCRIPT_WINDOW items: the viewer loads
   * earlier ones as you scroll up), or null when the file hasn't grown since knownSize.
   */
  async read(projectPath: string, sessionId: string, opts: { knownSize?: number; from?: number } = {}): Promise<Transcript | null> {
    const e = await parsed(projectPath, sessionId)
    if (opts.knownSize !== undefined && opts.knownSize === e.size) return null
    const total = e.parser.items.length
    const from = Math.max(0, Math.min(total, opts.from ?? total - TRANSCRIPT_WINDOW))
    return { sessionId, size: e.size, total, from, items: e.parser.items.slice(from).map(forDisplay) }
  },

  async tool(projectPath: string, sessionId: string, itemId: number): Promise<TranscriptTool> {
    const item = (await parsed(projectPath, sessionId)).parser.items[itemId]
    if (item?.kind !== 'tool') throw new Error('No such tool call')
    return item.tool
  },

  /** An image from the transcript as a data URL. */
  async image(projectPath: string, sessionId: string, imageId: number): Promise<string> {
    const e = await parsed(projectPath, sessionId)
    const loc = e.parser.images[imageId]
    if (!loc) throw new Error('No such image')
    const entry = JSON.parse((await readRange(e.path, loc.offset, loc.offset + loc.length)).toString('utf8'))
    const url = provider(e.provider).imageData(entry, loc)
    if (!url) throw new Error('The image is not stored in the transcript')
    return url
  },

  /** Searches one session, or every session of the project when sessionId is null. */
  async search(projectPath: string, query: string, sessionId: string | null): Promise<TranscriptSearchResult[]> {
    const ids = sessionId ? [sessionId] : (await sessions.list(projectPath)).map((s) => s.id)
    const out: TranscriptSearchResult[] = []
    let total = 0
    for (const id of ids) {
      if (total >= 500) break
      const e = await parsed(projectPath, id).catch(() => null)
      if (!e) continue
      const { hits, more } = searchItems(e.parser.items, query, sessionId ? 500 : Math.min(100, 500 - total))
      if (!hits.length) continue
      total += hits.length
      out.push({ sessionId: id, hits, more })
    }
    return out
  },

  async markdown(projectPath: string, sessionId: string, title: string): Promise<string> {
    const e = await parsed(projectPath, sessionId)
    const project = workspace.assertSessionHost(projectPath)
    const p = provider(e.provider)
    return transcriptMarkdown(e.parser.items, title, `${p.exportSubtitle(sessionId, project)} · exported from Hive ${new Date().toLocaleString()}`, p.descriptor.assistant)
  }
}
