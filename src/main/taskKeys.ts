import { lastTitle } from './terminalTitle'
import { TerminalScreen } from './terminalScreen'

/**
 * When keys typed into a CLI's own interface (a provider task's CommandSpec.keys) may go in: once its screen shows
 * it is ready, and its window title hasn't shown it busy for a moment. Fed the output as it comes, in pieces that can
 * end anywhere: readiness is read from the screen the output draws (a CLI can change a word in place by moving the
 * cursor), and the title from the output itself.
 */
export class KeyGate {
  ready = false
  busy = false
  /** When it became ready, or last showed or stopped showing that it is busy. */
  changed = 0
  private titleCarry = ''
  private screen: TerminalScreen | null

  private readonly readyPattern: RegExp
  private readonly busyTitle?: RegExp
  private readonly clock: () => number
  private readonly onReady?: () => void

  constructor(opts: { ready: RegExp; busyTitle?: RegExp; cols: number; rows: number; clock?: () => number; onReady?: () => void }) {
    this.readyPattern = opts.ready
    this.busyTitle = opts.busyTitle
    this.clock = opts.clock ?? Date.now
    this.onReady = opts.onReady
    this.screen = new TerminalScreen(opts.cols, opts.rows)
  }

  feed(data: string): void {
    if (this.busyTitle) {
      const { title, carry } = lastTitle(this.titleCarry, data)
      this.titleCarry = carry
      if (title !== null && this.busyTitle.test(title) !== this.busy) {
        this.busy = !this.busy
        this.changed = this.clock()
      }
    }
    const screen = this.screen
    screen?.write(data, () => {
      if (this.ready || !this.readyPattern.test(screen.text())) return
      this.ready = true
      // Idle since it became ready, not before: its startup spinner may come just after (#235).
      if (!this.busy) this.changed = this.clock()
      queueMicrotask(() => this.dispose())
      this.onReady?.()
    })
  }

  /** How long it has been ready and not busy (0 while busy or not ready). */
  idleFor(): number {
    return this.ready && !this.busy ? this.clock() - this.changed : 0
  }

  /** Not busy, and not for `ms` (ready or not: for keys that go in anyway). */
  settled(ms: number): boolean {
    return !this.busy && this.clock() - this.changed >= ms
  }

  /** Lets the screen go (once ready it isn't read again, and the title is enough). */
  dispose(): void {
    this.screen?.dispose()
    this.screen = null
  }
}
