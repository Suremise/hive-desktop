import { Notification } from 'electron'
import type { PlanLimit, PlanUsage } from '../shared/types'
import { config } from './config'
import { emit, toast } from './events'
import { notificationIcon } from './paths'

/**
 * Plan usage (the subscription's 5-hour and weekly limits) as reported by Claude Code to its status
 * line. Hive's status-line command forwards that JSON to the hook server; nothing here talks to
 * Anthropic directly. The values are account-wide, so the last report wins, whichever session sent it.
 */

/** Kept so Windows can still activate them after they are shown. */
const shown = new Set<Notification>()
const WARN_LEVELS = [95, 80]
const LIMIT_NAMES: Record<'fiveHour' | 'sevenDay', string> = { fiveHour: '5-hour', sevenDay: 'weekly' }

/** resets_at arrives as epoch seconds (or ms, or an ISO string); normalise to ISO. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

function limit(raw: unknown): PlanLimit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pct = Number(r.used_percentage)
  if (!Number.isFinite(pct)) return null
  return { usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: toIso(r.resets_at) }
}

/** Reads rate_limits from a status-line payload; null when it has none (e.g. API-key accounts). */
export function parsePlanUsage(payload: Record<string, unknown>, now = new Date()): PlanUsage | null {
  const rl = payload.rate_limits as Record<string, unknown> | undefined
  if (!rl || typeof rl !== 'object') return null
  const fiveHour = limit(rl.five_hour)
  const sevenDay = limit(rl.seven_day)
  if (!fiveHour && !sevenDay) return null
  return { fiveHour, sevenDay, updatedAt: now.toISOString() }
}

/** Reset times can wobble by seconds between reports; a new period moves them by hours. */
function samePeriod(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(Date.parse(a) - Date.parse(b)) < 30 * 60 * 1000
}

/**
 * Which warning to show for a limit, if any: the highest level crossed that hasn't been shown in
 * this reset period. Returns the level and the record to store.
 */
export function nextWarning(l: PlanLimit, shown: { resetsAt: string | null; level: number } | undefined): number | null {
  const level = shown && samePeriod(shown.resetsAt, l.resetsAt) ? shown.level : 0
  const crossed = WARN_LEVELS.find((w) => l.usedPercent >= w)
  return crossed !== undefined && crossed > level ? crossed : null
}

function resetText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return ` It resets ${sameDay ? 'at' : 'on'} ${d.toLocaleString([], sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
}

export function reportPlanUsage(usage: PlanUsage): void {
  const prev = config.get().planUsage
  const changed = !prev || JSON.stringify({ ...prev, updatedAt: '' }) !== JSON.stringify({ ...usage, updatedAt: '' })
  config.update((c) => (c.planUsage = usage))
  if (changed) emit({ type: 'plan-usage', usage })

  for (const key of ['fiveHour', 'sevenDay'] as const) {
    const l = usage[key]
    if (!l) continue
    const level = nextWarning(l, config.get().planWarnings[key])
    if (level === null) continue
    config.update((c) => (c.planWarnings[key] = { resetsAt: l.resetsAt, level }))
    const title = `${Math.round(l.usedPercent)}% of your ${LIMIT_NAMES[key]} limit used`
    const body = `${level >= 95 ? 'Sessions will pause when it runs out.' : 'You are getting close to the limit.'}${resetText(l.resetsAt)}`
    toast(level >= 95 ? 'error' : 'warning', title, body)
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: notificationIcon() })
      shown.add(n)
      n.on('close', () => shown.delete(n))
      n.show()
    }
  }
}
