import { ConsoleRing, hiveSourceId, makeEvent, sessionSourceId, type CapturedEvent, type ConsoleEvent } from '../shared/devConsole'

/**
 * The developer console's capture (#636): rings of events per source, kept only while someone watches. A source is
 * captured from its first subscriber to its last: before and after, `capture()` returns at once without building its
 * event, and no ring is kept, so a Hive with no console open does no work and holds no memory for it.
 *
 * Subscribers: a window showing the console (until it closes or unsubscribes) and the hive tools' readers (agents, the
 * Assistant, scripts), each with a lease that each read renews and that ends on its own (LEASE_MS) if they stop. Every
 * event is redacted as it is kept (shared/devConsole.ts); a subscriber that opted into text (the user's own recording,
 * #638) is sent a second copy with text kept, and only it.
 */

/** A reader's capture lasts this long after its last read. */
export const LEASE_MS = 30 * 60_000
/** At most this many sources per subscriber, and this many subscribers: each holds rings while it lasts. */
export const MAX_SOURCES = 40
export const MAX_SUBSCRIBERS = 200

export interface ConsoleSubscription {
  /** Live events as they are kept (a window's): batched, sent after the current task. */
  deliver?: (events: ConsoleEvent[]) => void
  /** Keep text in the events it is sent (never for an agent's or a script's reader). */
  includeText?: boolean
  /** Ends on its own this long after it was made or last renewed. */
  leaseMs?: number
}

interface Subscriber extends ConsoleSubscription {
  sources: Set<string>
  expiresAt: number | null
  queue: ConsoleEvent[]
}

export class DevConsole {
  private rings = new Map<string, ConsoleRing>()
  private subs = new Map<string, Subscriber>()
  /** Sources with a subscriber that keeps text, by how many such subscribers. */
  private textual = new Map<string, number>()
  private seq = 0
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a source is being captured: callers ask before building anything (zero cost when nobody watches). */
  capturing(source: string): boolean {
    return this.rings.has(source)
  }

  /** The sources being captured whose ids start so ("hive:" for every workspace's Hive events). */
  capturedLike(prefix: string): string[] {
    return [...this.rings.keys()].filter((s) => s.startsWith(prefix))
  }

  /** Whether anything is being captured at all. */
  get active(): boolean {
    return this.rings.size > 0
  }

  /**
   * Keeps an event in each of `sources` being captured (null entries are skipped): `build` runs only if one is, once,
   * and may return null to keep nothing. A capture point never fails its caller.
   */
  capture(sources: (string | null | undefined)[], build: () => CapturedEvent | null): void {
    if (!this.rings.size) return
    const live = [...new Set(sources)].filter((s): s is string => !!s && this.rings.has(s))
    if (!live.length) return
    let c: CapturedEvent | null
    try {
      c = build()
    } catch {
      return
    }
    if (!c) return
    const at = new Date(this.now()).toISOString()
    for (const source of live) {
      const e = makeEvent(++this.seq, at, source, c)
      this.rings.get(source)!.push(e)
      const withText = this.textual.get(source) ? makeEvent(e.seq, at, source, c, { includeText: true }) : null
      for (const sub of this.subs.values()) if (sub.deliver && sub.sources.has(source)) sub.queue.push(sub.includeText && withText ? withText : e)
    }
    this.scheduleFlush()
  }

  /**
   * Starts or changes a subscription: `sources` replaces its list (capture starts for the new ones and stops for those
   * no other subscriber watches). Returns each source's events so far (redacted), oldest first.
   */
  subscribe(id: string, sources: string[], opts: ConsoleSubscription = {}): Map<string, ConsoleEvent[]> {
    this.expire()
    const wanted = new Set(sources.slice(0, MAX_SOURCES))
    const old = this.subs.get(id)
    if (!old && this.subs.size >= MAX_SUBSCRIBERS) throw new Error('Too many developer console readers at once: try again later')
    const sub: Subscriber = { ...opts, sources: wanted, expiresAt: opts.leaseMs ? this.now() + opts.leaseMs : null, queue: old?.queue ?? [] }
    if (old?.includeText) for (const s of old.sources) this.untext(s)
    this.subs.set(id, sub)
    for (const s of wanted) if (!this.rings.has(s)) this.rings.set(s, new ConsoleRing())
    if (sub.includeText) for (const s of wanted) this.textual.set(s, (this.textual.get(s) ?? 0) + 1)
    if (old) for (const s of old.sources) if (!wanted.has(s)) this.dropIfUnwatched(s)
    this.armLease()
    return new Map([...wanted].map((s) => [s, this.rings.get(s)!.all()]))
  }

  /** Adds sources to a subscription (making it if need be), keeping those it has; renews its lease. */
  watch(id: string, sources: string[], opts: ConsoleSubscription = {}): void {
    const had = this.subs.get(id)
    this.subscribe(id, [...(had?.sources ?? []), ...sources.filter((s) => !had?.sources.has(s))], { ...had, ...opts })
  }

  /** Renews a subscriber's lease; false if it has none (ended, or never made). */
  renew(id: string): boolean {
    this.expire()
    const sub = this.subs.get(id)
    if (!sub) return false
    if (sub.leaseMs) sub.expiresAt = this.now() + sub.leaseMs
    this.armLease()
    return true
  }

  /** Ends a subscription, or only some of its sources. Capture stops for sources nobody else watches. */
  unsubscribe(id: string, sources?: string[]): void {
    const sub = this.subs.get(id)
    if (!sub) return
    const going = sources ? sources.filter((s) => sub.sources.has(s)) : [...sub.sources]
    for (const s of going) {
      sub.sources.delete(s)
      if (sub.includeText) this.untext(s)
    }
    if (!sources || !sub.sources.size) this.subs.delete(id)
    for (const s of going) this.dropIfUnwatched(s)
    this.armLease()
  }

  /** Ends every reader's capture (the subscriptions with a lease): agents' reading turned off. Windows keep theirs. */
  endReaders(): void {
    for (const [id, sub] of [...this.subs]) if (sub.leaseMs) this.unsubscribe(id)
  }

  /** The sources a subscriber watches (empty if none). */
  sourcesOf(id: string): string[] {
    this.expire()
    return [...(this.subs.get(id)?.sources ?? [])]
  }

  /** A subscriber's lease end, or null. */
  leaseEnd(id: string): number | null {
    return this.subs.get(id)?.expiresAt ?? null
  }

  /** A source's events after `since`, at most `limit` of the newest (redacted). */
  events(source: string, since = 0, limit = Infinity): ConsoleEvent[] {
    return this.rings.get(source)?.since(since, limit) ?? []
  }

  event(source: string, seq: number): ConsoleEvent | undefined {
    return this.rings.get(source)?.find(seq)
  }

  /** How many events a source's ring holds (0 when it isn't captured). */
  count(source: string): number {
    return this.rings.get(source)?.count ?? 0
  }

  /** What is captured now: sources, events and bytes (diagnostics and tests). */
  stats(): { sources: number; events: number; bytes: number; subscribers: number } {
    let events = 0
    let bytes = 0
    for (const r of this.rings.values()) {
      events += r.count
      bytes += r.bytes
    }
    return { sources: this.rings.size, events, bytes, subscribers: this.subs.size }
  }

  private untext(s: string): void {
    const n = (this.textual.get(s) ?? 0) - 1
    if (n > 0) this.textual.set(s, n)
    else this.textual.delete(s)
  }

  private dropIfUnwatched(source: string): void {
    for (const sub of this.subs.values()) if (sub.sources.has(source)) return
    this.rings.delete(source)
    this.textual.delete(source)
  }

  /** Ends the leases that have run out. */
  private expire(): void {
    const t = this.now()
    for (const [id, sub] of [...this.subs]) if (sub.expiresAt !== null && sub.expiresAt <= t) this.unsubscribe(id)
  }

  /** One timer, for the next lease to end (none when no subscriber has a lease). */
  private armLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    const ends = [...this.subs.values()].map((s) => s.expiresAt).filter((x): x is number => x !== null)
    if (!ends.length) return
    this.leaseTimer = setTimeout(
      () => {
        this.leaseTimer = null
        this.expire()
        this.armLease()
      },
      Math.max(1000, Math.min(...ends) - this.now() + 50)
    )
    this.leaseTimer.unref?.()
  }

  private scheduleFlush(): void {
    if (this.flushing) return
    this.flushing = true
    setTimeout(() => {
      this.flushing = false
      for (const sub of this.subs.values()) {
        if (!sub.queue.length) continue
        const batch = sub.queue.splice(0)
        try {
          sub.deliver?.(batch)
        } catch {
          // A window that has gone: its subscription ends when it closes.
        }
      }
    }, 0)
  }
}

/** Hive's console. */
export const devConsole = new DevConsole()

export { hiveSourceId, sessionSourceId }
