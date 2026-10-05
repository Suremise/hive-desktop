import { afterEach, describe, expect, it } from 'vitest'
import { dateStyle, formatDate, formatDateTime, formatTime, formatWeekdayTime, formatWhen, setDateStyle, type DateStyle } from '../src/shared/dates'

const at = new Date(2026, 9, 4, 14, 5)
const style = (date: DateStyle['date'], time: DateStyle['time'] = '24h'): DateStyle => ({ date, time })

afterEach(() => setDateStyle(undefined))

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

  it('uses the chosen style until it changes, falling back to the default for unknown values', () => {
    setDateStyle({ date: 'mdy', time: '12h' })
    expect(formatDateTime(at)).toBe('10/04/2026 2:05 PM')
    setDateStyle({ date: 'nonsense' as DateStyle['date'], time: '12h' })
    expect(dateStyle()).toEqual({ date: 'ymd', time: '12h' })
    setDateStyle(undefined)
    expect(formatDateTime(at)).toBe('2026-10-04 14:05')
  })
})
