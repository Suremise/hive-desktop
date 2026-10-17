// One run at a time (#1011): work started by an event (a board change, say) that reads a lot, run again for each event
// while the last run still goes on, piles up reads; under a batch of card changes they ran main out of memory (#988).

const runs = new Map<string, { again: boolean; done: Promise<void> }>()

/**
 * Runs `fn` for `key` now, or, when a run for that key is going on, once more after it: however many times it is asked
 * meanwhile, one more run, which sees what changed. Resolves when a run that started after this call has ended. A run's
 * error is `fn`'s to handle (it is logged by none here) and doesn't stop the run after it.
 */
export function coalesced(key: string, fn: () => Promise<void>): Promise<void> {
  const running = runs.get(key)
  if (running) {
    running.again = true
    return running.done
  }
  const state = { again: true, done: Promise.resolve() }
  state.done = (async () => {
    try {
      while (state.again) {
        state.again = false
        await fn().catch(() => undefined)
      }
    } finally {
      runs.delete(key)
    }
  })()
  runs.set(key, state)
  return state.done
}

/** Whether a run for `key` is going on (for tests). */
export const coalescing = (key: string): boolean => runs.has(key)
