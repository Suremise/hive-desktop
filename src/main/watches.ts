import { randomBytes } from 'crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { projectAgents } from '../shared/defaults'
import { cardChange, carriedOver, changesBetween, changesSince, entryWithin, ENTRY_KEY, limitLine, markOf, movedIntoSince, seenOf, readMark, readSavedCondition, WAKE_MAX_BYTES, wakeAbout, watchLabel, cardWakeLine, userNameOf, releasedLine, withLanesTail, type Released, type ReplyNote, alreadyThere, encodeSince, WATCH_DEFAULT_LIMIT_MINUTES, WATCH_MAX_CARDS, WATCH_MAX_LIMIT_MINUTES, type Baseline, type CardChange, type CardMark, type Seen, type WatchChange, type WatchCondition } from '../shared/watch'
import { agentBusy, agentEvent, agentLimitLine, agentMarkOf, agentPart, agentWakeLine, agentWatchLabel, readSavedAgentCondition, readSavedAgentMark, replyFirstLine, type AgentEvent, type AgentMark, type AgentNow, type AgentWatchCondition, type WatchedAgent } from '../shared/agentWatch'
import { isProjectId, type ProjectIdIndex } from '../shared/projectIds'
import { rebase } from '../shared/movePaths'
import { keepBeforeIds } from './beforeIds'
import type { LiveSessionState, TaskCard, TaskColumn, TaskWatchInfo } from '../shared/types'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { config } from './config'
import { onHiveEvent } from './events'
import { readCapped, renameRetrying } from './fsutil'
import { createLogger, userText } from './logger'
import { listLanes } from './lanes'
import { laneCardMark, laneHits, laneLimitLine, laneWakeLine, laneWatchLabel, mergeDue, newLaneBase, readSavedLaneCondition, readSavedLaneMark, verdictsOf, type LaneHit, type LaneMark, type LaneNow, type LaneWatchCondition } from '../shared/laneWatch'
import { cardStallIn } from './cardStall'
import { noteLoopWatch } from './loopCheck'
import { sessions } from './sessions'
import { allTasks, getTask, inScope, noteOnCard, unknownTask } from './tasks'
import { openWorkspaces, workspaceFor, type WorkspaceService } from './workspace'
import { devConsole, hiveSourceId, sessionSourceId } from './devConsole'
import { isUnread, type DeliveryRecord } from '../shared/deliveries'
import { cancelFromSource, createDelivery, deliveryNow, followAgent, inFlightNow as deliveriesInFlight, load as loadDeliveries, offerNow, registerSource, settled as deliveriesSettled } from './deliveries'
import { inFlightNow as writerInFlight, onLineComing, settled as writerSettled } from './lineWriter'
import { readyFor } from './readiness'

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
 * - An agent watch (#416, hive_wait_for_agents with wake) is a watch that follows agents instead of cards: it fires when
 *   a watched agent's turn ends, it waits for the user, or it stops, checked on every status change. It is the agent's
 *   one watch like any other (a card watch replaces it, and it replaces one), kept, typed and ended the same way.
 */

const log = createLogger('watches')
/** The user, as the Assistant's wake lines name them (#426): Settings → General → Your name. */
const userName = (): string => userNameOf(config.settings.general?.userName)

interface WatchRecord {
  id: string
  projectPath: string
  /**
   * The watcher's project's stable id (#508): read back, the watch follows its project to the folder that has the id now
   * (renamed or moved within the workspace). None for the Assistant, and in watches from before.
   */
  projectId?: string
  agentId: string
  /**
   * The project whose cards the agent may see (a project agent's own), or null for the whole board (the Assistant). Worked
   * out from the agent, never taken from the file.
   */
  scope: string | null
  /** The cards and what counts (an agent watch has no cards: `agents` says what it waits for). */
  cond: WatchCondition
  /** An agent watch (#416): the agents it follows, and each as it was when the watch began (by agentKey). */
  agents?: AgentWatchCondition
  agentMarks?: Record<string, AgentMark>
  /**
   * A lane watch (#531): the lanes it follows (ids, or every running lane in the watcher's view) and what counts, and each
   * lane as last measured (by id): as the watch began, moved on while nothing that counts happens, and what its line
   * told once it fires. No cards: a lane's cards are followed as the lane goes on.
   */
  lanes?: LaneWatchCondition
  laneMarks?: Record<string, LaneMark>
  /**
   * Where a lane watch's view of what is new begins (#531 round 2 finding): a lane started, or a card added to a lane,
   * after it is measured from an empty start. The watch's own start, or for one started after a wake, when that wake's
   * line was made, so what happened between the wake and this watch is told.
   */
  laneSince?: string
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
  /**
   * The Assistant's card watch (#418): the latest of the user's replies to agents (see replies) it already knows; one
   * after it to a watched card's agent or reviewer is news. Absent: from before #418 (then from when it was read).
   */
  replySeq?: number
  /**
   * A project agent's part in each watched card as the watch began (#420): its agent, its reviewer, or a reviewer
   * waiting for it to arrive in Review ("awaiting"). A card it has no part in
   * (another agent's card it depends on) isn't here, and is never released. The watcher's board name, for the history.
   */
  on?: Record<string, OnCard>
  watcherName?: string
  /** Cards that left the watch since it began, released (#420): told with its next line. */
  released?: Released[]
  limitMinutes: number
  limitAt: string
  /**
   * It fired: the line for the agent (made again when it is handed over), and the cards whose state it tells.
   * `delivery`: the delivery it was handed over as (#649, deliveries.ts), saved before the delivery service types it: the
   * watch ends once that is received (its line taken by its CLI, or fetched), and a watch read back with one follows it.
   * `sending`: from before #649 (Hive began typing it): read back, it counts as delivered. `agents`: an agent watch's
   * agents it tells about (by agentKey; none for its limit).
   */
  fired?: { line: string; at: string; cards: number[]; agents?: string[]; lanes?: true; replies?: true; delivery?: string; sending?: string }
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
  /**
   * What each agent's wakes told it about the agents it watched (#416): each one's latest event told (`seq`, see
   * happenings), by agentKey. Its next agent watch starts from there, so an event between the two is news. In memory,
   * bounded as `woke`.
   */
  wokeAgents: Map<string, Map<string, number>>
  /**
   * What each agent's lane watch wakes told it (#531): when the line was made, and each lane's mark, by id. Its next lane
   * watch starts there. In memory, bounded as `woke`.
   */
  wokeLanes: Map<string, { at: string; marks: Map<string, LaneMark> }>
  /** A lane check is due (debounced: status changes come in bursts). */
  laneCheck?: true
  /** When the tick last checked lane watches (stalls come with time). */
  laneTickAt?: number
  /** The latest of the user's replies (#418) each watcher's wakes told it about: its next card watch starts there. */
  wokeReplies: Map<string, number>
}

/** How long a fired watch waits before its line is typed, so changes landing together are told together (#224). */
const SETTLE_MS = 1500
/** The most cards whose last wake an agent's next watch can start from: the latest told. */
const WOKE_CARDS = 100

/**
 * What watches are doing in the background (#570): the checks the board's events start, deliveries and the settle
 * before each, lane checks, the confirmations that a typed wake was taken, notes on cards. `settled()` resolves once none
 * is left, what one starts meanwhile included, so a test (and Hive's loop wakes, #578) waits for the outcome rather than
 * for a quiet spell or a read straight after a call. A wake typed again after its line was cleared (#530) counts while
 * it is being typed (and then confirmed), not while it waits for its agent to be ready: that is the agent's, not Hive's.
 */
const inFlight = new Set<Promise<unknown>>()
/** Counts work as in flight until it ends, and returns it (its result or failure as it was). */
function counted<T>(work: Promise<T>): Promise<T> {
  const p = work.then(
    () => undefined,
    () => undefined
  )
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
  return work
}
/** Runs work in the background, counted until it ends; a failure is logged as `what`. */
function inBackground(what: string, work: Promise<unknown>): void {
  void counted(work.catch((e) => log.warn(what, e)))
}
/** Runs work after `ms`, counted from now until it ends. */
function inBackgroundAfter(ms: number, what: string, work: () => Promise<unknown>): void {
  inBackground(what, new Promise<void>((done, fail) => setTimeout(() => work().then(() => done(), fail), ms).unref?.()))
}
/** Resolves once watches have nothing in flight (#570): what was started in the background has ended, its lines' confirmations too. */
export async function settled(): Promise<void> {
  while (inFlight.size || writerInFlight() || deliveriesInFlight()) {
    await Promise.allSettled([...inFlight])
    await writerSettled()
    await deliveriesSettled()
  }
}
/** Whether watches have something in flight now (loop wakes' settled() waits for both), their wakes' lines included. */
export const inFlightNow = (): boolean => inFlight.size > 0 || writerInFlight() || deliveriesInFlight()

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
  /** Told each time a check reads a card from disk (#321: each card once a check). */
  cardRead?: (n: number) => void
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

/** A watcher's part in a card (#420). */
interface OnCard {
  role: 'agent' | 'reviewer' | 'awaiting'
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

/**
 * Whether an agent may watch an agent of `target` (#416): a project of this workspace (never the Assistant). Agents'
 * status is open to every caller; what another project's agent said isn't (shownTo).
 */
const mayWatch = (ws: WorkspaceService, path: string, _projectPath: string, target: string): boolean => !ws.isAssistantHome(target) && same(dirname(resolve(target)), resolve(path))

/**
 * A watched agent as its watcher may be told it: a project agent (`scope`, its project) isn't told the reply of another
 * project's agent, whose conversation holds that project's cards (as its activity is closed to it).
 */
const shownTo = (scope: string | null, agent: WatchedAgent, now: AgentNow): AgentNow => (scope === null || same(scope, basename(resolve(agent.projectPath))) ? now : { ...now, reply: null })

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
    // Only this workspace's agents, each with the view of the board its own token gives it. A watch handed over as a
    // delivery follows it (below); one from before #649 that was being typed when Hive stopped counts as delivered.
    const list: WatchRecord[] = []
    const invalid = read.invalid
    let delivered = false
    // Each watch in its project's folder now, by the project's id (#508), its agents' too; one from before gets the ids.
    const ids = await ws.projectIds()
    if (!open()) throw closedError()
    let stamped = false
    const gone = new Set<WatchRecord>()
    const from = oldFolder(ws, path, ids, read.list.map((x) => x.rec))
    for (const { rec } of read.list) {
      const r = followIds(ws, path, ids, rec, from)
      if (r === 'gone') gone.add(rec)
      else if (r === 'changed') stamped = true
    }
    // watches.json keeps what it was before the ids beside it, once.
    if (stamped || gone.size) await keepBeforeIds(fileOf(path))
    for (const { rec, raw } of read.list) {
      if (gone.has(rec)) invalid.push(raw)
      else if (!hostedIn(ws, path, rec.projectPath) || (rec.agents && !rec.agents.agents.every((a) => mayWatch(ws, path, rec.projectPath, a.projectPath)))) invalid.push(raw)
      else if (rec.fired?.sending) {
        delivered = true
        log.info(`The wake for ${userText(rec.agentId)} was being typed when Hive stopped: it counts as delivered`)
      } else if (list.some((x) => same(x.projectPath, rec.projectPath) && x.agentId === rec.agentId)) invalid.push(raw)
      else list.push({ ...rec, scope: scopeFor(ws, rec.projectPath) })
    }
    // Delivered ones leave the file at the next tick.
    const store: Store = { ws, path, life, list, invalid, saved: read.text, dirty: delivered || stamped || gone.size > 0, queue: Promise.resolve(), delivering: new Map(), woke: new Map(), wokeAgents: new Map(), wokeLanes: new Map(), wokeReplies: new Map() }
    // Read back too big for every watch to end (a hand edit, an older build): room is made, nothing is lost.
    if (budget(store, list) > MAX_FILE_BYTES) {
      const over: WatchRecord[] = []
      if (!(await setAside(store)) || budget(store, list) > MAX_FILE_BYTES) {
        // Each watch measured once, the last ones taken off until the rest fit (#321: not the whole file again a pop).
        const empty = Buffer.byteLength(fileText(store, [], []))
        const sizes = list.map((r) => entryBytes(atMost(r)))
        let sum = sizes.reduce((a, b) => a + b, 0)
        while (list.length && sizeOf(empty, sizes, sum) > MAX_FILE_BYTES) {
          over.unshift(list.pop()!)
          sum -= sizes.pop()!
        }
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
    // Those handed over as deliveries follow what became of them while Hive was closed (#649).
    if (list.some((r) => r.fired?.delivery)) inBackground('following wakes', followDelivered(store))
    // Cards can change while Hive is closed (a pull of .hive/tasks, a hand edit): check them now, not at the next change.
    if (list.length) inBackgroundAfter(0, 'checking watches', () => evaluate(ws))
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
  // An agent watch (#416): its agents and their marks, and no cards.
  let agents: AgentWatchCondition | undefined
  let agentMarks: Record<string, AgentMark> | undefined
  if (r.agents !== undefined) {
    const a = readSavedAgentCondition(r.agents)
    if (!a || !r.agentMarks || typeof r.agentMarks !== 'object') return null
    agentMarks = {}
    for (const t of a.agents) {
      const k = agentKey(t.projectPath, t.agentId)
      const m = readSavedAgentMark((r.agentMarks as Record<string, unknown>)[k])
      if (!m) return null
      agentMarks[k] = m
    }
    agents = a
  }
  // A lane watch (#531): its lanes and their marks, and no cards.
  let lanes: LaneWatchCondition | undefined
  let laneMarks: Record<string, LaneMark> | undefined
  if (r.lanes !== undefined) {
    const c = readSavedLaneCondition(r.lanes)
    if (!c || agents || !r.laneMarks || typeof r.laneMarks !== 'object' || Array.isArray(r.laneMarks)) return null
    const entries = Object.entries(r.laneMarks as Record<string, unknown>)
    if (entries.length > 200) return null
    laneMarks = {}
    for (const [id, m] of entries) {
      const mark = /^[\w-]{1,64}$/.test(id) ? readSavedLaneMark(m) : null
      if (!mark) return null
      laneMarks[id] = mark
    }
    lanes = c
    if (r.laneSince !== undefined && !time(r.laneSince)) return null
  }
  const cond = agents || lanes ? NO_CARDS : readSavedCondition(r.cond)
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
    if (!f || typeof f.line !== 'string' || jsonBytes(f.line) > MAX_LINE_BYTES || !f.line.startsWith('[Hive] ') || !time(f.at) || !cards || (f.sending !== undefined && !time(f.sending)) || (f.delivery !== undefined && !(typeof f.delivery === 'string' && /^m\d{1,15}$/.test(f.delivery)))) return null
    const told = Array.isArray(f.agents) && agentMarks ? f.agents.filter((k): k is string => typeof k === 'string' && k in agentMarks!) : undefined
    fired = { line: f.line, at: f.at, cards, ...(told?.length ? { agents: told } : {}), ...(f.lanes === true && lanes ? { lanes: true as const } : {}), ...(f.replies === true ? { replies: true as const } : {}), ...(f.delivery ? { delivery: f.delivery as string } : {}), ...(f.sending ? { sending: f.sending as string } : {}) }
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
  if (r.replySeq !== undefined && (typeof r.replySeq !== 'number' || !Number.isInteger(r.replySeq) || r.replySeq < 0)) return null
  // A watcher's part in its cards, and the cards released since (#420).
  let on: Record<string, OnCard> | undefined
  if (r.on !== undefined) {
    if (!r.on || typeof r.on !== 'object' || Array.isArray(r.on)) return null
    on = {}
    // A watch saved before #481 also kept whether the card was blocked: no longer used.
    for (const [k, part] of Object.entries(r.on as Record<string, { role?: unknown }>)) {
      if (!cond.cards.includes(Number(k)) || !part || !['agent', 'reviewer', 'awaiting'].includes(part.role as string)) return null
      on[k] = { role: part.role as OnCard['role'] }
    }
  }
  if (r.watcherName !== undefined && !text(r.watcherName, 300)) return null
  let released: Released[] | undefined
  if (r.released !== undefined) {
    if (!Array.isArray(r.released) || r.released.length > WATCH_MAX_CARDS) return null
    released = []
    for (const x of r.released as { number?: unknown; why?: unknown; detail?: unknown }[]) {
      if (!x || !Number.isInteger(x.number) || (x.number as number) <= 0 || !['reassigned', 'reviewer', 'blocked'].includes(x.why as string) || !(x.detail === null || text(x.detail, 300))) return null
      released.push({ number: x.number as number, why: x.why as Released['why'], detail: x.detail as string | null })
    }
  }
  const from = { ...(seen ? { seen } : {}), ...(r.self ? { self: r.self as string } : {}) }
  // The scope is set by the workspace that loads it (from the agent's folder), whatever the file says.
  return { id: r.id, projectPath: r.projectPath, ...(isProjectId(r.projectId) ? { projectId: r.projectId } : {}), agentId: r.agentId, scope: '', cond, ...(agents ? { agents, agentMarks } : {}), ...(lanes ? { lanes, laneMarks, ...(r.laneSince ? { laneSince: r.laneSince as string } : {}) } : {}), marks, current: { ...marks }, since: r.since, ...from, limitMinutes: minutes, limitAt: r.limitAt, ...(typeof r.replySeq === 'number' ? { replySeq: r.replySeq } : {}), ...(on ? { on } : {}), ...(r.watcherName ? { watcherName: r.watcherName as string } : {}), ...(released ? { released } : {}), ...(fired ? { fired } : {}) }
}

/** An agent watch's condition on cards: none. */
const NO_CARDS: WatchCondition = { cards: [], changes: [] }

/** A watch as the file keeps it (the scope and the cards as last seen are worked out on load). */
const entryOf = ({ scope: _scope, current: _current, ...r }: WatchRecord): object => r

/** The file's text for a list of watches (the scope and the cards as last seen aren't saved: both are worked out on load). */
const fileText = (store: Store, list: WatchRecord[], invalid = store.invalid): string =>
  JSON.stringify({ version: 1, watches: list.map(({ scope: _scope, current: _current, ...r }) => r), ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n'

/** The longest a watch's saved form can grow to: fired with the longest line, being typed. */
const AT = new Date(0).toISOString()
const atMost = (r: WatchRecord): WatchRecord => ({ ...r, fired: { line: 'x'.repeat(MAX_LINE_BYTES - 2), at: AT, cards: r.cond.cards, ...(r.agentMarks ? { agents: Object.keys(r.agentMarks) } : {}), delivery: 'm999999999999999', sending: AT } })
/**
 * The bytes one watch takes in the file (#321): its own JSON as fileText writes it, an entry of the "watches" array, so
 * each of its lines indented by four more spaces.
 */
function entryBytes(r: WatchRecord): number {
  const { scope: _scope, current: _current, ...saved } = r
  return savedEntryBytes(saved)
}
const savedEntryBytes = (saved: object): number => {
  const s = JSON.stringify(saved, null, 2)
  let lines = 1
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) lines++
  return Buffer.byteLength(s) + 4 * lines
}
/** The watches file's size for these saved entries, measured as budget() does (#321): for tests, against its text. */
export const savedFileBytes = (watches: object[], invalid: unknown[] = []): number =>
  sizeOf(Buffer.byteLength(JSON.stringify({ version: 1, watches: [], ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n'), watches.map(savedEntryBytes))

/**
 * The file's size with these entries (#321), without making its text: the file with no watches, then the entries, each
 * after a ",\n" but the first, the "[]" made "[\n" … "\n  ]". Exactly what fileText's length would be.
 */
const sizeOf = (empty: number, entries: number[], sum = entries.reduce((a, b) => a + b, 0)): number => (entries.length ? empty + sum + 2 * (entries.length - 1) + 4 : empty)

/**
 * The file's size with every watch at its longest: it must fit, so a watch Hive took can always fire, be typed and end.
 * Measured watch by watch (#321): making the whole file's text for it took seconds at 400 watches, once a pop.
 */
const budget = (store: Store, list: WatchRecord[], invalid = store.invalid): number => sizeOf(Buffer.byteLength(fileText(store, [], invalid)), list.map((r) => entryBytes(atMost(r))))

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

const infoOf = (r: WatchRecord): TaskWatchInfo =>
  r.agents
    ? { cards: [], changes: [], agents: r.agents.agents.map((a) => a.name), label: agentWatchLabel(r.agents), since: r.since, limitAt: r.limitAt }
    : r.lanes
      ? { cards: [], changes: [], lanes: r.lanes.ids === 'all' ? ['all'] : [...r.lanes.ids], label: laneWatchLabel(r.lanes), since: r.since, limitAt: r.limitAt }
      : { cards: r.cond.cards, changes: r.cond.changes, ...(r.cond.column ? { column: r.cond.column } : {}), label: watchLabel(r.cond), since: r.since, limitAt: r.limitAt }
/** A watcher's project's id (#508), as the workspace last read the ids (it reads them when it opens). */
const projectIdOf = (ws: WorkspaceService, projectPath: string): { projectId?: string } => {
  const id = ws.isAssistantHome(projectPath) ? undefined : ws.projectIdsNow().byPath.get(resolve(projectPath).toLowerCase())
  return id ? { projectId: id } : {}
}
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
    inBackground('loading watches', load(ws))
    return null
  }
  const r = recordOf(store, projectPath, agentId)
  return r ? infoOf(r) : null
}

/**
 * A card as the scope may see it (null: gone, archived cards included as they are, or outside the scope), read from the
 * store's own workspace: a read that a close or switch overlapped is refused.
 */
async function cardIn(store: Store, n: number, scope: string | null, cards?: CardReads): Promise<TaskCard | null> {
  checkAlive(store)
  let read = cards?.get(n)
  if (!read) {
    testHooks.cardRead?.(n)
    read = getTask(n, store.ws).catch(() => null)
    cards?.set(n, read)
  }
  const card = await read
  checkAlive(store)
  return card && inScope(card, scope) ? card : null
}

/**
 * The cards one check of the watches has read (#321): each card once, whatever the number of watches on it (a builder,
 * its reviewer and the Assistant on the same card; 400 watches of 20 cards each read 8,000 files a check before).
 */
type CardReads = Map<number, Promise<TaskCard | null>>

/**
 * Ends a watch's wake (the watch was cancelled or replaced): the line being made isn't handed over, and the delivery it
 * was handed over as is cancelled (its typing stops before Enter; a line its CLI hasn't taken is cleared, #647).
 */
const stopDelivery = (store: Store, rec: WatchRecord | undefined, why = 'its watch was replaced'): void => {
  const d = rec && store.delivering.get(rec.id)
  if (d) d.cancelled = true
  if (rec?.fired?.delivery) inBackground('cancelling a wake', cancelFromSource(rec.projectPath, 'watch', wakeRef(rec), `cancelled: ${why}`))
}

export type WatchResult = { watching: TaskWatchInfo } | { already: CardChange }

/**
 * Starts (or replaces) an agent's watch. A column condition a card already meets is met at once (a move into it too,
 * #434, unless it asks for a `fresh` one): the agent's earlier watch ends and the card's state is the answer. The agent sees the board as its token does (a project agent: its
 * project's cards; the Assistant: all), and a card outside that is unknown.
 * The board is checked again once the watch is in place, so a change while it was being set up isn't missed.
 */
export async function registerWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: WatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<WatchResult> {
  const store = await load(ws)
  // A wake whose line its CLI has taken is received first, so this watch starts from what it told (#649).
  await followAgent(projectPath, agentId)
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
    // A project agent's part in each card (#420): what ends its watch on one when the card is reassigned. A
    // blocked card stays (#481): it is paused, not gone, and the watch carries on until it moves again.
    const on: Record<string, OnCard> = {}
    let already: CardChange | null = null
    for (const n of cond.cards) {
      const card = await cardIn(store, n, scope)
      await testHooks.afterRead?.()
      if (!card) throw unknownTask(n)
      const role = scope === null ? null : card.agent === agentId ? 'agent' : card.review?.agent === agentId ? 'reviewer' : cond.column === 'review' ? 'awaiting' : null
      if (role) on[n] = { role }
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
    // The Assistant's: the user's replies to its cards' agents from what its last wake told (#418).
    const replySeq = scope === null ? (store.wokeReplies.get(agentKey(projectPath, agentId)) ?? latestReplySeq()) : undefined
    const rec: WatchRecord | null = already ? null : { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond, marks, current: now, since, ...from, ...(replySeq !== undefined ? { replySeq } : {}), ...(Object.keys(on).length ? { on, ...(self ? { watcherName: self } : {}) } : {}), limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
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
  // It waits on cards: an agent in a card loop, checked when its turn ends with no watch (#376).
  noteLoopWatch(projectPath, agentId, cond.cards)
  if ('watching' in result) inBackground('checking watches', evaluate(ws))
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
    stopDelivery(store, rec, 'its watch was cancelled')
    return true
  })
  if (had) sessions.watchChanged(projectPath, agentId)
  return had
}

/**
 * What agents did lately (#416), by agentKey: each change to a status that isn't working (its turn ended, it waits for
 * the user, it stopped), with the agent as it was then, numbered in order (`seq`: from the clock, so a number saved in a
 * watch still compares after a restart). The last few for each agent, whether or not anyone watches it yet: a wake's
 * next watch counts what happened in between. In memory: what happened while Hive was closed is read from the agents
 * as they are (agentHits).
 */
interface Happening {
  seq: number
  now: AgentNow
}
const happenings = new Map<string, Happening[]>()
const lastStatus = new Map<string, string>()
let lastSeq = 0
const HAPPENINGS_KEPT = 8
const AGENTS_KEPT = 2000
const latestSeq = (key: string): number => happenings.get(key)?.at(-1)?.seq ?? 0
/** The latest of an agent's events after `from` that a watch counts (one into background only with ignoreBackground). */
const happenedSince = (key: string, from: number, ignoreBackground: boolean): Happening | undefined =>
  happenings.get(key)?.findLast((h) => h.seq > from && !agentBusy(h.now, ignoreBackground))

/** Statuses during a turn: idle after one of these is the turn's end. */
/**
 * Each agent's turn (#416): its launch, and whether a turn is under way in it, one that has been seen working (or on
 * its background tasks) since its last turn ended. Only such a turn's end is a finished turn: a launch becoming ready,
 * also after a startup question (folder trust) or a refused sign-in, ran none.
 */
const turns = new Map<string, { runId: string; inTurn: boolean }>()

/**
 * Records an agent's status change (every session-status). An event is waiting for the user, a stop or an error, or
 * idle at the end of a turn under way (finished, interrupted, or into background tasks).
 */
export function noteAgentStatus(st: LiveSessionState): void {
  const key = agentKey(st.projectPath, st.agentId)
  const was = turns.get(key)
  const turn = { runId: st.runId || '', inTurn: !!was && was.runId === (st.runId || '') && was.inTurn }
  if (st.status === 'working' || st.status === 'background') turn.inTurn = true
  // Starting, stopped or refused a sign-in: no turn under way (one carried on after signing in works again first).
  if (st.status === 'starting' || st.status === 'stopped' || st.status === 'signin') turn.inTurn = false
  const ended = (st.status === 'ready' || st.status === 'finished' || st.status === 'watching') && turn.inTurn
  if (ended) turn.inTurn = false
  turns.delete(key)
  turns.set(key, turn)
  if (turns.size > AGENTS_KEPT) turns.delete(turns.keys().next().value!)
  const prev = lastStatus.get(key)
  if (prev === st.status) return
  lastStatus.delete(key)
  lastStatus.set(key, st.status)
  if (lastStatus.size > AGENTS_KEPT) lastStatus.delete(lastStatus.keys().next().value!)
  if (st.status === 'working' || st.status === 'starting') return
  const needsUser = st.status === 'waiting' || st.status === 'signin' || st.status === 'stopped' || st.status === 'error'
  if (!needsUser && !ended && !(st.status === 'background' && turn.inTurn)) return
  const reply = st.status === 'stopped' ? null : (sessions.agentNow(st.projectPath, st.agentId)?.reply ?? null)
  const now: AgentNow = { status: st.status, runId: st.runId || null, prompts: 0, pending: false, statusMessage: st.statusMessage ?? null, backgroundTasks: st.backgroundTasks ?? 0, reply, watch: st.status === 'watching' ? (st.watch?.label ?? null) : null }
  lastSeq = Math.max(lastSeq + 1, Date.now())
  const list = happenings.get(key) ?? []
  happenings.delete(key)
  happenings.set(key, [...list, { seq: lastSeq, now }].slice(-HAPPENINGS_KEPT))
  if (happenings.size > AGENTS_KEPT) happenings.delete(happenings.keys().next().value!)
}

/**
 * Prompts the user sent agents from their panes (#418: sessions.userReplied), the latest few, numbered on the events'
 * clock: told only to the Assistant's watches, on that agent (an agent watch) or on a card it has or reviews (a card
 * watch). Kept only with Settings → Assistant → Tell the Assistant when I reply to an agent on; the first line only.
 */
interface Reply {
  seq: number
  projectPath: string
  agentId: string
  agentName: string
  text: string
}
const replies: Reply[] = []
const REPLIES_KEPT = 200
const latestReplySeq = (): number => replies.at(-1)?.seq ?? 0

/** Records a reply of the user's to an agent, and has the watches of its workspace check it now. */
export function noteUserReply(projectPath: string, agentId: string, agentName: string, text: string): void {
  if (config.settings.assistant?.tellReplies === false) return
  const first = replyFirstLine(text)
  if (!first) return
  lastSeq = Math.max(lastSeq + 1, Date.now())
  replies.push({ seq: lastSeq, projectPath, agentId, agentName, text: first })
  if (replies.length > REPLIES_KEPT) replies.shift()
  const store = storeFor(projectPath)
  if (!store) return
  inBackground('checking agent watches', evaluateAgents(store))
  inBackground('checking watches', evaluate(store.ws))
}
/** The latest reply of the user's to an agent after `from`, for the Assistant's watch (null scope) only. */
const tellReplies = (): boolean => config.settings.assistant?.tellReplies !== false
/**
 * Raised (at once, before anything waits) each time replies stop being told: a wake made with a reply under an earlier
 * value is never typed, even if the setting is on again by then (#418).
 */
let replyGeneration = 0
/** Replies stop being told: the kept ones go, and every wake made with one is void. */
const dropReplies = (): void => {
  replies.length = 0
  replyGeneration++
}
const replyTo = (scope: string | null, projectPath: string, agentId: string, from: number): Reply | undefined => {
  if (scope !== null) return undefined
  // Turned off: what was kept goes, and nothing is told (also what a wake waiting to be typed would have said).
  if (!tellReplies()) {
    if (replies.length) dropReplies()
    return undefined
  }
  return replies.findLast((r) => r.seq > from && r.agentId === agentId && same(resolve(r.projectPath), resolve(projectPath)))
}

/**
 * Settings → Assistant → Tell the Assistant when I reply to an agent turned off (#418): the replies kept go, and a wake
 * waiting to be typed that tells one is made again without it (or, with nothing else to tell, isn't typed: the watch
 * waits on). Turned on again, none comes back.
 */
export async function revokeReplies(): Promise<void> {
  dropReplies()
  // A wake handed over as a delivery that tells one is cancelled now (its typing stops; a line its CLI hasn't taken is
  // cleared): its watch fires again, made without the reply (#649).
  for (const [id, h] of handed) if (h.told.replies) inBackground('withdrawing a reply', cancelFromSource(h.rec.projectPath, 'watch', wakeRef(h.rec), "cancelled: the user's replies are no longer told").then(() => handed.delete(id)))
  for (const store of [...stores.values()]) {
    // One handed over as a delivery is cancelled by its source's check (watchSource.refresh), and fires again.
    if (!alive(store) || !store.list.some((r) => r.fired?.replies && !r.fired.sending && !r.fired.delivery)) continue
    await locked(store, async () => {
      for (const rec of store.list) if (rec.fired?.replies && !rec.fired.sending && !rec.fired.delivery) delete rec.fired
      await saveQuietly(store)
    }).catch((e) => log.warn('withdrawing replies from watches', e))
    inBackground('checking watches', evaluate(store.ws))
    inBackground('checking agent watches', evaluateAgents(store))
  }
}

/** A watched agent as it is now (#416): not running reads as stopped. A watching agent's own watch is said too. */
function agentNowOf(a: Pick<WatchedAgent, 'projectPath' | 'agentId' | 'gone'>): AgentNow {
  // One whose project is gone (#508) is stopped: whatever runs at its folder now is another project's.
  const now = a.gone ? null : sessions.agentNow(a.projectPath, a.agentId)
  if (!now) return { status: 'stopped', runId: null, prompts: 0, pending: false }
  return { ...now, watch: now.status === 'watching' ? (sessions.watchFor(a.projectPath, a.agentId)?.label ?? null) : null }
}

type AgentHit = { agent: WatchedAgent; event: AgentEvent | null; now: AgentNow; again: boolean; seq: number; reply?: string }

/**
 * What the agents of an agent watch did since it began: each one's latest event after what the watcher knew (its mark's
 * seq), as the agent was then, and whether it is working again since; failing that (nothing recorded: Hive restarted,
 * or a typed prompt never taken), the agent as it is now, if it isn't working.
 */
function agentHits(rec: WatchRecord): AgentHit[] {
  const out: AgentHit[] = []
  const ib = rec.agents?.ignoreBackground ?? false
  for (const agent of rec.agents?.agents ?? []) {
    const key = agentKey(agent.projectPath, agent.agentId)
    const mark = rec.agentMarks?.[key]
    const cur = agentNowOf(agent)
    // What the user sent it from its pane since (#418), for the Assistant.
    // One whose project is gone (#508): nothing recorded at its folder is its own any more, only that it stopped.
    const r = agent.gone ? null : replyTo(rec.scope, agent.projectPath, agent.agentId, mark?.seq ?? 0)
    const said = r ? { reply: r.text } : {}
    const h = agent.gone ? null : happenedSince(key, mark?.seq ?? 0, ib)
    if (h) {
      out.push({ agent, event: agentEvent(h.now, undefined, ib)!, now: shownTo(rec.scope, agent, h.now), again: agentBusy(cur, ib), seq: Math.max(h.seq, r?.seq ?? 0), ...said })
      continue
    }
    const event = agentEvent(cur, mark, ib)
    if (event || r) out.push({ agent, event, now: shownTo(rec.scope, agent, cur), again: false, seq: Math.max(mark?.seq ?? 0, latestSeq(key), r?.seq ?? 0), ...said })
  }
  return out
}

/** Records what a wake (or an answer at once) told an agent about the agents it watched: its next watch starts there. */
function noteToldAgents(store: Store, watcher: string, told: Map<string, number>): void {
  const known = new Map(store.wokeAgents.get(watcher))
  for (const [k, seq] of told) {
    known.delete(k)
    known.set(k, seq)
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  store.wokeAgents.delete(watcher)
  store.wokeAgents.set(watcher, known)
  if (store.wokeAgents.size > MAX_WATCHES) store.wokeAgents.delete(store.wokeAgents.keys().next().value!)
}

export type AgentWatchResult = { watching: TaskWatchInfo; replaced?: string } | { already: string[] }

/**
 * Starts (or replaces) an agent's agent watch (#416): Hive types one line into it when one of `cond`'s agents finishes
 * its turn, waits for the user or stops. Agents not working now are the answer at once (as for a card already in the
 * column): the agent's earlier watch ends and each one's state is told. Only agents it may watch (mayWatch); not itself.
 */
export async function registerAgentWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: AgentWatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<AgentWatchResult> {
  // A wake whose line its CLI has taken is received first, so this watch starts from what it told (#649).
  await followAgent(projectPath, agentId)
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  for (const a of cond.agents) {
    if (!mayWatch(ws, store.path, projectPath, a.projectPath)) throw new Error(`Not a project of this workspace: ${a.project}`)
    if (same(a.projectPath, projectPath) && a.agentId === agentId) throw new Error("You can't watch yourself: nothing would wake you")
  }
  const result = await locked(store, async (): Promise<AgentWatchResult> => {
    const since = new Date().toISOString()
    const agentMarks: Record<string, AgentMark> = {}
    const already: string[] = []
    const scope = scopeFor(ws, projectPath)
    // After a wake, each agent starts from what that wake told (an event since is news, and fires the watch at once,
    // below); otherwise from its latest event now.
    const watcher = agentKey(projectPath, agentId)
    const told = store.wokeAgents.get(watcher)
    const toldNow = new Map<string, number>()
    for (const a of cond.agents) {
      const key = agentKey(a.projectPath, a.agentId)
      const now = shownTo(scope, a, agentNowOf(a))
      if (!agentBusy(now, cond.ignoreBackground)) {
        already.push(agentPart(a, agentEvent(now, undefined, cond.ignoreBackground)!, now, 200, true))
        toldNow.set(key, latestSeq(key))
      }
      agentMarks[key] = agentMarkOf(now, told?.get(key) ?? latestSeq(key))
    }
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    if (!already.length && !old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const followed = { ...cond, agents: cond.agents.map((a) => ({ ...a, ...projectIdOf(ws, a.projectPath) })) }
    const rec: WatchRecord | null = already.length ? null : { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond: NO_CARDS, agents: followed, agentMarks, marks: {}, current: {}, since, limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), ...(rec ? [rec] : [])]
    if (rec && budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES))
      throw new Error('Too many watches to keep in this workspace: wait for some to end')
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
    if (!rec) {
      noteToldAgents(store, watcher, toldNow)
      return { already }
    }
    log.info(`${userText(agentId)} watches ${cond.agents.map((a) => userText(a.name)).join(', ')}`)
    // A card watch it had ends: said, so it isn't thought to be still running.
    return { watching: infoOf(rec), ...(old && !old.agents ? { replaced: infoOf(old).label } : {}) }
  })
  sessions.watchChanged(projectPath, agentId)
  // Checked again once in place: an agent that finished while it was being set up isn't missed.
  if ('watching' in result) inBackground('checking agent watches', evaluateAgents(store))
  return result
}

/** Checks a workspace's agent watches against its agents now: those with an agent no longer working fire, then are delivered. */
async function evaluateAgents(store: Store): Promise<void> {
  if (!store.list.some((r) => r.agents && !r.fired)) return
  await locked(store, async () => {
    // Watched agents in their projects' folders now (#508).
    let changed = followProjects(store, store.ws.projectIdsNow())
    for (const rec of store.list) {
      if (!rec.agents || rec.fired) continue
      const hits = agentHits(rec)
      if (!hits.length) continue
      rec.fired = { line: fitLine(agentWakeLine(hits, userName())), at: new Date().toISOString(), cards: [], agents: hits.map((h) => agentKey(h.agent.projectPath, h.agent.agentId)), ...(hits.some((h) => h.reply !== undefined) ? { replies: true as const } : {}) }
      changed = true
    }
    if (changed) await saveQuietly(store)
  })
  for (const rec of store.list.filter((r) => r.agents && r.fired)) await deliver(store, rec)
}

/** How often the tick checks lane watches (a stall that comes with time, a card waiting in Review, #521). */
const LANE_TICK_MS = 30_000

/** Checks a workspace's lane watches soon: once for a burst of status changes. */
function laneCheckSoon(store: Store): void {
  if (store.laneCheck || !store.list.some((r) => r.lanes && !r.fired)) return
  store.laneCheck = true
  inBackgroundAfter(1000, 'checking lane watches', () => {
    store.laneCheck = undefined
    return evaluateLanes(store)
  })
}

/**
 * The lanes a lane watch follows, as they are now (#531): those it names, or every running lane, and any it already
 * follows (so a lane's end is told); in the watcher's view (a project agent: its project's lanes; the Assistant: all).
 * Each lane's cards as the board has them now, with their verdicts, blocks and stalls.
 */
async function lanesNow(store: Store, rec: Pick<WatchRecord, 'scope' | 'lanes' | 'laneMarks'> & { since?: string; laneSince?: string }, board?: TaskCard[]): Promise<LaneNow[]> {
  const cond = rec.lanes!
  const inView = (await listLanes(store.ws, { all: true })).filter((l) => rec.scope === null || same(l.project, rec.scope))
  // Every running lane, and a lane it follows until its end has been told (round 1 finding: one that ended between a
  // wake and the watch after it, which starts from what the wake told).
  const told = (id: string): boolean => !!rec.laneMarks?.[id] && rec.laneMarks[id].state !== 'ended' && rec.laneMarks[id].state !== 'abandoned'
  // A lane started since the watch's view began, and not yet followed: also when it has already ended or been abandoned
  // (round 2 finding), so its end is told.
  const from = Date.parse(rec.laneSince ?? rec.since ?? '')
  const isNew = (l: { id: string; startedAt: string }): boolean => !rec.laneMarks?.[l.id] && Date.parse(l.startedAt) > from
  const chosen = cond.ids === 'all' ? inView.filter((l) => l.state === 'active' || l.state === 'paused' || told(l.id) || isNew(l)) : inView.filter((l) => (cond.ids as string[]).includes(l.id))
  const byNumber = new Map((board ?? (await allTasks(store.ws))).map((c) => [c.number, c]))
  const agents = new Map()
  const out: LaneNow[] = []
  for (const l of chosen) {
    const marks: LaneMark['cards'] = {}
    const cards: LaneNow['cards'] = []
    for (const lc of l.cards) {
      const found = byNumber.get(lc.number)
      // A card moved to another project is gone from the lane.
      const card = found && same(found.project, l.project) ? found : null
      const stalled = card && !card.archived ? await cardStallIn(store.ws, card, agents) : null
      marks[lc.number] = laneCardMark(card, stalled)
      const v = card ? verdictsOf(card) : null
      cards.push({ number: lc.number, blocked: card?.blocked ?? null, stalled, failedBy: v?.failed?.by ?? null, passedBy: v?.passed?.by ?? null })
    }
    const label = `${l.builder.name}${l.reviewer ? ` / ${l.reviewer.name}` : ''}${l.name ? ` (${l.name})` : ''}`
    out.push({ id: l.id, label, mark: { state: l.state, mergeDue: mergeDue(Object.values(marks)), cards: marks }, cards })
  }
  return out
}

/**
 * A lane watch's events since its marks (#531), and where its marks would move to: each lane it follows now (a lane
 * started after an "all" watch began, from an empty start, so what it already has is told; a card new to a lane likewise,
 * from when the watch began). Lanes no longer followed (an ended one told) leave an "all" watch's marks.
 */
async function laneRound(store: Store, rec: WatchRecord, board?: TaskCard[]): Promise<{ hits: LaneHit[]; next: Record<string, LaneMark> }> {
  const cond = rec.lanes!
  const nows = await lanesNow(store, rec, board)
  const started = new Map((await listLanes(store.ws, { all: true })).map((l) => [l.id, l.startedAt]))
  const hits: LaneHit[] = []
  const next: Record<string, LaneMark> = cond.ids === 'all' ? {} : { ...rec.laneMarks }
  for (const n of nows) {
    const from = rec.laneSince ?? rec.since
    const was = rec.laneMarks?.[n.id] ?? (Date.parse(started.get(n.id) ?? '') > Date.parse(from) ? newLaneBase(n, from) : undefined)
    const h = laneHits(was, n, cond.events, from)
    if (h) hits.push(h)
    next[n.id] = n.mark
  }
  return { hits, next }
}

/**
 * Checks a workspace's lane watches (#531): a lane with an event that counts fires its watch, telling every lane's events
 * in one line, and the watch's marks become what that line told. Otherwise each lane's mark moves on to now, so a card
 * that gets blocked again after an unblock counts, and a lane or card new to the watch starts from now.
 */
async function evaluateLanes(store: Store): Promise<void> {
  if (!alive(store) || !store.list.some((r) => r.lanes && !r.fired)) return
  const board = await allTasks(store.ws).catch(() => null)
  if (!board) return
  await locked(store, async () => {
    let changed = false
    for (const rec of store.list) {
      if (!rec.lanes || rec.fired) continue
      try {
        const { hits, next } = await laneRound(store, rec, board)
        if (hits.length) {
          // Fired: its marks stay where they were, so the line typed later is worked out again from there with
          // whatever else happened meanwhile (one batch, round 1 finding), and becomes what the wake told.
          rec.fired = { line: fitLine(laneWakeLine(hits)), at: new Date().toISOString(), cards: [], lanes: true }
          changed = true
        } else if (JSON.stringify(next) !== JSON.stringify(rec.laneMarks)) {
          rec.laneMarks = next
          changed = true
        }
      } catch (e) {
        if (!alive(store)) throw e
        log.warn(`checking the lane watch of ${userText(rec.agentId)}`, e)
      }
    }
    if (changed) await saveQuietly(store)
  })
  for (const rec of store.list.filter((r) => r.lanes && r.fired)) await deliver(store, rec)
}

export type LaneWatchResult = { watching: TaskWatchInfo; replaced?: string }

/**
 * Starts (or replaces) an agent's watch on lanes (#531): the lanes it names (each in its view, else an error), or every
 * running lane. After a wake, each lane starts from what that wake told, so an event since fires it at once. It is the
 * agent's one watch: a card or agent watch it had ends (said in the reply).
 */
export async function registerLaneWatch(ws: WorkspaceService, projectPath: string, agentId: string, cond: LaneWatchCondition, limitMinutes = WATCH_DEFAULT_LIMIT_MINUTES): Promise<LaneWatchResult> {
  await followAgent(projectPath, agentId)
  const store = await load(ws)
  if (!hostedIn(ws, store.path, projectPath)) throw new Error(`Not a project of this workspace: ${projectPath}`)
  const scope = scopeFor(ws, projectPath)
  if (cond.ids !== 'all') {
    const known = (await listLanes(ws, { all: true })).filter((l) => scope === null || same(l.project, scope))
    const unknown = cond.ids.filter((id) => !known.some((l) => l.id === id))
    if (unknown.length) throw new Error(`No such lane${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (hive_lane list gives the lanes and their ids)`)
  }
  const result = await locked(store, async (): Promise<LaneWatchResult> => {
    const since = new Date().toISOString()
    const told = store.wokeLanes.get(agentKey(projectPath, agentId))
    // After a wake, what is new is measured from when its line was made: a lane started or a card added since then is
    // told (round 2 finding); otherwise from now.
    const laneSince = told?.at ?? since
    const toldMarks = told ? Object.fromEntries(told.marks) : undefined
    const nows = await lanesNow(store, { scope, lanes: cond, laneSince, ...(toldMarks ? { laneMarks: toldMarks } : {}) })
    const started = new Map((await listLanes(ws, { all: true })).map((l) => [l.id, l.startedAt]))
    const laneMarks: Record<string, LaneMark> = {}
    for (const n of nows) {
      const t = told?.marks.get(n.id)
      if (t) laneMarks[n.id] = t
      // Started since that wake: left unmarked, so the first check measures it from an empty start.
      else if (!(told && Date.parse(started.get(n.id) ?? '') > Date.parse(laneSince))) laneMarks[n.id] = n.mark
    }
    const old = recordOf(store, projectPath, agentId)
    const before = store.list
    if (!old && store.list.length >= MAX_WATCHES) throw new Error(`This workspace already has ${MAX_WATCHES} watches, the most Hive keeps: wait for some to end`)
    const minutes = Math.min(WATCH_MAX_LIMIT_MINUTES, Math.max(1, Math.round(limitMinutes)))
    const rec: WatchRecord = { id: randomBytes(6).toString('hex'), projectPath, ...projectIdOf(ws, projectPath), agentId, scope, cond: NO_CARDS, lanes: cond, laneMarks, laneSince, marks: {}, current: {}, since, limitMinutes: minutes, limitAt: new Date(Date.now() + minutes * 60_000).toISOString() }
    const next = [...store.list.filter((x) => x !== old), rec]
    if (budget(store, next) > MAX_FILE_BYTES && !((await setAside(store)) && budget(store, next) <= MAX_FILE_BYTES)) throw new Error('Too many watches to keep in this workspace: wait for some to end')
    store.list = next
    try {
      await save(store)
    } catch (e) {
      store.list = before
      throw new Error(`Could not save the watch: ${(e as Error).message}`, { cause: e })
    }
    stopDelivery(store, old)
    log.info(`${userText(agentId)} watches ${cond.ids === 'all' ? 'all running lanes' : cond.ids.join(', ')}`)
    return { watching: infoOf(rec), ...(old ? { replaced: infoOf(old).label } : {}) }
  })
  sessions.watchChanged(projectPath, agentId)
  // Checked once in place: an event since a wake, or while it was being set up, isn't missed.
  inBackground('checking lane watches', evaluateLanes(store))
  return result
}

/** Typing a wake stopped: it tells a reply of the user's, and they turned telling replies off meanwhile (#418). */
class RepliesRevoked extends Error {
  constructor() {
    super('The user turned off telling the Assistant their replies.')
  }
}

/** A fired watch that has nothing left to tell (#418: a reply no longer told) goes back to waiting, as if it hadn't fired. */
async function withdraw(store: Store, rec: WatchRecord, current: () => boolean): Promise<void> {
  await locked(store, async () => {
    if (!current() || !rec.fired || rec.fired.sending || rec.fired.delivery) return
    delete rec.fired
    await saveQuietly(store)
  }).catch(() => undefined)
}

/** Fired watches waiting out the settle before theirs is handed over. */
const settling = new Set<string>()

/**
 * Whether an agent's own card watch tells it of this change to card n (#405: Hive's loop wakes leave it to the watch),
 * the card being in `column` now: a watch on the card that counts a move into Review (`review`); one that counts a
 * verdict, or a move into the card's column now (`verdict`: a passing one that moved it to Passed; a failed one leaves
 * it in Review, which a watch for Passed doesn't count); or one that has fired and tells the card. Its watches not
 * loaded yet: false.
 */
export function watchCovers(projectPath: string, agentId: string, n: number, kind: 'review' | 'verdict', column: TaskColumn): boolean {
  const store = storeFor(projectPath)
  const rec = store && recordOf(store, projectPath, agentId)
  if (!rec || rec.agents || rec.lanes || !rec.cond.cards.includes(n)) return false
  if (rec.fired) return rec.fired.cards.includes(n)
  const into = (c: TaskColumn): boolean => rec.cond.changes.includes('column') && (!rec.cond.column || rec.cond.column === c)
  if (kind === 'verdict') return rec.cond.changes.includes('verdict') || (column !== 'review' && into(column))
  return into('review')
}

/**
 * What a watch's typed line last told each agent about each card (#578): the last history entry the line had read of the
 * card (its `seen` boundary), by agent key and card. A loop wake for a change whose history entry is within that boundary
 * is one the watch already told, so it is dropped, even once the watch itself has ended; a change after it (the next
 * round's arrival, at any time, the same millisecond too) is news. In memory, as loop wakes are, and kept a day (a loop
 * wake waits at most that long).
 */
const toldByWatch = new Map<string, Map<number, { h: string | null; at: number }>>()
const TOLD_KEEP_MS = 24 * 60 * 60_000
function noteToldByWatch(projectPath: string, agentId: string, told: Record<string, Baseline>): void {
  const cards = Object.entries(told)
  if (!cards.length) return
  const key = agentKey(projectPath, agentId)
  const known = toldByWatch.get(key) ?? new Map<number, { h: string | null; at: number }>()
  for (const [n, b] of cards) {
    known.delete(Number(n))
    known.set(Number(n), { h: b.seen.h, at: Date.now() })
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  toldByWatch.delete(key)
  toldByWatch.set(key, known)
  while (toldByWatch.size > MAX_WATCHES) toldByWatch.delete(toldByWatch.keys().next().value!)
}

/** Whether a watch's line typed into the agent has told it of card `card`'s history entry `entry` (#578). */
export function watchTold(projectPath: string, agentId: string, card: TaskCard, entry: TaskCard['history'][number]): boolean {
  const t = toldByWatch.get(agentKey(projectPath, agentId))?.get(card.number)
  return !!t && Date.now() - t.at < TOLD_KEEP_MS && entryWithin(card.history, entry, t.h)
}

/** Hive's own deliveries come from it. */
const HIVE = { kind: 'hive', name: 'Hive' } as const

/** A watch's wake's key among its deliveries: the watch and when it fired (a restart finds the one it made). */
const wakeRef = (rec: WatchRecord): string => `${rec.id}@${rec.fired?.at ?? ''}`

/** What a wake's line tells, as it was made: where the agent's next watch starts once that line is received (#224, #649). */
interface Told {
  /** Each card, as read for the line (else the watch's own start: nothing the line doesn't tell is taken as known). */
  cards: Record<string, Baseline>
  /** An agent watch's: each agent's latest event the line tells (else where the watch began). */
  agents: Map<string, number>
  /** A card watch's: the latest reply of the user's the line tells (#418), else where it began. */
  reply: number | undefined
  /** A lane watch's: when the line was made from the lanes (#531). */
  laneAt: string
  /** What the line tells of each card it names, as read for it (#578: what loop wakes then leave alone). */
  ofCards: Record<string, Baseline>
  /** Cards released as it was made (#420), noted in their history once it is received. */
  endedAt: { n: number; what: string }[]
  /** Whether it tells a reply of the user's (#418), and the replies' generation then: revoked since, it isn't given. */
  replies: boolean
  generation: number

}

/** Wakes handed over and not received yet, by delivery id: their watch and what their line tells (in memory, as `woke`). */
const handed = new Map<string, { store: Store; rec: WatchRecord; told: Told }>()
const MAX_HANDED = 2000

/** The watch a wake's delivery was handed over by (its workspace's watches loaded), or null. */
function watchOf(host: string, r: DeliveryRecord): { store: Store; rec: WatchRecord } | null {
  const h = handed.get(r.id)
  const store = storeFor(host)
  // The workspace's watches as they are now (a store read again since is the one that counts).
  if (h && h.store === store && h.store.list.includes(h.rec) && h.rec.fired?.delivery === r.id) return h
  const rec = store?.list.find((x) => x.fired?.delivery === r.id && same(x.projectPath, host) && x.agentId === r.agentId)
  return store && rec ? { store, rec } : null
}

/** Whether a wake's line still tells a reply the user still lets be told (#418). */
const repliesHold = (told: Told | undefined): boolean => !told?.replies || (tellReplies() && replyGeneration === told.generation)

/**
 * The watches' part in their wakes' deliveries (#649): a wake is offered only while its watch still has it (not
 * cancelled or replaced) and what it tells may still be told; received, the watch ends and what its line told is where
 * the agent's next watch starts; ended without that (expired, cancelled by its check), the watch fires again.
 */
registerSource('watch', {
  refresh: async (r, host) => {
    const w = watchOf(host, r)
    // Its workspace's watches not loaded yet: decided once they are (it isn't typed meanwhile).
    if (!w) return storeFor(host) ? { cancel: 'its watch has ended' } : null
    if (!repliesHold(handed.get(r.id)?.told)) return { cancel: "the user's replies are no longer told" }
    return null
  },
  holds: (r, host) => !!watchOf(host, r) && repliesHold(handed.get(r.id)?.told),
  received: (r, host) => {
    const w = watchOf(host, r)
    const told = handed.get(r.id)?.told
    handed.delete(r.id)
    if (!w) return
    const { store, rec } = w
    if (told) toldBy(store, rec, told)
    log.info(`The wake for ${userText(rec.agentId)} (${r.id}) was received: its watch has ended`)
    // The watch has ended (unless it was replaced meanwhile, which stays).
    inBackground(
      'ending a watch',
      locked(store, async () => {
        if (!store.list.includes(rec) || rec.fired?.delivery !== r.id) return
        store.list = store.list.filter((x) => x !== rec)
        await saveQuietly(store)
      }).then(() => sessions.watchChanged(rec.projectPath, rec.agentId))
    )
  },
  ended: (r, host) => {
    const w = watchOf(host, r)
    handed.delete(r.id)
    if (!w) return
    const { store, rec } = w
    // Not given (too old, or what it told may no longer be told): the watch goes back to waiting, and fires again on
    // what is still news to it.
    inBackground(
      'a wake not given',
      locked(store, async () => {
        if (!store.list.includes(rec) || rec.fired?.delivery !== r.id) return
        delete rec.fired
        await saveQuietly(store)
      }).then(() => {
        inBackground('checking watches', evaluate(store.ws))
        inBackground('checking agent watches', evaluateAgents(store))
      })
    )
  }
})

// A fired watch's line goes first: nothing else of Hive's is typed into its agent until it is handed over.
onLineComing((projectPath, agentId) => !!storeFor(projectPath)?.list.some((x) => x.fired && !x.fired.delivery && same(x.projectPath, projectPath) && x.agentId === agentId))

/** What a received wake told: the agent's next watch starts there (#224, #416, #418, #531, #578). */
function toldBy(store: Store, rec: WatchRecord, told: Told): void {
  const key = agentKey(rec.projectPath, rec.agentId)
  // The developer console (#636): the wake as it was received (its line is in the agent's own events, as input).
  devConsole.capture([store.ws.path && hiveSourceId(store.ws.path), sessionSourceId(rec.projectPath, rec.agentId)], () => {
    const what = rec.agents ? `${rec.agents.agents.length} agent(s)` : rec.lanes ? 'lanes' : rec.cond.cards.map((n) => `#${n}`).join(', ')
    return { kind: 'watch', name: 'wake', raw: { cards: rec.cond.cards, agents: rec.agents?.agents.length ?? 0, lanes: !!rec.lanes, firedAt: rec.fired?.at ?? null }, made: { typed: true, replies: told.replies }, safe: { raw: { firedAt: true } }, summary: `watch woke ${rec.agentId} (${what})` }
  })
  noteToldByWatch(rec.projectPath, rec.agentId, told.ofCards)
  for (const x of told.endedAt) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
  // What earlier wakes told about cards this one didn't stays: it is still all the agent was told about them.
  const known = new Map(store.woke.get(key))
  for (const [n, b] of Object.entries(told.cards)) {
    known.delete(n)
    known.set(n, b)
  }
  while (known.size > WOKE_CARDS) known.delete(known.keys().next().value!)
  store.woke.delete(key)
  store.woke.set(key, known)
  if (store.woke.size > MAX_WATCHES) store.woke.delete(store.woke.keys().next().value!)
  if (rec.agents) noteToldAgents(store, key, told.agents)
  // A lane watch's: each lane as its line told it (#531), where the agent's next lane watch starts.
  if (rec.lanes && rec.laneMarks) {
    store.wokeLanes.delete(key)
    store.wokeLanes.set(key, { at: told.laneAt, marks: new Map(Object.entries(rec.laneMarks)) })
    if (store.wokeLanes.size > MAX_WATCHES) store.wokeLanes.delete(store.wokeLanes.keys().next().value!)
  }
  if (told.reply !== undefined) {
    store.wokeReplies.delete(key)
    store.wokeReplies.set(key, told.reply)
    if (store.wokeReplies.size > MAX_WATCHES) store.wokeReplies.delete(store.wokeReplies.keys().next().value!)
  }
}

/**
 * Watches read back handed over as deliveries (#649): one whose delivery was received while Hive was closed has ended;
 * one whose delivery ended without that (or is gone) fires again; one still to be received waits for it (offered once
 * more if it was being offered when Hive stopped).
 */
async function followDelivered(store: Store): Promise<void> {
  for (const rec of store.list.filter((r) => r.fired?.delivery)) {
    const id = rec.fired!.delivery!
    await loadDeliveries(rec.projectPath).catch((e) => log.warn('loading deliveries', e))
    const d = deliveryNow(rec.projectPath, id)
    if (d && isUnread(d)) continue
    const received = !!d && (d.state === 'received' || d.state === 'acked')
    await locked(store, async () => {
      if (!store.list.includes(rec) || rec.fired?.delivery !== id) return
      if (received) store.list = store.list.filter((x) => x !== rec)
      else delete rec.fired
      await saveQuietly(store)
    }).catch((e) => log.warn('following a wake', e))
    sessions.watchChanged(rec.projectPath, rec.agentId)
  }
  if (alive(store)) inBackground('checking watches', evaluate(store.ws))
}

/**
 * Hands a fired watch's line to the delivery service (#649), which types it: once its agent can take a line (ready,
 * finished or watching, nobody typing there, no line of Hive's waiting), so the line is made from the cards as they are
 * then. The watch stays (the agent shows watching and takes no other work) until that delivery is received (its line
 * taken by its CLI, or fetched with hive_inbox): then it ends, and what its line told is where the agent's next watch
 * starts, never on "typed". Cancelled or replaced meanwhile, its delivery is cancelled too. A card its line tells about
 * is checked again first: one that has left the agent's view is told as gone.
 */
async function deliver(store: Store, rec: WatchRecord): Promise<void> {
  if (!rec.fired || rec.fired.delivery || store.delivering.has(rec.id) || !alive(store)) return
  // Changes landing together are told together: a watch fired by a change waits a moment before its line is made (#224).
  const due = Date.parse(rec.fired.at) + (testHooks.settleMs ?? SETTLE_MS)
  if ((rec.fired.cards.length || rec.fired.agents?.length || rec.fired.lanes) && Date.now() < due) {
    if (!settling.has(rec.id)) {
      settling.add(rec.id)
      inBackgroundAfter(due - Date.now() + 10, 'waking an agent', () => {
        settling.delete(rec.id)
        return deliver(store, rec)
      })
    }
    return
  }
  // Not over a line it hasn't taken (#430): its next wake waits until it takes that one, or the user presses Enter there.
  if (!readyFor(sessions.liveFor(rec.projectPath, rec.agentId)) || sessions.userMayBeTyping(rec.projectPath, rec.agentId) || sessions.lineWaiting(rec.projectPath, rec.agentId)) return
  const token = { cancelled: false }
  store.delivering.set(rec.id, token)
  const current = (): boolean => !token.cancelled && alive(store) && store.list.includes(rec)
  try {
    let line = rec.fired.line
    // Whether the line tells a reply of the user's (#418): then the setting is checked again before every piece and
    // before Enter, and turned off, it isn't given.
    let telling = !!rec.fired.replies
    const generation = replyGeneration
    // What the line tells the agent about each card, where its next watch starts from (#224): the cards as read for the
    // line; otherwise (a line about the limit, or one not made again) the watch's own starting point, so nothing that
    // the line doesn't tell is taken as known.
    let told: Record<string, Baseline> = {}
    const toldAgents = new Map(Object.entries(rec.agentMarks ?? {}).map(([k, m]) => [k, m.seq]))
    let toldReply = rec.replySeq
    let laneTold: Record<string, LaneMark> | null = null
    let laneToldAt = rec.fired.at
    let toldOfCards: Record<string, Baseline> = {}
    const endedAt: { n: number; what: string }[] = []
    for (const n of rec.cond.cards) {
      const s = rec.seen?.[n]
      if (s) told[n] = { mark: rec.marks[n], seen: s }
    }
    if (rec.fired.cards.length) {
      // Told as the cards are now, every change since the watch began (#224): one that landed after the line was made
      // is in it too, and a card that has left the agent's view is told as gone.
      const r = await check(store, rec)
      // A card released since the line was made (#420: reassigned before it was handed over) is told as released, not
      // as the change that fired it.
      let left = rec.cond.cards.length
      if (r.released.length) {
        const ok = await locked(store, async () => {
          if (!current() || !rec.fired || rec.fired.sending || rec.fired.delivery) return false
          left = applyRelease(rec, r.released, endedAt)
          await saveQuietly(store)
          return true
        }).catch(() => false)
        if (!ok) return
        sessions.watchChanged(rec.projectPath, rec.agentId)
      }
      if (r.released.length && !left) {
        line = fitLine(releasedLine(rec.released!))
        telling = false
      } else if (r.released.length && !r.hits.length && !r.replies.length) {
        // What fired it was a card since released, and the rest haven't changed: not given; the watch waits on for the
        // rest, and tells the release with its next line (#420).
        for (const x of endedAt) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
        await withdraw(store, rec, current)
        sessions.watchChanged(rec.projectPath, rec.agentId)
        return
      } else if (r.hits.length || r.replies.length) {
        const made = cardWakeLine(r.hits, r.replies.map((x) => x.note), rec.released ?? [], userName())
        line = fitLine(made.line)
        telling = r.replies.length > 0
        toldOfCards = Object.fromEntries(r.hits.filter((h) => h.changes !== 'gone' && r.told[h.number]).map((h) => [h.number, r.told[h.number]]))
        if (r.hits.length) told = r.told
        // Only replies the line names are told (#418).
        if (made.repliesTold) toldReply = Math.max(rec.replySeq ?? 0, ...r.replies.map((x) => x.seq))
      } else if (rec.fired.replies) {
        // It told only replies, which may no longer be told (the setting turned off): not given, the watch waits on.
        await withdraw(store, rec, current)
        return
      }
    } else if (rec.fired.lanes && rec.lanes) {
      // Every lane's events since the watch's marks (#531): ones that landed after it fired are in the same line, and
      // the marks it is handed over with are what the wake told.
      const r = await laneRound(store, rec).catch(() => null)
      if (r?.hits.length) {
        line = fitLine(laneWakeLine(r.hits))
        laneTold = r.next
        laneToldAt = new Date().toISOString()
      }
    } else if (rec.fired.agents?.length) {
      // Every agent's latest event since the watch began (#416): one that finished meanwhile is in it too, and one
      // given work again since is still told what it did (and that it is working again).
      const hits = agentHits(rec)
      if (hits.length) {
        line = fitLine(agentWakeLine(hits, userName()))
        telling = hits.some((h) => h.reply !== undefined)
        for (const h of hits) toldAgents.set(agentKey(h.agent.projectPath, h.agent.agentId), h.seq)
      } else if (rec.fired.replies) {
        await withdraw(store, rec, current)
        return
      }
    }
    if (telling && (!tellReplies() || replyGeneration !== generation)) throw new RepliesRevoked()
    // The Assistant woken from a card watch while lanes run (#402): its watch has ended, so the line says to watch them
    // all again (a model that reads no skill on a wake otherwise ends its turn watching nothing).
    if (rec.agentId === ASSISTANT_AGENT_ID && !rec.agents && rec.cond.cards.length && (await listLanes(store.ws).catch(() => [])).some((l) => l.state === 'active' || l.state === 'paused')) line = withLanesTail(line, MAX_LINE_BYTES)
    // Handed over as a delivery, saved as the watch's before the service can type it: a restart follows that delivery
    // rather than making another (the same watch and fire make the same one). Not saved: not handed over (tried again).
    const given = await locked(store, async () => {
      if (!current() || !rec.fired || rec.fired.delivery) return null
      const d = await createDelivery(rec.projectPath, { agentId: rec.agentId, kind: 'card-event', from: HIVE, body: line, ...(rec.fired.cards.length ? { card: rec.fired.cards[0] } : {}), source: 'watch', ref: wakeRef(rec), replace: true })
      const wasLanes = rec.laneMarks
      rec.fired.line = line
      rec.fired.delivery = d.id
      if (laneTold) rec.laneMarks = laneTold
      try {
        await save(store)
      } catch (e) {
        delete rec.fired.delivery
        rec.laneMarks = wasLanes
        await cancelFromSource(rec.projectPath, 'watch', wakeRef(rec), "cancelled: its watch couldn't be saved").catch(() => undefined)
        throw e
      }
      handed.set(d.id, { store, rec, told: { cards: told, agents: toldAgents, reply: toldReply, laneAt: laneToldAt, ofCards: toldOfCards, endedAt, replies: telling, generation } })
      while (handed.size > MAX_HANDED) handed.delete(handed.keys().next().value!)
      return d
    })
    if (!given) return
    log.info(`The wake for ${userText(rec.agentId)} was handed over as ${given.id}`)
    // Offered now (typed if it can be), as the wake always was when its watch was delivered.
    await offerNow(rec.projectPath, rec.agentId)
  } catch (e) {
    // A line telling a reply the user no longer lets be told is dropped: the watch waits on, and fires again on whatever
    // else changed, made without the reply.
    if (e instanceof RepliesRevoked) {
      await locked(store, async () => {
        if (!store.list.includes(rec) || !rec.fired || rec.fired.delivery) return
        delete rec.fired
        await saveQuietly(store)
      }).catch(() => undefined)
      inBackground('checking watches', evaluate(store.ws))
      inBackground('checking agent watches', evaluateAgents(store))
    }
    log.info(`Wake for ${userText(rec.agentId)} put off: ${(e as Error).message}`)
  } finally {
    store.delivering.delete(rec.id)
  }
}

/** Checks one watch against the board: whether it fires now. Its cards are read as its scope sees them. */
async function check(store: Store, rec: WatchRecord, cards?: CardReads): Promise<{ moved: boolean; hits: CardChange[]; told: Record<string, Baseline>; replies: { seq: number; note: ReplyNote }[]; released: Released[] }> {
  const hits: CardChange[] = []
  // Cards the watcher's part in has ended (#420).
  const released: Released[] = []
  // The user's replies to a watched card's agent or reviewer since the watch began (#418), for the Assistant: each once,
  // with the watched cards its agent has or reviews.
  const said = new Map<number, { seq: number; note: ReplyNote }>()
  // Each card as read now: what a line made from these reads tells the agent.
  const told: Record<string, Baseline> = {}
  let moved = false
  for (const n of rec.cond.cards) {
    const card = await cardIn(store, n, rec.scope, cards)
    const gone = releaseOf(rec, n, card)
    if (gone) {
      released.push(gone)
      continue
    }
    const after = markOf(card)
    if (card) told[n] = { mark: after, seen: seenOf(card) }
    const prev = rec.current?.[n]
    if (prev?.column !== after.column || prev?.agent !== after.agent) moved = true
    ;(rec.current ??= {})[n] = after
    // Seen moved into the column as last seen (it was elsewhere, it's there now): also when its history no longer says,
    // and for a watch that waits only to see it there (#521).
    const intoAsSeen = !!rec.cond.column &&!!prev && prev.column !== rec.cond.column && after.column === rec.cond.column
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
    if (card?.project && rec.scope === null && rec.replySeq !== undefined) {
      const projectPath = join(store.path, card.project)
      for (const id of new Set([card.agent, card.review?.agent].filter((x): x is string => !!x))) {
        const r = replyTo(rec.scope, projectPath, id, rec.replySeq)
        if (!r) continue
        const had = said.get(r.seq)
        if (had) had.note.cards.push(n)
        else said.set(r.seq, { seq: r.seq, note: { agentName: r.agentName, cards: [n], text: r.text } })
      }
    }
  }
  return { moved, hits, told, replies: [...said.values()], released }
}

/**
 * Whether a watched card leaves the watch because the watcher's part in it ended (#420): the card was given to another
 * agent (or none) when the watcher had it; or another agent reviews it when the watcher reviewed it, or waited for it
 * to arrive in Review. Null: it stays. A card that is gone is told as gone, as before. A blocked card stays too (#481):
 * it is paused, not gone, and its loop waits for it (a reviewer that moved on deadlocked with its builder).
 */
function releaseOf(rec: WatchRecord, n: number, card: TaskCard | null): Released | null {
  const on = rec.on?.[n]
  if (!on || !card || card.archived) return null
  const me = rec.agentId
  const reviewer = card.review && card.review.agent !== me ? card.review.agentName || card.review.agent : null
  if (on.role === 'agent' && card.agent !== me) return { number: n, why: 'reassigned', detail: card.agentName ?? card.agent ?? null }
  if ((on.role === 'reviewer' || on.role === 'awaiting') && reviewer) return { number: n, why: 'reviewer', detail: reviewer }
  // Its review taken from it (not ended by its own verdict): stopped, or cleared by someone else.
  if (on.role === 'reviewer' && !card.review) {
    const last = card.history.findLast((h) => /^(Started reviewing|Review (passed|failed)|Review by .* stopped)/.test(h.what))
    if (!last || !(/^Review (passed|failed)/.test(last.what) && last.by === rec.watcherName)) return { number: n, why: 'reviewer', detail: null }
  }
  // Waiting for it in Review: its agent was replaced by another, or by none (its work goes to another lane, or nowhere).
  const was = rec.marks[n]?.agent
  if (on.role === 'awaiting' && was && card.agent !== was && card.agent !== me) return { number: n, why: 'reassigned', detail: card.agentName ?? card.agent ?? null }
  return null
}

/** What ended a watch on a card (#420), for its history. */
const releasedWhy = (r: Released): string => (r.why === 'blocked' ? 'the card is blocked' : r.why === 'reviewer' ? (r.detail ? `${r.detail} reviews it` : 'its review was taken from it') : `reassigned to ${r.detail ?? 'no agent'}`)

/**
 * Takes released cards out of a watch (#420), under the store's lock: they join what its next line tells (`released`),
 * each noted for its card's history (`ended`), and the watch keeps the rest, with their marks. How many cards are left
 * (0: every card was released; the watch keeps its condition then, and its line tells only the releases).
 */
function applyRelease(rec: WatchRecord, released: Released[], ended: { n: number; what: string }[]): number {
  rec.released = [...(rec.released ?? []), ...released].slice(-WATCH_MAX_CARDS)
  for (const x of released) ended.push({ n: x.number, what: `Ended ${rec.watcherName ?? rec.agentId}'s watch on it: ${releasedWhy(x)}` })
  const left = rec.cond.cards.filter((n) => !released.some((x) => x.number === n))
  if (!left.length) return 0
  rec.cond = { ...rec.cond, cards: left }
  for (const x of released) {
    delete rec.marks[x.number]
    delete rec.seen?.[x.number]
    delete rec.current?.[x.number]
    delete rec.on?.[x.number]
  }
  return left.length
}

/**
 * A project's place by its stable id (#508), for a watch's own folder or a watched agent's: the folder that has its id
 * now (renamed or moved since, the whole workspace too), `gone` when its id is no project's now and another project has
 * its folder (never that project's watch), or the id to stamp on one saved before ids whose folder is a project. Only
 * this workspace's projects: the index is its own.
 */
function placeOf(ids: ProjectIdIndex, projectPath: string, projectId: string | undefined): { path?: string; id?: string; gone?: true } {
  const now = projectId ? ids.byId.get(projectId) : undefined
  if (now) return same(resolve(now), resolve(projectPath)) ? {} : { path: now }
  const here = ids.byPath.get(resolve(projectPath).toLowerCase())
  if (!projectId) return here ? { id: here } : {}
  return here && here !== projectId ? { gone: true } : {}
}

/**
 * The folder this workspace was in before it moved here (#146), for watches saved there: as the workspace records it
 * (movedFrom: where it was last opened, as it opened), or else as its watches with ids say, when those whose project is
 * here now were all saved under one other folder. Null when it didn't move, or that can't be known.
 */
function oldFolder(ws: WorkspaceService, path: string, ids: ProjectIdIndex, list: readonly WatchRecord[]): string | null {
  if (ws.movedFrom) return same(ws.movedFrom, resolve(path)) ? null : ws.movedFrom
  const roots = new Map<string, string>()
  for (const rec of list)
    for (const t of [rec, ...(rec.agents?.agents ?? [])])
      if (t.projectId && ids.byId.has(t.projectId) && !ws.isAssistantHome(t.projectPath)) {
        const d = dirname(resolve(t.projectPath))
        if (!same(d, resolve(path))) roots.set(d.toLowerCase(), d)
      }
  return roots.size === 1 ? [...roots.values()][0] : null
}

/** A path saved under the workspace's old folder (oldFolder), as it is under its folder now; any other path as it is. */
const movedPath = (path: string, from: string | null, p: string): string => (from ? (rebase(resolve(p), from, resolve(path)) ?? p) : p)

/**
 * Brings a watch to its projects' folders now, by their ids (#508): its own (the watcher's), and each agent an agent watch
 * follows (with its marks, and the agents a fired line tells, kept by their folder). An id in this workspace's index
 * decides, wherever it was saved (the whole workspace moved since too): the folder is that project's, so always one of
 * this workspace's. One from before ids, and the Assistant's, come from the workspace's old folder (`from`, oldFolder)
 * to the same place under its folder now, never from another path, and get their ids. `gone`: the watcher's project is
 * gone and another project has its folder. A watched agent whose project is gone while another project has its folder is
 * marked `gone`: told as stopped, never as that project's agent of the same id.
 */
function followIds(ws: WorkspaceService, path: string, ids: ProjectIdIndex, rec: WatchRecord, from: string | null): 'same' | 'changed' | 'gone' {
  let changed = false
  const known = (id: string | undefined): boolean => !!id && ids.byId.has(id)
  if (!ws.isAssistantHome(rec.projectPath)) {
    const p = known(rec.projectId) ? rec.projectPath : movedPath(path, from, rec.projectPath)
    if (ws.isAssistantHome(p)) {
      rec.projectPath = ws.assistantHome
      changed = true
    } else if (known(rec.projectId) || hostedIn(ws, path, p)) {
      const at = placeOf(ids, p, rec.projectId)
      if (at.gone) return 'gone'
      const to = at.path ?? p
      if (to !== rec.projectPath) {
        log.info(`A watch follows its project to ${userText(basename(to))}`)
        rec.projectPath = to
        changed = true
      }
      if (at.id) {
        rec.projectId = at.id
        changed = true
      }
    }
  }
  for (const a of rec.agents?.agents ?? []) {
    const p = known(a.projectId) ? a.projectPath : movedPath(path, from, a.projectPath)
    if (!known(a.projectId) && !mayWatch(ws, path, rec.projectPath, p)) continue
    const at = placeOf(ids, p, a.projectId)
    if (!!at.gone !== !!a.gone) {
      if (at.gone) {
        log.info("A watched agent's project is gone, and another project has its folder: it is told as stopped")
        a.gone = true
      } else delete a.gone
      changed = true
    }
    const to = at.path ?? p
    if (to !== a.projectPath) {
      const was = agentKey(a.projectPath, a.agentId)
      a.projectPath = to
      a.project = basename(to)
      const key = agentKey(a.projectPath, a.agentId)
      if (rec.agentMarks && was in rec.agentMarks && was !== key) {
        rec.agentMarks[key] = rec.agentMarks[was]
        delete rec.agentMarks[was]
      }
      if (rec.fired?.agents) rec.fired.agents = rec.fired.agents.map((k) => (k === was ? key : k))
      changed = true
    }
    if (at.id) {
      a.projectId = at.id
      changed = true
    }
  }
  return changed ? 'changed' : 'same'
}

/**
 * Watches whose project was renamed or moved within the workspace while Hive runs (#508) go with it, by its id: their
 * folder and the cards they may see are the project's now, and so do the agents an agent watch follows. A watch whose
 * project is gone while another project has its folder leaves the list, kept aside in the file (as one that isn't valid
 * is when read). Whether any changed (in the store's lock).
 */
function followProjects(store: Store, ids: ProjectIdIndex): boolean {
  let changed = false
  const from = oldFolder(store.ws, store.path, ids, store.list)
  for (const rec of [...store.list]) {
    const before = rec.projectPath
    const r = followIds(store.ws, store.path, ids, rec, from)
    if (r === 'same') continue
    changed = true
    if (r === 'gone') {
      store.list = store.list.filter((x) => x !== rec)
      store.invalid.push(entryOf(rec))
      sessions.watchChanged(before, rec.agentId)
      continue
    }
    if (rec.projectPath !== before) {
      // An agent has one watch: one made at the new folder since stays.
      if (store.list.some((x) => x !== rec && same(x.projectPath, rec.projectPath) && x.agentId === rec.agentId)) {
        store.list = store.list.filter((x) => x !== rec)
        continue
      }
      rec.scope = scopeFor(store.ws, rec.projectPath)
      sessions.watchChanged(rec.projectPath, rec.agentId)
    }
  }
  return changed
}

/** Checks a workspace's watches against its board: those whose cards changed (as they count) fire, then are delivered. */
async function evaluate(ws: WorkspaceService): Promise<void> {
  const store = await load(ws)
  // Whether a watched card's column or agent changed (also gone, or out of the agent's view): what a pending quit's
  // "is the work it waits for going on?" reads (watchKeepsQuitWaiting), told once the cards as last seen are updated.
  let moved = false
  // Watches that ended on a card (#420), for its history once the watches are saved, and those left with fewer cards
  // (what their agents show changes).
  const ended: { n: number; what: string }[] = []
  const narrowed: WatchRecord[] = []
  await locked(store, async () => {
    // The projects as they are now, which the cards read below see too.
    let changed = followProjects(store, await store.ws.projectIds({ fresh: true }))
    // Each card read once for all the watches on it (#321).
    const reads: CardReads = new Map()
    for (const rec of [...store.list]) {
      if (rec.fired || rec.agents || rec.lanes) continue
      // One watch that can't be checked doesn't stop the others.
      try {
        const r = await check(store, rec, reads)
        if (r.moved) moved = true
        if (r.released.length) {
          // Released cards leave the watch (#420), told with its next line; when none is left, it is woken now.
          changed = true
          if (!applyRelease(rec, r.released, ended)) {
            rec.fired = { line: fitLine(releasedLine(rec.released!)), at: new Date().toISOString(), cards: [] }
            continue
          }
          narrowed.push(rec)
        }
        const hits = r.hits
        if (!hits.length && !r.replies.length) continue
        const cards = [...new Set([...hits.filter((h) => h.changes !== 'gone').map((h) => h.number), ...r.replies.flatMap((x) => x.note.cards)])]
        rec.fired = { line: fitLine(cardWakeLine(hits, r.replies.map((x) => x.note), rec.released ?? [], userName()).line), at: new Date().toISOString(), cards, ...(r.replies.length ? { replies: true as const } : {}) }
        changed = true
      } catch (e) {
        if (!alive(store)) throw e
        log.warn(`checking the watch of ${userText(rec.agentId)}`, e)
      }
    }
    if (changed) await saveQuietly(store)
  })
  for (const x of ended) inBackground(`noting on #${x.n} that a watch ended`, noteOnCard(x.n, x.what, store.ws))
  for (const rec of narrowed) sessions.watchChanged(rec.projectPath, rec.agentId)
  if (moved && alive(store)) watchedCardsMoved?.()
  for (const rec of store.list.filter((r) => r.fired)) await deliver(store, rec)
  // Lane watches follow the same board (#531).
  await evaluateLanes(store).catch((e) => log.warn('checking lane watches', e))
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
          rec.fired = { line: fitLine(rec.agents ? agentLimitLine(rec.agents, rec.limitMinutes) : rec.lanes ? laneLimitLine(rec.lanes, rec.limitMinutes) : limitLine(rec.cond, rec.limitMinutes, rec.released ?? [])), at: new Date(now).toISOString(), cards: [] }
          changed = true
        }
      }
      if (changed) await saveQuietly(store)
    }).catch((e) => log.warn('watch limits', e))
    // Agent watches are checked on every status change; also here, for what no status change tells (a typed prompt
    // its CLI never took).
    await evaluateAgents(store).catch((e) => log.warn('checking agent watches', e))
    // Lane watches (#531): a stall comes with time (a card waiting in Review), so they are checked now and then too.
    if (now - (store.laneTickAt ?? 0) >= LANE_TICK_MS) {
      store.laneTickAt = now
      await evaluateLanes(store).catch((e) => log.warn('checking lane watches', e))
    }
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
  // An agent watch: while an agent it waits for works.
  if (rec.agents) return rec.agents.agents.some((a) => agentBusy(agentNowOf(a), rec.agents!.ignoreBackground)) ? st.watch.label : null
  // A lane watch: it follows lanes, not work it is waiting on (#531).
  if (rec.lanes) return null
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
  sessions.userReplied = noteUserReply
  config.onSettingsChanged((s, prev) => {
    if (prev.assistant?.tellReplies !== false && s.assistant?.tellReplies === false) inBackground('withdrawing replies', revokeReplies())
  })
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && same(w.path, e.workspacePath))
      if (ws) inBackground('checking watches', evaluate(ws))
    } else if (e.type === 'lanes-changed') {
      const store = [...stores.values()].find((x) => same(x.path, e.workspacePath))
      if (store) laneCheckSoon(store)
    } else if (e.type === 'session-status') {
      noteAgentStatus(e.state)
      const store = storeFor(e.state.projectPath)
      if (!store) return
      // A stall can come with a status (an agent idle with no watch, one stopped): lane watches look again (#531).
      laneCheckSoon(store)
      // An agent someone watches changed status (#416).
      const { projectPath, agentId } = e.state
      if (store.list.some((x) => x.agents && !x.fired && x.agents.agents.some((a) => same(a.projectPath, projectPath) && a.agentId === agentId)))
        inBackground('checking agent watches', evaluateAgents(store))
      if (!readyFor(e.state)) return
      const rec = store.list.find((x) => x.fired && !x.fired.delivery && same(x.projectPath, projectPath) && x.agentId === agentId)
      if (rec) inBackgroundAfter(500, 'waking an agent', () => deliver(store, rec))
    }
  })
  const timer = setInterval(() => inBackground('watch tick', tick()), 5000)
  timer.unref?.()
}

/** Forgets a workspace's watches in memory, as closing it does (they stay on disk for its next opening): for tests. */
/**
 * Reads a workspace's watches as it opens (#508): each is brought to its projects' folders by their ids, and one saved
 * before ids gets them, saved now (watches.json keeps what it was before beside it, once) rather than at the next change.
 */
export async function stampWatchProjects(ws: WorkspaceService): Promise<void> {
  const store = await load(ws)
  if (store.dirty) await locked(store, () => saveQuietly(store))
}

/** The watches saved before ids (#508) whose folder is no project now, as Repair weighs whose they are: the folder's name and the watcher. */
export async function legacyWatches(ws: WorkspaceService): Promise<{ name: string; agents: string[] }[]> {
  const store = await load(ws)
  const ids = await ws.projectIds()
  return store.list.filter((r) => !r.projectId && !ws.isAssistantHome(r.projectPath) && !ids.byPath.has(resolve(r.projectPath).toLowerCase())).map((r) => ({ name: basename(resolve(r.projectPath)), agents: [r.agentId] }))
}

/**
 * Repair (#508): watches saved before ids in a project's old folder go to the project's folder now, with its id. In the
 * store's lock; one with an id, or in another folder now, is left as it is. Returns how many moved.
 */
export async function moveOrphanWatches(ws: WorkspaceService, m: { from: string; to: string }): Promise<number> {
  const store = await load(ws)
  const ids = await ws.projectIds()
  const to = join(store.path, m.to)
  const projectId = ids.byPath.get(to.toLowerCase())
  if (!projectId) return 0
  const moved = await locked(store, async () => {
    const list = store.list.filter((r) => !r.projectId && !ws.isAssistantHome(r.projectPath) && same(dirname(resolve(r.projectPath)), resolve(store.path)) && same(basename(resolve(r.projectPath)), m.from))
    for (const r of list) {
      if (recordOf(store, to, r.agentId)) {
        store.list = store.list.filter((x) => x !== r)
        continue
      }
      r.projectPath = to
      r.projectId = projectId
      r.scope = scopeFor(ws, to)
    }
    if (list.length) {
      await keepBeforeIds(fileOf(store.path))
      await saveQuietly(store)
    }
    return list
  })
  for (const r of moved) sessions.watchChanged(r.projectPath, r.agentId)
  return moved.length
}

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
/** Checks a workspace's agent watches now (what a status change does): for tests. */
export const evaluateAgentWatches = async (ws: WorkspaceService): Promise<void> => evaluateAgents(await load(ws))
