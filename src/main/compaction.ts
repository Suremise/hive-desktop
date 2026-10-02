/** How long the CLI has to begin a compaction once Hive has submitted its /compact (PreCompact), before Hive stops waiting. */
export const BEGIN_MS = 20_000
/** How long a begun compaction may take, should the CLI never say it ended. */
export const LIMIT_MS = 10 * 60_000

/**
 * A compaction Hive asked for (Compact), from the moment it is reserved, through typing its /compact (no limit
 * runs yet: a long focus takes a while to type) and its submission, until it is over. The CLI says so with
 * PostCompact; when it doesn't, Hive learns it from the transcript (a compaction more than before), the terminal
 * (the CLI refused or failed it, which sends no hook), or the time limits. `over` is called once, whichever comes
 * first; a hook that ends it (PostCompact, or a prompt that starts a new turn) calls end() and takes care of the
 * status itself.
 */
export class Compaction {
  started = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private output = ''
  private done = false

  constructor(
    /** Compactions in the transcript before this one. */
    readonly before: number,
    /** What the CLI prints when it refuses or fails a compaction (ProviderAdapter.compactFailure). */
    private readonly failure: RegExp | null,
    private readonly over: () => void
  ) {}

  /** Hive submitted the /compact: the CLI has BEGIN_MS to begin it. */
  submitted(): void {
    if (this.done || this.started) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.finish(), BEGIN_MS)
  }

  /** The CLI began it (PreCompact): it may now take up to LIMIT_MS. */
  begin(): void {
    if (this.done) return
    this.started = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.finish(), LIMIT_MS)
  }

  /** The transcript has `count` compactions: one more than before means it is done. */
  transcript(count: number): void {
    if (count > this.before) this.finish()
  }

  /** Terminal output while it runs. */
  terminal(data: string): void {
    if (this.done || !this.failure) return
    // Terminal UIs draw spaces as cursor moves (ESC[1C), so control sequences become spaces. Keep a
    // short tail so a message split across chunks still matches.
    this.output = (this.output + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
    if (this.failure.test(this.output)) this.finish()
  }

  /** Over, without `over` (a hook ended it, or the session exited). */
  end(): void {
    this.done = true
    clearTimeout(this.timer)
  }

  private finish(): void {
    if (this.done) return
    this.end()
    this.over()
  }
}
