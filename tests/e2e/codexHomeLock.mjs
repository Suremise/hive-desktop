// Codex's unelevated sandbox can refuse a shell launch when two runners use one test home (#478). Hold one slot
// for the whole real suite/run, across worktrees; a separate home has a separate slot. The existing slot claims
// provide the queue, atomic acquisition, exit cleanup and dead/stale-holder recovery, without skipping a test.
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import { describeClaim, waitForSlot } from './slots.mjs'
import { slotWaitProgress } from '../progressReport.mts'

const ctx = createRequire(import.meta.url)('./runContext.cjs')

export function codexLockDir(home, poolRoot = join(ctx.TEST_ROOT, 'codex-home-locks')) {
  let canonical = resolve(home)
  try {
    canonical = realpathSync.native(canonical)
  } catch {
    // A not-yet-created test home still has a stable absolute name.
  }
  if (ctx.isUserCliHome(home) || ctx.isUserCliHome(canonical)) throw new Error('Codex home locks require a test home')
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return join(poolRoot, createHash('sha256').update(canonical).digest('hex').slice(0, 24))
}

/** Real Codex suites, and a suite explicitly naming the shared home (skills), use the same lease. */
export const usesCodexHome = (suite) => suite.needs?.includes('codex') || suite.codexHome === 'test'

export async function acquireCodexHome(home, { poolRoot, ...options } = {}) {
  const lease = await waitForSlot(codexLockDir(home, poolRoot), { ...options, slots: 1 })
  if (lease.release) {
    const release = lease.release
    // waitForSlot registers this cleanup on exit. Suites release earlier too; don't accumulate exit listeners.
    lease.release = () => {
      process.off('exit', release)
      release()
    }
  }
  return lease
}

export async function waitForCodexHome(home, { kind, root, what, argv = process.argv.slice(2) }) {
  const queue = slotWaitProgress(kind, `npm run ${kind} -- ${argv.join(' ')}`, argv, 'the Codex test home')
  let said = ''
  const lease = await acquireCodexHome(home, {
    root,
    what,
    onWait: ({ holders, ahead }) => {
      const who = holders.map((c) => describeClaim(c)).join('; ')
      const line = `Waiting for the Codex test home ${home}${ahead ? `, ${ahead} ahead of this one` : ''}: held by ${who || 'a run just finishing'}.`
      if (line !== said) console.log(line)
      said = line
      queue.waiting(who)
    }
  })
  if (said) {
    const after = `${Math.round(lease.waitedMs / 1000)} s`
    console.log(`Got the Codex test home after ${after}.`)
    await queue.finish(`got the Codex test home after ${after}`)
  }
  return lease
}
