import { lastTitle } from './terminalTitle'
import { TerminalScreen } from './terminalScreen'

/**
 * When keys typed into a CLI's own interface (a provider task's CommandSpec.keys) may go in: once its screen shows
 * it is ready, and it hasn't shown it is busy for a moment, in its window title or on its screen (#363: Codex's
 * "tab to queue message" can show before its title's spinner). Fed the output as it comes, in pieces that can end
 * anywhere: readiness and the screen's busy sign are read from the screen the output draws (a CLI can change a word
 * in place by moving the cursor), and the title from the output itself.
 */
export class KeyGate {
  ready = false
  /** Busy by its title or its screen. */
  busy = false
  /** When it became ready, or last showed or stopped showing that it is busy. */
  changed = 0
  private titleBusy = false
  private screenBusy = false
  private titleCarry = ''
  private screen: TerminalScreen | null

  private readonly readyPattern: RegExp
  private readonly busyTitle?: RegExp
  private readonly busyScreen?: (screen: string) => boolean
  private readonly clock: () => number
  private readonly onReady?: () => void
  private readonly keepScreen: boolean

  /**
   * keepScreen: the screen is still rendered once ready, for keys picked from it (a menu, #396) or checked against it
   * (a held submission, #363); dispose() ends it. busyScreen is read while the screen is rendered, so it needs it kept.
   */
  constructor(opts: { ready: RegExp; busyTitle?: RegExp; busyScreen?: (screen: string) => boolean; cols: number; rows: number; clock?: () => number; onReady?: () => void; keepScreen?: boolean }) {
    this.readyPattern = opts.ready
    this.busyTitle = opts.busyTitle
    this.busyScreen = opts.busyScreen
    this.clock = opts.clock ?? Date.now
    this.onReady = opts.onReady
    this.keepScreen = !!opts.keepScreen || !!opts.busyScreen
    this.screen = new TerminalScreen(opts.cols, opts.rows)
  }

  /** The screen as rendered now, or null once it has gone. */
  text(): string | null {
    return this.screen?.text() ?? null
  }

  feed(data: string): void {
    if (this.busyTitle) {
      const { title, carry } = lastTitle(this.titleCarry, data)
      this.titleCarry = carry
      if (title !== null) this.setBusy(this.busyTitle.test(title), this.screenBusy)
    }
    const screen = this.screen
    screen?.write(data, () => {
      if (this.busyScreen) this.setBusy(this.titleBusy, this.busyScreen(screen.text()))
      if (this.ready || !this.readyPattern.test(screen.text())) return
      this.ready = true
      // Idle since it became ready, not before: its startup spinner may come just after (#235).
      if (!this.busy) this.changed = this.clock()
      if (!this.keepScreen) queueMicrotask(() => this.dispose())
      this.onReady?.()
    })
  }

  private setBusy(title: boolean, screen: boolean): void {
    this.titleBusy = title
    this.screenBusy = screen
    if (title || screen) {
      if (!this.busy) this.changed = this.clock()
      this.busy = true
    } else if (this.busy) {
      this.busy = false
      this.changed = this.clock()
    }
  }

  /** How long it has been ready and not busy (0 while busy or not ready). */
  idleFor(): number {
    return this.ready && !this.busy ? this.clock() - this.changed : 0
  }

  /** Not busy, and not for `ms` (ready or not: for keys that go in anyway). */
  settled(ms: number): boolean {
    return !this.busy && this.clock() - this.changed >= ms
  }

  /** Lets the screen go (once ready it isn't read again, unless kept for picks, and the title is enough). */
  dispose(): void {
    this.screen?.dispose()
    this.screen = null
  }
}
