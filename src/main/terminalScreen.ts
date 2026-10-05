import { Terminal } from '@xterm/headless'

/**
 * A session terminal's visible screen, kept in the main process so Hive can read what the CLI shows (its footer)
 * rather than the raw output: a CLI that redraws only the characters that changed (Claude Code without colours,
 * NO_COLOR) never sends the whole line again. No scrollback, so it holds one screen (rows × cols cells) at most.
 */
export class TerminalScreen {
  private term: Terminal | null

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  }

  /** Renders `data`; `parsed` runs once the terminal has taken it in (not after dispose). */
  write(data: string, parsed?: () => void): void {
    const term = this.term
    if (!term) return
    term.write(data, () => {
      if (this.term === term) parsed?.()
    })
  }

  resize(cols: number, rows: number): void {
    if (!this.term || cols < 2 || rows < 2) return
    this.term.resize(Math.floor(cols), Math.floor(rows))
  }

  /** The visible lines, top to bottom, without trailing blanks. */
  text(): string {
    const buf = this.term?.buffer.active
    if (!buf) return ''
    const lines: string[] = []
    for (let i = 0; i < this.term!.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  dispose(): void {
    this.term?.dispose()
    this.term = null
  }
}
