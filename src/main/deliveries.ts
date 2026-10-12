import { join } from 'path'
import { mkdir, rename, rm, writeFile } from 'original-fs/promises'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { HIVE_DIR } from '../shared/defaults'
import {
  DELIVERY_BODY_MAX_CHARS,
  DELIVERY_EXPIRY_HOURS,
  OVERDUE_MINUTES,
  deliveryRow,
  goesAlone,
  inboxItems,
  inboxSummary,
  isLive,
  isUnread,
  isWaiting,
  moved,
  needsAck,
  offerLine,
  readDelivery,
  type DeliveryKind,
  type DeliveryNeed,
  type DeliveryRecord,
  type DeliveryRow,
  type DeliverySender,
  type DeliveryState,
  type InboxItem
} from '../shared/deliveries'
import * as assistant from './assistantControl'
import { onHiveEvent } from './events'
import { readCapped, renameRetrying } from './fsutil'
import { canTypeLine, typeLine, whyNoLine } from './lineWriter'
import { createLogger, userText } from './logger'
import { readyFor } from './readiness'
import { sessions } from './sessions'

/**
 * The delivery service (#647, plans/2026-10-12-messaging-redesign.md §3.1). Everything Hive has for an agent to read is a
 * delivery record (shared/deliveries.ts), saved in its session host's .hive/deliveries.json (a project's, or the
 * Assistant's home's) with atomic writes, and restored when Hive starts. Every way into an agent makes one (#649): a
 * message, a task, a watch's or a loop's wake, the user's decisions, a mode notice, a lock's go-ahead, the carry-on after
 * a sign-in, a handover. This service alone offers them: today by typing the line each always was (lineWriter.typeLine),
 * until Messaging 4 switches the channel; producers neither type nor keep their own cursors.
 *
 * **Receipts.** A typed line makes a delivery offered. It is received when the agent fetches it with hive_inbox, or
 * (#649, until #650's doorbell) when the CLI takes the line that carried its whole text: the prompt count rises in the
 * launch it was typed into, after that line's Enter (receivedVia 'typed'); never because it was typed. A card event or a
 * control notice is done then; a message, a task, a handover or the user's answer waits for the agent's ack (hive_inbox),
 * and one not acked OVERDUE_MINUTES after it was made is overdue. One offered when Hive stopped, or when its agent's launch
 * ended before its CLI took it, is uncertain: it may not have reached the agent, so it is offered once more, saying it may
 * repeat, and stays uncertain (shown) if that one isn't received either.
 *
 * **Sources.** What made a delivery (`source`: a watch, a loop wake…) registers itself here: it can make its line again
 * just before it is offered, from things as they are then (`refresh`; null: no longer due, and it is cancelled), say
 * whether it still holds before each key (`holds`), and is told when it is received (its cursor moves on then, never on
 * "typed") or ends. A live delivery's source and `ref` name it: the same one is never made twice.
 *
 * **Transactions.** Each host's records change one transaction at a time (`transact`, under the host's lock): planned on
 * a copy of what is published, with its checks (below), saved by one atomic write, and only then published, so nothing (a
 * read, the pane) ever sees a change that isn't on disk. An operation takes effect at that save: a permission change that
 * lands while it is saved applies to the next operation, not this one (it was decided before). A save that fails changes
 * nothing, on disk or in memory (NotSaved): the rename never happened. The offer's writer checks again before each piece
 * of the line, its Enter, and the confirmation's Enter again (`offerHolds`).
 *
 * **Authority.** A sender's permission is worked out again at every step, from the sender saved with it and the settings
 * now (never a closure or token): the Assistant's needs Settings → Assistant → Control at Control agents and the launch
 * that sent it still running (#645: a launch that has ended sends nothing more; its waiting messages are refused, and the
 * refusal is in the Assistant's activity list and the agent's). One is for its agent's conversation when that was known.
 *
 * The rules, for every operation (create, offer, readInbox, ack, cancel): **one async lock per host**, inside it copy,
 * check (sender permission, expiry, the target conversation) and change the copy, save atomically, then publish and
 * return; no check after the save. A line typed into the agent is checked again by its writer before each key, and before
 * the confirmation's Enter again, with the same check (`offerHolds`); one that no longer holds gets no Enter.
 */

const log = createLogger('deliveries')

/** Ended deliveries kept per agent (the newest), and for how long at most. */
const KEEP_ENDED = 50
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000
/** Received deliveries never acked are kept this long, then expire. */
const KEEP_RECEIVED_MS = 7 * 24 * 60 * 60_000
/** The most deliveries a host keeps live; more are refused when made. */
export const MAX_LIVE_PER_HOST = 500
/** The most Hive reads back from a deliveries file; what it writes stays within fileBudget, half of it. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
let fileBudget = 4 * 1024 * 1024
/** Room kept for each live delivery to grow to its end (its times, receipt, a reason it ended). */
const GROWTH_PER_LIVE = 800
/** For tests: a smaller budget for the file. */
export const setFileBudgetForTests = (bytes: number): void => {
  fileBudget = bytes
}

/** How long until a delivery is overdue: OVERDUE_MINUTES, or an unpackaged test build's (HIVE_TEST_DELIVERY_OVERDUE_MS). */
export const overdueMs = (): number => {
  const t = !app.isPackaged ? Number(process.env.HIVE_TEST_DELIVERY_OVERDUE_MS) : NaN
  return Number.isFinite(t) && t > 0 ? t : OVERDUE_MINUTES * 60_000
}

/** The run a delivery made for a launch is offered into until that launch has started (launchWith). */
const LAUNCHING = 'launching'

/** Why a delivery may repeat when it is offered once more (#649). */
const AGAIN_RESTART = 'Hive restarted while offering it'
const AGAIN_LAUNCH = 'its session ended or restarted before its CLI took the line'

interface Store {
  host: string
  /** What is published: saved, and what every read sees. Never changed in place: a transaction replaces it. */
  records: readonly DeliveryRecord[]
  next: number
  /** Saved entries that aren't deliveries (a hand edit, a newer build's): kept aside in the file as they were, not used. */
  invalid: readonly unknown[]
  /** Transactions, one after another. */
  lock: Promise<unknown>
  /** The ids a line being typed now offers: cancelled meanwhile, its typing stops. */
  offering: Set<string>
  /**
   * The ids a typed line offers, by the launch and its prompt count just before the line's Enter: taken (received) once
   * the count rises in that launch; until then a cancel can still end it. Kept until it leaves offered.
   */
  confirming: Map<string, { runId: string; count: number }>
  /** Deliveries launched into a run whose saving may have failed (launchWith): the run they went into, by id. */
  launches: Map<string, string>
  /**
   * Agents whose line Hive left in their prompt, not submitted (#530: the user typed over it, or it couldn't be cleared):
   * nothing more is typed into one until that prompt is submitted (its CLI's count passes this), so a draft is never
   * typed over.
   */
  leftUntil: Map<string, { runId: string; count: number }>
  /**
   * What the producer of a delivery gave with it (#649, in memory only: one that can't outlive its launch, such as a lock's
   * go-ahead): its own check, asked with offerHolds, and what to do once it is received or ends without that.
   */
  hooks: Map<string, DeliveryHooks>
}

/** A transaction's working copy: planned on, saved, then published. */
interface Draft {
  records: DeliveryRecord[]
  next: number
  invalid: unknown[]
  dirty: boolean
  /** What to do once it is published (log lines, the Assistant's activity list, sources told): nothing for a plan that isn't. */
  after: (() => void)[]
}

const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
const keyOf = (host: string): string => host.toLowerCase()
const fileOf = (host: string): string => join(host, HIVE_DIR, 'deliveries.json')
const nowIso = (): string => new Date().toISOString()

/** Hive couldn't save a change, so it wasn't made. */
export class NotSaved extends Error {}
/** A delivery refused because too many of its kind wait already for its agent (NewDelivery.maxWaiting). */
export class TooManyWaiting extends Error {}
/** A delivery refused because its project's deliveries are full (MAX_LIVE_PER_HOST, or the file's budget). */
export class DeliveriesFull extends Error {}
/** A delivery wanted now (deliverNow) that couldn't be given: why. It was cancelled. */
export class NotGiven extends Error {}

/**
 * A producer's part in its deliveries (#649), registered once by name (`source` on the delivery): made again just before
 * it is offered (`refresh`: the line from things as they are now, or null if it is no longer due: it is cancelled then,
 * with `why`); checked before each piece and Enter of its line (`holds`); told when it is received (`received`: its
 * cursor moves on) or ends without that (`ended`). Called outside the host's lock.
 */
export interface DeliverySource {
  refresh?: (r: DeliveryRecord, host: string) => Promise<{ body: string } | { cancel: string } | null>
  holds?: (r: DeliveryRecord, host: string) => boolean
  received?: (r: DeliveryRecord, host: string) => void
  ended?: (r: DeliveryRecord, host: string) => void
}
const sources = new Map<string, DeliverySource>()

/** A producer's own part in one delivery, given when it is made (in memory only): see Store.hooks. */
export interface DeliveryHooks {
  holds?: () => boolean
  received?: () => void
  ended?: () => void
}
/** Registers a producer's part (once per name; again replaces it). */
export function registerSource(name: string, s: DeliverySource): void {
  sources.set(name, s)
}

/** Runs fn after the host's transactions before it (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.lock.then(fn)
  store.lock = run.catch(() => undefined)
  return run
}

/**
 * A transaction (see the top): `plan` checks and changes a copy of what is published (synchronously, under the host's
 * lock); a copy it changed is saved (`save`: one atomic write) and then published, and `plan`'s result returned. A plan
 * that throws, or a save that fails (NotSaved), leaves the deliveries file and what is published as they were.
 */
function transact<T>(store: Store, plan: (d: Draft) => T): Promise<T> {
  running++
  return locked(store, async () => {
    const d: Draft = { records: [...store.records], next: store.next, invalid: [...store.invalid], dirty: false, after: [] }
    const planned = plan(d)
    if (!d.dirty) return planned
    try {
      await save(store, d)
    } catch (e) {
      throw new NotSaved(`Hive couldn't save the deliveries (${(e as Error).message}): nothing changed.`, { cause: e })
    }
    store.records = d.records
    store.next = d.next
    store.invalid = d.invalid
    for (const f of d.after) f()
    return planned
  }).finally(() => running--)
}

/** Transactions not finished yet (also those nothing waits for): what settled() waits for. */
let running = 0
/** Whether the service has a change in flight (watches' and loop wakes' settled() wait for it, #570). */
export const inFlightNow = (): boolean => running > 0 || trying.size > 0
/** Resolves once no change or offer is in flight, and what sources were told of them has run. */
export async function settled(): Promise<void> {
  while (inFlightNow()) {
    await Promise.allSettled([...stores.values()].map((s) => s.lock))
    await Promise.allSettled([...trying.values()])
    await new Promise((r) => setImmediate(r))
  }
}

/** A transaction nothing waits for (one that follows what happened); a failure is logged. */
function transactSoon(store: Store, what: string, plan: (d: Draft) => unknown): void {
  transact(store, plan)
    .then(() => showAll(store))
    .catch((e) => log.warn(what, e))
}

/**
 * A host's deliveries, loaded once and restored: each one not received yet checked again (refused, expired), and one
 * offered when Hive stopped uncertain (it may not have reached its agent: offered once more, #649).
 */
export function load(host: string): Promise<Store> {
  const k = keyOf(host)
  const had = stores.get(k)
  if (had) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  const p = (async () => {
    const read = await readFileOf(host)
    if (stores.has(k)) return stores.get(k)!
    const store: Store = { host, records: read.records, next: read.next, invalid: read.invalid, lock: Promise.resolve(), offering: new Set(), confirming: new Map(), launches: new Map(), leftUntil: new Map(), hooks: new Map() }
    // Restored before anything else sees it (a second load waits for this one).
    await transact(store, (d) => {
      for (const r of [...d.records]) if (r.state === 'offered') set(store, d, r, 'uncertain', 'may not have reached it: Hive stopped while offering it', undefined, { again: AGAIN_RESTART })
      recheck(store, d)
    }).catch((e) => log.warn('restoring deliveries', e))
    if (stores.has(k)) return stores.get(k)!
    stores.set(k, store)
    showAll(store)
    return store
  })().finally(() => {
    if (loading.get(k) === p) loading.delete(k)
  })
  loading.set(k, p)
  return p
}

async function readFileOf(host: string): Promise<{ records: DeliveryRecord[]; next: number; invalid: unknown[] }> {
  const file = fileOf(host)
  let got: { data: Buffer; more: boolean }
  try {
    got = await readCapped(file, MAX_FILE_BYTES)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], next: 1, invalid: [] }
    throw new Error(`Could not read the deliveries (${(e as Error).message})`, { cause: e })
  }
  let data: { next?: unknown; deliveries?: unknown; invalid?: unknown } | null = null
  try {
    if (!got.more) data = JSON.parse(got.data.toString('utf8'))
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Not Hive's (too big, or damaged): set aside, never overwritten, and started again.
    const to = `${file}.${got.more ? 'too-big' : 'damaged'}-${Date.now()}`
    await renameRetrying(file, to)
    log.warn(`The deliveries file was ${got.more ? 'too big' : 'damaged'}: set aside as ${userText(to)}`)
    return { records: [], next: 1, invalid: [] }
  }
  const raw = Array.isArray(data.deliveries) ? data.deliveries : []
  const records: DeliveryRecord[] = []
  const invalid: unknown[] = Array.isArray(data.invalid) ? [...data.invalid] : []
  for (const v of raw) {
    const r = readDelivery(v)
    if (r && !records.some((x) => x.id === r.id)) records.push(r)
    else invalid.push(v)
  }
  if (records.length < raw.length) log.warn(`${raw.length - records.length} saved deliver${raw.length - records.length === 1 ? 'y is' : 'ies are'} not valid: kept aside in the file, not used`)
  const top = records.reduce((m, r) => Math.max(m, r.seq), 0)
  const next = Number.isInteger(data.next) && (data.next as number) > top ? (data.next as number) : top + 1
  return { records, next, invalid }
}

/** The file's text for a draft. */
const fileText = (d: Pick<Draft, 'records' | 'next' | 'invalid'>): string => JSON.stringify({ version: 1, next: d.next, deliveries: d.records, ...(d.invalid.length ? { invalid: d.invalid } : {}) }, null, 2) + '\n'

/**
 * Whether a draft fits the file's budget, with room for each live delivery to grow to its end (times, a reason): what
 * Hive writes stays well under what it reads back (MAX_FILE_BYTES), so a file it wrote is never set aside as too big.
 */
const fits = (d: Draft): boolean => Buffer.byteLength(fileText(d)) + d.records.filter(isLive).length * GROWTH_PER_LIVE <= fileBudget

/** Makes room in the budget by dropping the oldest ended deliveries (their history), if need be. False if it still doesn't fit. */
function makeRoom(d: Draft): boolean {
  while (!fits(d)) {
    const oldest = d.records.filter((r) => !isLive(r)).sort((a, b) => a.seq - b.seq)[0]
    if (!oldest) return false
    d.records = d.records.filter((r) => r !== oldest)
    d.dirty = true
  }
  return true
}

/** For tests: run before each save (to fail it, or hold it). */
let beforeSave: (() => Promise<void> | void) | null = null
export const setBeforeSaveForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeSave = fn
}

/** Saves a draft as the host's deliveries file: atomic (a temp file beside it, then a rename), so a failure leaves it as it was. */
async function save(store: Store, d: Draft): Promise<void> {
  await beforeSave?.()
  prune(store, d)
  const file = fileOf(store.host)
  await mkdir(join(store.host, HIVE_DIR), { recursive: true })
  // Entries kept aside that would push it over: moved to a file of their own (never lost), not kept in this one.
  if (!makeRoom(d) && d.invalid.length) {
    const aside = `${file}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
    await writeFile(aside, JSON.stringify({ version: 1, invalid: d.invalid }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    d.after.push(() => log.warn(`Saved deliveries that aren't valid moved to ${userText(aside)}, to keep the file small enough`))
    d.invalid = []
  }
  // What is written is what reads back (#649): one check, readDelivery's, for saving and restoring alike; a record it
  // wouldn't read back fails the save (nothing changes), never a delivery lost on the next start.
  for (const r of d.records) if (!readDelivery(JSON.parse(JSON.stringify(r)))) throw new Error(`delivery ${r.id} isn't one Hive could read back`)
  const text = fileText(d)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('too many deliveries to keep in this project')
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await beforeRename?.()
    await renameRetrying(tmp, file, 20, undefined, rename)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** For tests: run between writing the temp file and its rename (to fail the rename). */
let beforeRename: (() => Promise<void> | void) | null = null
export const setBeforeRenameForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeRename = fn
}

/** Ended deliveries beyond what is kept (per agent, by age) go; received ones never acked expire after a week. */
function prune(store: Store, d: Draft): void {
  const now = Date.now()
  for (const r of [...d.records]) if (r.state === 'received' && needsAck(r.kind) && now - Date.parse(r.received ?? r.created) > KEEP_RECEIVED_MS) set(store, d, r, 'expired', 'received, never acked')
  const ended = new Map<string, DeliveryRecord[]>()
  for (const r of d.records) if (!isLive(r)) ended.set(r.agentId, [...(ended.get(r.agentId) ?? []), r])
  const drop = new Set<DeliveryRecord>()
  for (const list of ended.values()) {
    list.sort((a, b) => b.seq - a.seq)
    list.forEach((r, i) => {
      if (i >= KEEP_ENDED || now - Date.parse(r.ended ?? r.acked ?? r.received ?? r.created) > KEEP_ENDED_MS) drop.add(r)
    })
  }
  if (drop.size) d.records = d.records.filter((r) => !drop.has(r))
}

/** Replaces a record in a draft. */
function put(d: Draft, from: DeliveryRecord, to: DeliveryRecord): void {
  const i = d.records.indexOf(from)
  if (i < 0) return
  d.records[i] = to
  d.dirty = true
}

/** Tells a delivery's source what became of it, once published and outside the lock. */
function tell(store: Store, d: Draft, r: DeliveryRecord, what: 'received' | 'ended'): void {
  const fn = r.source ? sources.get(r.source)?.[what] : undefined
  const hook = store.hooks.get(r.id)?.[what]
  if (!fn && !hook) return
  d.after.push(() =>
    queueMicrotask(() => {
      try {
        fn?.(r, store.host)
        hook?.()
      } catch (e) {
        log.warn(`telling ${r.source ?? 'its producer'} that ${r.id} was ${what}`, e)
      }
    })
  )
}

/** Moves a delivery in a draft (with `extra` fields); false when that move isn't allowed. */
function set(store: Store, d: Draft, r: DeliveryRecord, to: DeliveryState, detail?: string, via?: 'inbox' | 'typed', extra: Partial<DeliveryRecord> = {}): boolean {
  if (!d.records.includes(r)) return false
  const next = moved(r, to, nowIso(), detail)
  if (!next) return false
  if (via && (to === 'received' || (to === 'acked' && !r.received))) next.receivedVia = via
  const out = { ...next, ...extra }
  put(d, r, out)
  if (to === 'refused' && r.from.kind === 'assistant') {
    const ws = r.from.workspace
    d.after.push(() => assistant.record(ws, `A message for ${r.agentName ?? r.agentId} (${r.id}) was refused`, detail ?? 'its sender may no longer send it'))
  }
  if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'uncertain') d.after.push(() => log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${detail ? `: ${userText(detail)}` : ''}`))
  if ((to === 'received' || to === 'acked') && !r.received) tell(store, d, out, 'received')
  else if (to === 'refused' || to === 'expired' || to === 'cancelled') tell(store, d, out, 'ended')
  return true
}

const byId = (records: readonly DeliveryRecord[], id: string): DeliveryRecord | undefined => records.find((r) => r.id === id)

/** The time expiry is measured against (Date.now; a test's own clock). */
let clock = (): number => Date.now()
/** For tests: the clock expiry is measured against (null: Date.now). */
export const setClockForTests = (fn: (() => number) | null): void => {
  clock = fn ?? (() => Date.now())
}

/** Why this sender may no longer send what it left (null: it may). Asked at every step: before it is offered, before each piece and Enter. */
let senderRefusal = (from: DeliverySender): string | null => {
  if (from.kind !== 'assistant') return null
  if (!assistant.allows('agents')) return 'the user turned Settings → Assistant → Control down'
  if (sessions.liveFor(assistant.assistantHome(from.workspace), ASSISTANT_AGENT_ID)?.runId !== from.launch) return "the Assistant's session that left it ended"
  return null
}
/** For tests: how a sender's permission is worked out. */
export const setSenderCheckForTests = (fn: (from: DeliverySender) => string | null): void => {
  senderRefusal = fn
}

/** Why a delivery not received yet may no longer be given to its agent (null: it may), and what it becomes then. */
function whyNot(store: Store, r: DeliveryRecord): { to: 'refused' | 'expired'; why: string } | null {
  const why = senderRefusal(r.from)
  if (why) return { to: 'refused', why }
  if (Date.parse(r.expires) <= clock()) return { to: 'expired', why: 'not received in time' }
  const live = sessions.liveFor(store.host, r.agentId)
  if (r.forRun && live?.runId !== r.forRun) return { to: 'expired', why: 'the session it was for has ended' }
  if (r.conversation && live?.sessionId && live.sessionId !== r.conversation) return { to: 'expired', why: 'its agent is in another conversation now' }
  return null
}

/**
 * Follows, in a draft, what happened to deliveries not received yet: one that may no longer be given to its agent ends;
 * one whose typed line its CLI has taken since is received (#649); one offered into a launch that has ended (or another
 * one) before that is uncertain, and offered once more.
 */
function recheck(store: Store, d: Draft, agentId?: string): void {
  for (const r of [...d.records]) {
    if (!isUnread(r) || (agentId && r.agentId !== agentId)) continue
    if (r.state === 'offered' && !store.offering.has(r.id)) {
      const base = store.confirming.get(r.id)
      const now = sessions.promptsTaken(store.host, r.agentId)
      // The launch it went into: as saved, or (a launch's save that failed) as followed in memory.
      const run = store.launches.get(r.id) ?? r.offerRun
      if (base && now && now.runId === base.runId && run === base.runId && now.count > base.count) {
        set(store, d, r, 'received', undefined, 'typed', run !== r.offerRun ? { offerRun: run } : {})
        continue
      }
      // A launch still starting (its run not attached yet) is in progress, never a run that has gone: only a restart
      // (load) finds one left like that, and makes it uncertain.
      if (run === LAUNCHING) continue
      if (run && sessions.liveFor(store.host, r.agentId)?.runId !== run) {
        set(store, d, r, 'uncertain', `may not have reached it: ${AGAIN_LAUNCH}`, undefined, { again: AGAIN_LAUNCH })
        continue
      }
    }
    const no = whyNot(store, r)
    if (no) set(store, d, r, no.to, no.why)
  }
  // What has left offered keeps no check of its line's receipt.
  for (const id of [...store.confirming.keys()]) if (byId(d.records, id)?.state !== 'offered') store.confirming.delete(id)
  for (const id of [...store.launches.keys()]) if (byId(d.records, id)?.state !== 'offered') store.launches.delete(id)
  for (const id of [...store.hooks.keys()]) if (!isUnread(byId(d.records, id) ?? { state: 'cancelled' })) store.hooks.delete(id)
}

/** Shows an agent's unread and overdue deliveries in its pane (only while it runs). */
function show(store: Store, agentId: string): void {
  sessions.setInbox(store.host, agentId, inboxSummary(store.records.filter((r) => r.agentId === agentId), Date.now(), overdueMs()))
}
function showAll(store: Store): void {
  for (const id of new Set(store.records.map((r) => r.agentId))) show(store, id)
}

export interface NewDelivery {
  agentId: string
  agentName?: string
  conversation?: string | null
  kind: DeliveryKind
  from: DeliverySender
  card?: number
  body: string
  /** How long it may wait to be received (default DELIVERY_EXPIRY_HOURS). */
  expiresMs?: number
  /** At most this many of its kind waiting for the agent (counted with it, when it is made): more is refused. */
  maxWaiting?: number
  /** What made it (a registered source) and its key there: one waiting with the same is that one (`replace`: made again from this). */
  source?: string
  ref?: string
  replace?: boolean
  meta?: Record<string, string | number | boolean>
  /** What its agent must be doing to be offered it (default idle). */
  need?: DeliveryNeed
  /** Only for this launch of its agent (a mode notice, a lock's go-ahead): it expires when that launch ends. */
  forRun?: string
  /** Why it may repeat (one Hive may have given before: a watch read back from before #649 being typed). */
  again?: string
  /** Offered by a launch about to start (launchWith only). */
  launching?: true
}

/** How many of an agent's deliveries of a kind wait to be offered. */
export const waitingCount = (host: string, agentId: string, kind: DeliveryKind): number => stores.get(keyOf(host))?.records.filter((r) => r.agentId === agentId && r.kind === kind && isWaiting(r)).length ?? 0

/**
 * Makes a delivery for an agent of a host, saved before this returns. Refused (an Error) when its sender may not send it.
 * One already waiting with the same source and ref is returned instead (made again from this one with `replace`).
 */
export async function createDelivery(host: string, nd: NewDelivery, hooks?: DeliveryHooks): Promise<DeliveryRecord> {
  // Only what reads back is saved (readDelivery's limits): a longer text is refused here, never lost on a restart.
  if (nd.body.length > DELIVERY_BODY_MAX_CHARS) throw new Error(`It is too long to give an agent (${nd.body.length} characters, at most ${DELIVERY_BODY_MAX_CHARS}).`)
  if ((nd.ref?.length ?? 0) > 300 || (nd.source?.length ?? 0) > 40) throw new Error('Not a delivery Hive can keep: its source or key is too long.')
  const meta = nd.meta && Object.fromEntries(Object.entries(nd.meta).slice(0, 20).map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 500) : v]))
  const agentName = nd.agentName?.slice(0, 300)
  const store = await load(host)
  const r = await transact(store, (d) => {
    const why = senderRefusal(nd.from)
    if (why) throw new Error(`Not sent: ${why}.`)
    const had = nd.source && nd.ref !== undefined ? d.records.find((x) => x.source === nd.source && x.ref === nd.ref && x.agentId === nd.agentId && isWaiting(x)) : undefined
    if (had) {
      if (!nd.replace) return had
      const again: DeliveryRecord = { ...had, body: nd.body, ...(nd.card ? { card: nd.card } : {}), ...(meta ? { meta } : {}), ...(nd.forRun ? { forRun: nd.forRun } : {}), expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString() }
      put(d, had, again)
      return again
    }
    if (nd.maxWaiting !== undefined && d.records.filter((x) => x.agentId === nd.agentId && x.kind === nd.kind && isWaiting(x)).length >= nd.maxWaiting) throw new TooManyWaiting(`${nd.maxWaiting} already wait`)
    if (d.records.filter(isLive).length >= MAX_LIVE_PER_HOST) throw new DeliveriesFull(`This project already has ${MAX_LIVE_PER_HOST} deliveries waiting or not acked, the most Hive keeps.`)
    const seq = d.next++
    const rec: DeliveryRecord = {
      id: `m${seq}`,
      seq,
      agentId: nd.agentId,
      ...(agentName ? { agentName } : {}),
      conversation: nd.conversation || null,
      kind: nd.kind,
      from: nd.from,
      ...(nd.card ? { card: nd.card } : {}),
      body: nd.body,
      state: 'queued',
      created: nowIso(),
      expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString(),
      ...(nd.source ? { source: nd.source, ...(nd.ref !== undefined ? { ref: nd.ref } : {}) } : {}),
      ...(meta ? { meta } : {}),
      ...(nd.need && nd.need !== 'idle' ? { need: nd.need } : {}),
      ...(nd.forRun ? { forRun: nd.forRun } : {}),
      ...(nd.again ? { again: nd.again } : {}),
      // Made offered, into a launch about to start (launchWith): saved before the launch, never offered by the scheduler.
      ...(nd.launching ? { state: 'offered' as const, offered: nowIso(), offers: 1, offerRun: LAUNCHING } : {})
    }
    d.records.push(rec)
    d.dirty = true
    // Within the file's budget (ended ones' history makes room first), or not made at all.
    if (!makeRoom(d)) throw new DeliveriesFull("This project's deliveries are full (what waits for its agents and isn't acked): wait until they are received and acked, or cancel some.")
    d.after.push(() => log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} queued`))
    return rec
  })
  // Its producer's own part (also for one made again from this: the newest producer's).
  if (hooks && isUnread(r)) store.hooks.set(r.id, hooks)
  show(store, nd.agentId)
  return r
}

/** A delivery as it is now (null when it is gone, or its host isn't loaded). */
export const deliveryNow = (host: string, id: string): DeliveryRecord | null => byId(stores.get(keyOf(host))?.records ?? [], id) ?? null

/** An agent's deliveries, oldest first (loaded if need be). */
export async function deliveriesOf(host: string, agentId: string): Promise<DeliveryRecord[]> {
  const store = await load(host)
  return store.records.filter((r) => r.agentId === agentId).sort((a, b) => a.seq - b.seq)
}

/** A host's deliveries from a source, oldest first (only what is loaded). */
export const fromSource = (host: string, source: string): DeliveryRecord[] => (stores.get(keyOf(host))?.records ?? []).filter((r) => r.source === source).sort((a, b) => a.seq - b.seq)
/** Every loaded host's deliveries from a source, with their hosts. */
export const everyFromSource = (source: string): { host: string; r: DeliveryRecord }[] => [...stores.values()].flatMap((s) => s.records.filter((r) => r.source === source).map((r) => ({ host: s.host, r })))

/** An agent's deliveries as the Agent API shows them: unread and overdue counts, and the rows (the newest `limit`). */
export async function deliveryView(host: string, agentId: string, limit: number, textChars = 80): Promise<{ unread: number; overdue: number; deliveries: DeliveryRow[]; more?: number }> {
  const list = await deliveriesOf(host, agentId)
  const now = Date.now()
  const rows = list.map((r) => deliveryRow(r, now, textChars, overdueMs()))
  const shown = rows.slice(-limit)
  return { unread: list.filter(isUnread).length, overdue: rows.filter((r) => r.overdue).length, deliveries: shown, ...(rows.length > shown.length ? { more: rows.length - shown.length } : {}) }
}

/** Whether a delivery can still be cancelled: waiting, or offered and being typed, or typed and not taken by its CLI yet. */
const cancellable = (store: Store, r: DeliveryRecord): boolean => isWaiting(r) || (r.state === 'offered' && (store.offering.has(r.id) || untaken(store, r))) || (r.state === 'uncertain' && !isWaiting(r))

/**
 * Cancels an agent's deliveries waiting to be offered (and one being typed now, whose typing stops, or typed and not
 * taken by its CLI yet, whose confirmation then clears the line rather than pressing Enter again), all of them or those
 * of `kinds` (or those `match` picks); by: who cancelled. How many.
 */
export async function cancelDeliveries(host: string, agentId: string, by: string, kinds?: readonly DeliveryKind[], match?: (r: DeliveryRecord) => boolean): Promise<number> {
  const store = await load(host)
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.agentId !== agentId || (kinds && !kinds.includes(r.kind)) || (match && !match(r))) continue
      if (cancellable(store, r) && set(store, d, r, 'cancelled', `cancelled by ${by}`)) count++
    }
    return count
  })
  show(store, agentId)
  return n
}

/** Cancels a host's deliveries from a source (`ref`: only that one) not received yet, as cancelDeliveries does (`why`: the reason given). How many. */
export async function cancelFromSource(host: string, source: string, ref: string | null, why: string): Promise<number> {
  const store = stores.get(keyOf(host)) ?? (await load(host))
  const agents = new Set<string>()
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.source !== source || (ref !== null && r.ref !== ref) || !cancellable(store, r)) continue
      if (set(store, d, r, 'cancelled', why)) {
        count++
        agents.add(r.agentId)
      }
    }
    return count
  })
  for (const a of agents) show(store, a)
  return n
}

/** Whether an offered delivery's line is typed and its CLI hasn't taken it yet (the confirmation then gives it no Enter). */
function untaken(store: Store, r: DeliveryRecord): boolean {
  const c = store.confirming.get(r.id)
  const now = c && sessions.promptsTaken(store.host, r.agentId)
  return !!c && !!now && now.runId === c.runId && r.offerRun === c.runId && now.count <= c.count
}

/**
 * hive_inbox for an agent: its deliveries not received yet (a card's events coalesced), now received; and those received
 * before and not acked (of the kinds it acks). What may no longer be given out is refused or expired instead, checked in
 * the same transaction.
 */
export async function readInbox(host: string, agentId: string): Promise<{ items: InboxItem[]; unacked: string[] }> {
  const store = await load(host)
  // Its sources' say first (#649), as for an offer: each made again from things as they are now.
  const fresh = await refreshAll(store, store.records.filter((x) => x.agentId === agentId && isUnread(x)))
  const r = await transact(store, (d) => {
    recheck(store, d, agentId)
    applyFresh(store, d, fresh)
    const mine = d.records.filter((x) => x.agentId === agentId)
    // Only what may still be given out: what its source and producer still hold (a reply the user no longer lets be
    // told, a watch that has ended, a wake that is someone else's now, isn't handed out).
    const give = mine.filter((x) => isUnread(x) && stillWanted(store, x))
    const out = { items: inboxItems(give), unacked: mine.filter((x) => x.state === 'received' && needsAck(x.kind)).map((x) => x.id) }
    for (const x of give) set(store, d, x, 'received', undefined, 'inbox')
    return out
  })
  show(store, agentId)
  return { items: r.items, unacked: r.unacked }
}

/** hive_inbox ack: marks an agent's deliveries acked. Ids that aren't its own, or don't exist, are unknown (nothing said of them). */
export async function ackDeliveries(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[] }> {
  const store = await load(host)
  const asked = new Set(ids)
  const fresh = await refreshAll(store, store.records.filter((x) => x.agentId === agentId && asked.has(x.id) && isUnread(x)))
  const r = await transact(store, (d) => {
    // One not received yet is checked as it would be before it is given out (its sender's permission, its expiry, the
    // agent's conversation, and its source's say): one that may no longer be delivered is refused, expired or
    // cancelled, not acked; one its source doesn't hold now is unknown.
    recheck(store, d, agentId)
    applyFresh(store, d, fresh)
    const acked: string[] = []
    const unknown: string[] = []
    for (const id of [...new Set(ids)]) {
      const x = byId(d.records, id)
      if (!x || x.agentId !== agentId) unknown.push(id)
      else if (x.state === 'acked') acked.push(id)
      // Ended without being received (cancelled, refused, expired): not for it to act on.
      else if (isUnread(x) && !stillWanted(store, x)) unknown.push(id)
      else if ((isLive(x) || x.state === 'received') && set(store, d, x, 'acked', undefined, 'inbox')) acked.push(id)
      else unknown.push(id)
    }
    return { acked, unknown }
  })
  show(store, agentId)
  return { acked: r.acked, unknown: r.unknown }
}

/** Applies, in a draft, what sources said as their deliveries were made again: cancelled, or their text as it is now. */
function applyFresh(store: Store, d: Draft, fresh: Map<string, { body: string } | { cancel: string }>): void {
  for (const [id, f] of fresh) {
    const r = byId(d.records, id)
    if (!r || !isUnread(r)) continue
    if ('cancel' in f) set(store, d, r, 'cancelled', f.cancel)
    else if (f.body.length > DELIVERY_BODY_MAX_CHARS) set(store, d, r, 'cancelled', 'cancelled: made again, it was too long to keep')
    else if (f.body !== r.body) put(d, r, { ...r, body: f.body })
  }
}

/** Whether a delivery's source and producer still hold it (what an offer's writer asks before each key). */
const stillWanted = (store: Store, r: DeliveryRecord): boolean => (r.source ? sources.get(r.source)?.holds?.(r, store.host) : undefined) !== false && store.hooks.get(r.id)?.holds?.() !== false

/** An offer: its deliveries (as they were before it, to put back), the line, the launch and conversation it is for. */
interface Offer {
  ids: string[]
  was: Map<string, DeliveryRecord>
  line: string
  runId: string
  sessionId: string
  need: DeliveryNeed
}

/** What an agent must be doing to be offered these together: the one they share, else free (which every need takes). */
const needOf = (items: readonly DeliveryRecord[]): DeliveryNeed => {
  const needs = new Set(items.map((r) => r.need ?? 'idle'))
  return needs.size === 1 ? [...needs][0] : 'free'
}

/**
 * Which of an agent's waiting deliveries go in its next line (those that may still be given out and that it can take,
 * as it is now): `only` that one; else a task or handover alone (the oldest), or all the others together.
 */
function pickOffer(store: Store, records: readonly DeliveryRecord[], agentId: string, only?: string): DeliveryRecord[] {
  const live = sessions.liveFor(store.host, agentId)
  const can = records.filter((r) => r.agentId === agentId && isWaiting(r) && !whyNot(store, r) && readyFor(live, r.need ?? 'idle')).sort((a, b) => a.seq - b.seq)
  if (only) return can.filter((r) => r.id === only)
  const alone = can.find((r) => goesAlone(r.kind))
  return alone ? [alone] : can.filter((r) => !goesAlone(r.kind))
}

/**
 * Plans an offer of an agent's waiting deliveries (`items`, as picked) in a draft: offered, into this launch
 * (`offerRun`), with the line that will be typed. Null when none of them still waits.
 */
function planOffer(store: Store, d: Draft, items: readonly DeliveryRecord[], target: { runId: string; sessionId: string }, label: string | null): Offer | null {
  const now = items.map((r) => byId(d.records, r.id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r) && !whyNot(store, r))
  if (!now.length) return null
  // A watching agent is told its watch carries on, unless the line is its own watch's wake (whose receipt ends it).
  const line = offerLine(now, now.some((r) => r.source === 'watch') ? null : label)
  const was = new Map(now.map((r) => [r.id, r]))
  for (const r of now) set(store, d, r, 'offered', undefined, undefined, { offerRun: target.runId })
  return { ids: now.map((r) => r.id), was, line, runId: target.runId, sessionId: target.sessionId, need: needOf(now) }
}

/**
 * Whether an offer still holds: each still offered by it, allowed and still wanted by its source (and by its caller), and
 * its agent in the same launch and conversation.
 */
function offerHolds(store: Store, o: Offer, records: readonly DeliveryRecord[] = store.records): boolean {
  const live = sessions.liveFor(store.host, o.ids.length ? byId(records, o.ids[0])!.agentId : '')
  if (!live || live.runId !== o.runId || (o.sessionId && live.sessionId && live.sessionId !== o.sessionId)) return false
  return o.ids.every((id) => {
    const r = byId(records, id)
    if (r?.state !== 'offered' || r.offerRun !== o.runId || senderRefusal(r.from) || Date.parse(r.expires) <= clock() || (r.conversation && live.sessionId && live.sessionId !== r.conversation)) return false
    const s = r.source ? sources.get(r.source) : undefined
    return (s?.holds?.(r, store.host) ?? true) && (store.hooks.get(id)?.holds?.() ?? true)
  })
}

/** Puts an offer's deliveries back as they were (the line wasn't typed), those it still has as offered. */
function unoffer(store: Store, o: Offer): Promise<void> {
  for (const id of o.ids) store.offering.delete(id)
  return transact(store, (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      const was = o.was.get(id)
      if (r?.state === 'offered' && r.offerRun === o.runId && was) put(d, r, was)
    }
    // One that may no longer be given out is ended now, not at the next try.
    recheck(store, d, byId(d.records, o.ids[0])?.agentId)
  })
    .then(() => showAll(store))
    .catch((e) => log.warn('putting deliveries back', e))
}

/**
 * The line they were in won't be submitted by Hive (#530: the confirmation found the offer no longer holds before its
 * Enter again, and cleared the line or left the user's draft): each still offered by it ends as what is true now, refused
 * (its sender may no longer send it) or expired (too old, its agent in another conversation); one that would still hold
 * for another line (its agent started again, or only another of the line stopped holding) is put back to wait.
 */
function withdrawn(store: Store, o: Offer, left: boolean): void {
  // What still holds goes in a line again soon (the wake a message rode, typed alone), but not over a line left in the
  // prompt: only once that prompt has been submitted.
  const agentId = byId(store.records, o.ids[0])?.agentId
  const base = store.confirming.get(o.ids[0])
  if (left && agentId && base) store.leftUntil.set(agentId, base)
  transact(store, (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      if (r?.state !== 'offered' || r.offerRun !== o.runId) continue
      const no = whyNot(store, r)
      if (no) set(store, d, r, no.to, no.why)
      else {
        const was = o.was.get(id)
        if (was) put(d, r, was)
      }
    }
  })
    .then(() => {
      showAll(store)
      if (agentId) retrySoon(store.host, agentId)
    })
    .catch((e) => log.warn('withdrawing deliveries', e))
}

/** The launch the line was typed into ended (or another began) before its CLI took it: what it carried is uncertain now. */
function lost(store: Store): void {
  transactSoon(store, 'checking deliveries', (d) => recheck(store, d))
}

/** The line was taken by its CLI (its confirmation saw the prompt count rise in its launch): what it carried is received (#649). */
function taken(store: Store, o: Offer): void {
  transactSoon(store, 'receiving deliveries', (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      if (r?.state === 'offered' && r.offerRun === o.runId) set(store, d, r, 'received', undefined, 'typed')
    }
  })
}

/** While the confirmation checks its CLI took the line: until then a cancel can still end it (and no Enter comes). */
function confirming(store: Store, o: Offer, before: { runId: string; count: number }): void {
  for (const id of o.ids) store.confirming.set(id, before)
}

/** Each source's line made again for what is about to be offered (from things as they are now): its body, or why it is cancelled. */
async function refreshAll(store: Store, items: readonly DeliveryRecord[]): Promise<Map<string, { body: string } | { cancel: string }>> {
  const out = new Map<string, { body: string } | { cancel: string }>()
  for (const r of items) {
    const fn = r.source ? sources.get(r.source)?.refresh : undefined
    if (!fn) continue
    try {
      const got = await fn(r, store.host)
      if (got) out.set(r.id, got)
    } catch (e) {
      log.warn(`making delivery ${r.id} again`, e)
    }
  }
  return out
}

const trying = new Map<string, Promise<boolean>>()

/** Offers an agent's waiting deliveries now if it can take a line (one try at a time per agent); `only`: that one alone. Whether a line was typed. */
export function offerNow(host: string, agentId: string, only?: string): Promise<boolean> {
  const k = `${keyOf(host)}#${agentId}`
  const going = trying.get(k)
  if (going) return going.then(() => false)
  const run = offerOnce(host, agentId, only).finally(() => trying.delete(k))
  trying.set(k, run)
  return run
}

async function offerOnce(host: string, agentId: string, only?: string): Promise<boolean> {
  const store = await load(host)
  const st = sessions.liveFor(host, agentId)
  if (!st) return false
  // A line of Hive's left in its prompt (the user's draft in it): nothing more until that prompt is submitted.
  const left = store.leftUntil.get(agentId)
  if (left) {
    const now = sessions.promptsTaken(host, agentId)
    if (now && now.runId === left.runId && now.count <= left.count) return false
    store.leftUntil.delete(agentId)
  }
  // What may no longer be given out (its sender's permission gone, too old, another conversation) ends now, not later.
  if (store.records.some((r) => r.agentId === agentId && isUnread(r) && whyNot(store, r))) await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  let items = pickOffer(store, store.records, agentId, only)
  if (!items.length) return false
  if (!canTypeLine(host, agentId, needOf(items))) {
    // The user may still be writing there: nothing says when they stop, so it is tried again in a moment.
    if (sessions.userMayBeTyping(host, agentId)) retrySoon(host, agentId)
    return false
  }
  // Each source's line made again from things as they are now: one no longer due is cancelled (and not offered), as is
  // one its producer no longer wants (its own check, given with it).
  const fresh = await refreshAll(store, items)
  for (const r of items) if (!fresh.has(r.id) && store.hooks.get(r.id)?.holds?.() === false) fresh.set(r.id, { cancel: 'cancelled: no longer wanted' })
  const label = st.status === 'watching' && st.watch ? st.watch.label : null
  // Saved as offered before the first key (checked as it is planned), and checked again before each key: if Hive stops
  // in between it is uncertain, never "delivered". Not saved, or no longer to be given out: nothing is typed.
  let offer: Offer | null
  try {
    offer = await transact(store, (d) => {
      applyFresh(store, d, fresh)
      items = pickOffer(store, d.records, agentId, only).filter((r) => items.some((x) => x.id === r.id))
      return planOffer(store, d, items, { runId: st.runId, sessionId: st.sessionId }, label)
    })
  } catch (e) {
    log.warn(`Deliveries for ${userText(agentId)} not offered: ${(e as Error).message}`)
    show(store, agentId)
    return false
  }
  show(store, agentId)
  if (!offer || !offerHolds(store, offer)) {
    if (offer) await unoffer(store, offer)
    return false
  }
  const o = offer
  for (const id of o.ids) store.offering.add(id)
  let typed = false
  try {
    typed = await typeLine(host, agentId, o.line, () => offerHolds(store, o) && o.ids.every((id) => store.offering.has(id)), {
      need: o.need,
      // Before the confirmation's Enter again: the same check as before each key of the line.
      ride: { still: () => offerHolds(store, o), withdrawn: (inPrompt) => withdrawn(store, o, inPrompt), confirming: (before) => confirming(store, o, before), taken: () => taken(store, o), lost: () => lost(store) }
    })
  } finally {
    for (const id of o.ids) store.offering.delete(id)
    // Not typed: put back (and ended, if it may no longer be given out) before this returns, so a reply says so; what
    // its source no longer has due (what it was made from changed as it was typed) ends now too, not at the next try.
    if (typed) log.info(`Deliveries ${o.ids.join(', ')} for ${userText(agentId)} offered`)
    else {
      await unoffer(store, o)
      await dropUndue(store, o.ids)
    }
    show(store, agentId)
  }
  // Put off part-way (the user began typing there, what it was made from changed): tried again by itself, soon.
  if (!typed) retrySoon(host, agentId)
  return typed
}

/**
 * Ends, of these deliveries still waiting, those their source no longer has due (a producer's own check, given with one,
 * is its caller's to answer: deliverNow says why it wasn't given; the next offer ends what its check no longer wants).
 */
async function dropUndue(store: Store, ids: readonly string[]): Promise<void> {
  const waiting = ids.map((id) => byId(store.records, id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r))
  const fresh = await refreshAll(store, waiting)
  const ends = [...fresh].filter(([, f]) => 'cancel' in f) as [string, { cancel: string }][]
  if (!ends.length) return
  await transact(store, (d) => {
    for (const [id, f] of ends) {
      const r = byId(d.records, id)
      if (r && isWaiting(r)) set(store, d, r, 'cancelled', f.cancel)
    }
  }).catch((e) => log.warn('ending deliveries no longer due', e))
}

/** Agents whose line was put off part-way, tried again in a moment (one timer each; the tick and statuses try too). */
const retrying = new Map<string, ReturnType<typeof setTimeout>>()
const RETRY_MS = 1000
function retrySoon(host: string, agentId: string): void {
  const k = `${keyOf(host)}#${agentId}`
  if (retrying.has(k)) return
  const t = setTimeout(() => {
    retrying.delete(k)
    void offerNow(host, agentId).catch((e) => log.warn('offering deliveries', e))
  }, RETRY_MS)
  t.unref?.()
  retrying.set(k, t)
}

/**
 * Makes a delivery its caller wants given now, or not at all (#649: a task, a handover's step, which are never queued):
 * offered at once, alone; else cancelled, and NotGiven says why. `holds`: the caller's own check, asked with each key.
 */
export async function deliverNow(host: string, nd: NewDelivery, holds?: () => boolean, hooks: Omit<DeliveryHooks, 'holds'> = {}): Promise<DeliveryRecord> {
  const rec = await createDelivery(host, nd, { ...hooks, ...(holds ? { holds } : {}) })
  const store = await load(host)
  let why: string | null = null
  try {
    // Another try for the agent may be running (the tick's): once it is done, this one's own.
    for (let i = 0; i < 3; i++) {
      const now = deliveryNow(host, rec.id)
      if (!now || !isWaiting(now)) break
      why = whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? (holds && !holds() ? 'what it was for changed meanwhile' : null)
      if (why) break
      if (await offerNow(host, nd.agentId, rec.id)) break
    }
  } finally {
    const now = deliveryNow(host, rec.id)
    if (now && isWaiting(now)) {
      why ??= whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? 'Hive could not type it'
      await transact(store, (d) => {
        const r = byId(d.records, rec.id)
        if (r && isWaiting(r)) set(store, d, r, 'cancelled', `not given: ${why}`)
      }).catch(() => undefined)
      show(store, nd.agentId)
    }
  }
  const out = deliveryNow(host, rec.id) ?? rec
  if (out.state === 'cancelled' || out.state === 'refused' || out.state === 'expired') {
    store.hooks.delete(rec.id)
    throw new NotGiven(out.detail?.replace(/^not given: /, '') ?? why ?? out.state)
  }
  return out
}

/**
 * Makes a delivery that a launch carries (#649: the task an agent is started with, its prompt on the command line):
 * `start` launches the agent with its line (its text, with its id to ack), and it is offered into that launch, received
 * once the launch's CLI takes its first prompt. `start` failing cancels it, and the error stands.
 */
export async function launchWith<T extends { runId: string }>(host: string, nd: NewDelivery, start: (line: string) => Promise<T>, hooks?: DeliveryHooks): Promise<{ record: DeliveryRecord; launched: T }> {
  // Saved as offered before anything is launched (persist before the effect, #647): not saved, nothing starts. From
  // here a crash leaves it offered, so it is uncertain after the restart, never queued and typed again as if new. The
  // scheduler never offers it (it isn't waiting), and the checks leave it alone while the launch starts.
  const rec = await createDelivery(host, { ...nd, launching: true }, hooks)
  const store = await load(host)
  store.offering.add(rec.id)
  let run: T
  try {
    run = await start(offerLine([rec], null))
  } catch (e) {
    store.offering.delete(rec.id)
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING) set(store, d, r, 'cancelled', `not given: ${(e as Error).message}`)
    }).catch((err) => log.warn("cancelling a launch's task", err))
    show(store, nd.agentId)
    throw e
  }
  // The launch it went into, in memory at once (what the checks follow if saving it fails), and on disk.
  if (run?.runId) {
    store.launches.set(rec.id, run.runId)
    store.confirming.set(rec.id, { runId: run.runId, count: 0 })
  }
  try {
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING && run?.runId) put(d, r, { ...r, offerRun: run.runId })
    })
  } catch (e) {
    // Launched with it: still offered into that launch (followed in memory); a restart finds it uncertain.
    log.warn("saving the launch a task went into (it is followed in memory; a restart finds it uncertain)", e)
  } finally {
    store.offering.delete(rec.id)
  }
  show(store, nd.agentId)
  return { record: deliveryNow(host, rec.id) ?? rec, launched: run }
}

/**
 * For a producer about to start from what an agent was told (a new watch, #649): its typed lines taken since are
 * received now, and their sources told, before this returns.
 */
export async function followAgent(host: string, agentId: string): Promise<void> {
  const store = stores.get(keyOf(host))
  if (!store?.records.some((r) => r.agentId === agentId && r.state === 'offered')) return
  await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  // Its sources are told in microtasks queued as it was published: they have run once this has.
  await new Promise((r) => setImmediate(r))
  show(store, agentId)
}

/** Follows each loaded host's deliveries (received, uncertain, ended), offers what waits, and refreshes the panes (overdue). */
function tick(): void {
  for (const store of stores.values()) {
    if (store.records.some((r) => isUnread(r) && (whyNot(store, r) || r.state === 'offered'))) transactSoon(store, 'checking deliveries', (d) => recheck(store, d))
    const agents = new Set(store.records.filter(isLive).map((r) => r.agentId))
    for (const a of agents) {
      show(store, a)
      if (store.records.some((r) => r.agentId === a && isWaiting(r))) void offerNow(store.host, a).catch((e) => log.warn('offering deliveries', e))
    }
  }
}

let started = false
/** Wires the service in (once, at start): statuses and a tick offer and follow deliveries, workspaces restore them. */
export function initDeliveries(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'workspace-changed') {
      // Restored as a workspace opens: its projects' and its Assistant's (refusals shown, panes filled in).
      const hosts = [...(e.workspace?.projects ?? []).map((p) => p.path), ...(e.workspace?.assistant ? [e.workspace.assistant.path] : [])]
      for (const h of hosts) void load(h).catch((err) => log.warn('restoring deliveries', err))
      return
    }
    if (e.type !== 'session-status') return
    const { projectPath, agentId, status } = e.state
    void load(projectPath)
      .then((store) => {
        // A prompt taken, a launch ended: what was offered is received, or uncertain.
        if (store.records.some((r) => r.agentId === agentId && r.state === 'offered')) transactSoon(store, 'checking deliveries', (d) => recheck(store, d, agentId))
        show(store, agentId)
        if (readyFor(e.state, 'stalled') || status === 'watching') setTimeout(() => void offerNow(projectPath, agentId).catch((err) => log.warn('offering deliveries', err)), 500).unref?.()
      })
      .catch((err) => log.warn('loading deliveries', err))
  })
  // The user's pause after typing, a line taken, overdue: nothing tells of those, so they are looked at now and then.
  const timer = setInterval(tick, 5000)
  timer.unref?.()
}

// Sessions give their own lines through the service (#649: a lock's go-ahead, the carry-on after a sign-in, a handover's
// steps): it is set as this loads.
sessions.deliveries = {
  give: async (host, nd, hooks) => {
    const r = await createDelivery(host, nd, hooks)
    await offerNow(host, nd.agentId)
    return r
  },
  now: (host, nd, holds) => deliverNow(host, nd, holds),
  cancel: cancelFromSource
}

/** For tests: every loaded host's agents offered now (what the tick does), awaited. */
export async function offerAllForTests(): Promise<void> {
  const runs: Promise<boolean>[] = []
  for (const store of stores.values()) for (const a of new Set(store.records.filter(isWaiting).map((r) => r.agentId))) runs.push(offerNow(store.host, a))
  await Promise.all(runs)
}
/** For tests: what the tick follows (received, uncertain, ended), now, awaited. */
export async function followAllForTests(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => transact(store, (d) => recheck(store, d)).then(() => showAll(store))))
}
/** For tests: transactions still running finish. */
export async function settledForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.all([...stores.values()].map((s) => s.lock))
}
/** For tests: forgets every host in memory, as a restart of Hive does (transactions finish first); what is on disk stays. */
export async function forgetDeliveriesForTests(): Promise<void> {
  await settledForTests()
  for (const t of retrying.values()) clearTimeout(t)
  retrying.clear()
  stores.clear()
  trying.clear()
}
