/**
 * Card numbers in a terminal line ("#383 is back On Hold", "(#12)", "#12,"), which the terminal links to their
 * cards (#440). Only numbers that are cards on the workspace's board are links (the caller decides): a GitHub
 * issue or a stray "#5" in output isn't underlined.
 */

export interface CardMatch {
  /** Where `#n` starts and ends in the line (end exclusive). */
  start: number
  end: number
  number: number
}

/**
 * `#n`, not inside a longer word (`abc#12`), path (`a/#12`) or HTML entity (`&#12;`), and not hex (`#fff`, `#12ab`,
 * a commit) or a version (`#12.5`). Up to seven digits, no leading zero.
 */
const CARD_RE = /(?<![\p{L}\p{N}_&#/\\.])#([1-9]\d{0,6})(?![\p{L}\p{N}_]|[.-][\p{L}\p{N}_])/gu
/** A URL, whose fragment (`https://x/y#12`) is the web link's. */
const URL_RE = /\b(?:[a-z][\w+.-]*:\/\/|www\.)\S+/gi

/** The card numbers in a line that `isCard` accepts, in order. */
export function findCardRefs(text: string, isCard: (n: number) => boolean): CardMatch[] {
  if (!text.includes('#')) return []
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length])
  const out: CardMatch[] = []
  for (const m of text.matchAll(CARD_RE)) {
    const start = m.index
    if (urls.some(([a, b]) => start >= a && start < b)) continue
    const number = Number(m[1])
    if (isCard(number)) out.push({ start, end: start + m[0].length, number })
  }
  return out
}
