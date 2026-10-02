import { describe, expect, it } from 'vitest'
import { lastTitle } from '../src/main/terminalTitle'

/** Feeds output in pieces, as the terminal delivers it: the titles each piece shows (null: none). */
function feed(...pieces: string[]): (string | null)[] {
  let carry = ''
  return pieces.map((p) => {
    const r = lastTitle(carry, p)
    carry = r.carry
    return r.title
  })
}

describe('terminal titles', () => {
  it('reads OSC 0 and 2, ended by BEL or ST; the last one in a piece wins', () => {
    expect(lastTitle('', 'x\x1b]0;demo\x07y').title).toBe('demo')
    expect(lastTitle('', '\x1b]2;[ ! ] Action Required | demo\x1b\\').title).toBe('[ ! ] Action Required | demo')
    expect(lastTitle('', '\x1b]0;one\x07\x1b[2J\x1b]0;two\x07').title).toBe('two')
    expect(lastTitle('', 'plain output').title).toBeNull()
  })

  it('a title split across pieces, anywhere, is read once it is whole', () => {
    const t = '\x1b]0;[ ! ] Action Required | demo\x07'
    for (let i = 1; i < t.length; i++) expect(feed('a' + t.slice(0, i), t.slice(i) + 'b'), `split at ${i}`).toEqual([null, '[ ! ] Action Required | demo'])
    // Ended by ST, split between its two characters.
    expect(feed('\x1b]0;demo\x1b', '\\')).toEqual([null, 'demo'])
  })

  it("other sequences aren't titles, and aren't kept waiting", () => {
    // A hyperlink (OSC 8) and colours.
    expect(lastTitle('', '\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b[31mred').title).toBeNull()
    expect(lastTitle('', 'text \x1b]8;;https://x').carry).toBe('')
    // A title that never ends isn't kept forever.
    expect(lastTitle('', '\x1b]0;' + 'x'.repeat(2000)).carry).toBe('')
    expect(lastTitle('', 'done\x1b]0;demo\x07').carry).toBe('')
  })
})
