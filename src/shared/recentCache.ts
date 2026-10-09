/**
 * A bounded cache of the most recently used entries: reading or writing an entry makes it the newest, and past `max`
 * the least recently used go first. `scope` empties it when what it caches for changes (a window's workspace).
 */
export class RecentCache<V> {
  private entries = new Map<string, V>()
  private scopeKey: string | null = null

  constructor(private readonly max: number) {}

  /** Empties the cache when `scope` isn't the one it holds entries for. */
  scope(scope: string | null): this {
    if (scope !== this.scopeKey) {
      this.entries.clear()
      this.scopeKey = scope
    }
    return this
  }

  get(key: string): V | undefined {
    const v = this.entries.get(key)
    if (v !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, v)
    }
    return v
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }

  get size(): number {
    return this.entries.size
  }
}
