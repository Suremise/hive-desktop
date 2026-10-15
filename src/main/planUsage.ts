import { englishText } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { Notification } from 'electron'
import type { PlanLimit, PlanUsage, ProviderId } from '../shared/types'
import { providerName } from '../shared/providers'
import { formatTime, formatWeekdayTime } from '../shared/dates'
import { config } from './config'
import { emit, logNotice } from './events'
import { notificationIcon } from './paths'
import { showOsNotification } from './testQuiet'
import { routeAppNotice } from './notices'

/**
 * Plan usage (a subscription's rolling limits, e.g. 5-hour and weekly) as each provider reports it:
 * Claude Code to its status line, Codex in its transcripts. Nothing here talks to a provider's servers.
 * The values are account-wide, so per provider the last report wins, whichever session sent it.
 */

/** Kept so Windows can still activate them after they are shown. */
const shown = new Set<Notification>()
const WARN_LEVELS = [95, 80]

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
export function nextWarning(l: Pick<PlanLimit, 'usedPercent' | 'resetsAt'>, warned: { resetsAt: string | null; level: number } | undefined): number | null {
  const level = warned && samePeriod(warned.resetsAt, l.resetsAt) ? warned.level : 0
  const crossed = WARN_LEVELS.find((w) => l.usedPercent >= w)
  return crossed !== undefined && crossed > level ? crossed : null
}

function resetText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return ` ${sameDay ? tr(msg({ id: 'main.plan.resetsAt', defaultMessage: 'It resets at {time}.', description: 'The end of a plan-usage notice: the limit resets today. {time} is the time.' }), { time: formatTime(d) }) : tr(msg({ id: 'main.plan.resetsOn', defaultMessage: 'It resets on {when}.', description: 'The end of a plan-usage notice: the limit resets another day. {when} is the day and time.' }), { when: formatWeekdayTime(d) })}`
}

/** At most one save of plan usage per minute; the numbers are only shown, so a late save loses nothing that matters. */
const SAVE_INTERVAL_MS = 60_000
let lastSave = 0
let saveTimer: NodeJS.Timeout | null = null

function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    lastSave = Date.now()
    config.update(() => undefined)
  }, Math.max(0, lastSave + SAVE_INTERVAL_MS - Date.now()))
}

const USED = msg({ id: 'main.plan.used', defaultMessage: '{share, number, ::percent} of your {provider} {limit} limit used', description: "A notice: how much of a plan's usage limit is used ({share}: \"85%\"). {provider} is the coding agent; {limit} names the limit as the provider does (5-hour, weekly), in English for now." })

/**
 * The notice that a limit is `level`% used: in the language shown, its title in English for the Agent API too.
 * Exported for tests.
 */
export function planNotice(provider: ProviderId, l: Pick<PlanLimit, 'usedPercent' | 'resetsAt' | 'label'>, level: number): { title: string; body: string; apiTitle: string } {
  const values = { share: Math.round(l.usedPercent) / 100, provider: providerName(provider), limit: l.label }
  const body = `${level >= 95 ? tr(msg({ id: 'main.plan.pause', defaultMessage: 'Sessions will pause when it runs out.', description: 'A plan-usage notice, at 95% used or more.' })) : tr(msg({ id: 'main.plan.close', defaultMessage: 'You are getting close to the limit.', description: 'A plan-usage notice, below 95% used.' }))}${resetText(l.resetsAt)}`
  return { title: tr(USED, values), body, apiTitle: englishText({ m: USED, values }) }
}

/** What the user sees: whole percentages and the reset times. Anything else (the report time) isn't a change. */
const shownValues = (u: PlanUsage | null | undefined): string => JSON.stringify([u?.plan ?? null, (u?.limits ?? []).map((l) => [l.id, Math.round(l.usedPercent), l.resetsAt])])

/**
 * Providers report plan usage often (Claude Code with every status-line update, many times a minute while
 * agents work). The latest report is kept in memory (saved with the config on quit and with any other
 * change); it is only written to disk when a shown value changes, and then at most once a minute.
 */
export function reportPlanUsage(provider: ProviderId, usage: PlanUsage): void {
  const all = config.get().planUsage
  const prev = all[provider]
  const changed = shownValues(prev) !== shownValues(usage)
  config.get().planUsage = { ...all, [provider]: usage }
  if (changed) {
    emit({ type: 'plan-usage', provider, usage })
    saveSoon()
  }

  for (const l of usage.limits) {
    const key = `${provider}:${l.id}`
    const level = nextWarning(l, config.get().planWarnings[key])
    if (level === null) continue
    config.update((c) => (c.planWarnings[key] = { resetsAt: l.resetsAt, level }))
    const { title, body, apiTitle } = planNotice(provider, l, level)
    // Kept in the Notifications panel, and told as agent notices are (routeAppNotice): a banner in the window you are
    // using, a Windows notification with Hive in the background, or nothing (notifications off, or Show nothing).
    logNotice(level >= 95 ? 'error' : 'warning', title, body)
    routeAppNotice(
      title,
      body,
      () => {
        if (!Notification.isSupported()) return
        const n = new Notification({ title, body, icon: notificationIcon() })
        shown.add(n)
        n.on('close', () => shown.delete(n))
        if (!showOsNotification(n, title, body)) shown.delete(n)
      },
      apiTitle
    )
  }
}
