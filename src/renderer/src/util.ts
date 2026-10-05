import type { RecentWorkspace } from '@shared/types'
import { formatDate, formatWeekdayTime } from '@shared/dates'

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

export function formatNumber(n: number): string {
  return n.toLocaleString()
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!t) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 90) return '1 minute ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  if (d < 30) return d === 1 ? 'yesterday' : `${d} days ago`
  return formatDate(t)
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function isMac(): boolean {
  return window.hive.platform === 'darwin'
}

export function formatKeybinding(k: string): string {
  return k
    .split(' ')
    .map((chord) => chord.split('+').map((p) => (p === 'Mod' ? (isMac() ? '⌘' : 'Ctrl') : p.replace(/^Arrow(?=.)/, ''))).join('+'))
    .join(' ')
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** Quotes a path for pasting into a terminal when it contains whitespace. */
export const quotePath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Drag payload for files dragged out of the Files and Images tabs. */
export const HIVE_FILES_MIME = 'application/x-hive-files'

export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes('Files') || dt.types.includes(HIVE_FILES_MIME))
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** URL the renderer can load a workspace image from (served by the main process). */
export const imageUrl = (path: string): string => `hive-img://img/${encodeURIComponent(path)}`

/** When a limit resets, relative if soon: "in 2 h 14 min", else "Mon 09:00". */
export function resetsIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const min = Math.round(ms / 60000)
  if (min < 60) return `in ${min} min`
  if (min < 24 * 60) return `in ${Math.floor(min / 60)} h ${min % 60} min`
  return formatWeekdayTime(iso)
}

export { sessionLabel } from '@shared/defaults'

/** A recent workspace's tooltip: its path, and why it is greyed or marked (#144). */
export function recentTip(r: RecentWorkspace): string {
  return !r.exists ? `${r.path}\nNot found: moved or deleted, or on a drive that isn't connected.` : r.openElsewhere ? `${r.path}\nOpen in another window: choosing it brings that window forward.` : r.path
}

/** What a recent entry says beside its name: its path, "not found", or "open in another window". */
export function recentNote(r: RecentWorkspace): string {
  return !r.exists ? 'not found' : r.openElsewhere ? 'open in another window' : r.path
}
