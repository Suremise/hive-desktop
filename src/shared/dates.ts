/**
 * Dates and times as the user chose them (Settings → General → Date format and Time): every date Hive shows goes
 * through these, so one setting changes them all. Each process keeps the current choice (`setDateStyle`, from its
 * settings); a formatter given a style uses that instead.
 */

/** yyyy-mm-dd (2026-10-04), dd/mm/yyyy, mm/dd/yyyy, or the system's own short date. */
export type DateFormat = 'ymd' | 'dmy' | 'mdy' | 'system'
/** 24-hour (14:05) or 12-hour (2:05 PM). */
export type TimeFormat = '24h' | '12h'
export interface DateStyle {
  date: DateFormat
  time: TimeFormat
}

export const DEFAULT_DATE_STYLE: DateStyle = { date: 'ymd', time: '24h' }
export const DATE_FORMATS: DateFormat[] = ['ymd', 'dmy', 'mdy', 'system']
export const TIME_FORMATS: TimeFormat[] = ['24h', '12h']

let current: DateStyle = DEFAULT_DATE_STYLE

/** The choice formatters use from now on (unknown values fall back to the default). */
export function setDateStyle(s: Partial<DateStyle> | undefined): void {
  current = {
    date: s?.date && DATE_FORMATS.includes(s.date) ? s.date : DEFAULT_DATE_STYLE.date,
    time: s?.time && TIME_FORMATS.includes(s.time) ? s.time : DEFAULT_DATE_STYLE.time
  }
}

export function dateStyle(): DateStyle {
  return current
}

const toDate = (d: Date | string | number): Date | null => {
  const x = d instanceof Date ? d : new Date(d)
  return isNaN(x.getTime()) ? null : x
}
const pad = (n: number): string => String(n).padStart(2, '0')

/** The date alone: "2026-10-04" (or as chosen); '' for a date that can't be read. */
export function formatDate(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  const [y, m, day] = [x.getFullYear(), pad(x.getMonth() + 1), pad(x.getDate())]
  switch (style.date) {
    case 'dmy':
      return `${day}/${m}/${y}`
    case 'mdy':
      return `${m}/${day}/${y}`
    case 'system':
      return x.toLocaleDateString()
    default:
      return `${y}-${m}-${day}`
  }
}

/** The time alone: "14:05", or "2:05 PM". */
export function formatTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  const h = x.getHours()
  const mm = pad(x.getMinutes())
  return style.time === '12h' ? `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${mm}`
}

/** Date and time: "2026-10-04 14:05". */
export function formatDateTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  return x ? `${formatDate(x, style)} ${formatTime(x, style)}` : ''
}

/** When something happened, briefly: the time alone today, else the date and time. */
export function formatWhen(d: Date | string | number, now = new Date(), style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  return x.toDateString() === now.toDateString() ? formatTime(x, style) : formatDateTime(x, style)
}

/** A weekday and time, for something within the coming week: "Mon 14:05". */
export function formatWeekdayTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  return x ? `${x.toLocaleDateString([], { weekday: 'short' })} ${formatTime(x, style)}` : ''
}
