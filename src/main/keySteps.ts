import type { KeySteps } from './providers/types'

/** A pick step couldn't find what it looks for on the CLI's screen: `what` says what (the adapter's words). */
export class PickNotFound extends Error {
  constructor(readonly what: string) {
    super(`Couldn't find ${what}.`)
  }
}

/**
 * Types key steps into a CLI's terminal (#396). A plain step's keys go in as they are. A pick step reads the CLI's
 * screen as rendered, every 100 ms until it finds what it needs or `pickTimeoutMs` passes, and types what it chose
 * (Codex's /permissions menu: the number its menu shows beside a preset's label, which a Codex version can reorder).
 * Throws PickNotFound when it never finds it, after the steps before it have gone in. `ready` runs before each step
 * (a task waits there while the CLI is busy) and returns false to stop.
 */
export async function typeKeySteps(
  steps: KeySteps,
  io: { write: (keys: string) => void; screen: () => string | null; ready?: () => Promise<boolean>; pickTimeoutMs?: number }
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  for (const step of steps) {
    if (io.ready && !(await io.ready())) return
    let keys: string | null
    if ('pick' in step) {
      keys = null
      for (const t0 = Date.now(); ; await sleep(100)) {
        const screen = io.screen()
        keys = screen === null ? null : step.pick(screen)
        if (keys !== null || Date.now() - t0 >= (io.pickTimeoutMs ?? 4000)) break
      }
      if (keys === null) throw new PickNotFound(step.what)
    } else keys = step.keys
    io.write(keys)
    await sleep(step.waitMs ?? 60)
  }
}
