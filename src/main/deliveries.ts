import { join } from 'path'
import { mkdir, rename, rm, writeFile } from 'original-fs/promises'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { HIVE_DIR } from '../shared/defaults'
import {
  DELIVERY_EXPIRY_HOURS,
  OVERDUE_MINUTES,
  deliveryRow,
  inboxItems,
  inboxSummary,
  isLive,
  isUnread,
  isWaiting,
  moved,
  offerLine,
  readDelivery,
  type DeliveryKind,
  type DeliveryRecord,
  type DeliveryRow,
  type DeliverySender,
  type DeliveryState,
  type InboxItem
} from '../shared/deliveries'
import * as assistant from './assistantControl'
import { onHiveEvent } from './events'
import { readCapped, renameRetrying } from './fsutil'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { canTypeLine, onWakeRider, typeLine, type Rider } from './watches'

/**
 * The delivery service (#647, plans/2026-10-12-messaging-redesign.md §3.1). Everything Hive has for an agent to read is a
 * delivery record (shared/deliveries.ts), saved in its session host's .hive/deliveries.json (a project's, or the
 * Assistant's home's) with atomic writes, and restored when Hive starts: one offered when Hive stopped is uncertain then,
 * and one whose sender may no longer send it is refused, and shown. This service alone offers them: today by typing the
 * line a message always was (watches.typeLine, or first in a wake's line), until Messaging 4 switches the channel. A typed
 * line makes a delivery offered, never received: **received means fetched through hive_inbox, and nothing else** (§3.1,
 * #645: received is automatic on fetch). The agent acks it with hive_inbox once it has acted on it (from offered too, as
 * the body is still typed until #650); one not acked OVERDUE_MINUTES after it was made is overdue. One offered when Hive
 * stopped stays offered after it (it is never typed again) until the agent fetches or acks it.
 *
 * **Transactions.** Each host's records change one transaction at a time (`transact`, under the host's lock): planned on
 * a copy of what is published, saved, and only then published, so nothing (a read, a wake's rider, the pane) ever sees a
 * change that isn't on disk, and a save that fails changes nothing (NotSaved). What a transaction hands out or acts on is
 * checked again once its save is done (`verify`): changed meanwhile (its sender's permission gone, past its expiry, its
 * agent in another conversation or launch), it is planned again from what is published, so the outcome recorded is the
 * one that is true when it takes effect. The offer's writer checks the same before each piece and Enter.
 *
 * **Authority.** A sender's permission is worked out again at every step, from the sender saved with it and the settings
 * now (never a closure or token): the Assistant's needs Settings → Assistant → Control at Control agents and the launch
 * that sent it still running (#645: a launch that has ended sends nothing more; its waiting messages are refused, and the
 * refusal is in the Assistant's activity list and the agent's). One is for its agent's conversation when that was known.
 *
 * The rules, for every operation (create, offer, readInbox, ack, cancel): **one async lock per host**, inside it copy,
 * change the copy, save atomically, then publish; and **check at the effect, inside that lock**: sender permission,
 * expiry and the target conversation are checked right before a body is returned, an ack is recorded or a line is typed
 * (after the save, the last wait before the effect; for a line, before each piece and Enter).
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
/** A transaction whose checks keep failing after its save is planned again at most this many times. */
const MAX_PLANS = 3

/** How long until a delivery is overdue: OVERDUE_MINUTES, or an unpackaged test build's (HIVE_TEST_DELIVERY_OVERDUE_MS). */
export const overdueMs = (): number => {
  const t = !app.isPackaged ? Number(process.env.HIVE_TEST_DELIVERY_OVERDUE_MS) : NaN
  return Number.isFinite(t) && t > 0 ? t : OVERDUE_MINUTES * 60_000
}

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
}

/** A transaction's working copy: planned on, saved, then published. */
interface Draft {
  records: DeliveryRecord[]
  next: number
  invalid: unknown[]
  dirty: boolean
  /** What to do once it is published (log lines, the Assistant's activity list): nothing for a plan that isn't. */
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

/** Runs fn after the host's transactions before it (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.lock.then(fn)
  store.lock = run.catch(() => undefined)
  return run
}

/**
 * A transaction (see the top): `plan` changes a copy of what is published (synchronously); a copy it changed is saved and
 * then published. `verify`, asked once the save is done, says whether what was planned still holds; if not, it is planned
 * again from what is published (which nothing else changed meanwhile: the host's lock is held) and saved again, up to
 * MAX_PLANS times. A plan that throws changes nothing; a save that fails throws NotSaved and publishes nothing.
 */
function transact<T>(store: Store, plan: (d: Draft) => T, verify?: (d: Draft, planned: T) => boolean): Promise<T> {
  return locked(store, async () => {
    let saved = false
    for (let n = 1; ; n++) {
      const d: Draft = { records: [...store.records], next: store.next, invalid: [...store.invalid], dirty: false, after: [] }
      let planned: T
      try {
        planned = plan(d)
      } catch (e) {
        // Planned again after a save and refused now: what is on disk goes back to what is published.
        if (saved) await write(store, { records: [...store.records], next: store.next, invalid: [...store.invalid], dirty: true, after: [] }).catch((err) => log.warn('restoring deliveries', err))
        throw e
      }
      if (d.dirty) {
        try {
          await write(store, d)
          saved = true
        } catch (e) {
          throw new NotSaved(`Hive couldn't save the deliveries (${(e as Error).message}): nothing changed.`, { cause: e })
        }
      }
      if (verify && n < MAX_PLANS && !verify(d, planned)) continue
      if (d.dirty) {
        store.records = d.records
        store.next = d.next
        store.invalid = d.invalid
        for (const f of d.after) f()
      }
      return planned
    }
  })
}

/** A transaction nothing waits for (one that follows what happened); a failure is logged. */
function transactSoon(store: Store, what: string, plan: (d: Draft) => unknown): void {
  transact(store, plan)
    .then(() => showAll(store))
    .catch((e) => log.warn(what, e))
}

/** A host's deliveries, loaded once and restored (each one not received yet checked again: refused, expired). */
export function load(host: string): Promise<Store> {
  const k = keyOf(host)
  const had = stores.get(k)
  if (had) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  const p = (async () => {
    const read = await readFileOf(host)
    if (stores.has(k)) return stores.get(k)!
    const store: Store = { host, records: read.records, next: read.next, invalid: read.invalid, lock: Promise.resolve(), offering: new Set() }
    // Restored before anything else sees it (a second load waits for this one).
    // One offered when Hive stopped stays offered: never typed again, received only once the agent fetches it.
    await transact(store, (d) => recheck(store, d)).catch((e) => log.warn('restoring deliveries', e))
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

/** Writes a draft to the host's file (atomic: a temp file, then a rename). */
async function write(store: Store, d: Draft): Promise<void> {
  await beforeSave?.()
  prune(d)
  const file = fileOf(store.host)
  await mkdir(join(store.host, HIVE_DIR), { recursive: true })
  // Entries kept aside that would push it over: moved to a file of their own (never lost), not kept in this one.
  if (!makeRoom(d) && d.invalid.length) {
    const aside = `${file}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
    await writeFile(aside, JSON.stringify({ version: 1, invalid: d.invalid }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    d.after.push(() => log.warn(`Saved deliveries that aren't valid moved to ${userText(aside)}, to keep the file small enough`))
    d.invalid = []
  }
  const text = fileText(d)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('too many deliveries to keep in this project')
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await renameRetrying(tmp, file, 20, undefined, rename)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** Ended deliveries beyond what is kept (per agent, by age) go; received ones never acked expire after a week. */
function prune(d: Draft): void {
  const now = Date.now()
  for (const r of [...d.records]) if (r.state === 'received' && now - Date.parse(r.received ?? r.created) > KEEP_RECEIVED_MS) set(d, r, 'expired', 'received, never acked')
  const ended = new Map<string, DeliveryRecord[]>()
  for (const r of d.records) if (!isLive(r)) ended.set(r.agentId, [...(ended.get(r.agentId) ?? []), r])
  const drop = new Set<DeliveryRecord>()
  for (const list of ended.values()) {
    list.sort((a, b) => b.seq - a.seq)
    list.forEach((r, i) => {
      if (i >= KEEP_ENDED || now - Date.parse(r.ended ?? r.acked ?? r.created) > KEEP_ENDED_MS) drop.add(r)
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

/** Moves a delivery in a draft (with `extra` fields); false when that move isn't allowed. */
function set(d: Draft, r: DeliveryRecord, to: DeliveryState, detail?: string, via?: 'inbox', extra: Partial<DeliveryRecord> = {}): boolean {
  if (!d.records.includes(r)) return false
  const next = moved(r, to, nowIso(), detail)
  if (!next) return false
  if (via && (to === 'received' || (to === 'acked' && !r.received))) next.receivedVia = via
  put(d, r, { ...next, ...extra })
  if (to === 'refused' && r.from.kind === 'assistant') {
    const ws = r.from.workspace
    d.after.push(() => assistant.record(ws, `A message for ${r.agentName ?? r.agentId} (${r.id}) was refused`, detail ?? 'its sender may no longer send it'))
  }
  if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'uncertain') d.after.push(() => log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${detail ? `: ${userText(detail)}` : ''}`))
  return true
}

const byId = (records: readonly DeliveryRecord[], id: string): DeliveryRecord | undefined => records.find((r) => r.id === id)

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
  if (Date.parse(r.expires) <= Date.now()) return { to: 'expired', why: 'not received in time' }
  const live = sessions.liveFor(store.host, r.agentId)
  if (r.conversation && live?.sessionId && live.sessionId !== r.conversation) return { to: 'expired', why: 'its agent is in another conversation now' }
  return null
}

/** Ends, in a draft, what may no longer be given to its agent (only what isn't received yet). */
function recheck(store: Store, d: Draft, agentId?: string): void {
  for (const r of [...d.records]) {
    if (!isUnread(r) || (agentId && r.agentId !== agentId)) continue
    const no = whyNot(store, r)
    if (no) set(d, r, no.to, no.why)
  }
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
}

/** How many of an agent's deliveries of a kind wait to be offered. */
export const waitingCount = (host: string, agentId: string, kind: DeliveryKind): number => stores.get(keyOf(host))?.records.filter((r) => r.agentId === agentId && r.kind === kind && isWaiting(r)).length ?? 0

/** Makes a delivery for an agent of a host, saved before this returns. Refused (an Error) when its sender may not send it. */
export async function createDelivery(host: string, nd: NewDelivery): Promise<DeliveryRecord> {
  const store = await load(host)
  const r = await transact(store, (d) => {
    const why = senderRefusal(nd.from)
    if (why) throw new Error(`Not sent: ${why}.`)
    if (nd.maxWaiting !== undefined && d.records.filter((x) => x.agentId === nd.agentId && x.kind === nd.kind && isWaiting(x)).length >= nd.maxWaiting) throw new TooManyWaiting(`${nd.maxWaiting} already wait`)
    if (d.records.filter(isLive).length >= MAX_LIVE_PER_HOST) throw new DeliveriesFull(`This project already has ${MAX_LIVE_PER_HOST} deliveries waiting or not acked, the most Hive keeps.`)
    const seq = d.next++
    const rec: DeliveryRecord = {
      id: `m${seq}`,
      seq,
      agentId: nd.agentId,
      ...(nd.agentName ? { agentName: nd.agentName } : {}),
      conversation: nd.conversation || null,
      kind: nd.kind,
      from: nd.from,
      ...(nd.card ? { card: nd.card } : {}),
      body: nd.body,
      state: 'queued',
      created: nowIso(),
      expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString()
    }
    d.records.push(rec)
    d.dirty = true
    // Within the file's budget (ended ones' history makes room first), or not made at all.
    if (!makeRoom(d)) throw new DeliveriesFull("This project's deliveries are full (what waits for its agents and isn't acked): wait until they are received and acked, or cancel some.")
    d.after.push(() => log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} queued`))
    return rec
  })
  show(store, nd.agentId)
  return r
}

/** A delivery as it is now (null when it is gone). */
export const deliveryNow = (host: string, id: string): DeliveryRecord | null => byId(stores.get(keyOf(host))?.records ?? [], id) ?? null

/** An agent's deliveries, oldest first (loaded if need be). */
export async function deliveriesOf(host: string, agentId: string): Promise<DeliveryRecord[]> {
  const store = await load(host)
  return store.records.filter((r) => r.agentId === agentId).sort((a, b) => a.seq - b.seq)
}

/** An agent's deliveries as the Agent API shows them: unread and overdue counts, and the rows (the newest `limit`). */
export async function deliveryView(host: string, agentId: string, limit: number, textChars = 80): Promise<{ unread: number; overdue: number; deliveries: DeliveryRow[]; more?: number }> {
  const list = await deliveriesOf(host, agentId)
  const now = Date.now()
  const rows = list.map((r) => deliveryRow(r, now, textChars, overdueMs()))
  const shown = rows.slice(-limit)
  return { unread: list.filter(isUnread).length, overdue: rows.filter((r) => r.overdue).length, deliveries: shown, ...(rows.length > shown.length ? { more: rows.length - shown.length } : {}) }
}

/**
 * Cancels an agent's deliveries waiting to be offered (and one being typed now, whose typing stops), all of them or those
 * of `kinds`; by: who cancelled. How many.
 */
export async function cancelDeliveries(host: string, agentId: string, by: string, kinds?: readonly DeliveryKind[]): Promise<number> {
  const store = await load(host)
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.agentId !== agentId || (kinds && !kinds.includes(r.kind))) continue
      if ((isWaiting(r) || (r.state === 'offered' && store.offering.has(r.id))) && set(d, r, 'cancelled', `cancelled by ${by}`)) count++
    }
    return count
  })
  show(store, agentId)
  return n
}

/**
 * hive_inbox for an agent: its deliveries not received yet (a card's events coalesced), now received; and those received
 * before and not acked. What may no longer be given out is refused or expired instead, checked as it is planned and again
 * once it is saved, just before the bodies are given out.
 */
export async function readInbox(host: string, agentId: string): Promise<{ items: InboxItem[]; unacked: string[] }> {
  const store = await load(host)
  const r = await transact(
    store,
    (d) => {
      recheck(store, d, agentId)
      const mine = d.records.filter((x) => x.agentId === agentId)
      const unread = mine.filter(isUnread)
      const out = { items: inboxItems(mine), unacked: mine.filter((x) => x.state === 'received').map((x) => x.id), ids: unread.map((x) => x.id) }
      for (const x of unread) set(d, x, 'received', undefined, 'inbox')
      return out
    },
    (_d, p) => stillValidNow(store, p.ids)
  )
  show(store, agentId)
  return { items: r.items, unacked: r.unacked }
}

/** Whether what was unread (and is published so) may still be given out now: the check after a transaction's save. */
const stillValidNow = (store: Store, ids: readonly string[]): boolean => ids.every((id) => {
  const r = byId(store.records, id)
  return !r || !isUnread(r) || !whyNot(store, r)
})

/** hive_inbox ack: marks an agent's deliveries acked. Ids that aren't its own, or don't exist, are unknown (nothing said of them). */
export async function ackDeliveries(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[] }> {
  const store = await load(host)
  const r = await transact(
    store,
    (d) => {
      // One not received yet is checked as it would be before it is given out (its sender's permission, its expiry, the
      // agent's conversation): one that may no longer be delivered is refused or expired, not acked.
      recheck(store, d, agentId)
      const acked: string[] = []
      const unknown: string[] = []
      const unread: string[] = []
      for (const id of [...new Set(ids)]) {
        const x = byId(d.records, id)
        if (!x || x.agentId !== agentId) unknown.push(id)
        else if (x.state === 'acked') acked.push(id)
        // Ended without being received (cancelled, refused, expired): not for it to act on.
        else if (isLive(x)) {
          if (isUnread(x)) unread.push(id)
          if (set(d, x, 'acked', undefined, 'inbox')) acked.push(id)
          else unknown.push(id)
        } else unknown.push(id)
      }
      return { acked, unknown, unread }
    },
    (_d, p) => stillValidNow(store, p.unread)
  )
  show(store, agentId)
  return { acked: r.acked, unknown: r.unknown }
}

/** An offer: its deliveries (as they were before it, to put back), the line, the launch and conversation it is for. */
interface Offer {
  ids: string[]
  was: Map<string, DeliveryRecord>
  line: string
  runId: string
  sessionId: string
}

/**
 * Plans an offer of an agent's waiting deliveries (those that may still be given out) in a draft: offered, into this
 * launch (`offerRun`), with the line that will be typed (`lineFor`: its text, and the whole line when it goes in front of
 * a wake's). Null when none waits.
 */
function planOffer(store: Store, d: Draft, agentId: string, target: { runId: string; sessionId: string }, lineFor: (items: DeliveryRecord[]) => { text: string; full: string }): (Offer & { text: string }) | null {
  recheck(store, d, agentId)
  const items = d.records.filter((r) => r.agentId === agentId && isWaiting(r)).sort((a, b) => a.seq - b.seq)
  if (!items.length) return null
  const { text, full } = lineFor(items)
  const was = new Map(items.map((r) => [r.id, r]))
  for (const r of items) set(d, r, 'offered', undefined, undefined, { offerRun: target.runId })
  return { ids: items.map((r) => r.id), was, line: full, text, runId: target.runId, sessionId: target.sessionId }
}

/** Whether an offer still holds: each still offered by it and allowed, and its agent in the same launch and conversation. */
function offerHolds(store: Store, o: Offer, records: readonly DeliveryRecord[] = store.records): boolean {
  const live = sessions.liveFor(store.host, o.ids.length ? byId(records, o.ids[0])!.agentId : '')
  if (!live || live.runId !== o.runId || (o.sessionId && live.sessionId && live.sessionId !== o.sessionId)) return false
  return o.ids.every((id) => {
    const r = byId(records, id)
    return r?.state === 'offered' && r.offerRun === o.runId && !senderRefusal(r.from) && Date.parse(r.expires) > Date.now() && !(r.conversation && live.sessionId && live.sessionId !== r.conversation)
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

/** The line they were in was cleared before its CLI took it (#530): their sender may no longer send them, so refused. */
function withdrawn(store: Store, o: Offer): void {
  transactSoon(store, 'refusing deliveries', (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      if (r?.state === 'offered' && r.offerRun === o.runId) set(d, r, 'refused', senderRefusal(r.from) ?? 'its sender may no longer send it')
    }
  })
}

/** Whether an offer's deliveries may still all be sent (the confirmation's check before Enter again). */
const allowedAll = (store: Store, o: Offer): boolean => o.ids.every((id) => {
  const r = byId(store.records, id)
  return !!r && !senderRefusal(r.from)
})

/**
 * What rides a wake typed into the agent (watches.onWakeRider), first in its line: its deliveries waiting that may still be
 * given out. Their offer is saved by `ready`, which the writer waits for before the line's first key; taken back to
 * waiting if the line isn't typed after all.
 */
function riderFor(projectPath: string, agentId: string, wakeLine: string): Rider | null {
  const store = stores.get(keyOf(projectPath))
  const live = sessions.liveFor(projectPath, agentId)
  if (!store || !live) return null
  // One that may no longer be given out doesn't ride it, and is ended now (refused, expired), not at the next tick.
  if (store.records.some((r) => r.agentId === agentId && isWaiting(r) && whyNot(store, r))) transactSoon(store, 'checking deliveries', (d) => recheck(store, d, agentId))
  const items = store.records.filter((r) => r.agentId === agentId && isWaiting(r) && !whyNot(store, r)).sort((a, b) => a.seq - b.seq)
  if (!items.length) return null
  const text = offerLine(items, null)
  let offer: Offer | null = null
  const ready = (async () => {
    offer = await transact(
      store,
      (d) => {
        const o = planOffer(store, d, agentId, { runId: live.runId, sessionId: live.sessionId }, (now) => {
          // What waits changed since the rider was made (one cancelled, refused, added): not this line.
          if (now.map((r) => r.id).join() !== items.map((r) => r.id).join()) throw new Error('The deliveries riding it changed.')
          return { text, full: `${text} ${wakeLine}` }
        })
        if (!o) throw new Error('No deliveries ride it now.')
        return o
      },
      (d, o) => offerHolds(store, o, d.records)
    )
    for (const id of offer.ids) store.offering.add(id)
    show(store, agentId)
  })()
  ready.catch(() => undefined)
  return {
    text,
    ready,
    still: () => !!offer && offerHolds(store, offer) && offer.ids.every((id) => store.offering.has(id)),
    taken: () => {
      if (!offer) return
      for (const id of offer.ids) store.offering.delete(id)
      log.info(`Deliveries ${offer.ids.join(', ')} for ${userText(agentId)} offered with a wake`)
    },
    notTaken: () => {
      if (offer) void unoffer(store, offer)
    },
    allowed: () => !!offer && allowedAll(store, offer),
    withdrawn: () => {
      if (offer) withdrawn(store, offer)
    }
  }
}

const trying = new Map<string, Promise<void>>()

/** Offers an agent's waiting deliveries now if it can take a line (one try at a time per agent). */
export function offerNow(host: string, agentId: string): Promise<void> {
  const k = `${keyOf(host)}#${agentId}`
  const running = trying.get(k)
  if (running) return running
  const run = offerOnce(host, agentId).finally(() => trying.delete(k))
  trying.set(k, run)
  return run
}

async function offerOnce(host: string, agentId: string): Promise<void> {
  const store = await load(host)
  const st = sessions.liveFor(host, agentId)
  if (!st) return
  if (!store.records.some((r) => r.agentId === agentId && isWaiting(r)) || !canTypeLine(host, agentId)) return
  const label = st.status === 'watching' && st.watch ? st.watch.label : null
  // Saved as offered before the first key, then checked again: if Hive stops before it knows the line arrived, it is
  // uncertain, never "delivered". Not saved, or no longer to be given out: nothing is typed.
  let offer: Offer | null
  try {
    offer = await transact(
      store,
      (d) => {
        const o = planOffer(store, d, agentId, { runId: st.runId, sessionId: st.sessionId }, (items) => {
          const line = offerLine(items, label)
          return { text: line, full: line }
        })
        return o
      },
      (d, o) => !o || offerHolds(store, o, d.records)
    )
  } catch (e) {
    log.warn(`Deliveries for ${userText(agentId)} not offered: ${(e as Error).message}`)
    show(store, agentId)
    return
  }
  show(store, agentId)
  if (!offer || !offerHolds(store, offer)) {
    if (offer) await unoffer(store, offer)
    return
  }
  const o = offer
  for (const id of o.ids) store.offering.add(id)
  let typed = false
  try {
    typed = await typeLine(host, agentId, o.line, () => offerHolds(store, o) && o.ids.every((id) => store.offering.has(id)), {
      rider: false,
      ride: { still: () => allowedAll(store, o), withdrawn: () => withdrawn(store, o), instead: null }
    })
  } finally {
    for (const id of o.ids) store.offering.delete(id)
    // Not typed: put back (and ended, if it may no longer be given out) before this returns, so a reply says so.
    if (typed) log.info(`Deliveries ${o.ids.join(', ')} for ${userText(agentId)} offered`)
    else await unoffer(store, o)
    show(store, agentId)
  }
}

/** Tries every loaded host's agents that have deliveries waiting, and refreshes what their panes show (overdue). */
function tick(): void {
  for (const store of stores.values()) {
    // Also for agents not running: what has expired, or whose sender may no longer send it, ends now, not at their next start.
    if (store.records.some((r) => isUnread(r) && whyNot(store, r))) transactSoon(store, 'checking deliveries', (d) => recheck(store, d))
    const agents = new Set(store.records.filter(isLive).map((r) => r.agentId))
    for (const a of agents) {
      show(store, a)
      if (store.records.some((r) => r.agentId === a && isWaiting(r))) void offerNow(store.host, a).catch((e) => log.warn('offering deliveries', e))
    }
  }
}

let started = false
/** Wires the service in (once, at start): wakes take deliveries along, statuses and a tick offer them, workspaces restore them. */
export function initDeliveries(): void {
  if (started) return
  started = true
  onWakeRider(riderFor)
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
        show(store, agentId)
        if (status === 'ready' || status === 'finished' || status === 'watching') setTimeout(() => void offerNow(projectPath, agentId).catch((err) => log.warn('offering deliveries', err)), 500).unref?.()
      })
      .catch((err) => log.warn('loading deliveries', err))
  })
  // The user's pause after typing, a line taken, overdue: nothing tells of those, so they are looked at now and then.
  const timer = setInterval(tick, 5000)
  timer.unref?.()
}

/** For tests: every loaded host's agents offered now (what the tick does), awaited. */
export async function offerAllForTests(): Promise<void> {
  const runs: Promise<void>[] = []
  for (const store of stores.values()) for (const a of new Set(store.records.filter(isWaiting).map((r) => r.agentId))) runs.push(offerNow(store.host, a))
  await Promise.all(runs)
}
/** For tests: wires the wake rider in without the events. */
export const useRiderForTests = (): void => onWakeRider(riderFor)
/** For tests: transactions still running finish. */
export async function settledForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.all([...stores.values()].map((s) => s.lock))
}
/** For tests: forgets every host in memory, as a restart of Hive does (transactions finish first); what is on disk stays. */
export async function forgetDeliveriesForTests(): Promise<void> {
  await settledForTests()
  stores.clear()
  trying.clear()
}
