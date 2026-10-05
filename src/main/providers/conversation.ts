import type { TranscriptItem, TranscriptSearchHit } from '../../shared/types'
import { formatDateTime } from '../../shared/dates'

/**
 * The provider-neutral side of transcripts: the viewer's items are the same for every provider, so
 * search and Markdown export live here. Each provider's adapter has its own parser into these items.
 */

/** An item before it gets its id (distributes over the union, so each kind keeps its own fields). */
export type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, 'id'> : never) : never

/** "mcp__hive__hive_notify" → "hive · hive_notify"; built-in tools keep their name. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} · ${m[2]}` : name
}

/** A path relative to the project, when it is inside it. */
export function shortPath(p: unknown, root: string | null): string {
  if (typeof p !== 'string') return ''
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + '\\')) return p.slice(root.length + 1).replace(/\\/g, '/')
  if (root && p.toLowerCase().startsWith(root.toLowerCase().replace(/\\/g, '/') + '/')) return p.slice(root.length + 1)
  return p
}

export const firstLine = (s: unknown): string => (typeof s === 'string' ? s.trim().split('\n')[0] : '')

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

const when = (ts: string | null): string => (ts ? formatDateTime(ts) : '')
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/** The conversation as Markdown, with tool calls, thinking and summaries in collapsible sections. */
export function transcriptMarkdown(items: TranscriptItem[], title: string, subtitle: string, assistant = 'Claude'): string {
  const out: string[] = [`# ${title}`, '', subtitle, '']
  let speaker: 'user' | 'assistant' | null = null
  const heading = (who: 'user' | 'assistant', ts: string | null): void => {
    if (speaker === who) return
    speaker = who
    out.push(`## ${who === 'user' ? 'You' : assistant}${when(ts) ? ` · ${when(ts)}` : ''}`, '')
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
        out.push('---', '', `**Conversation compacted** (${item.trigger}) · ${tokens(item.preTokens)} → ${tokens(item.postTokens)} tokens${when(item.timestamp) ? ` · ${when(item.timestamp)}` : ''}`, '')
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
