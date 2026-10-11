import type { CapturedEvent } from '../shared/devConsole'
import { brief } from '../shared/devConsole'
import type { ProviderId } from '../shared/types'
import type { LiveDetails } from './providers/types'

/**
 * The developer console's summary lines (#636): what came in and what Hive made of it, in Hive's own words. Never the
 * CLI's text: values go through brief(), which keeps numbers and identifiers only.
 */

export function hookSummary(name: string, tool: unknown, event: string, status: string, actions: string[], replied: boolean): string {
  const t = brief(tool)
  return `${name}${t ? ` (${t})` : ''} → ${event}; ${status}${actions.length ? `; ${actions.join(', ')}` : ''}${replied ? '; replied' : ''}`
}

export function detailsSummary(d: LiveDetails): string {
  const parts: string[] = []
  if (d.modelId || d.modelName) parts.push(`model ${brief(d.modelId ?? d.modelName)}`)
  if (d.effort) parts.push(`effort ${brief(d.effort)}`)
  if (d.costUsd != null) parts.push(`$${d.costUsd.toFixed(2)}`)
  if (d.contextWindow) parts.push(`window ${d.contextWindow}`)
  if (d.permissionMode) parts.push(`mode ${d.permissionMode}`)
  if (d.planMode !== undefined) parts.push(`plan mode ${d.planMode ? 'on' : 'off'}`)
  for (const l of d.planUsage?.limits ?? []) parts.push(`${brief(l.id)} ${Math.round(l.usedPercent)}%`)
  if (d.signIn) parts.push('sign-in refused')
  if (d.interruptedAt) parts.push('interrupted')
  return parts.join(' · ')
}

export const statusLineSummary = (d: LiveDetails): string => `status line → ${detailsSummary(d) || 'nothing new'}`

/** At most this many of a read's newest records go into its event (each redacted, the event bounded). */
const RECORDS = 10

/** A transcript read: its newest records as they were written, next to the details Hive read from them. */
export function transcriptEvent(provider: ProviderId, chunk: string, d: LiveDetails): CapturedEvent {
  const lines = chunk.split('\n').filter((l) => l.trim())
  const newest = lines.slice(-RECORDS).map((l) => {
    try {
      return JSON.parse(l) as unknown
    } catch {
      return { unparsed: l.length }
    }
  })
  const said = detailsSummary(d)
  return { kind: 'transcript', name: 'transcript', provider, raw: { records: lines.length, newest }, made: d, summary: `transcript +${lines.length} record${lines.length === 1 ? '' : 's'} → ${said || 'nothing new'}` }
}
