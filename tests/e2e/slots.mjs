// Heavy test runs, machine-wide (#204). Several agents checking their cards at once on one machine (full e2e sets,
// repeats, scenario runs) slowed each other until tests timed out: the flakes were the load, not the code. So at most
// a few heavy runs go at once across every worktree (heavySlots in hive-test\config.json, default 2, #589); a heavy run started while
// they are all taken waits for one, in the order the runs asked, saying who holds them (and in Hive's Progress panel).
// A pre-merge run goes first (#558): one started by the agent holding its project's merge slot (holdsMergeSlot), or
// with --pre-merge. It takes the next free slot before runs that asked earlier for other reasons (a merge shouldn't wait
// behind flake-proof repeats while every other merge waits behind it), but never stops a run that holds one.
// A run that isn't heavy (a few suites, a single scenario) never waits, nor does a runner started inside a suite, e2e or
// scenarios (needsSlot): its parent's run holds a slot, and waiting behind it would never end (#211).
//
// Claims are files in a folder of the run context (runContext.HEAVY_DIR), as lanes are (lanes.mjs): `slot-<k>.json`
// for a run holding a slot and `wait-<pid>.json` for one waiting (when it asked; `first` for a pre-merge run), each
// with its runner's process id, changed only under the claims lock. A crashed run's claim expires: its process is gone (or it is a day old).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { processAlive } from './logs.mjs'
import { claimHeld, withLock } from './lanes.mjs'
import { parentSuite } from './runner.mjs'

/** Heavy runs at once, unless the machine's config.json or HIVE_TEST_HEAVY_SLOTS says otherwise. */
export const DEFAULT_SLOTS = 2
/**
 * The machine's test settings (#589): `{ "heavySlots": 3 }` in the shared test folder, read each time a run asks, so an
 * edit counts from the next run with no restart. Machine-wide, as the slots are: every worktree's runs read the same file.
 */
export const CONFIG_FILE = join(createRequire(import.meta.url)('./runContext.cjs').TEST_ROOT, 'config.json')
/** A run of more suites or scenarios than this (or any repeat) is heavy. */
export const HEAVY_OVER = 5

/** What a run has said about where its count came from: each line once a process. */
const said = new Set()
const sayOnce = (say, line) => {
  if (said.has(line)) return
  said.add(line)
  say(line)
}

/**
 * How many heavy runs may go at once (#589): HIVE_TEST_HEAVY_SLOTS, a one-off override; else `heavySlots` in the machine's
 * config.json (CONFIG_FILE); else DEFAULT_SLOTS. Each a whole number, 1 or more. A missing or unreadable file, or a value
 * that isn't one, falls back to the default, and the run says so in one line (once).
 */
export function heavySlots(env = process.env, file = CONFIG_FILE, say = (line) => console.error(line)) {
  const whole = (v) => Number.isInteger(v) && v >= 1
  const set = env.HIVE_TEST_HEAVY_SLOTS
  if (set !== undefined && set !== '') {
    if (whole(Number(set))) return Number(set)
    sayOnce(say, `Test slots: HIVE_TEST_HEAVY_SLOTS=${JSON.stringify(set)} isn't a whole number from 1; it is left out.`)
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    const why = e?.code === 'ENOENT' ? 'there is none' : `it can't be read (${e?.code ?? e?.message})`
    sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file}: ${why}).`)
    return DEFAULT_SLOTS
  }
  let n
  try {
    n = JSON.parse(text.replace(/^\uFEFF/, ''))?.heavySlots
  } catch {
    sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file} isn't JSON).`)
    return DEFAULT_SLOTS
  }
  if (whole(n)) return n
  sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file}: ${n === undefined ? 'no heavySlots in it' : `heavySlots ${JSON.stringify(n)} isn't a whole number from 1`}).`)
  return DEFAULT_SLOTS
}

/** Whether a run is heavy: more than HEAVY_OVER suites or scenarios, or run more than once (--repeat). */
export function isHeavy({ count, repeat = 1 }) {
  return repeat > 1 || count > HEAVY_OVER
}

/** Vitest options whose value is the next argument (so it is no file filter). */
const VITEST_VALUE_OPTIONS = ['-c', '--config', '-r', '--root', '--dir', '--reporter', '--outputFile', '--environment', '--pool', '--maxWorkers', '--testTimeout', '--hookTimeout', '--retry', '--bail', '--mode', '--exclude']

/**
 * Whether a unit test run is the whole set (#599), heavy as a full e2e set is: its workers and what its tests start beside
 * e2e runs were what ran Windows short (0xc0000142 dialogs). A run of some files (a file filter), some tests (-t), the
 * changed or related files, a shard or a project, or watch mode, isn't. args: Vitest's command line after its script.
 */
export function isFullUnitRun({ args, watch = false, changed = false, related = [], testNamePattern = null }) {
  if (watch || changed || related?.length || testNamePattern) return false
  if (args.some((a) => /^(--changed|--related|-t|--testNamePattern|--shard|--project|--watch|-w)(=|$)/.test(a))) return false
  return !args.some((a, i) => !a.startsWith('-') && a !== 'run' && !VITEST_VALUE_OPTIONS.includes(args[i - 1]))
}

/**
 * Whether a run waits for a test slot (both runners ask): a heavy one, unless it was started inside a suite
 * (runner.mjs parentSuite: a suite's agent shell, say). That run's load is its parent's, whose slot counts it; waiting
 * for a slot the parent holds would never end, and --no-wait would refuse it (#211). Only the slot is skipped: a nested
 * e2e runner still keeps to its parent's nested folder and ports above the parent's, and a nested scenario run still
 * claims a lane of its own (lanes.mjs), so neither shares folders or ports with its parent.
 */
export function needsSlot({ count, repeat = 1 }, env = process.env) {
  return isHeavy({ count, repeat }) && !parentSuite(env)
}

/**
 * Whether this run is the merge slot holder's (#558): started in the session of the agent that holds its project's
 * merge slot (the default branch's), asked through Hive's Agent API with the session's own variables, which the runners
 * read from the shell they were started in, as their progress reporting does. False when no Hive agent runs it or the
 * API doesn't answer in time: an ordinary run then.
 */
export async function holdsMergeSlot(env = process.env, { fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const url = env.HIVE_API_URL?.replace(/\/+$/, '')
  if (!url || !env.HIVE_PROJECT || !env.HIVE_AGENT) return false
  let token = env.HIVE_API_TOKEN && !env.HIVE_API_TOKEN.includes('${') ? env.HIVE_API_TOKEN : ''
  if (!token && env.HIVE_API_TOKEN_FILE) {
    try {
      token = String(JSON.parse(readFileSync(env.HIVE_API_TOKEN_FILE, 'utf8')).token ?? '')
    } catch {
      token = ''
    }
  }
  if (!token) return false
  try {
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(env.HIVE_PROJECT)}/merge-slot`, {
      headers: { Authorization: `Bearer ${token}`, ...(env.HIVE_WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(env.HIVE_WORKSPACE) } : {}) },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return false
    const holder = (await res.json())?.holder
    return holder?.kind === 'agent' && holder.name === env.HIVE_AGENT
  } catch {
    return false
  }
}

/**
 * Whether a run goes first in the queue, for waitForSlot's `first`: --pre-merge (flag), or its agent holds the merge
 * slot, asked again at most every askMs while the run waits (the agent may take the merge slot meanwhile, or let it go).
 */
export function preMerge(flag, { env = process.env, askMs = 30_000, holds = holdsMergeSlot, now = () => Date.now() } = {}) {
  let asked = null
  let last = false
  return async () => {
    if (flag) return true
    if (asked === null || now() - asked >= askMs) {
      asked = now()
      last = await holds(env)
    }
    return last
  }
}

/** The claims in dir whose names start with prefix: [{ file, claim }] (an unreadable one is { claim: null }). */
function claims(dir, prefix) {
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => {
      try {
        return { file: join(dir, f), claim: JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      } catch {
        return { file: join(dir, f), claim: null }
      }
    })
}

/**
 * One look, under the claims lock: takes a slot if one is free and no run ahead of this one is still waiting for it:
 * pre-merge runs (first) are ahead of the others, and among each, those that asked earlier. Returns { slot } (its number), or { holders, ahead }: the claims holding the slots, and how many runs wait ahead of
 * this one. Waiting (wait: true), this run's place in the queue is kept (wait-<pid>.json, with when it first asked);
 * otherwise it leaves no trace. Claims whose runner is gone are removed.
 */
export async function trySlot(dir, { slots = heavySlots(), owner = process.pid, what = '', root = '', first = false, wait = true, alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const t = now()
    const live = (prefix) =>
      claims(dir, prefix).filter(({ file, claim }) => {
        if (claimHeld(claim, alive, t)) return true
        rmSync(file, { force: true })
        return false
      })
    const held = live('slot-').map((c) => c.claim)
    const mine = join(dir, `wait-${owner}.json`)
    const waiting = live('wait-').map((c) => c.claim)
    const me = { ...(waiting.find((c) => c.pid === owner) ?? { pid: owner, at: t, root, what }), first: !!first }
    const queue = [...waiting.filter((c) => c.pid !== owner), me].sort((a, b) => Number(!!b.first) - Number(!!a.first) || a.at - b.at || a.pid - b.pid)
    const ahead = queue.indexOf(me)
    const free = slots - held.length
    if (ahead < free) {
      const used = new Set(held.map((c) => c.slot))
      let k = 0
      while (used.has(k)) k++
      writeFileSync(join(dir, `slot-${k}.json`), JSON.stringify({ pid: owner, at: t, slot: k, root, what, ...(first ? { first: true } : {}) }))
      rmSync(mine, { force: true })
      return { slot: k }
    }
    if (wait) writeFileSync(mine, JSON.stringify(me))
    else rmSync(mine, { force: true })
    return { holders: held, ahead }
  })
}

/** A claim, for a person: what it runs and where, its process and for how long. */
export function describeClaim(c, now = Date.now()) {
  const min = Math.max(0, Math.round((now - c.at) / 60_000))
  return `${c.what || 'a heavy run'}${c.first ? ' (pre-merge)' : ''} in ${c.root || 'another worktree'} (process ${c.pid}, ${min} min)`
}

/** What a waiting run prints at a look that finds no slot (both runners): how many go at once, its place, the holders. */
export function waitLine({ holders, ahead, first = false }, slots = heavySlots()) {
  const place = first ? `, pre-merge, ${ahead ? `${ahead} pre-merge ahead of this one` : 'next in line'}` : ahead ? `, ${ahead} ahead of this one` : ''
  return `Waiting for a test slot (${slots} heavy runs at once on this machine, HIVE_TEST_HEAVY_SLOTS)${place}: held by ${holders.map((c) => describeClaim(c)).join('; ') || 'runs just finishing'}.`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits for a slot (wait: false, only one look): { slot, waitedMs, release() }, or { refused: { holders, ahead } }.
 * first: whether it is a pre-merge run, or a function saying so at each look (preMerge). onWait({ holders, ahead, first })
 * is called at each look that finds none, every pollMs. release() lets the slot go (only if
 * it is still this run's); it is also let go when the process exits, and expires if it crashes.
 */
export async function waitForSlot(dir, { wait = true, pollMs = 2000, onWait = () => {}, first = false, ...opts } = {}) {
  const started = Date.now()
  const owner = opts.owner ?? process.pid
  const queued = join(dir, `wait-${owner}.json`)
  const leaveQueue = () => rmSync(queued, { force: true })
  process.on('exit', leaveQueue)
  try {
    for (;;) {
      const goesFirst = typeof first === 'function' ? await first() : !!first
      const r = await trySlot(dir, { ...opts, owner, wait, first: goesFirst })
      if (r.slot !== undefined) {
        const file = join(dir, `slot-${r.slot}.json`)
        const release = () => {
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
          } catch {
            // Gone already.
          }
        }
        process.on('exit', release)
        return { slot: r.slot, waitedMs: Date.now() - started, release }
      }
      if (!wait) return { refused: r }
      onWait({ ...r, first: goesFirst })
      await sleep(pollMs)
    }
  } finally {
    process.off('exit', leaveQueue)
  }
}
