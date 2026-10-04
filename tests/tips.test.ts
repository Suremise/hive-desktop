// Tips: which one shows (one a day, unseen first, skipping what the user already does, in rounds), the moments
// that show one once, and the content itself (unique ids, a user guide heading behind each Learn more).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { EMPTY_TIPS_STATE, TIP_ENTRIES, TIP_GROUPS, TIP_MOMENTS, TIPS, localDay, nextTip, sawTip, tipForMoment, tipForToday, tipsState, usedCommand, type Tip, type TipsState } from '../src/shared/tips'

const t = (id: string, command?: string, knownBy?: string[]): Tip => ({ id, group: 'Sessions', order: 0, title: id, text: id, command, knownBy })
const tips = [t('a', 'cmd.a'), t('b'), t('c', 'cmd.c'), t('d', 'cmd.d', [])]

describe('choosing a tip', () => {
  it('shows one a day', () => {
    const today = new Date(2026, 9, 2, 9)
    expect(tipForToday(EMPTY_TIPS_STATE, today, tips)?.id).toBe('a')
    expect(tipForToday({ ...EMPTY_TIPS_STATE, shownOn: localDay(today) }, new Date(2026, 9, 2, 23), tips)).toBeNull()
    expect(tipForToday({ ...EMPTY_TIPS_STATE, shownOn: localDay(today) }, new Date(2026, 9, 3, 0, 5), tips)?.id).toBe('a')
  })

  it("doesn't repeat a tip until the round is over, then starts again", () => {
    let s: TipsState = EMPTY_TIPS_STATE
    const shown: string[] = []
    for (let i = 0; i < 6; i++) {
      const tip = nextTip(s, shown.at(-1) ?? null, tips)!
      shown.push(tip.id)
      s = sawTip(s, tip.id, tips)
    }
    expect(shown).toEqual(['a', 'b', 'c', 'd', 'a', 'b'])
    // Starting again after a restart: the next unseen one.
    expect(nextTip(sawTip(sawTip(EMPTY_TIPS_STATE, 'a', tips), 'b', tips), null, tips)?.id).toBe('c')
  })

  it("skips tips about what the user already does (knownBy, by default the tip's command)", () => {
    const s = usedCommand(usedCommand(EMPTY_TIPS_STATE, 'cmd.a'), 'cmd.d')
    expect(nextTip(s, null, tips)?.id).toBe('b')
    expect(nextTip(s, 'b', tips)?.id).toBe('c')
    // d's knownBy is empty: running its command doesn't hide it.
    expect(nextTip(s, 'c', tips)?.id).toBe('d')
    expect(nextTip(usedCommand(usedCommand(EMPTY_TIPS_STATE, 'cmd.a'), 'cmd.c'), null, [t('a', 'cmd.a'), t('c', 'cmd.c')])).toBeNull()
  })

  it('shows a moment\'s tip once, and not when the user knows it', () => {
    const tip = TIPS.find((x) => x.id === TIP_MOMENTS['compact-suggested'])!
    expect(tipForMoment(EMPTY_TIPS_STATE, 'compact-suggested')?.id).toBe(tip.id)
    expect(tipForMoment({ ...EMPTY_TIPS_STATE, moments: ['compact-suggested'] }, 'compact-suggested')).toBeNull()
    expect(tipForMoment(usedCommand(EMPTY_TIPS_STATE, tip.command!), 'compact-suggested')).toBeNull()
  })

  it('reads a damaged saved state safely', () => {
    expect(tipsState(null)).toEqual(EMPTY_TIPS_STATE)
    expect(tipsState({ seen: ['a', 3], moments: 'x', used: ['c'], shownOn: 5 })).toEqual({ seen: ['a'], moments: [], used: ['c'] })
  })
})

describe('the tips', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs', 'USER_GUIDE.md'), 'utf8')
  const headings = new Set([...guide.matchAll(/^#{1,4} (.+)$/gm)].map((m) => m[1].trim()))

  it('have unique ids, known groups, short texts and a heading of the user guide behind Learn more', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(25)
    expect(new Set(TIPS.map((x) => x.id)).size).toBe(TIPS.length)
    for (const tip of TIPS) {
      expect(TIP_GROUPS).toContain(tip.group)
      expect(tip.text.length, tip.id).toBeLessThanOrEqual(260)
      if (tip.docs) expect(headings.has(tip.docs), `${tip.id}: "${tip.docs}"`).toBe(true)
    }
  })

  it('are listed in id order (fewer merge conflicts) and shown in their own order', () => {
    const ids = TIP_ENTRIES.map((x) => x.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(TIPS.map((x) => x.order)).size, 'two tips share an order').toBe(TIPS.length)
    expect(TIPS.map((x) => x.order)).toEqual(TIP_ENTRIES.map((x) => x.order).sort((a, b) => a - b))
  })

  it('cover every moment', () => {
    for (const id of Object.values(TIP_MOMENTS)) expect(TIPS.some((x) => x.id === id), id).toBe(true)
  })
})
