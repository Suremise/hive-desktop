import { afterEach, describe, expect, it } from 'vitest'
import { dateStyle, daysAgo, formatDate, formatDateTime, formatLongDay, formatShortDay, formatTime, formatWeekdayTime, formatWhen, setDateStyle, type DateStyle } from '../src/shared/dates'
import { setFormatLocale } from '../src/shared/i18n/locale'

const at = new Date(2026, 9, 4, 14, 5)
const style = (date: DateStyle['date'], time: DateStyle['time'] = '24h'): DateStyle => ({ date, time })

afterEach(() => {
  setDateStyle(undefined)
  setFormatLocale('en')
})

describe('dates', () => {
  it('formats the date as chosen, yyyy-mm-dd by default', () => {
    expect(formatDate(at)).toBe('2026-10-04')
    expect(formatDate(at, style('ymd'))).toBe('2026-10-04')
    expect(formatDate(at, style('dmy'))).toBe('04/10/2026')
    expect(formatDate(at, style('mdy'))).toBe('10/04/2026')
    expect(formatDate(at, style('system'))).toBe(at.toLocaleDateString())
  })

  it('formats the time in 24 or 12 hours, midnight and noon too', () => {
    expect(formatTime(at)).toBe('14:05')
    expect(formatTime(at, style('ymd', '12h'))).toBe('2:05 PM')
    expect(formatTime(new Date(2026, 9, 4, 0, 7), style('ymd', '12h'))).toBe('12:07 AM')
    expect(formatTime(new Date(2026, 9, 4, 0, 7))).toBe('00:07')
    expect(formatTime(new Date(2026, 9, 4, 12, 0), style('ymd', '12h'))).toBe('12:00 PM')
    expect(formatTime(new Date(2026, 9, 4, 9, 30), style('ymd', '12h'))).toBe('9:30 AM')
  })

  it('takes ISO strings and times, and gives nothing for a date it cannot read', () => {
    expect(formatDateTime(at.toISOString())).toBe('2026-10-04 14:05')
    expect(formatDateTime(at.getTime(), style('dmy', '12h'))).toBe('04/10/2026 2:05 PM')
    expect(formatDate('not a date')).toBe('')
    expect(formatDateTime('not a date')).toBe('')
  })

  it('says only the time for today, else the date too', () => {
    const now = new Date(2026, 9, 4, 18, 0)
    expect(formatWhen(at, now)).toBe('14:05')
    expect(formatWhen(new Date(2026, 9, 3, 23, 59), now)).toBe('2026-10-03 23:59')
    expect(formatWeekdayTime(at, style('ymd', '12h'))).toMatch(/ 2:05 PM$/)
  })

  it('counts calendar days back, across midnight and a clock change', () => {
    const now = new Date(2026, 9, 15, 0, 30)
    expect(daysAgo(new Date(2026, 9, 15, 0, 1), now)).toBe(0)
    expect(daysAgo(new Date(2026, 9, 14, 23, 59), now)).toBe(1)
    expect(daysAgo(new Date(2026, 9, 9, 12, 0).toISOString(), now)).toBe(6)
    expect(daysAgo(new Date(2026, 2, 28, 12), new Date(2026, 2, 30, 1))).toBe(2)
  })

  it('names a day in the language, with the year only when it is not this year', () => {
    const now = new Date(2026, 9, 15, 12)
    expect(formatShortDay(new Date(2026, 9, 9, 8), now)).toBe('Oct 9')
    expect(formatShortDay(new Date(2025, 11, 30, 8), now)).toBe('Dec 30, 2025')
    expect(formatLongDay(new Date(2026, 9, 14, 8), now)).toBe('Wednesday, Oct 14')
    setFormatLocale('de')
    expect(formatShortDay(new Date(2026, 9, 9, 8), now)).toBe('9. Okt.')
    expect(formatLongDay(new Date(2026, 9, 14, 8), now)).toBe('Mittwoch, 14. Okt.')
    expect(formatShortDay('not a date', now)).toBe('')
  })

  it('uses the chosen style until it changes, falling back to the default for unknown values', () => {
    setDateStyle({ date: 'mdy', time: '12h' })
    expect(formatDateTime(at)).toBe('10/04/2026 2:05 PM')
    setDateStyle({ date: 'nonsense' as DateStyle['date'], time: '12h' })
    expect(dateStyle()).toEqual({ date: 'ymd', time: '12h' })
    setDateStyle(undefined)
    expect(formatDateTime(at)).toBe('2026-10-04 14:05')
  })
})
