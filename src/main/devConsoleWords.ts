import { basename } from 'path'
import type { CapturedEvent } from '../shared/devConsole'
import { DETAILS_FIELDS, TRANSCRIPT_FIELDS, safeWord } from '../shared/devConsole'
import type { LiveSessionState, ProviderId } from '../shared/types'
import type { LiveDetails } from './providers/types'

/**
 * The developer console's summary lines (#636): what came in and what Hive made of it, in Hive's own words. Never the
 * CLI's or anyone's text: values go through safeWord(), which keeps numbers and identifiers only and says the rest is
 * text; Hive's own names (agents, projects) through hiveName() as the event is kept.
 */

export function hookSummary(name: string, tool: unknown, event: string, status: string, actions: string[], replied: boolean): string {
  const t = safeWord(tool)
  return `${safeWord(name) || '(unnamed)'}${t ? ` (${t})` : ''} → ${event}; ${status}${actions.length ? `; ${actions.join(', ')}` : ''}${replied ? '; replied' : ''}`
}

export function detailsSummary(d: LiveDetails): string {
  const parts: string[] = []
  if (d.modelId || d.modelName) parts.push(`model ${safeWord(d.modelId ?? d.modelName)}`)
  if (d.effort) parts.push(`effort ${safeWord(d.effort)}`)
  if (typeof d.costUsd === 'number' && Number.isFinite(d.costUsd)) parts.push(`$${d.costUsd.toFixed(2)}`)
  if (typeof d.contextWindow === 'number') parts.push(`window ${d.contextWindow}`)
  if (d.permissionMode) parts.push(`mode ${safeWord(d.permissionMode)}`)
  if (d.planMode !== undefined) parts.push(`plan mode ${d.planMode ? 'on' : 'off'}`)
  for (const l of (d.planUsage?.limits ?? []).slice(0, 6)) parts.push(`${safeWord(l.id)} ${Math.round(Number(l.usedPercent) || 0)}%`)
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
  return { kind: 'transcript', name: 'transcript', provider, raw: { records: lines.length, newest }, made: d, safe: { raw: TRANSCRIPT_FIELDS, made: DETAILS_FIELDS }, summary: `transcript +${lines.length} record${lines.length === 1 ? '' : 's'} → ${said || 'nothing new'}` }
}

/**
 * A launch: the CLI, its version and how many arguments, never the arguments themselves. An option's value, inline
 * (`--append-system-prompt=…`) or not, can be a prompt, and a value can begin with a dash: only the CLI's own grammar
 * tells them from switches, so none is kept.
 */
export function launchEvent(l: { provider: ProviderId; name: string; file: string; args: string[]; cwd: string; version: string | null; state: Pick<LiveSessionState, 'status' | 'permissionMode' | 'modelId' | 'effort'>; resumed: boolean }): CapturedEvent {
  return {
    kind: 'launch',
    name: 'launch',
    provider: l.provider,
    raw: { file: basename(l.file), args: l.args.length, cwd: l.cwd, version: l.version },
    made: { status: l.state.status, permissionMode: l.state.permissionMode, modelId: l.state.modelId, effort: l.state.effort, resumed: l.resumed },
    safe: { raw: { file: true, cwd: true, version: true }, made: { status: true, permissionMode: true, modelId: true, effort: true } },
    summary: `${l.name} ${safeWord(l.version)} started${l.resumed ? ' (resumed)' : ''}; ${l.state.status}`
  }
}
