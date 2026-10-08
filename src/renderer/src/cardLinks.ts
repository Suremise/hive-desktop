import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findCardRefs } from '@shared/cardLinks'
import { columnLabel } from '@shared/tasks'
import type { TaskCard } from '@shared/types'
import { lineText } from './fileLinks'
import { get, set } from './store'

/** The hover text for a card's link: its number, title and column, and how to open it. */
export function cardLinkTitle(c: TaskCard): string {
  return `#${c.number} ${c.title} · ${c.archived ? `Archived (from ${columnLabel(c.column)})` : columnLabel(c.column)} · Ctrl+click to open`
}

/**
 * Ctrl+click on a card number (`#12`) in a terminal opens the card (#440), like a file path's link. Only the numbers
 * of cards on this window's board (archived too) are links; the card is the window's, whose workspace owns the
 * terminal. Reads the rendered text, so it works for every provider and the Assistant.
 */
export function cardLinkProvider(term: Terminal, host: () => HTMLElement | null): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const tasks = get().tasks
      if (!line || !tasks.length) return callback(undefined)
      const { text, colOf } = lineText(line, term.cols)
      const cards = new Map(tasks.map((c) => [c.number, c]))
      const links: ILink[] = findCardRefs(text, (n) => cards.has(n)).map((m) => ({
        text: text.slice(m.start, m.end),
        range: { start: { x: colOf[m.start] + 1, y }, end: { x: colOf[m.end - 1] + 1, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: (e) => {
          if ((e.ctrlKey || e.metaKey) && get().tasks.some((c) => c.number === m.number)) set({ taskOpen: m.number })
        },
        hover: () => {
          // The card as it is now: its title or column may have changed since the line was printed.
          const c = get().tasks.find((x) => x.number === m.number)
          if (c) host()?.setAttribute('title', cardLinkTitle(c))
        },
        leave: () => host()?.removeAttribute('title')
      }))
      callback(links.length ? links : undefined)
    }
  }
}
