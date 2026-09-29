import type { TranscriptImageRef, TranscriptItem, TranscriptSearchHit, TranscriptTool } from '../../shared/types'

/**
 * Turns a Claude Code JSONL transcript into the conversation shown in the transcript viewer:
 * messages, replies, thinking, tool calls with their results, slash commands and compactions.
 *
 * The parser is incremental because transcripts are append-only: feed() takes the bytes added since
 * the last call, so a live session is followed without re-reading the whole file. Items already
 * returned are updated in place when a later entry completes them (a tool's result, a command's
 * output, a compaction's summary). Like parseTranscript, it ignores anything it doesn't recognise.
 */

/** Where an image's base64 data sits in the file: the line's byte range and the block inside it. */
export interface ImageLocation {
  offset: number
  length: number
  /** Content-block indices from message.content to the image (tool results nest one level deeper). */
  path: number[]
}

/** An item before it gets its id (distributes over the union, so each kind keeps its own fields). */
type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, 'id'> : never) : never

const ANSI =/\x1b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (s: string): string => s.replace(ANSI, '')
const tag = (s: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)
  return m ? m[1] : null
}

function shortPath(p: unknown, root: string | null): string {
  if (typeof p !== 'string') return ''
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + '\\')) return p.slice(root.length + 1).replace(/\\/g, '/')
  if (root && p.toLowerCase().startsWith(root.toLowerCase().replace(/\\/g, '/') + '/')) return p.slice(root.length + 1)
  return p
}

const firstLine = (s: unknown): string => (typeof s === 'string' ? s.trim().split('\n')[0] : '')

/** One line describing a tool call, e.g. "npm test" or "src/main/files.ts". */
export function toolSummary(name: string, input: Record<string, unknown>, root: string | null = null): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(input.description) || firstLine(input.command)
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(input.file_path ?? input.notebook_path, root)
    case 'Glob':
    case 'Grep':
      return [firstLine(input.pattern), input.path ? `in ${shortPath(input.path, root)}` : ''].filter(Boolean).join(' ')
    case 'Agent':
    case 'Task':
      return firstLine(input.description) || firstLine(input.prompt)
    case 'WebFetch':
      return firstLine(input.url)
    case 'WebSearch':
    case 'ToolSearch':
      return firstLine(input.query)
    case 'Skill':
      return firstLine(input.skill)
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return firstLine(first).slice(0, 200)
}

/** "mcp__hive__hive_notify" → "hive · hive_notify"; built-in tools keep their name. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} · ${m[2]}` : name
}

/** Tool input as readable text: the command itself for shells, otherwise one "key: value" per field. */
export function formatToolInput(name: string, input: Record<string, unknown>): string {
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') return input.command
  return Object.entries(input)
    .map(([k, v]) => {
      if (typeof v === 'string') return v.includes('\n') ? `${k}:\n${v}` : `${k}: ${v}`
      return `${k}: ${JSON.stringify(v, null, 2)}`
    })
    .join('\n')
}

export class ConversationParser {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  /** Bytes consumed, always at a line boundary. */
  offset = 0
  private tools = new Map<string, TranscriptTool>()
  private pendingCompaction: Extract<TranscriptItem, { kind: 'compaction' }> | null = null
  private lastCommand: Extract<TranscriptItem, { kind: 'command' }> | null = null
  private lastUser: Extract<TranscriptItem, { kind: 'user' }> | null = null
  private root: string | null

  constructor(projectPath: string | null = null) {
    this.root = projectPath
  }

  /**
   * Parses the complete lines in buf, which starts at this.offset. A partial last line (Claude Code
   * is still writing it) is left for the next call. Returns the bytes consumed.
   */
  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      this.line(buf.toString('utf8', start, nl), this.offset + start, nl - start)
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push<T extends NewItem>(item: T): T & { id: number } {
    const full = { ...item, id: this.items.length }
    this.items.push(full as TranscriptItem)
    if (full.kind !== 'command') this.lastCommand = null
    return full
  }

  private image(offset: number, length: number, path: number[]): TranscriptImageRef {
    this.images.push({ offset, length, path })
    return { id: this.images.length - 1, path: null }
  }

  private line(text: string, offset: number, length: number): void {
    if (!text.trim()) return
    let o: Record<string, any>
    try {
      o = JSON.parse(text)
    } catch {
      return
    }
    if (o.isSidechain) return
    const ts: string | null = typeof o.timestamp === 'string' ? o.timestamp : null
    if (o.type === 'assistant') this.assistant(o, ts)
    else if (o.type === 'user') this.user(o, ts, offset, length)
    else if (o.type === 'system') this.system(o, ts)
  }

  private assistant(o: Record<string, any>, ts: string | null): void {
    const msg = o.message ?? {}
    const u = msg.usage
    if (u && this.pendingCompaction) {
      this.pendingCompaction.nextRequestTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      this.pendingCompaction = null
    }
    if (!Array.isArray(msg.content)) return
    for (const b of msg.content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        // Synthetic replies are Claude Code's own messages, such as API errors.
        if (msg.model === '<synthetic>') this.push({ kind: 'notice', timestamp: ts, text: b.text.trim(), level: /error/i.test(b.text) ? 'error' : 'info' })
        else this.push({ kind: 'assistant', timestamp: ts, text: b.text })
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        this.push({ kind: 'thinking', timestamp: ts, text: b.thinking })
      } else if (b?.type === 'tool_use') {
        const input: Record<string, unknown> = b.input && typeof b.input === 'object' ? b.input : {}
        const name = String(b.name ?? 'Tool')
        const tool: TranscriptTool = {
          toolUseId: String(b.id ?? ''),
          name: toolLabel(name),
          summary: toolSummary(name, input, this.root),
          input: formatToolInput(name, input),
          result: null,
          isError: false,
          images: []
        }
        this.tools.set(tool.toolUseId, tool)
        this.push({ kind: 'tool', timestamp: ts, tool })
      }
    }
  }

  private user(o: Record<string, any>, ts: string | null, offset: number, length: number): void {
    const content = o.message?.content
    if (o.isCompactSummary) {
      const summary = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => b?.text ?? '').join('\n') : ''
      const last = [...this.items].reverse().find((i) => i.kind === 'compaction') as Extract<TranscriptItem, { kind: 'compaction' }> | undefined
      if (last && !last.summary) last.summary = summary
      return
    }
    if (o.isMeta) {
      // "[Image: source: <path>]" follows a message with pasted images and says where each came from.
      if (Array.isArray(content) && this.lastUser) {
        const paths = content.map((b: any) => /^\[Image: source: (.+)\]$/.exec(b?.text ?? '')?.[1]).filter(Boolean) as string[]
        const open = this.lastUser.images.filter((i) => !i.path)
        paths.forEach((p, i) => open[i] && (open[i].path = p))
      }
      return
    }
    if (typeof content === 'string') {
      this.userText(content, ts, [])
      return
    }
    if (!Array.isArray(content)) return
    const texts: string[] = []
    const images: TranscriptImageRef[] = []
    content.forEach((b: any, i: number) => {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      else if (b?.type === 'image') images.push(this.image(offset, length, [i]))
      else if (b?.type === 'tool_result') this.toolResult(b, offset, length, i)
    })
    if (texts.length || images.length) this.userText(texts.join('\n'), ts, images)
  }

  private toolResult(b: any, offset: number, length: number, index: number): void {
    const tool = this.tools.get(String(b.tool_use_id))
    if (!tool) return
    tool.isError = !!b.is_error
    if (typeof b.content === 'string') tool.result = b.content
    else if (Array.isArray(b.content)) {
      const parts: string[] = []
      b.content.forEach((c: any, j: number) => {
        if (c?.type === 'text') parts.push(c.text ?? '')
        else if (c?.type === 'image') tool.images.push(this.image(offset, length, [index, j]))
        else if (c?.type === 'tool_reference') parts.push(`[tool: ${c.tool_name ?? c.name ?? '?'}]`)
      })
      tool.result = parts.join('\n')
    } else tool.result = ''
  }

  private userText(text: string, ts: string | null, images: TranscriptImageRef[]): void {
    const t = text.trim()
    if (!images.length && this.special(t, ts)) return
    if (!t && !images.length) return
    if (/^\[Request interrupted by user[^\]]*\]$/.test(t) && !images.length) {
      this.push({ kind: 'notice', timestamp: ts, text: 'Interrupted by you', level: 'info' })
      return
    }
    this.lastUser = this.push({ kind: 'user', timestamp: ts, text, images })
  }

  /** Slash commands, ! shell commands, their output and background-task notices. True if handled. */
  private special(t: string, ts: string | null): boolean {
    if (!t.startsWith('<')) return false
    const name = tag(t, 'command-name')
    if (name !== null) {
      this.lastCommand = this.push({ kind: 'command', timestamp: ts, name: name.trim(), args: (tag(t, 'command-args') ?? '').trim(), output: '' })
      return true
    }
    const bash = tag(t, 'bash-input')
    if (bash !== null) {
      this.lastCommand = this.push({ kind: 'command', timestamp: ts, name: '!', args: bash.trim(), output: '' })
      return true
    }
    const out = [tag(t, 'local-command-stdout'), tag(t, 'local-command-stderr'), tag(t, 'bash-stdout'), tag(t, 'bash-stderr')].filter((x) => x !== null) as string[]
    if (out.length) {
      const text = stripAnsi(out.join('\n')).trim()
      if (this.lastCommand) this.lastCommand.output = [this.lastCommand.output, text].filter(Boolean).join('\n')
      else if (text) this.push({ kind: 'notice', timestamp: ts, text, level: 'info' })
      return true
    }
    if (t.startsWith('<task-notification>')) {
      this.push({ kind: 'notice', timestamp: ts, text: (tag(t, 'summary') ?? 'A background task finished').trim(), level: 'info' })
      return true
    }
    return t.startsWith('<local-command-caveat>') || t.startsWith('<system-reminder>')
  }

  private system(o: Record<string, any>, ts: string | null): void {
    if (o.subtype === 'compact_boundary') {
      const m = o.compactMetadata ?? {}
      this.pendingCompaction = this.push({
        kind: 'compaction',
        timestamp: ts,
        trigger: String(m.trigger ?? 'unknown'),
        preTokens: m.preTokens ?? 0,
        postTokens: m.postTokens ?? 0,
        nextRequestTokens: null,
        summary: null
      })
    } else if (o.subtype === 'local_command' && typeof o.content === 'string') {
      this.special(o.content.trim(), ts)
    } else if ((o.subtype === 'api_error' || o.level === 'error') && (typeof o.content === 'string' || o.error)) {
      this.push({ kind: 'notice', timestamp: ts, text: typeof o.content === 'string' ? o.content : 'API error', level: 'error' })
    } else if (o.subtype === 'informational' && typeof o.content === 'string') {
      this.push({ kind: 'notice', timestamp: ts, text: o.content, level: 'info' })
    }
  }
}

/** Everything searchable in an item, in the order it is shown. */
export function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'tool':
      return [item.tool.name, item.tool.summary, item.tool.input, item.tool.result ?? ''].join('\n')
    case 'compaction':
      return item.summary ?? ''
    case 'command':
      return [item.name, item.args, item.output].join('\n')
    default:
      return item.text
  }
}

/** Case-insensitive plain-text search. Snippets show the text around the first match in each item. */
export function searchItems(items: TranscriptItem[], query: string, limit = 200): { hits: TranscriptSearchHit[]; more: boolean } {
  const q = query.trim().toLowerCase()
  const hits: TranscriptSearchHit[] = []
  if (!q) return { hits, more: false }
  for (const item of items) {
    const text = itemText(item)
    const at = text.toLowerCase().indexOf(q)
    if (at === -1) continue
    if (hits.length === limit) return { hits, more: true }
    const from = Math.max(0, at - 60)
    const snippet = (from ? '…' : '') + text.slice(from, at + q.length + 100).replace(/\s+/g, ' ').trim() + (at + q.length + 100 < text.length ? '…' : '')
    hits.push({ itemId: item.id, kind: item.kind, snippet })
  }
  return { hits, more: false }
}

/** A code fence longer than any run of backticks in the text. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text}\n${f}`
}

const when = (ts: string | null): string => (ts ? new Date(ts).toLocaleString() : '')
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/** The conversation as Markdown, with tool calls, thinking and summaries in collapsible sections. */
export function transcriptMarkdown(items: TranscriptItem[], title: string, subtitle: string): string {
  const out: string[] = [`# ${title}`, '', subtitle, '']
  let speaker: 'user' | 'assistant' | null = null
  const heading = (who: 'user' | 'assistant', ts: string | null): void => {
    if (speaker === who) return
    speaker = who
    out.push(`## ${who === 'user' ? 'You' : 'Claude'}${ts ? ` · ${when(ts)}` : ''}`, '')
  }
  const details = (summary: string, body: string): void => {
    out.push('<details>', `<summary>${summary.replace(/</g, '&lt;')}</summary>`, '', body, '', '</details>', '')
  }
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        heading('user', item.timestamp)
        out.push(item.text, '')
        for (const img of item.images) out.push(`*[Image${img.path ? `: ${img.path}` : ''}]*`, '')
        speaker = 'user'
        break
      case 'assistant':
        heading('assistant', item.timestamp)
        out.push(item.text, '')
        break
      case 'thinking':
        heading('assistant', item.timestamp)
        details('Thinking', item.text)
        break
      case 'tool': {
        heading('assistant', item.timestamp)
        const t = item.tool
        const body = [fence(t.input)]
        if (t.result !== null) body.push('', t.isError ? '**Error:**' : '**Result:**', '', fence(t.result))
        details(`${t.name}${t.summary ? `: ${t.summary}` : ''}`, body.join('\n'))
        break
      }
      case 'compaction':
        speaker = null
        out.push('---', '', `**Conversation compacted** (${item.trigger}) · ${tokens(item.preTokens)} → ${tokens(item.postTokens)} tokens${item.timestamp ? ` · ${when(item.timestamp)}` : ''}`, '')
        if (item.summary) details('Summary', item.summary)
        out.push('---', '')
        break
      case 'command':
        speaker = null
        out.push(`> \`${item.name === '!' ? `! ${item.args}` : `${item.name}${item.args ? ` ${item.args}` : ''}`}\``, '')
        if (item.output) out.push(fence(item.output), '')
        break
      case 'notice':
        out.push(`> *${item.text.replace(/\n+/g, ' ')}*`, '')
        break
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
