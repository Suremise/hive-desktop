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
  lineIds,
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
import { transcripts } from './transcripts'
import { canTypeLine, onWakeRider, typeLine, type Rider } from './watches'
import { inWorkspace, workspaceOf } from './workspace'

/**
 * The delivery service (#647, plans/2026-10-12-messaging-redesign.md §3.1). Everything Hive has for an agent to read is a
 * delivery record (shared/deliveries.ts), saved in its session host's .hive/deliveries.json (a project's, or the
 * Assistant's home's) with atomic writes, and restored when Hive starts: one offered when Hive stopped is uncertain then,
 * and one whose sender may no longer send it is refused, and shown. This service alone offers them: today by typing the
 * line a message always was (watches.typeLine, or first in a wake's line), until Messaging 4 switches the channel. The
 * agent receives them when its CLI takes that line, or by fetching them with hive_inbox, and acks them with hive_inbox
 * once it has acted on them; one not acked OVERDUE_MINUTES after it was made is overdue.
 *
 * A sender's permission is worked out again at every step, from the sender saved with it and the settings now (never a
 * closure or token): the Assistant's needs Settings → Assistant → Control at Control agents and the launch that sent it
 * still running (#645: a launch that has ended sends nothing more; its waiting messages are refused, and the refusal is in
 * the Assistant's activity list and the agent's). One is for its agent's conversation when that was known: another
 * conversation doesn't get it (expired). An agent's waiting deliveries survive its stops and Hive's restarts.
 *
 * In memory each host's records are the truth, changed synchronously (so a wake's line can take them at once); every
 * change is saved after the ones before it, and what must be on disk first (offered, before typing) is awaited.
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
const GROWTH_PER_LIVE = 700
/** For tests: a smaller budget for the file. */
export const setFileBudgetForTests = (bytes: number): void => {
  fileBudget = bytes
}

/** How long until a delivery is overdue: OVERDUE_MINUTES, or an unpackaged test build's (HIVE_TEST_DELIVERY_OVERDUE_MS). */
export const overdueMs = (): number => {
  const t = !app.isPackaged ? Number(process.env.HIVE_TEST_DELIVERY_OVERDUE_MS) : NaN
  return Number.isFinite(t) && t > 0 ? t : OVERDUE_MINUTES * 60_000
}

interface Store {
  host: string
  records: DeliveryRecord[]
  next: number
  /** Saves, one after another. */
  queue: Promise<void>
  /** The ids being offered by a line being typed now: cancelled meanwhile, its typing stops. */
  offering: Set<string>
  /** Saved entries that aren't deliveries (a hand edit, a newer build's): kept aside in the file as they were, not used. */
  invalid: unknown[]
}

const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
const keyOf = (host: string): string => host.toLowerCase()
const fileOf = (host: string): string => join(host, HIVE_DIR, 'deliveries.json')
const nowIso = (): string => new Date().toISOString()

/** A host's deliveries, loaded once (and restored: see the top). */
export function load(host: string): Promise<Store> {
  const k = keyOf(host)
  const had = stores.get(k)
  if (had) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  const p = (async () => {
    const read = await readFileOf(host)
    const store: Store = { host, records: read.records, next: read.next, queue: Promise.resolve(), offering: new Set(), invalid: read.invalid }
    if (stores.has(k)) return stores.get(k)!
    stores.set(k, store)
    // Offered when Hive stopped: whether it arrived isn't known.
    let changed = false
    for (const r of store.records) if (r.state === 'offered') changed = set(store, r, 'uncertain', 'Hive stopped before it knew whether this reached the agent') || changed
    changed = recheck(store) || changed
    if (changed) saveSoon(store)
    for (const id of new Set(store.records.map((r) => r.agentId))) show(store, id)
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
  let data: { next?: unknown; deliveries?: unknown } | null = null
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
  const invalid: unknown[] = Array.isArray((data as { invalid?: unknown }).invalid) ? [...((data as { invalid: unknown[] }).invalid)] : []
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

/**
 * Saves a host's deliveries after the saves before it (its records as they are when it runs). Rejects when this save
 * failed: what needs it on disk first (a delivery made, offered before typing, received from the inbox, acked) waits for
 * it and fails with it (durably); the next save is tried all the same.
 */
function commit(store: Store): Promise<void> {
  const run = store.queue.then(() => save(store))
  store.queue = run.catch(() => undefined)
  return run
}

/** Saves after a change nothing waits for (one that only follows what happened: received by a line, refused, put back). */
function saveSoon(store: Store): void {
  commit(store).catch((e) => log.warn('saving deliveries', e))
}

/** Hive couldn't save a change, so it wasn't made. */
export class NotSaved extends Error {}

/**
 * Makes a change (synchronously, in memory) and waits until it is saved. Not saved: each record it changed is put back
 * as it was (unless changed again since), and this fails, so nothing claims what isn't on disk.
 */
async function durably<T>(store: Store, change: () => T): Promise<T> {
  const before = new Map(store.records.map((r) => [r.id, r]))
  const result = change()
  const mine = store.records.filter((r) => before.get(r.id) !== r)
  try {
    await commit(store)
  } catch (e) {
    for (const r of mine) {
      const i = store.records.indexOf(r)
      if (i < 0) continue
      const was = before.get(r.id)
      if (was) store.records[i] = was
      else store.records.splice(i, 1)
    }
    for (const a of new Set(mine.map((r) => r.agentId))) show(store, a)
    throw new NotSaved(`Hive couldn't save the deliveries (${(e as Error).message}): nothing changed.`, { cause: e })
  }
  return result
}

/** The file's text for a host's deliveries. */
const fileText = (store: Store): string => JSON.stringify({ version: 1, next: store.next, deliveries: store.records, ...(store.invalid.length ? { invalid: store.invalid } : {}) }, null, 2) + '\n'

/**
 * Whether a host's deliveries fit the file's budget, with room for each live one to grow to its end (times, a reason):
 * what Hive writes stays well under what it reads back (MAX_FILE_BYTES), so a file it wrote is never set aside as too big.
 */
const fits = (store: Store): boolean => Buffer.byteLength(fileText(store)) + store.records.filter(isLive).length * GROWTH_PER_LIVE <= fileBudget

/** Makes room in the budget by dropping the oldest ended deliveries (their history), if need be. False if it still doesn't fit. */
function makeRoom(store: Store): boolean {
  while (!fits(store)) {
    const oldest = store.records.filter((r) => !isLive(r)).sort((a, b) => a.seq - b.seq)[0]
    if (!oldest) return false
    store.records = store.records.filter((r) => r !== oldest)
  }
  return true
}

/** For tests: run before each save (to fail it, or hold it). */
let beforeSave: (() => Promise<void> | void) | null = null
export const setBeforeSaveForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeSave = fn
}

async function save(store: Store): Promise<void> {
  await beforeSave?.()
  prune(store)
  const file = fileOf(store.host)
  await mkdir(join(store.host, HIVE_DIR), { recursive: true })
  // Entries kept aside that would push it over: moved to a file of their own (never lost), not kept in this one.
  if (!makeRoom(store) && store.invalid.length) {
    const aside = `${file}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
    await writeFile(aside, JSON.stringify({ version: 1, invalid: store.invalid }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    log.warn(`Saved deliveries that aren't valid moved to ${userText(aside)}, to keep the file small enough`)
    store.invalid = []
  }
  const text = fileText(store)
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
function prune(store: Store): void {
  const now = Date.now()
  for (const r of store.records) if (r.state === 'received' && now - Date.parse(r.received ?? r.created) > KEEP_RECEIVED_MS) set(store, r, 'expired', 'received, never acked')
  const ended = new Map<string, DeliveryRecord[]>()
  for (const r of store.records) if (!isLive(r)) ended.set(r.agentId, [...(ended.get(r.agentId) ?? []), r])
  const drop = new Set<DeliveryRecord>()
  for (const list of ended.values()) {
    list.sort((a, b) => b.seq - a.seq)
    list.forEach((r, i) => {
      if (i >= KEEP_ENDED || now - Date.parse(r.ended ?? r.acked ?? r.created) > KEEP_ENDED_MS) drop.add(r)
    })
  }
  if (drop.size) store.records = store.records.filter((r) => !drop.has(r))
}

/** Moves a delivery (in the store, in memory); false when that move isn't allowed. Saving is the caller's (commit). */
function set(store: Store, r: DeliveryRecord, to: DeliveryState, detail?: string, via?: 'line' | 'inbox'): boolean {
  const i = store.records.indexOf(r)
  if (i < 0) return false
  const next = moved(r, to, nowIso(), detail)
  if (!next) return false
  if (to === 'received' && via) next.receivedVia = via
  if (to === 'acked' && !r.received && via) next.receivedVia = via
  store.records[i] = next
  if (to === 'refused' && r.from.kind === 'assistant') {
    assistant.record(r.from.workspace, `A message for ${r.agentName ?? r.agentId} (${r.id}) was refused`, detail ?? 'its sender may no longer send it')
  }
  if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'uncertain') log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${detail ? `: ${userText(detail)}` : ''}`)
  return true
}

/** Finds a record by id now (records are replaced as they move). */
const byId = (store: Store, id: string): DeliveryRecord | undefined => store.records.find((r) => r.id === id)

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

/**
 * Ends what may no longer be delivered: past its expiry, its sender no longer allowed, its agent in another conversation
 * (running now with a known one). Only those not received yet. True when one changed.
 */
function recheck(store: Store, agentId?: string): boolean {
  const now = Date.now()
  let changed = false
  for (const r of [...store.records]) {
    if (!isUnread(r) || (agentId && r.agentId !== agentId)) continue
    const why = senderRefusal(r.from)
    if (why) changed = set(store, r, 'refused', why) || changed
    else if (Date.parse(r.expires) <= now) changed = set(store, r, 'expired', 'not received in time') || changed
    else {
      const live = sessions.liveFor(store.host, r.agentId)
      if (r.conversation && live?.sessionId && live.sessionId !== r.conversation) changed = set(store, r, 'expired', 'its agent is in another conversation now') || changed
    }
  }
  return changed
}

/** Shows an agent's unread and overdue deliveries in its pane (only while it runs). */
function show(store: Store, agentId: string): void {
  sessions.setInbox(store.host, agentId, inboxSummary(store.records.filter((r) => r.agentId === agentId), Date.now(), overdueMs()))
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

/** A delivery refused because too many of its kind wait already (NewDelivery.maxWaiting). */
export class TooManyWaiting extends Error {}

/** How many of an agent's deliveries of a kind wait to be offered. */
export const waitingCount = (host: string, agentId: string, kind: DeliveryKind): number => stores.get(keyOf(host))?.records.filter((r) => r.agentId === agentId && r.kind === kind && isWaiting(r)).length ?? 0

/** Makes a delivery for an agent of a host, saved before this returns. Refused (an Error) when its sender may not send it. */
export async function createDelivery(host: string, d: NewDelivery): Promise<DeliveryRecord> {
  const store = await load(host)
  const why = senderRefusal(d.from)
  if (why) throw new Error(`Not sent: ${why}.`)
  if (d.maxWaiting !== undefined && waitingCount(host, d.agentId, d.kind) >= d.maxWaiting) throw new TooManyWaiting(`${d.maxWaiting} already wait`)
  if (store.records.filter(isLive).length >= MAX_LIVE_PER_HOST) throw new Error(`This project already has ${MAX_LIVE_PER_HOST} deliveries waiting or not acked, the most Hive keeps.`)
  const seq = store.next++
  const created = nowIso()
  const r: DeliveryRecord = {
    id: `m${seq}`,
    seq,
    agentId: d.agentId,
    ...(d.agentName ? { agentName: d.agentName } : {}),
    conversation: d.conversation || null,
    kind: d.kind,
    from: d.from,
    ...(d.card ? { card: d.card } : {}),
    body: d.body,
    state: 'queued',
    created,
    expires: new Date(Date.now() + (d.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString()
  }
  await durably(store, () => {
    store.records.push(r)
    // Within the file's budget (ended ones' history makes room first), or not made at all.
    if (!makeRoom(store)) {
      store.records = store.records.filter((x) => x !== r)
      throw new TooManyWaiting(`This project's deliveries are full (what waits for its agents and isn't acked): wait until they are received and acked, or cancel some.`)
    }
  })
  show(store, d.agentId)
  log.info(`Delivery ${r.id} (${r.kind}) for ${userText(d.agentName ?? d.agentId)} queued`)
  return r
}

/** A delivery as it is now (null when it is gone). */
export const deliveryNow = (host: string, id: string): DeliveryRecord | null => (stores.get(keyOf(host)) ? (byId(stores.get(keyOf(host))!, id) ?? null) : null)

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
  const n = await durably(store, () => {
    let count = 0
    for (const r of [...store.records]) {
      if (r.agentId !== agentId || (kinds && !kinds.includes(r.kind))) continue
      if ((isWaiting(r) || (r.state === 'offered' && store.offering.has(r.id))) && set(store, r, 'cancelled', `cancelled by ${by}`)) count++
    }
    return count
  })
  show(store, agentId)
  return n
}

/**
 * hive_inbox for an agent: its deliveries not received yet (a card's events coalesced), now received; and those received
 * before and not acked.
 */
export async function readInbox(host: string, agentId: string): Promise<{ items: InboxItem[]; unacked: string[] }> {
  const store = await load(host)
  // What may no longer be delivered ends first, in the same step, so it is never given out.
  const r = await durably(store, () => {
    recheck(store, agentId)
    const mine = store.records.filter((x) => x.agentId === agentId)
    const unacked = mine.filter((x) => x.state === 'received').map((x) => x.id)
    const items = inboxItems(mine)
    for (const x of mine.filter(isUnread)) set(store, x, 'received', undefined, 'inbox')
    return { items, unacked }
  })
  show(store, agentId)
  return r
}

/** hive_inbox ack: marks an agent's deliveries acked. Ids that aren't its own, or don't exist, are unknown (nothing said of them). */
export async function ackDeliveries(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[] }> {
  const store = await load(host)
  const r = await durably(store, () => {
    // One not received yet is checked as it would be before it is given out (its sender's permission, its expiry, the
    // agent's conversation), in the same step: one that may no longer be delivered is refused or expired, not acked.
    recheck(store, agentId)
    const acked: string[] = []
    const unknown: string[] = []
    for (const id of [...new Set(ids)]) {
      const x = byId(store, id)
      if (!x || x.agentId !== agentId) unknown.push(id)
      else if (x.state === 'acked') acked.push(id)
      // Ended without being received (cancelled, refused, expired): not for it to act on.
      else if (isLive(x) && set(store, x, 'acked', undefined, 'inbox')) acked.push(id)
      else unknown.push(id)
    }
    return { acked, unknown }
  })
  show(store, agentId)
  return r
}

/** An agent's deliveries waiting to be offered, as they are now (oldest first), once those that can't be are ended. */
function waitingFor(store: Store, agentId: string): DeliveryRecord[] {
  if (recheck(store, agentId)) {
    saveSoon(store)
    show(store, agentId)
  }
  return store.records.filter((r) => r.agentId === agentId && isWaiting(r)).sort((a, b) => a.seq - b.seq)
}

/** Takes these (as they were when offered) back to waiting: the line they were in wasn't typed. */
function unoffer(store: Store, ids: readonly string[], was: Map<string, DeliveryState>): void {
  for (const id of ids) {
    store.offering.delete(id)
    const r = byId(store, id)
    if (r?.state !== 'offered') continue
    if (was.get(id) === 'uncertain') {
      // Its first offer's outcome still isn't known: uncertain again, not queued.
      const i = store.records.indexOf(r)
      store.records[i] = { ...r, state: 'uncertain', offers: Math.max(0, (r.offers ?? 1) - 1) }
    } else set(store, r, 'queued')
  }
}

/** Marks these offered (in memory), remembering what each was. */
function offer(store: Store, items: readonly DeliveryRecord[]): { ids: string[]; was: Map<string, DeliveryState> } {
  const was = new Map(items.map((r) => [r.id, r.state]))
  for (const r of items) {
    set(store, r, 'offered')
    store.offering.add(r.id)
  }
  return { ids: items.map((r) => r.id), was }
}

/** Whether all of these are still offered by this line (none cancelled meanwhile) and their senders may still send them. */
const stillOffered = (store: Store, ids: readonly string[]): boolean => ids.every((id) => byId(store, id)?.state === 'offered' && store.offering.has(id))
const allowedAll = (store: Store, ids: readonly string[]): boolean => ids.every((id) => {
  const r = byId(store, id)
  return !!r && !senderRefusal(r.from)
})

/** The line they were in was cleared before its CLI took it (#530): their sender may no longer send them, so refused. */
function withdrawn(store: Store, ids: readonly string[]): void {
  for (const id of ids) {
    const r = byId(store, id)
    if (r?.state === 'offered') set(store, r, 'refused', senderRefusal(r.from) ?? 'its sender may no longer send it')
  }
  saveSoon(store)
  const agents = new Set(ids.map((id) => byId(store, id)?.agentId).filter(Boolean) as string[])
  for (const a of agents) show(store, a)
}

/**
 * The ids of the deliveries whose lines are in an agent's conversation as prompts its CLI took (its transcript's user
 * messages): the CLI's own record that the line reached it. A line names its ids ("(Its id: m4." / "(Their ids: m4, m5."),
 * which are never used again, so another prompt (the user's own, typed over a line Hive's Enter didn't send) is never
 * taken for one.
 */
let promptsOf = async (host: string, sessionId: string): Promise<string[]> => {
  try {
    const t = await inWorkspace(workspaceOf(host), () => transcripts.read(host, sessionId))
    return (t?.items ?? []).flatMap((x) => (x.kind === 'user' ? [x.text] : []))
  } catch {
    // Not readable now (no transcript yet, the workspace closed): nothing found, so nothing is taken for received.
    return []
  }
}
/** For tests: how the prompts an agent's CLI took are read. */
export const setPromptReaderForTests = (fn: (host: string, sessionId: string) => Promise<string[]>): void => {
  promptsOf = fn
}

async function idsTaken(host: string, sessionId: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const text of await promptsOf(host, sessionId)) for (const id of lineIds(text)) out.add(id)
  return out
}

/** How long Hive looks for a taken line in the agent's transcript (it is written as the CLI takes it). */
const RECEIPT_WAIT_MS = 15_000

/**
 * Its CLI took a prompt after the line was typed: received, once that prompt is found to be this line (its ids in the
 * conversation's transcript). One that isn't found stays offered: the agent's inbox fetch or ack says when it has it.
 */
async function receivedByLine(store: Store, agentId: string, ids: readonly string[]): Promise<void> {
  const sessionId = sessions.liveFor(store.host, agentId)?.sessionId
  if (!sessionId) return
  for (const end = Date.now() + RECEIPT_WAIT_MS; ; ) {
    const taken = await idsTaken(store.host, sessionId)
    let any = false
    for (const id of ids) {
      const r = byId(store, id)
      if (r?.state === 'offered' && taken.has(id)) any = set(store, r, 'received', undefined, 'line') || any
    }
    if (any) {
      saveSoon(store)
      show(store, agentId)
    }
    if (ids.every((id) => byId(store, id)?.state !== 'offered') || Date.now() >= end) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Uncertain ones (Hive stopped while offering them) whose line the agent's CLI did take: received now, not offered again. */
async function reconcile(store: Store, agentId: string): Promise<void> {
  const sessionId = sessions.liveFor(store.host, agentId)?.sessionId
  const unsure = store.records.filter((r) => r.agentId === agentId && r.state === 'uncertain' && (!r.conversation || r.conversation === sessionId))
  if (!sessionId || !unsure.length) return
  const taken = await idsTaken(store.host, sessionId)
  let any = false
  for (const id of unsure.map((r) => r.id)) {
    const r = byId(store, id)
    if (r?.state === 'uncertain' && taken.has(id)) any = set(store, r, 'received', undefined, 'line') || any
  }
  if (any) {
    saveSoon(store)
    show(store, agentId)
  }
}

/**
 * What rides a wake typed into the agent (watches.onWakeRider), first in its line: its deliveries waiting, offered now
 * (saved as such before the line's Enter); taken back to waiting if the line isn't typed after all.
 */
function riderFor(projectPath: string, agentId: string): Rider | null {
  const store = stores.get(keyOf(projectPath))
  if (!store || !sessions.liveFor(projectPath, agentId)) return null
  const items = waitingFor(store, agentId)
  if (!items.length) return null
  const text = offerLine(items, null)
  const { ids, was } = offer(store, items)
  // Saved as offered before the line's first key: the writer waits for this (and doesn't type if it fails).
  const ready = commit(store)
  ready.catch(() => undefined)
  show(store, agentId)
  return {
    text,
    ready,
    still: () => stillOffered(store, ids),
    taken: () => {
      for (const id of ids) store.offering.delete(id)
      log.info(`Deliveries ${ids.join(', ')} for ${userText(agentId)} offered with a wake`)
    },
    notTaken: () => {
      unoffer(store, ids, was)
      saveSoon(store)
      show(store, agentId)
    },
    allowed: () => allowedAll(store, ids),
    withdrawn: () => withdrawn(store, ids),
    received: () => void receivedByLine(store, agentId, ids).catch((e) => log.warn('checking a delivery was received', e))
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
  await reconcile(store, agentId)
  const items = waitingFor(store, agentId)
  if (!items.length || !canTypeLine(host, agentId)) return
  const line = offerLine(items, st.status === 'watching' && st.watch ? st.watch.label : null)
  // Saved as offered before the first key: if Hive stops before it knows the line arrived, it is uncertain, never
  // "delivered" (and never typed twice without saying so). Not saved: nothing is typed.
  let ids: string[] = []
  let was = new Map<string, DeliveryState>()
  try {
    ;({ ids, was } = await durably(store, () => offer(store, items)))
  } catch (e) {
    for (const r of items) store.offering.delete(r.id)
    show(store, agentId)
    log.warn(`Deliveries for ${userText(agentId)} not offered: ${(e as Error).message}`)
    return
  }
  show(store, agentId)
  let typed = false
  try {
    typed = await typeLine(host, agentId, line, () => stillOffered(store, ids) && allowedAll(store, ids), {
      rider: false,
      ride: { still: () => allowedAll(store, ids), withdrawn: () => withdrawn(store, ids), instead: null },
      received: () => void receivedByLine(store, agentId, ids).catch((e) => log.warn('checking a delivery was received', e))
    })
  } finally {
    if (typed) {
      for (const id of ids) store.offering.delete(id)
      log.info(`Deliveries ${ids.join(', ')} for ${userText(agentId)} offered`)
    } else {
      // Not typed: back to waiting; one refused meanwhile is ended now, not at the next try.
      unoffer(store, ids, was)
      recheck(store, agentId)
    }
    saveSoon(store)
    show(store, agentId)
  }
}

/** Tries every loaded host's agents that have deliveries waiting, and refreshes what their panes show (overdue). */
function tick(): void {
  for (const store of stores.values()) {
    // Also for agents not running: what has expired, or whose sender may no longer send it, ends now, not at their next start.
    if (recheck(store)) saveSoon(store)
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
/** For tests: forgets every host in memory, as a restart of Hive does (saves finish first); what is on disk stays. */
export async function forgetDeliveriesForTests(): Promise<void> {
  await Promise.all([...stores.values()].map((s) => s.queue))
  stores.clear()
  trying.clear()
}
/** For tests: saves still running finish. */
export const settledForTests = async (): Promise<void> => {
  await Promise.all([...stores.values()].map((s) => s.queue))
}
