import { randomBytes } from 'crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { projectAgents } from '../shared/defaults'
import { cardChange, carriedOver, changesBetween, changesSince, ENTRY_KEY, limitLine, markOf, movedIntoSince, seenOf, readMark, readSavedCondition, WAKE_MAX_BYTES, wakeAbout, wakeLines, watchLabel, alreadyThere, encodeSince, WATCH_DEFAULT_LIMIT_MINUTES, WATCH_MAX_LIMIT_MINUTES, type Baseline, type CardChange, type CardMark, type Seen, type WatchChange, type WatchCondition } from '../shared/watch'
import type { LiveSessionState, TaskCard, TaskWatchInfo } from '../shared/types'
import { onHiveEvent } from './events'
import { readCapped, renameRetrying } from './fsutil'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { getTask, inScope, unknownTask } from './tasks'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'

/**
 * Wake-on-change watches (#128): an agent registers what it waits for on the board (hive_wait_for_tasks with wake), ends
 * its turn, and Hive types one line into it when a watched card changes, or when its overall limit passes with no change.
 * Nothing runs while it waits. One watch per agent (a new one replaces it), kept in the workspace's .hive/watches.json so
 * it survives the agent being resumed and Hive restarting; it ends when its line is typed, or when the agent or the user
 * cancels it. A watch whose agent isn't running (or is busy, or the user is typing in it) is delivered when the agent is
 * idle again: nothing is typed over its work or the user's.
 *
 * - A watch keeps its caller's view of the board (`scope`: a project agent's project, null for the whole board) and every
 *   read is checked against it, so a card moved to another project reads as gone and nothing about it is told.
 * - A workspace's watches belong to that workspace's lifetime: the folder and lifetime are taken before anything waits,
 *   checked after every wait and before every write, and the watches are dropped when it closes or the window switches.
 * - Changes to a workspace's watches happen one at a time (`locked`), so a board change checked while a watch is being
 *   registered is checked again once it is in place, and a cancel can't be undone by a delivery that was under way.
 */

const log = createLogger('watches')

interface WatchRecord {
  id: string
  projectPath: string
  agentId: string
  /**
   * The project whose cards the agent may see (a project agent's own), or null for the whole board (the Assistant). Worked
   * out from the agent, never taken from the file.
   */
  scope: string | null
  cond: WatchCondition
  /** Each watched card as it was when the watch began: what a change is measured from. */
  marks: Record<string, CardMark>
  /**
   * Each watched card as last seen (the quit check: is the work it waits for going on?). Not saved: it starts again from
   * `marks` when the watches are read back (moves into a column are found in the cards' history).
   */
  current?: Record<string, CardMark>
  since: string
  /**
   * Where the watch's view of each card ends (#224): the last history entry and comment counted in `marks`. What comes
   * after counts as news, however close in time. Saved watches from before have none (then times are compared).
   */
  seen?: Record<string, Seen>
  /**
   * Started after a wake: the agent's name on the board, whose own changes between that wake and `since` aren't news
   * (the cards are measured from what the wake told).
   */
  self?: string
  limitMinutes: number
  limitAt: string
  /**
   * It fired: the line to type when the agent is idle (kept until it is typed), and the cards whose state it tells.
   * `sending`: Hive began typing it (saved before the first key): a watch read back with it was delivered, or was being
   * delivered when Hive stopped, and is never typed again (at most once).
   */
  fired?: { line: string; at: string; cards: number[]; sending?: string }
}

interface Store {
  ws: WorkspaceService
  /** The folder its watches were loaded from, and that folder's lifetime in its window (aborted when it closes). */
  path: string
  life: AbortSignal
  list: WatchRecord[]
  /** Saved entries that aren't valid watches: kept as they were in the file (never overwritten), never acted on. */
  invalid: unknown[]
  /** The file's text as Hive last read or wrote it (null: no file): put back if a save lands after the workspace closed. */
  saved: string | null
  /** A save failed: the file is behind the list, and the tick saves again. */
  dirty: boolean
  /** One change to the list at a time. */
  queue: Promise<unknown>
  /** Watches being typed now, by id: cancelled stops the typing (checked before each piece and before Enter). */
  delivering: Map<string, { cancelled: boolean }>
  /**
   * What each agent's wakes told it (#224): each card of a delivered watch as its line was made from it (for a line about
   * the limit, as the watch began: nothing new was told), the latest wake's for a card in several. The agent's next watch
   * starts from there for those cards. In memory only (a restart between a wake and the next watch starts that watch from
   * now), at most MAX_WATCHES agents and WOKE_CARDS cards each.
   */
  woke: Map<string, Map<string, Baseline>>
}

/** How long a fired watch waits before its line is typed, so changes landing together are told together (#224). */
const SETTLE_MS = 1500
/** The most cards whose last wake an agent's next watch can start from: the latest told. */
const WOKE_CARDS = 100

/**
 * Seams for unit tests: pauses that make races happen (after a watch's cards are read; after a watches file is read), and
 * the file system's rename and write, to make them fail.
 */
export const testHooks: {
  afterRead?: () => Promise<void>
  afterLoad?: () => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  write?: (path: string, text: string) => Promise<void>
  link?: (from: string, to: string) => Promise<void>
  backupRename?: (from: string, to: string) => Promise<void>
  /** The settle before a fired line is typed (SETTLE_MS): 0 types it at once. */
  settleMs?: number
} = {}
/** The same seams by their first name (round-one probes use it). */
export const testPauses = testHooks
const renameOnce = (from: string, to: string): Promise<void> => (testHooks.rename ?? rename)(from, to)
const writeText = (path: string, text: string): Promise<void> => (testHooks.write ?? ((p: string, t: string) => writeFile(p, t, 'utf8')))(path, text)

/**
 * At most this many watches a workspace (one per agent: 12 agents in each of many projects), and this big a file. Both
 * hold for what Hive writes as well as what it reads: a watch that would pass either is refused when it is made.
 */
const MAX_WATCHES = 500
const MAX_FILE_BYTES = 1024 * 1024
/** A fired line's most bytes as saved (JSON-quoted): what a watch may still grow by is known when it is made. */
const MAX_LINE_BYTES = WAKE_MAX_BYTES
const jsonBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s))
/** A line cut to fit MAX_LINE_BYTES as saved. */
function fitLine(line: string): string {
  if (jsonBytes(line) <= MAX_LINE_BYTES) return line
  let s = line
  while (s && jsonBytes(`${s}…`) > MAX_LINE_BYTES) s = s.slice(0, -1)
  return `${s}…`
}

/** The watches of each open workspace, loaded on first need (by its path, case-folded). */
const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
/** A workspace's watches file, by the folder it was loaded from (a window's service can open another workspace later). */
const fileOf = (path: string): string => join(path, '.hive', 'watches.json')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const closedError = (): Error => new Error('The workspace was closed')

/** What an agent may see of the board: its own project's cards, or every card for the Assistant. */
const scopeFor = (ws: WorkspaceService, projectPath: string): string | null => (ws.isAssistantHome(projectPath) ? null : basename(resolve(projectPath)))
/** Whether an agent's folder is a session host of this workspace (a project in it, or its Assistant). */
const hostedIn = (ws: WorkspaceService, path: string, projectPath: string): boolean =>
  ws.isAssistantHome(projectPath) || same(dirname(resolve(projectPath)), resolve(path))

/** Whether a store's workspace is still the one open in its window. */
const alive = (store: Store): boolean => !store.life.aborted && !!store.ws.path && same(store.ws.path, store.path)
const checkAlive = (store: Store): void => {
  if (!alive(store)) throw closedError()
}

/** Runs fn after the store's earlier changes (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.queue.then(() => {
    checkAlive(store)
    return fn()
  })
  store.queue = run.catch(() => undefined)
  return run
}

/** A workspace's watches (loaded once per lifetime). */
function load(ws: WorkspaceService): Promise<Store> {
  // Its folder and lifetime now, before anything waits: a window switching workspaces meanwhile can't change them.
  const path = ws.path
  const life = ws.lifetime
  if (!path || life.aborted) return Promise.reject(closedError())
  const k = path.toLowerCase()
  const had = stores.get(k)
  if (had && had.ws === ws && alive(had)) return Promise.resolve(had)
  const going = loading.get(k)
  if (going) return going
  const open = (): boolean => !life.aborted && !!ws.path && same(ws.path, path)
  const p = (async () => {
    const read = await readFileOf(path, open)
    await testHooks.afterLoad?.()
    if (!open()) throw closedError()
    // Only this workspace's agents, each with the view of the board its own token gives it. A watch that was being
    // typed when Hive stopped counts as delivered: it is never typed twice.
    const list: WatchRecord[] = []
    const invalid = read.invalid
    let delivered = false
    for (const { rec, raw } of read.list) {
      if (!hostedIn(ws, path, rec.projectPath)) invalid.push(raw)
      else if (rec.fired?.sending) {
        delivered = true
        log.info(`The wake for ${userText(rec.agentId)} was being typed when Hive stopped: it counts as delivered`)
      } else list.push({ ...rec, scope: scopeFor(ws, rec.projectPath) })
    }
    // Delivered ones leave the file at the next tick.
    const store: Store = { ws, path, life, list, invalid, saved: read.text, dirty: delivered, queue: Promise.resolve(), delivering: new Map(), woke: new Map() }
    // Read back too big for every watch to end (a hand edit, an older build): room is made, nothing is lost.
    if (budget(store, list) > MAX_FILE_BYTES) {
      const over: WatchRecord[] = []
      if (!(await setAside(store)) || budget(store, list) > MAX_FILE_BYTES) {
        while (list.length && budget(store, list, []) > MAX_FILE_BYTES) over.unshift(list.pop()!)
        if (over.length && !(await setAside(store, over))) throw new Error('The card watches file is too big, and its extra watches could not be set aside')
      }
      store.dirty = true
    }
    stores.set(k, store)
    // Closed or switched: its watches go from memory (they stay on disk for its next opening), and typing stops.
    life.addEventListener(
      'abort',
      () => {
        if (stores.get(k) === store) stores.delete(k)
        for (const d of store.delivering.values()) d.cancelled = true
      },
      { once: true }
    )
    // Agents already running learn their watch now.
    for (const r of list) sessions.watchChanged(r.projectPath, r.agentId)
    // Cards can change while Hive is closed (a pull of .hive/tasks, a hand edit): check them now, not at the next change.
    if (list.length) setTimeout(() => void evaluate(ws).catch((e) => log.warn('checking watches', e)), 0)
    return store
  })().finally(() => {
    if (loading.get(k) === p) loading.delete(k)
  })
  loading.set(k, p)
  return p
}

type FileRead = { list: { rec: WatchRecord; raw: unknown }[]; invalid: unknown[]; text: string | null }

/**
 * Reads a workspace's watches file (at most MAX_FILE_BYTES). No file is no watches; a file that can't be read (locked,
 * no permission) is an error, never "none". A file too big to be Hive's, or one that isn't JSON, is set aside (renamed,
 * not deleted) so that saving can't overwrite it; if it can't be set aside, that is an error too and nothing is written.
 * Entries that aren't valid watches, and any over the limit, are kept aside in the file as they were.
 */
async function readFileOf(path: string, open: () => boolean): Promise<FileRead> {
  const file = fileOf(path)
  let got: { data: Buffer; more: boolean }
  try {
    got = await readCapped(file, MAX_FILE_BYTES)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], invalid: [], text: null }
    throw new Error(`Could not read the card watches (${(e as Error).message})`, { cause: e })
  }
  const aside = async (why: string): Promise<FileRead> => {
    const to = `${file}.${why}-${Date.now()}`
    try {
      await renameRetrying(file, to, 20, () => {
        if (!open()) throw closedError()
      }, renameOnce)
    } catch (e) {
      throw new Error(`The card watches file is ${why} and couldn't be set aside (${(e as Error).message}): it was left as it is`, { cause: e })
    }
    log.warn(`The watches file was ${why}: set aside as ${userText(to)}`)
    return { list: [], invalid: [], text: null }
  }
  if (got.more) return aside('too-big')
  const text = got.data.toString('utf8')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return aside('damaged')
  }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as { watches?: unknown; invalid?: unknown }) : null
  if (!obj) return aside('damaged')
  const raw = Array.isArray(obj.watches) ? obj.watches : []
  const invalid: unknown[] = Array.isArray(obj.invalid) ? [...obj.invalid] : []
  const list: { rec: WatchRecord; raw: unknown }[] = []
  for (const v of raw) {
    const r = list.length < MAX_WATCHES ? readRecord(v) : null
    if (r && !list.some((x) => same(x.rec.projectPath, r.projectPath) && x.rec.agentId === r.agentId)) list.push({ rec: r, raw: v })
    else invalid.push(v)
  }
  if (invalid.length) log.warn(`${invalid.length} saved watch${invalid.length === 1 ? ' is' : 'es are'} not valid: kept aside in the file, not used`)
  return { list, invalid, text }
}

/** A saved watch, checked in full (the file can be edited by hand) and rebuilt from what checks out; null if it isn't one. */
function readRecord(v: unknown): WatchRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max
  const time = (x: unknown): x is string => text(x, 40) && Number.isFinite(Date.parse(x))
  if (!text(r.id, 64) || !text(r.projectPath, 1024) || !text(r.agentId, 128)) return null
  const cond = readSavedCondition(r.cond)
  if (!cond || !r.marks || typeof r.marks !== 'object') return null
  const marks: Record<string, CardMark> = {}
  for (const n of cond.cards) {
    const m = readMark((r.marks as Record<string, unknown>)[n])
    if (!m) return null
    marks[n] = m
  }
  const minutes = r.limitMinutes
  if (!time(r.since) || !time(r.limitAt) || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > WATCH_MAX_LIMIT_MINUTES) return null
  let fired: WatchRecord['fired']
  if (r.fired !== undefined) {
    const f = r.fired as Record<string, unknown> | null
    const cards = Array.isArray(f?.cards) ? f.cards.filter((n): n is number => cond.cards.includes(n as number)) : null
    if (!f || typeof f.line !== 'string' || jsonBytes(f.line) > MAX_LINE_BYTES || !f.line.startsWith('[Hive] ') || !time(f.at) || !cards || (f.sending !== undefined && !time(f.sending))) return null
    fired = { line: f.line, at: f.at, cards, ...(f.sending ? { sending: f.sending as string } : {}) }
  }
  // Where its view of each card ended (every card, or none from before #224), and whose own changes aren't news.
  let seen: Record<string, Seen> | undefined
  if (r.seen !== undefined) {
    if (!r.seen || typeof r.seen !== 'object') return null
    seen = {}
    const key = (x: unknown): x is string | null => x === null || (typeof x === 'string' && ENTRY_KEY.test(x))
    for (const n of cond.cards) {
      const s = (r.seen as Record<string, { h?: unknown; c?: unknown } | undefined>)[n]
      if (!s || !key(s.h) || !key(s.c)) return null
      seen[n] = { h: s.h, c: s.c }
    }
  }
  if (r.self !== undefined && (!text(r.self, 300) || !seen)) return null
  const from = { ...(seen ? { seen } : {}), ...(r.self ? { self: r.self as string } : {}) }
  // The scope is set by the workspace that loads it (from the agent's folder), whatever the file says.
  return { id: r.id, projectPath: r.projectPath, agentId: r.agentId, scope: '', cond, marks, current: { ...marks }, since: r.since, ...from, limitMinutes: minutes, limitAt: r.limitAt, ...(fired ? { fired } : {}) }
}

/** The file's text for a list of watches (the scope and the cards as last seen aren't saved: both are worked out on load). */
const fileText = (store: Store, list: WatchRecord[], invalid = store.invalid): string =>
  JSON.stringify({ version: 1, watches: list.map(({ scope: _scope, current: _current, ...r }) => r), ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n'

/** The longest a watch's saved form can grow to: fired with the longest line, being typed. */
const AT = new Date(0).toISOString()
const atMost = (r: WatchRecord): WatchRecord => ({ ...r, fired: { line: 'x'.repeat(MAX_LINE_BYTES - 2), at: AT, cards: r.cond.cards, sending: AT } })
/** The file's size with every watch at its longest: it must fit, so a watch Hive took can always fire, be typed and end. */
const budget = (store: Store, list: WatchRecord[], invalid = store.invalid): number => Buffer.byteLength(fileText(store, list.map(atMost), invalid))

/**
 * Makes room in the file: the saved entries that aren't valid watches (and, read back over the limit, the watches that
 * don't fit) move to a file of their own next to it, created new (never over another), so nothing is lost. False if
 * there was nothing to move or it couldn't be written (then nothing moved).
 */
async function setAside(store: Store, watches: WatchRecord[] = []): Promise<boolean> {
  if (!store.invalid.length && !watches.length) return false
  const to = `${fileOf(store.path)}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
  const text = JSON.stringify({ version: 1, ...(watches.length ? { watches: watches.map(({ scope: _scope, current: _current, ...r }) => r) } : {}), ...(store.invalid.length ? { invalid: store.invalid } : {}) }, null, 2) + '\n'
  try {
    checkAlive(store)
    await writeFile(to, text, { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    log.warn('setting watches aside', e)
    return false
  }
  log.warn(`To keep the card watches file small enough, ${store.invalid.length} entr${store.invalid.length === 1 ? 'y' : 'ies'} that aren't valid watches${watches.length ? ` and ${watches.length} watch${watches.length === 1 ? '' : 'es'}` : ''} moved to ${userText(to)}`)
  store.invalid = []
  return true
}

/**
 * Saves a workspace's watches (under its lock) to the folder they came from, only while that workspace is open there: a
 * temp file, then a rename checked against the workspace's lifetime before every try. A rename that was already under
 * way when it closed is undone (the file as it was is put back) and the save fails. Too big to read back: refused.
 */
async function save(store: Store): Promise<void> {
  checkAlive(store)
  const text = fileText(store, store.list)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Too many card watches to keep in this workspace')
  const file = fileOf(store.path)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeText(tmp, text)
    await renameRetrying(tmp, file, 20, () => checkAlive(store), renameOnce)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
  if (!alive(store)) {
    // Landed after the workspace closed: the change didn't happen. Undone only while the file is still this write.
    await undoLateSave(file, text, store.saved).catch((e) => log.warn('undoing a late save of the watches', e))
    throw closedError()
  }
  store.saved = text
  store.dirty = false
}
/**
 * Undoes a save that landed after its workspace closed, without losing anything written since: only if the file is still
 * exactly that save is it moved aside (renamed, not deleted), and the file as it was is put back only where nothing has
 * taken its place since (a link, which never replaces a file); otherwise the earlier text is kept next to it, under a name
 * of its own. A copy is only removed once another is confirmed: whatever fails, the earlier text is left in some file.
 */
async function undoLateSave(file: string, ours: string, previous: string | null): Promise<void> {
  if ((await readFile(file, 'utf8').catch(() => null)) !== ours) return
  const aside = `${file}.after-close-${Date.now()}-${randomBytes(3).toString('hex')}`
  await rename(file, aside)
  if ((await readFile(aside, 'utf8').catch(() => null)) !== ours) {
    // Something else was written in between: it goes back if the place is free, else it stays aside, kept.
    await link(aside, file).then(() => rm(aside), () => undefined)
    return
  }
  if (previous === null) {
    await rm(aside, { force: true })
    return
  }
  // The earlier text goes to a file of its own first (created new); only then does this save's copy go (it has the
  // earlier watches too, so it is kept if that fails), and that file only once the text is back in place.
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, previous, { encoding: 'utf8', flag: 'wx' })
  await rm(aside, { force: true })
  try {
    if (testHooks.link) await testHooks.link(tmp, file)
    else await link(tmp, file)
    await rm(tmp, { force: true }).catch(() => undefined)
    return
  } catch {
    // Taken meanwhile (or no links here): it is kept beside it instead, under a name of its own.
  }
  const backup = `${file}.before-close-${Date.now()}-${randomBytes(4).toString('hex')}`
  for (let attempt = 0; ; attempt++) {
    try {
      if (testHooks.backupRename) await testHooks.backupRename(tmp, backup)
      else await rename(tmp, backup)
      log.warn(`The card watches as they were before a late save are kept in ${userText(backup)}`)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 10 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        // Still the staging file: kept as it is, never removed while it is the only copy.
        log.warn(`The card watches as they were before a late save are kept in ${userText(tmp)}`, e)
        return
      }
      await new Promise((r) => setTimeout(r, 15 + attempt * 10))
    }
  }
}

/** A save that may fail (a background one): the tick tries again. */
const saveQuietly = (store: Store): Promise<void> =>
  save(store).catch((e) => {
    store.dirty = true
    log.warn('saving watches', e)
  })

const infoOf = (r: WatchRecord): TaskWatchInfo => ({ cards: r.cond.cards, changes: r.cond.changes, ...(r.cond.column ? { column: r.cond.column } : {}), label: watchLabel(r.cond), since: r.since, limitAt: r.limitAt })
const recordOf = (store: Store, projectPath: string, agentId: string): WatchRecord | undefined => store.list.find((x) => same(x.projectPath, projectPath) && x.agentId === agentId)
const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * The agent's name on the board, as its own changes are recorded ("Coder (alpha)", the Assistant's "Assistant"): what it
 * did itself after a wake isn't news to its next watch. Null when it can't be known (then that watch starts from now).
 */
async function boardName(ws: WorkspaceService, projectPath: string, agentId: string): Promise<string | null> {
  if (ws.isAssistantHome(projectPath)) return 'Assistant'
  const def = await ws
    .projectConfig(projectPath)
    .then((cfg) => projectAgents(cfg).find((x) => x.id === agentId))
    .catch(() => undefined)
  return def ? `${def.name} (${basename(resolve(projectPath))})` : null
}
const storeFor = (projectPath: string): Store | undefined => {
  const ws = workspaceFor(projectPath)
  const store = ws?.path ? stores.get(ws.path.toLowerCase()) : undefined
  return store && store.ws === ws && alive(store) ? store : undefined
}

/** An agent's watch as its state shows it (null: none, or its workspace's watches aren't loaded yet; they load now). */
export function watchFor(projectPath: string, agentId: string): TaskWatchInfo | null {
  const ws = workspaceFor(projectPath)
  if (!ws?.path) return null
  const store = storeFor(projectPath)
  if (!store) {
    void load(ws).catch((e) => log.warn('loading watches', e))
    return null
  }
  const r = recordOf(store, projectPath, agentId)
  return r ? infoOf(r) : null
}

/**
 * A card as the scope may see it (null: gone, archived cards included as they are, or outside the scope), read from the
 * store's own workspace: a read that a close or switch overlapped is refused.
 */
async function cardIn(store: Store, n: number, scope: string | null): Promise<TaskCard | null> {
  checkAlive(store)
  const card = await getTask(n, store.ws).catch(() => null)
  checkAlive(store)
  return card && inScope(card, scope) ? card : null
}

/** Ends a watch being typed: the typing stops before Enter. */
const stopDelivery = (store: Store, rec: WatchRecord | undefined): void => {
  const d = rec && store.delivering.get(rec.id)
  if (d) d.cancelled = true
}

export type WatchResult = { watching: TaskWatchInfo } | { already: CardChange }

/**
 * Starts (or replaces) an agent's watch. A column condition a card already meets is met at once: the agent's earlier
 * watch ends and the card's state is the answer. The agent sees the board as its token does (a project agent: its
 * project's cards; the Assistant: all), and a card outside that is unknown.
 * The board is checked again once the watch is in place, so a change while it was being set up isn't missed.
 */
export async function registerWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: WatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<WatchResult> {
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  const scope = scopeFor(ws, projectPath)
  const self = await boardName(ws, projectPath, agentId)
  const result = await locked(store, async (): Promise<WatchResult> => {
    // Moves into a column are looked for in the history from here: before the cards are read, so none falls between.
    const since = new Date().toISOString()
    // After a wake, a card that wake told about starts from what it told (#224): what others changed since counts, so a
    // change that landed between the wake and this watch (a second card's verdict a second later) fires it at once.
    const told = self ? store.woke.get(agentKey(projectPath, agentId)) : undefined
    const marks: Record<string, CardMark> = {}
    const seen: Record<string, Seen> = {}
    const now: Record<string, CardMark> = {}
    let already: CardChange | null = null
    for (const n of cond.cards) {
      const card = await cardIn(store, n, scope)
      await testHooks.afterRead?.()
      if (!card) throw unknownTask(n)
      const mark = markOf(card)
      if (alreadyThere(mark, cond)) {
        already = cardChange(n, card, ['column'])
        break
      }
      const was = told?.get(String(n))
      marks[n] = was ? carriedOver(card, was, self!) : mark
      seen[n] = was ? was.seen : seenOf(card)
      now[n] = mark
    }
    const from = { seen, ...(told && cond.cards.some((n) => told.has(String(n))) ? { self: self! } : {}) }
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    // The limit holds for what Hive writes as for what it reads: replacing an agent's watch is always allowed.
    if (!already && !old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} card watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const rec: WatchRecord | null = already ? null : { id: randomBytes(6).toString('hex'), projectPath, agentId, scope, cond, marks, current: now, since, ...from, limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), ...(rec ? [rec] : [])]
    // Every watch must be able to fire, be typed and end within the file's limit: make room, else refuse.
    if (rec && budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES))
      throw new Error('Too many card watches to keep in this workspace: wait for some to end')
    store.list = next
    if (old || rec) {
      try {
        await save(store)
      } catch (e) {
        store.list = before
        throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
      }
    }
    stopDelivery(store, old)
    if (already) return { already }
    log.info(`${userText(agentId)} watches ${cond.cards.map((c) => `#${c}`).join(', ')}`)
    return { watching: infoOf(rec!) }
  })
  sessions.watchChanged(projectPath, agentId)
  if ('watching' in result) void evaluate(ws).catch((e) => log.warn('checking watches', e))
  return result
}

/** Ends an agent's watch (the agent itself, or the user's Cancel), also one being typed. Whether it had one. */
export async function cancelWatch(ws: WorkspaceService, projectPath: string, agentId: string): Promise<boolean> {
  const store = await load(ws)
  const had = await locked(store, async () => {
    const rec = recordOf(store, projectPath, agentId)
    if (!rec) return false
    const before = store.list
    store.list = store.list.filter((x) => x !== rec)
    try {
      await save(store)
    } catch (e) {
      store.list = before
      throw new Error(`Could not cancel the watch: ${(e as Error).message}`, { cause: e })
    }
    stopDelivery(store, rec)
    return true
  })
  if (had) sessions.watchChanged(projectPath, agentId)
  return had
}

/** Agents Hive is waking now (one at a time each), and fired watches waiting out the settle before theirs is typed. */
const waking = new Set<string>()
const settling = new Set<string>()
const idle = (st: LiveSessionState | null): boolean => !!st && (st.status === 'watching' || st.status === 'ready' || st.status === 'finished')

/**
 * Types a fired watch's line into its agent, if it is idle and the user isn't typing there; otherwise later (its next
 * idle status, or the tick). The watch stays (the agent shows watching and takes no other work) until the line is in:
 * then it ends. Cancelled or replaced meanwhile, the typing stops before Enter; refused (the agent got busy, the user
 * typed), it is tried again later. A card its line tells about is checked again first: one that has left the agent's
 * view is told as gone.
 */
async function deliver(store: Store, rec: WatchRecord): Promise<void> {
  if (!rec.fired || store.delivering.has(rec.id) || !alive(store)) return
  const key = agentKey(rec.projectPath, rec.agentId)
  // Changes landing together are told together: a watch fired by a change waits a moment before its line is typed (#224).
  const due = Date.parse(rec.fired.at) + (testHooks.settleMs ?? SETTLE_MS)
  if (rec.fired.cards.length && Date.now() < due) {
    if (!settling.has(rec.id)) {
      settling.add(rec.id)
      setTimeout(() => {
        settling.delete(rec.id)
        void deliver(store, rec).catch((e) => log.warn('waking an agent', e))
      }, due - Date.now() + 10).unref?.()
    }
    return
  }
  if (waking.has(key) || !idle(sessions.liveFor(rec.projectPath, rec.agentId)) || sessions.userMayBeTyping(rec.projectPath, rec.agentId)) return
  const token = { cancelled: false }
  store.delivering.set(rec.id, token)
  waking.add(key)
  const current = (): boolean => !token.cancelled && alive(store) && store.list.includes(rec)
  try {
    let line = rec.fired.line
    // What the line tells the agent about each card, where its next watch starts from (#224): the cards as read for the
    // line; otherwise (a line about the limit, or one not made again) the watch's own starting point, so nothing that
    // the line doesn't tell is taken as known.
    let told: Record<string, Baseline> = {}
    for (const n of rec.cond.cards) {
      const s = rec.seen?.[n]
      if (s) told[n] = { mark: rec.marks[n], seen: s }
    }
    if (rec.fired.cards.length) {
      // Told as the cards are now, every change since the watch began (#224): one that landed after the line was made
      // is in it too, and a card that has left the agent's view is told as gone.
      const r = await check(store, rec)
      if (r.hits.length) {
        line = fitLine(wakeLines(r.hits))
        told = r.told
      }
    }
    // Saved as being typed before the first key: if Hive stops before the watch's end is saved, it is never typed again.
    // Not saved, nothing is typed (tried again later).
    const marked = await locked(store, async () => {
      if (!current() || !rec.fired) return false
      rec.fired.line = line
      rec.fired.sending = new Date().toISOString()
      try {
        await save(store)
      } catch (e) {
        delete rec.fired.sending
        throw e
      }
      return true
    })
    if (!marked) return
    try {
      await sessions.sendPrompt(rec.projectPath, rec.agentId, line, () => {
        if (!current()) throw new Error('The watch was cancelled.')
        if (!idle(sessions.liveFor(rec.projectPath, rec.agentId))) throw new Error('The agent got busy.')
        if (sessions.userMayBeTyping(rec.projectPath, rec.agentId)) throw new Error('The user is typing there.')
      })
    } catch (e) {
      // Not typed: ready for the next try again (a watch cancelled or replaced meanwhile is already gone).
      await locked(store, async () => {
        if (!store.list.includes(rec) || !rec.fired) return
        delete rec.fired.sending
        await saveQuietly(store)
      }).catch(() => undefined)
      throw e
    }
    log.info(`Woke ${userText(rec.agentId)}: ${userText(line.slice(0, 80))}`)
    // What earlier wakes told about cards this one didn't stays: it is still all the agent was told about them.
    const known = new Map(store.woke.get(key))
    for (const [n, b] of Object.entries(told)) {
      known.delete(n)
      known.set(n, b)
    }
    while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
    store.woke.delete(key)
    store.woke.set(key, known)
    if (store.woke.size > MAX_WATCHES) store.woke.delete(store.woke.keys().next().value!)
    // Typed: the watch has ended (unless it was replaced meanwhile, which stays). If that can't be saved, the file still
    // says it was being typed, which reads back as delivered; the tick saves again.
    await locked(store, async () => {
      if (!store.list.includes(rec)) return
      store.list = store.list.filter((x) => x !== rec)
      await saveQuietly(store)
    }).catch(() => undefined)
    sessions.watchChanged(rec.projectPath, rec.agentId)
  } catch (e) {
    log.info(`Wake for ${userText(rec.agentId)} put off: ${(e as Error).message}`)
  } finally {
    store.delivering.delete(rec.id)
    waking.delete(key)
  }
}

/** Checks one watch against the board: whether it fires now. Its cards are read as its scope sees them. */
async function check(store: Store, rec: WatchRecord): Promise<{ moved: boolean; hits: CardChange[]; told: Record<string, Baseline> }> {
  const hits: CardChange[] = []
  // Each card as read now: what a line made from these reads tells the agent.
  const told: Record<string, Baseline> = {}
  let moved = false
  for (const n of rec.cond.cards) {
    const card = await cardIn(store, n, rec.scope)
    const after = markOf(card)
    if (card) told[n] = { mark: after, seen: seenOf(card) }
    const prev = rec.current?.[n]
    if (prev?.column !== after.column || prev?.agent !== after.agent) moved = true
    ;(rec.current ??= {})[n] = after
    // Seen moved into the column as last seen (it was elsewhere, it's there now): also when its history no longer says.
    const intoAsSeen = !!rec.cond.moveInto && !!rec.cond.column && !!prev && prev.column !== rec.cond.column && after.column === rec.cond.column
    const seen = rec.seen?.[n]
    let kinds: WatchChange[] | 'gone'
    if (seen) {
      // From where the watch's view of the card ended (#224).
      kinds = changesSince(card, { mark: rec.marks[n], seen, since: rec.since, self: rec.self }, rec.cond)
      if (kinds !== 'gone' && intoAsSeen && !kinds.includes('column') && (!rec.cond.changes.length || rec.cond.changes.includes('column'))) kinds.push('column')
    } else {
      // A watch saved before #224: a move into the column by its history since the watch began.
      const into = !!rec.cond.moveInto && !!rec.cond.column && (movedIntoSince(card, rec.cond.column, rec.since) || intoAsSeen)
      kinds = changesBetween(rec.marks[n], after, rec.cond, into)
    }
    if (kinds === 'gone' || kinds.length) hits.push({ ...cardChange(n, card, kinds), about: wakeAbout(card, kinds, rec.agentId) })
  }
  return { moved, hits, told }
}

/** Checks a workspace's watches against its board: those whose cards changed (as they count) fire, then are delivered. */
async function evaluate(ws: WorkspaceService): Promise<void> {
  const store = await load(ws)
  // Whether a watched card's column or agent changed (also gone, or out of the agent's view): what a pending quit's
  // "is the work it waits for going on?" reads (watchKeepsQuitWaiting), told once the cards as last seen are updated.
  let moved = false
  await locked(store, async () => {
    let changed = false
    for (const rec of [...store.list]) {
      if (rec.fired) continue
      // One watch that can't be checked doesn't stop the others.
      try {
        const r = await check(store, rec)
        if (r.moved) moved = true
        const hits = r.hits
        if (!hits.length) continue
        rec.fired = { line: fitLine(wakeLines(hits)), at: new Date().toISOString(), cards: hits.filter((h) => h.changes !== 'gone').map((h) => h.number) }
        changed = true
      } catch (e) {
        if (!alive(store)) throw e
        log.warn(`checking the watch of ${userText(rec.agentId)}`, e)
      }
    }
    if (changed) await saveQuietly(store)
  })
  if (moved && alive(store)) watchedCardsMoved?.()
  for (const rec of store.list.filter((r) => r.fired)) await deliver(store, rec)
}

/** Told when watched cards move or change hands (after the watches have seen it): a pending quit checks again. */
let watchedCardsMoved: (() => void) | null = null
export function onWatchedCardsMoved(fn: () => void): void {
  watchedCardsMoved = fn
}

/** The tick: limits passed with no change fire; fired watches are tried again (an agent idle, the user done typing). */
export async function tick(now = Date.now()): Promise<void> {
  for (const store of [...stores.values()]) {
    if (!alive(store)) continue
    await locked(store, async () => {
      let changed = store.dirty
      for (const rec of store.list) {
        if (!rec.fired && Date.parse(rec.limitAt) <= now) {
          rec.fired = { line: fitLine(limitLine(rec.cond, rec.limitMinutes)), at: new Date(now).toISOString(), cards: [] }
          changed = true
        }
      }
      if (changed) await saveQuietly(store)
    }).catch((e) => log.warn('watch limits', e))
    for (const rec of store.list.filter((r) => r.fired)) await deliver(store, rec)
  }
}

/**
 * Whether a watching agent keeps "Quit when agents finish" waiting: it does while a card it watches is in Doing or Review
 * with another agent (the work it waits for is going on). The label says what for.
 */
export function watchKeepsQuitWaiting(st: LiveSessionState): string | null {
  if (st.status !== 'watching' || !st.watch) return null
  const store = storeFor(st.projectPath)
  const rec = store && recordOf(store, st.projectPath, st.agentId)
  if (!rec) return null
  const busyCard = rec.cond.cards.some((n) => {
    const m = rec.current?.[n] ?? rec.marks[n]
    return m && (m.column === 'doing' || m.column === 'review') && m.agent && m.agent !== st.agentId
  })
  return busyCard ? st.watch.label : null
}

let started = false
/** Wires watches into the sessions and the board's events (once, at start). */
export function initWatches(): void {
  if (started) return
  started = true
  sessions.watchFor = watchFor
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && same(w.path, e.workspacePath))
      if (ws) void evaluate(ws).catch((err) => log.warn('checking watches', err))
    } else if (e.type === 'session-status' && idle(e.state)) {
      const store = storeFor(e.state.projectPath)
      const rec = store?.list.find((x) => x.fired && same(x.projectPath, e.state.projectPath) && x.agentId === e.state.agentId)
      if (store && rec) setTimeout(() => void deliver(store, rec).catch((err) => log.warn('waking an agent', err)), 500)
    }
  })
  const timer = setInterval(() => void tick().catch((e) => log.warn('watch tick', e)), 5000)
  timer.unref?.()
}

/** Forgets a workspace's watches in memory, as closing it does (they stay on disk for its next opening): for tests. */
export function forgetWatches(ws: WorkspaceService): void {
  if (ws.path && stores.get(ws.path.toLowerCase())?.ws === ws) stores.delete(ws.path.toLowerCase())
}

/**
 * The marks of cards now as `scope` sees them (a card outside it reads as gone), for a bounded wait, from the folder that
 * was open when the wait began: `life` aborted (the workspace closed or switched) refuses.
 */
export async function scopedCard(ws: WorkspaceService, path: string, life: AbortSignal, n: number, scope: string | null): Promise<TaskCard | null> {
  const ok = (): void => {
    if (life.aborted || !ws.path || !same(ws.path, path)) throw closedError()
  }
  ok()
  const card = await getTask(n, ws).catch(() => null)
  ok()
  return card && inScope(card, scope) ? card : null
}

export { encodeSince }

/** Checks a workspace's watches against its board now (what a board change does): for tests. */
export const evaluateWatches = (ws: WorkspaceService): Promise<void> => evaluate(ws)
