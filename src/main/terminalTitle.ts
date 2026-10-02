/** The window title a program sets in its terminal output (OSC 0 or 2, ended by BEL or ST). */
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** A title sequence longer than this isn't one: its start isn't kept waiting for an end. */
const MAX_TITLE = 1024

/**
 * The last title set in a piece of output, read after `carry` (the unfinished title sequence the previous piece
 * ended with); `carry` is then the unfinished one this piece ends with, if any. Null when it sets none.
 */
export function lastTitle(carry: string, data: string): { title: string | null; carry: string } {
  const text = carry + data
  let title: string | null = null
  let end = 0
  for (const m of text.matchAll(TITLE)) {
    title = m[1]
    end = m.index + m[0].length
  }
  // A piece can end anywhere in a title's sequence, even between its first ESC and "]".
  const open = text.lastIndexOf('\x1b]')
  let rest = open >= end ? text.slice(open) : ''
  if (!/^\x1b\](?:[02]?$|[02];)/.test(rest)) rest = text.endsWith('\x1b') ? '\x1b' : ''
  return { title, carry: rest.length <= MAX_TITLE ? rest : '' }
}
