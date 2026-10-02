import { localDay, nextTip, sawTip, tipForMoment, tipForToday, usedCommand, type TipMoment, type TipsState } from '@shared/tips'
import { call } from './api'
import { get, notify, set, setActivity } from './store'

/**
 * What the tip card shows and what the tips remember (`ui.tips` in the profile, saved shortly after a change).
 * The card and Help → Tips… are in components/Tips.tsx.
 */

let saveTimer: ReturnType<typeof setTimeout> | null = null
function update(fn: (s: TipsState) => TipsState): void {
  set((st) => ({ tips: fn(st.tips) }))
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void call('ui:set', { tips: get().tips }).catch(() => undefined), 500)
}

const tipsOn = (): boolean => get().settings?.general.showTips !== false

function show(id: string): void {
  update((s) => sawTip(s, id))
  set({ tipShown: id })
}

/** Notes a command the user ran, so tips about it aren't shown by themselves. */
export function noteCommandUsed(id: string): void {
  if (!get().tips.used.includes(id)) update((s) => usedCommand(s, id))
}

/** The day's tip, when Hive starts: at most one a day, and only with tips on. */
export function showTodaysTip(): void {
  if (!tipsOn() || get().tipShown) return
  const now = new Date()
  const tip = tipForToday(get().tips, now)
  if (!tip) return
  update((s) => ({ ...s, shownOn: localDay(now) }))
  show(tip.id)
}

/** A moment a tip helps with (the first long transcript, the first pasted image…): its tip, the first time. */
export function offerTip(moment: TipMoment): void {
  if (!tipsOn() || get().tips.moments.includes(moment)) return
  const tip = tipForMoment(get().tips, moment)
  update((s) => ({ ...s, moments: [...s.moments, moment] }))
  if (tip) show(tip.id)
}

/** Next tip in the card (also with tips turned off: the user asked). */
export function showNextTip(): void {
  const tip = nextTip(get().tips, get().tipShown)
  if (tip) show(tip.id)
}

export const closeTip = (): void => set({ tipShown: null })

/** "Don't show tips": turns the setting off; Help → Tips… still has them. */
export async function turnOffTips(): Promise<void> {
  closeTip()
  try {
    set({ settings: await call('settings:update', { general: { showTips: false } }) })
    notify('info', 'Tips are off', 'Help → Tips… still has them, and Settings → General turns them back on.')
  } catch {
    // The card is closed either way; the setting is still in Settings → General.
  }
}

/** Opens the user guide at a heading. */
export function openGuideAt(heading: string): void {
  set({ docsPage: 'guide', docsAnchor: heading })
  if (get().activity !== 'docs') setActivity('docs')
}
