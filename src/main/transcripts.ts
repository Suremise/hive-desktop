import { open, stat } from 'fs/promises'
import type { Transcript, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '../shared/types'
import { assertSessionId } from '../shared/defaults'
import { ConversationParser, searchItems, transcriptMarkdown } from './agents/conversation'
import { sessions } from './sessions'
import { workspace } from './workspace'

/**
 * The Sessions tab's transcript viewer. Parsed transcripts are cached and followed incrementally
 * (Claude Code only appends), so re-reading a live session costs only the new lines.
 */

interface Entry {
  path: string
  parser: ConversationParser
  size: number
  used: number
}

const MAX_CACHED = 6
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
  projectPath = workspace.assertProject(projectPath)
  // The id becomes part of a file name, so only accept what Claude Code uses (UUIDs).
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
  // A different file (Claude Code deleted it and Hive's backup is used) or a shorter one means start again.
  if (!e || e.path !== path || size < e.parser.offset) {
    e = { path, parser: new ConversationParser(projectPath), size: 0, used: 0 }
    cache.set(key, e)
  }
  e.used = Date.now()
  if (size !== e.size) {
    e.parser.feed(await readRange(path, e.parser.offset, size))
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
  /** The conversation so far, or null when the file hasn't grown since knownSize. */
  async read(projectPath: string, sessionId: string, knownSize?: number): Promise<Transcript | null> {
    const e = await parsed(projectPath, sessionId)
    if (knownSize !== undefined && knownSize === e.size) return null
    return { sessionId, size: e.size, items: e.parser.items.map(forDisplay) }
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
    let block = entry.message?.content?.[loc.path[0]]
    if (loc.path.length > 1) block = block?.content?.[loc.path[1]]
    const src = block?.source
    if (src?.type !== 'base64' || typeof src.data !== 'string') throw new Error('The image is not stored in the transcript')
    return `data:${src.media_type ?? 'image/png'};base64,${src.data}`
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
    const project = workspace.assertProject(projectPath)
    return transcriptMarkdown(e.parser.items, title, `Claude Code session \`${sessionId}\` · project ${project} · exported from Hive ${new Date().toLocaleString()}`)
  }
}
