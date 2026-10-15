import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { mkdir, readdir, readFile, stat } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { projectAgents } from '../shared/defaults'
import { englishText, withValues, type Text } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { COLUMN_CHOICES, TASK_COLUMNS, cardMatches, isTaskColumn, restoreOrders, sortCards } from '../shared/tasks'
import { HISTORY, storedLineText, storedText } from '../shared/taskHistory'
import { providerMessage } from '../shared/providers'
import type { ArchiveBatch, ArchiveRequest, ArchiveResult, StoredText, TaskCard, TaskDecision, TaskColumn, TaskComment, TaskHistoryEntry, TaskPatch, UnarchiveResult } from '../shared/types'
import { returnRound } from '../shared/watch'
import { holdsOf, trackHolds } from '../shared/cardCosts'
import { isProjectId, projectIdNamed, projectNameOf, projectNow, savedProjectName, type ProjectIdIndex } from '../shared/projectIds'
import { keepBeforeIds } from './beforeIds'
import { config } from './config'
import { emit } from './events'
import { readJson, withFileLock, writeJsonAtomic } from './fsutil'
import { HiveError, hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { workspace, type WorkspaceService } from './workspace'
import { trash } from './trash'

const log = createLogger('tasks')

/**
 * The board's refusals (#846, E10b of #677) are HiveErrors: the window reads them in its language, agents (the Agent API,
 * the hive tools) in English, exactly as before. A refusal's `kind` is set where it is the status its English always
 * gave (servers.ts `statusFor`); without one, the English still gives it. A column (`{column}`) is its key, and each
 * message chooses its words.
 */
const ERR = {
  unknownTask: msg({ id: 'tasks.error.unknownTask', defaultMessage: 'Unknown task #{n}', description: 'An error: there is no card #{n} (a number), or none the caller may see.' }),
  noWorkspace: msg({ id: 'tasks.error.noWorkspace', defaultMessage: 'No workspace is open', description: "An error: a change to the task board needs an open workspace, and there is none." }),
  needsTitle: msg({ id: 'tasks.error.needsTitle', defaultMessage: 'A task needs a title.', description: 'An error: a card (a task) was saved with an empty title.' }),
  unknownColumn: msg({ id: 'tasks.error.unknownColumn', defaultMessage: 'Unknown column "{column}": {choices}.', description: 'An error: {column} is not a column of the board; {choices} lists the column ids the call takes (hold, todo, doing… kept as they are).' }),
  archived: msg({ id: 'tasks.error.archived', defaultMessage: '#{n} is archived. Only the user can bring it back.', description: 'An error: card #{n} (a number) is archived, so an agent or the Assistant cannot change it; only the user can bring it back from the archive.' }),
  noCard: msg({ id: 'tasks.error.noCard', defaultMessage: 'There is no card #{n}.', description: 'An error: there is no card #{n} (a number) that the caller may see.' }),
  cardsTooMany: msg({ id: 'tasks.error.cardsTooMany', defaultMessage: 'cards: at most {max} cards at once.', description: 'An error: a call listed more than {max} cards. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsNotNumber: msg({ id: 'tasks.error.cardsNotNumber', defaultMessage: 'cards: "{value}" is not a card number', description: 'An error: {value} in the list of cards is not a card number. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsTwice: msg({ id: 'tasks.error.cardsTwice', defaultMessage: 'cards: #{n} is listed twice', description: 'An error: the list of cards names card #{n} (a number) twice. "cards:" is the name of the call\'s field: keep it as it is.' }),
  emptyDecision: msg({ id: 'tasks.error.emptyDecision', defaultMessage: 'The decision is empty.', description: "An error: a decision recorded on a card has no text." }),
  onlyUserDone: msg({ id: 'tasks.error.onlyUserOrdersDone', defaultMessage: 'Only the user puts the cards in Done in order.', description: 'An error: an agent or the Assistant tried to put the cards of the Done column in order; only the user does that.' })
}

/**
 * The workspace's task board: one JSON file per card in .hive/tasks (<number>.json), and board.json with the next
 * number. Cards belong to a project and can be given to one of its agents. A card names its project by folder name
 * and by the project's stable id (#508, `projectId` in the file): the name is read back from the id, so a project
 * renamed or moved keeps its cards, and saving a card writes both (the name for people and older Hive versions).
 */

/**
 * Who changes a card: the user (Hive's window), the Hive Assistant, or an agent or script through the Agent API.
 * `self` is the agent whose call it is (its project's folder name and id); scripts have none. `scope` confines a
 * project agent to its project's cards: others are "unknown" to it, as if they didn't exist.
 */
export type TaskActor = { kind: 'user' } | { kind: 'assistant' } | { kind: 'agent'; name: string; self?: { project: string; agentId: string }; scope?: string }

/** The project an actor is confined to on the board (a project agent's own), or null for the whole workspace. */
export const scopeOf = (a: TaskActor): string | null => (a.kind === 'agent' && a.scope !== undefined ? a.scope : null)

/** Whether a card is one the scope may see: every card without a scope, else only its project's (not the workspace's). */
export const inScope = (c: { project: string }, scope: string | null): boolean => scope === null || (!!c.project && c.project.toLowerCase() === scope.toLowerCase())

/** What a confined agent is told about a card outside its project: the same as for one that doesn't exist. */
export const unknownTask = (n: number): Error => hiveError(ERR.unknownTask, { n }, { kind: 'notFound' })

/** The calling agent, when a card of `project` going into Doing with no agent named should be given to it. */
const selfIn = (actor: TaskActor, project: string): string | null =>
  actor.kind === 'agent' && actor.self && project && actor.self.project.toLowerCase() === project.toLowerCase() ? actor.self.agentId : null

/** Who changed a card, as its history, comments and decisions store it: English, read by agents (the window words them, shared/taskHistory.ts BY_TEXT). */
const BY = { you: 'You', assistant: 'Assistant', hive: 'Hive', repair: 'Repair' } as const // i18n-ignore: stored with cards in English, as agents read them

export const actorName = (a: TaskActor): string => (a.kind === 'user' ? BY.you : a.kind === 'assistant' ? BY.assistant : a.name)

/** A change only the user may make (or the Assistant once the user said yes): thrown for others. The Agent API's 403. */
export class TaskPermissionError extends HiveError {
  constructor(text: Text) {
    super(text, { kind: 'forbidden' })
  }
}

/** A change the card's state rules out now (another agent is working on it): the Agent API's 409. */
export class TaskConflictError extends HiveError {
  constructor(text: Text) {
    super(text, { kind: 'conflict' })
  }
}

const MAX_TITLE = 200
const MAX_TEXT = 20_000
const MAX_LABELS = 12
const MAX_COMMENTS = 500
const MAX_DECISIONS = 100
const MAX_DECISION = 4000
/**
 * A new history entry's or comment's id, unique on its card (#224): two entries alike in time, author and words are
 * still two. Card watches count what they have seen by it; the Agent API's card views leave it out.
 */
const entryId = (): string => randomBytes(6).toString('hex')
const MAX_HISTORY = 300

function tasksDir(ws: WorkspaceService = workspace): string {
  return join(ws.hiveDir, 'tasks')
}

/** A card's file, and the lock on it (taken under the board's lock, below). */
export const cardFile = (n: number, ws?: WorkspaceService): string => join(tasksDir(ws), `${n}.json`)

/**
 * The board's lock. A card's place is worked out from every card's order, so each change that places one (creating,
 * updating, reordering, archiving, bringing back or importing a card) reads the board and writes its card under this
 * lock. It is taken before any card's lock and never inside one; a batch takes it card by card, so other changes
 * interleave. Keyed by the workspace folder, so every window's service shares it.
 */
export function boardLock<T>(ws: WorkspaceService, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`board-lock:${ws.path ?? ''}`, fn)
}

function changed(ws: WorkspaceService = workspace): void {
  if (ws.path) emit({ type: 'tasks-changed', workspacePath: ws.path })
}

/** A card loop's handoff (#405): a card arrived in Review (moved or returned there), or its review gave a verdict. */
export interface LoopEvent {
  ws: WorkspaceService
  card: TaskCard
  kind: 'review' | 'verdict'
  /** Who made the change. */
  actor: TaskActor
}
let loopEvents: ((e: LoopEvent) => void) | null = null
/** Told of each loop handoff once its change is saved (loopWakes.ts wakes the card's reviewer or builder). */
export function onLoopEvent(fn: (e: LoopEvent) => void): void {
  loopEvents = fn
}
/** History lines that bring a card into Review: moved there (to its top, bottom or before a card), or returned there for its next round. */
const INTO_REVIEW = new Set<string>([HISTORY.moved.id, HISTORY.movedTop.id, HISTORY.movedBottom.id, HISTORY.movedBefore.id])
const intoReview = (s: StoredText): boolean => s.id === HISTORY.returned.id || (INTO_REVIEW.has(s.id) && s.values?.column === 'review')

/** A card read from disk, with anything missing or of the wrong type made safe (the files can be edited by hand). */
function clean(raw: Partial<TaskCard> & { projectId?: unknown }, n: number, ids?: ProjectIdIndex): TaskCard {
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [])
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const now = new Date(0).toISOString()
  return {
    number: n,
    title: typeof raw.title === 'string' ? raw.title : `Task ${n}`, // i18n-ignore: a damaged card's stand-in title, saved and read by agents
    description: typeof raw.description === 'string' ? raw.description : '',
    // Renamed or moved since it was saved: the project that has its id now (projectNow).
    project: ids ? projectNow(ids, typeof raw.project === 'string' ? raw.project : '', raw.projectId) : typeof raw.project === 'string' ? raw.project : '',
    agent: typeof raw.agent === 'string' && raw.agent ? raw.agent : null,
    ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
    ...(raw.review && typeof raw.review.agent === 'string' && raw.review.agent && typeof raw.review.since === 'string'
      ? { review: { agent: raw.review.agent, agentName: typeof raw.review.agentName === 'string' ? raw.review.agentName : raw.review.agent, since: raw.review.since } }
      : {}),
    column: isTaskColumn(raw.column) ? raw.column : 'todo',
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : n,
    labels: strs(raw.labels),
    blocked: typeof raw.blocked === 'string' && raw.blocked.trim() ? raw.blocked : null,
    blockedBy: nums(raw.blockedBy),
    links: nums(raw.links),
    comments: Array.isArray(raw.comments) ? raw.comments.filter((c) => c && typeof c.text === 'string') : [],
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h.what === 'string') : [],
    archived: raw.archived === true,
    ...(raw.archivedFor ? { archivedFor: raw.archivedFor } : {}),
    ...(raw.archived === true && typeof raw.archivedBatch === 'string' && raw.archivedBatch ? { archivedBatch: raw.archivedBatch } : {}),
    ...decisionsOf(raw.decisions),
    ...holdsOf(raw.held),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  }
}

/** A card's decisions as read from disk (#357): only well-formed ones, each with an id; none, no field. */
function decisionsOf(v: unknown): { decisions?: TaskDecision[] } {
  if (!Array.isArray(v)) return {}
  const out = v.flatMap((d): TaskDecision[] =>
    d && typeof d.text === 'string' && d.text.trim()
      ? [
          {
            id: typeof d.id === 'string' && d.id ? d.id : entryId(),
            text: d.text,
            decidedBy: 'user',
            recordedBy: typeof d.recordedBy === 'string' ? d.recordedBy : '',
            at: typeof d.at === 'string' ? d.at : new Date(0).toISOString(),
            ...(typeof d.editedAt === 'string' ? { editedAt: d.editedAt } : {})
          }
        ]
      : []
  )
  return out.length ? { decisions: out } : {}
}

/**
 * Leaves out references to cards that are gone. A card deleted while another was being linked to it can leave
 * one behind; it is never shown or passed on, and leaves the file the next time that card is saved. Numbers are
 * never reused, so a reference can't come to mean another card.
 */
function withoutGone(card: TaskCard, exists: (n: number) => boolean): TaskCard {
  card.blockedBy = card.blockedBy.filter(exists)
  card.links = card.links.filter(exists)
  return card
}

/** Every card on the board (archived ones too), in board order. */
export async function allTasks(ws: WorkspaceService = workspace): Promise<TaskCard[]> {
  if (!ws.path) return []
  const names = await readdir(tasksDir(ws)).catch(() => [] as string[])
  const numbers = new Set(names.flatMap((f) => (/^(\d+)\.json$/.test(f) ? [Number(f.slice(0, -5))] : [])))
  const ids = await ws.projectIds()
  const out = await bounded([...numbers], READS_AT_ONCE, async (n) => {
    const raw = await readJson<Partial<TaskCard> | null>(cardFile(n, ws), null)
    return raw && typeof raw === 'object' ? [withoutGone(clean(raw, n, ids), (x) => numbers.has(x))] : []
  })
  return sortCards(out.flat())
}

/** How many card files the board reads at once (#458): one at a time, a board of 500 cards took 0.1 s to read. */
const READS_AT_ONCE = 16

/** `fn` on each of `items`, at most `limit` at a time; the results in the items' order. */
async function bounded<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** A card's place on the board: all that placing another card needs of it (#458). */
type CardPlace = Pick<TaskCard, 'number' | 'column' | 'order' | 'archived' | 'project'>
/** A card file's place fields as read, and the file's stamp then (its time, size and file id); null fields: not a card (not JSON). */
interface KnownPlace {
  stamp: string
  raw: Pick<Partial<TaskCard>, 'column' | 'order' | 'archived' | 'project'> & { projectId?: unknown } | null
}
/**
 * Each open board's known places, as of its last read (only what is on it then), by its workspace's lifetime: dropped when
 * the workspace closes, and a read still going then can't keep them (it finds the lifetime over).
 */
const knownPlaces = new WeakMap<AbortSignal, Map<number, KnownPlace>>()

/** Whether a workspace lifetime's board places are kept (for tests). */
export const placesKept = (life: AbortSignal): boolean => knownPlaces.has(life)

/**
 * Every card's place (archived ones too), in board order, for placing a card (#458). Each change that places one did
 * read every card file, one at a time, under the board's lock: N cards created in a row cost about N²/2 reads. A card
 * file is read again only when its stamp has changed since (a write by Hive, another program or the user replaces or
 * changes it); the others are only stat'ed, a few at a time. Each file stays the truth for its card.
 */
export async function boardPlaces(ws: WorkspaceService): Promise<CardPlace[]> {
  if (!ws.path) return []
  // The board and its workspace's lifetime, together before anything is awaited: closed (or switched) meanwhile, what this
  // read finds is never kept, not even under the next lifetime.
  const dir = tasksDir(ws)
  const life = ws.lifetime
  const names = await readdir(dir).catch(() => [] as string[])
  const numbers = names.flatMap((f) => (/^(\d+)\.json$/.test(f) ? [Number(f.slice(0, -5))] : []))
  const ids = await ws.projectIds()
  const was = knownPlaces.get(life)
  const now = new Map<number, KnownPlace>()
  const out = await bounded(numbers, READS_AT_ONCE, async (n): Promise<CardPlace[]> => {
    const file = join(dir, `${n}.json`)
    const st = await stat(file).catch(() => null)
    if (!st?.isFile()) return []
    // Stat'ed before it is read: a change in between is read again next time, as its stamp is newer than the one kept.
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`
    let known = was?.get(n)
    if (known?.stamp !== stamp) {
      // A file that can't be read now (held by another program, gone) has no place this time, as in allTasks, and is
      // read again next time; one that isn't a card (not JSON) is known not to be one until it changes.
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) return []
      let raw: (Partial<TaskCard> & { projectId?: unknown }) | null = null
      try {
        raw = JSON.parse(text)
      } catch {
        // Not a card.
      }
      known = { stamp, raw: raw && typeof raw === 'object' ? { column: raw.column, order: raw.order, archived: raw.archived, project: raw.project, projectId: raw.projectId } : null }
    }
    now.set(n, known)
    if (!known.raw) return []
    const c = clean(known.raw, n, ids)
    return [{ number: n, column: c.column, order: c.order, archived: c.archived, project: c.project }]
  })
  if (!life.aborted) {
    if (!knownPlaces.has(life)) life.addEventListener('abort', () => knownPlaces.delete(life), { once: true })
    knownPlaces.set(life, now)
  }
  return sortCards(out.flat())
}

/** Cards on the board, filtered; with `scope`, only that project's (asking for another project is refused). */
export async function listTasks(opts: { project?: string; column?: TaskColumn; archived?: boolean; scope?: string | null } = {}): Promise<TaskCard[]> {
  const scope = opts.scope ?? null
  if (scope !== null && opts.project !== undefined && opts.project.toLowerCase() !== scope.toLowerCase()) {
    throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.ownCardsOnly', defaultMessage: "You can see only your project's cards ({project}).", description: "An error: an agent asked for another project's cards; it sees only its own project's ({project}, its folder name)." }), { project: scope }))
  }
  return (await allTasks()).filter(
    (c) =>
      (opts.archived === undefined ? !c.archived : c.archived === opts.archived) &&
      (opts.project === undefined || c.project.toLowerCase() === opts.project.toLowerCase()) &&
      (!opts.column || c.column === opts.column) &&
      inScope(c, scope)
  )
}

/** A card, as an actor may see it: a confined agent gets "Unknown task" for another project's. */
export async function readTask(n: number, actor: TaskActor): Promise<TaskCard> {
  const c = await getTask(n)
  if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
  return c
}

/** The cards `refs` names that are outside the scope (another project's, or the workspace's): a confined agent sees only their numbers. */
export async function refsOutside(refs: number[], scope: string | null): Promise<number[]> {
  if (scope === null) return []
  const out: number[] = []
  for (const n of refs) if (!inScope(await getTask(n).catch(() => ({ project: '' })), scope)) out.push(n)
  return out
}

export async function getTask(n: number, ws: WorkspaceService = workspace): Promise<TaskCard> {
  if (!Number.isInteger(n) || n < 1) throw unknownTask(n)
  const raw = await readJson<Partial<TaskCard> | null>(cardFile(n, ws), null)
  if (!raw || typeof raw !== 'object') throw unknownTask(n)
  return withoutGone(clean(raw, n, await ws.projectIds()), (x) => existsSync(cardFile(x, ws)))
}

/**
 * Writes a card (in its lock) with its project's id beside its name (#508). A card whose project the workspace doesn't
 * have now (removed, or renamed before it had an id) keeps the id it was saved with, if any, and never takes another
 * project's: shown as goneProject's while another project has its name, it is saved with that name as it was.
 */
async function saveCard(ws: WorkspaceService, n: number, card: TaskCard): Promise<void> {
  // Who holds it now, for its cost (#602): a hold that ended gets its end, a new one starts.
  trackHolds(card, new Date().toISOString())
  const saved = savedProjectName(card.project)
  let projectId = saved && saved === card.project ? projectIdNamed(await ws.projectIds(), saved) : null
  if (!projectId && saved) {
    const was = await readJson<{ project?: unknown; projectId?: unknown } | null>(cardFile(n, ws), null)
    if (was && isProjectId(was.projectId) && typeof was.project === 'string' && was.project.toLowerCase() === saved.toLowerCase()) projectId = was.projectId
  }
  const { number, title, description, project: _shown, ...rest } = card
  await writeJsonAtomic(cardFile(n, ws), { number, title, description, project: saved, ...(projectId ? { projectId } : {}), ...rest })
}

/** A card file's fields in Hive's order, with its project and id as given (the rest as they were). */
function withProject(raw: Record<string, unknown>, project: string, projectId: string): Record<string, unknown> {
  const { number, title, description, project: _was, projectId: _id, ...rest } = raw
  return { number, title, description, project, projectId, ...rest }
}

/**
 * Each card names its project by id too (#508), once: a card saved before ids (or by an older Hive, which leaves the id
 * out) whose name is a project of the workspace gets that project's id, and a card whose project was renamed or moved
 * since gets its name now. A card with an id no project has (its project removed or gone) is left as it is, and so is one
 * saved before ids under a name no project has (Repair can give those to their project). Under the board's lock, each
 * card in its own, read again there, every field kept; each keeps its content from before beside it once
 * (`<n>.json.before-ids.bak`). Run each time the workspace opens; it changes nothing the second time.
 */
export function stampCardProjects(ws: WorkspaceService): Promise<number> {
  return boardLock(ws, async () => {
    if (!ws.path) return 0
    const ids = await ws.projectIds()
    const names = await readdir(tasksDir(ws)).catch(() => [] as string[])
    let n = 0
    for (const f of names) {
      if (!/^\d+\.json$/.test(f)) continue
      const file = join(tasksDir(ws), f)
      const did = await withFileLock(file, async () => {
        const raw = await readJson<Record<string, unknown> | null>(file, null)
        if (!raw || typeof raw !== 'object' || typeof raw.project !== 'string' || !raw.project) return false
        let next: { project: string; projectId: string } | null = null
        if (isProjectId(raw.projectId)) {
          const now = projectNameOf(ids, raw.projectId)
          if (now && now !== raw.project) next = { project: now, projectId: raw.projectId }
        } else {
          const id = projectIdNamed(ids, raw.project)
          if (id) next = { project: raw.project, projectId: id }
        }
        if (!next) return false
        await keepBeforeIds(file)
        await writeJsonAtomic(file, withProject(raw, next.project, next.projectId))
        return true
      }).catch((e) => {
        log.warn(`giving card ${f} its project's id`, e)
        return false
      })
      if (did) n++
    }
    if (n) {
      log.info(`${n} card(s) now name their project by its id`)
      changed(ws)
    }
    return n
  })
}

/** The cards saved before ids (#508: no projectId in the file), as Repair weighs whose they are: their project's name and agents. */
export async function legacyCards(ws: WorkspaceService): Promise<{ number: number; name: string; agents: string[] }[]> {
  if (!ws.path) return []
  const out: { number: number; name: string; agents: string[] }[] = []
  for (const f of await readdir(tasksDir(ws)).catch(() => [] as string[])) {
    const n = /^(\d+)\.json$/.exec(f)?.[1]
    if (!n) continue
    const raw = await readJson<Record<string, unknown> | null>(join(tasksDir(ws), f), null)
    if (!raw || typeof raw !== 'object' || isProjectId(raw.projectId) || typeof raw.project !== 'string' || !raw.project) continue
    const review = raw.review as { agent?: unknown } | undefined
    const agents = [raw.agent, review?.agent].filter((a): a is string => typeof a === 'string' && !!a)
    out.push({ number: Number(n), name: raw.project, agents })
  }
  return out.sort((a, b) => a.number - b.number)
}

/**
 * Gives cards saved before ids under a project's old name to the project they belong to now (#508, Repair's plan), with
 * its id and a line in each one's history by Repair; nothing else of the card changes (its date neither: nobody edited
 * it, and an archived card's date is when Archived says it was archived). Under the board's lock, each card read again
 * in its own: one with an id, or under another name now, is left as it is. Each keeps its content from before beside it
 * once, as stampCardProjects does. Returns how many moved.
 */
export function moveOrphanCards(ws: WorkspaceService, m: { from: string; to: string; cards: number[] }): Promise<number> {
  return boardLock(ws, async () => {
    const projectId = projectIdNamed(await ws.projectIds(), m.to)
    if (!projectId) throw hiveError(msg({ id: 'tasks.error.repairNoProject', defaultMessage: "{project} isn't a project of the workspace now", description: "An error from Repair: the project {project} (a folder name) it was to give cards to isn't in the workspace any more." }), { project: m.to })
    let n = 0
    for (const x of m.cards) {
      const file = cardFile(x, ws)
      const moved = await withFileLock(file, async () => {
        const raw = await readJson<Record<string, unknown> | null>(file, null)
        if (!raw || typeof raw !== 'object' || isProjectId(raw.projectId) || typeof raw.project !== 'string' || raw.project.toLowerCase() !== m.from.toLowerCase()) return false
        const history = Array.isArray(raw.history) ? raw.history : []
        const entry = entryOf(new Date().toISOString(), BY.repair, storedText(HISTORY.repaired, { from: m.from, to: m.to }))
        await keepBeforeIds(file)
        await writeJsonAtomic(file, { ...withProject(raw, m.to, projectId), history: [...history, entry].slice(-MAX_HISTORY) })
        return true
      })
      if (moved) n++
    }
    if (n) {
      log.info(`Repair gave ${n} card(s) of ${userText(m.from)} to ${userText(m.to)}`)
      changed(ws)
    }
    return n
  })
}

/** The next card number, never reused (board.json keeps it; past every card file, damaged ones too, if it is lost). */
async function nextNumber(ws: WorkspaceService): Promise<number> {
  const file = join(tasksDir(ws), 'board.json')
  return withFileLock(file, async () => {
    const saved = await readJson<{ next?: number }>(file, {})
    const highest = (await readdir(tasksDir(ws)).catch(() => [] as string[])).reduce((m, f) => Math.max(m, Number(/^(\d+)\.json$/.exec(f)?.[1] ?? 0)), 0)
    const n = Math.max(saved.next ?? 1, highest + 1)
    await writeJsonAtomic(file, { version: 1, next: n + 1 })
    return n
  })
}

/** A project of the workspace by folder name ('' for the workspace itself); throws for an unknown one. */
async function projectName(name: string | undefined): Promise<string> {
  const v = (name ?? '').trim()
  if (!v) return ''
  const hit = (await workspace.listProjectPaths()).map((p) => basename(p)).find((p) => p.toLowerCase() === v.toLowerCase())
  if (!hit) throw hiveError(msg({ id: 'tasks.error.unknownProject', defaultMessage: 'Unknown project "{project}"', description: 'An error: the workspace has no project named {project}.' }), { project: v }, { kind: 'notFound' })
  return hit
}

/** An agent of the project, by id or name: its id and name. */
async function agentOf(project: string, agent: string): Promise<{ id: string; name: string }> {
  if (!project) throw hiveError(msg({ id: 'tasks.error.chooseProject', defaultMessage: 'Choose a project before giving the task to an agent.', description: "An error: a card of the whole workspace (no project) can't be given to an agent: agents belong to a project." }), undefined, { kind: 'invalid' })
  const cfg = await workspace.projectConfig(join(workspace.path!, project))
  const a = projectAgents(cfg).find((x) => x.id === agent || x.name.toLowerCase() === agent.toLowerCase())
  if (!a) throw hiveError(UNKNOWN_AGENT, { agent, project }, { kind: 'notFound' })
  return { id: a.id, name: a.name }
}

/** An agent named that the project doesn't have (also taskStart.ts's). */
export const UNKNOWN_AGENT = msg({ id: 'tasks.error.unknownAgent', defaultMessage: 'Unknown agent "{agent}" in {project}', description: 'An error: the project {project} (a folder name) has no agent named {agent}.' })

/** A field of a card, by what its "too long" refusal calls it. */
type TextField = 'title' | 'description' | 'comment' | 'decision' | 'blockedReason'

const text = (v: unknown, max: number, what: TextField): string => {
  const s = String(v ?? '')
  if (s.length > max) {
    throw hiveError(msg({ id: 'tasks.error.tooLong', defaultMessage: '{what, select, title {The title is too long (at most {max, number} characters).} description {The description is too long (at most {max, number} characters).} comment {The comment is too long (at most {max, number} characters).} decision {The decision is too long (at most {max, number} characters).} other {The blocked reason is too long (at most {max, number} characters).}}', description: "An error: a card's field is longer than it may be ({what}, select: its title, description, comment, decision or blocked reason; translate each sentence); {max} is the most characters it takes." }), { what, max }, { kind: 'invalid' })
  }
  return s
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.labelsList', defaultMessage: 'labels must be a list', description: 'An error: the call gave the card\'s labels as something other than a list. "labels" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].map((l) => l.slice(0, 40))
  if (out.length > MAX_LABELS) throw hiveError(msg({ id: 'tasks.error.tooManyLabels', defaultMessage: 'A card can have up to {max} labels.', description: 'An error: a card was given more labels than it may have ({max}, a number).' }), { max: MAX_LABELS }, { kind: 'invalid' })
  return out
}

/**
 * The cards a list names (blockedBy, links), checked. A confined agent can only name its project's cards; when it
 * changes a card's list, the cards from other projects already on it (`kept`, which it sees only as numbers) stay.
 */
async function cardRefs(v: unknown, self: number | null, what: 'blockedBy' | 'links', scope: string | null = null, kept: number[] = []): Promise<number[]> {
  // `what` is the call's field, named as it is in every language.
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.refsList', defaultMessage: '{field} must be a list of card numbers', description: 'An error: the call gave {field} (the name of its field: blockedBy or links, kept as it is) as something other than a list of card numbers.' }), { field: what })
  const nums = [...new Set(v.map((x) => Number(String(x).replace(/^#/, ''))))]
  const hidden = await refsOutside(kept, scope)
  const noCard = (n: number): HiveError => hiveError(msg({ id: 'tasks.error.refsNoCard', defaultMessage: '{field}: there is no card #{n}', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) names card #{n} (a number), which there is not.' }), { field: what, n }, { kind: 'invalid' })
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1) throw hiveError(msg({ id: 'tasks.error.refsNotNumber', defaultMessage: '{field}: "{value}" is not a card number', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) has {value} in it, which is not a card number.' }), { field: what, value: String(n) }, { kind: 'invalid' })
    if (n === self) throw hiveError(msg({ id: 'tasks.error.refsSelf', defaultMessage: "{field}: a card can't refer to itself", description: "An error: the list {field} (the name of the call's field: blockedBy or links, kept as it is) names the card itself." }), { field: what }, { kind: 'invalid' })
    if (!existsSync(cardFile(n))) throw noCard(n)
    if (!hidden.includes(n) && !inScope(await getTask(n), scope)) throw noCard(n)
  }
  return [...nums, ...hidden.filter((n) => !nums.includes(n))]
}

/** The order that puts a card before `before` in `column` (at the end without one). */
function orderIn(cards: CardPlace[], column: TaskColumn, self: number | null, before: number | null | undefined): number {
  const list = cards.filter((c) => c.column === column && !c.archived && c.number !== self)
  const i = before ? list.findIndex((c) => c.number === before) : -1
  if (i < 0) return (list.length ? Math.max(...list.map((c) => c.order)) : 0) + 1
  const prev = i > 0 ? list[i - 1].order : list[i].order - 2
  return (prev + list[i].order) / 2
}

/**
 * On Hold is the user's and the Assistant's (#170): parked work nobody picks up. A project agent (its own token) can't
 * park a card, by a move or by creating it there; taking one out (the user asked it to work on it) is a move like any.
 */
function checkHold(column: TaskColumn, actor: TaskActor, n?: number): void {
  if (column !== 'hold' || actor.kind !== 'agent' || !actor.self) return
  throw new TaskPermissionError(
    n
      ? withValues(msg({ id: 'tasks.error.holdCard', defaultMessage: 'Only the user or the Assistant puts cards On Hold: ask the user to park #{n}.', description: 'An error: an agent tried to move card #{n} (a number) On Hold (a board column), which only the user or the Assistant may do.' }), { n })
      : msg({ id: 'tasks.error.holdNew', defaultMessage: 'Only the user or the Assistant puts cards On Hold: ask the user to park it.', description: 'An error: an agent tried to add a card On Hold (a board column), which only the user or the Assistant may do.' })
  )
}

/**
 * Where a change puts a card in `column`: before a card, at the top or bottom, or (without either) at the end. An
 * agent's or the Assistant's explicit placement is checked (the card it names has to be in the column; never in
 * Done) and, when it moves the card, says so for the history; the user's drags are saved quietly.
 */
function placement(all: CardPlace[], card: TaskCard, column: TaskColumn, patch: TaskPatch, actor: TaskActor): { order: number; said?: StoredText } {
  const { before, position } = patch
  const placed = (before !== undefined && before !== null) || position !== undefined
  if (position !== undefined && position !== 'top' && position !== 'bottom') throw hiveError(msg({ id: 'tasks.error.unknownPosition', defaultMessage: 'Unknown position "{position}": top or bottom.', description: 'An error: the call\'s position was {position}, which it doesn\'t take. "top" and "bottom" are the values it takes: keep them as they are.' }), { position: String(position) }, { kind: 'invalid' })
  if (placed && before !== undefined && before !== null && position !== undefined) throw hiveError(msg({ id: 'tasks.error.beforeOrPosition', defaultMessage: 'Give before or position, not both.', description: 'An error: the call gave both of its fields "before" and "position" (keep them as they are), which place a card in two ways.' }), undefined, { kind: 'invalid' })
  const list = all.filter((c) => c.column === column && !c.archived && c.number !== card.number)
  // A confined agent places its card among its project's cards: the top and bottom of those, never past another project's.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  if (placed && actor.kind !== 'user') {
    if (column === 'done') throw new TaskPermissionError(ERR.onlyUserDone)
    if (before != null && !own.some((c) => c.number === before)) {
      const other = all.find((c) => c.number === before && inScope(c, scope))
      if (before === card.number) throw hiveError(msg({ id: 'tasks.error.beforeItself', defaultMessage: "A card can't go before itself.", description: 'An error: a card was to be placed just above itself.' }), undefined, { kind: 'invalid' })
      if (!other) throw hiveError(ERR.noCard, { n: before }, { kind: 'invalid' })
      // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
      if (other.archived) throw hiveError(msg({ id: 'tasks.error.beforeArchived', defaultMessage: "#{before} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: #{n} can only go before a card in the column it's in.", description: 'An error: card #{n} was to be placed just above card #{before} (numbers), which is archived, not in the column {column} (select: a board column; translate each).' }), { before, column, n: card.number }, { kind: 'conflict' })
      throw hiveError(msg({ id: 'tasks.error.beforeElsewhere', defaultMessage: "#{before} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: #{n} can only go before a card in the column it's in.", description: 'An error: card #{n} was to be placed just above card #{before} (numbers), which is in the column {other}, not in {column} (select: board columns; translate each).' }), { before, other: other.column, column, n: card.number }, { kind: 'invalid' })
    }
  }
  const order =
    scope !== null && position === 'top'
      ? orderIn(all, column, card.number, own[0]?.number ?? null)
      : scope !== null && position === 'bottom'
        ? orderIn(all, column, card.number, own.length ? (list[list.indexOf(own[own.length - 1]) + 1]?.number ?? null) : null)
        : position === 'top'
          ? list.length
            ? list[0].order - 1
            : 1
          : orderIn(all, column, card.number, position === 'bottom' ? null : before)
  if (!placed || actor.kind === 'user') return { order }
  const moved = column !== card.column
  // Within its column, a placement that leaves it where it was isn't worth a line.
  const rank = (o: number): number => sortCards([...list, { ...card, column, order: o }]).findIndex((c) => c.number === card.number)
  if (!moved && rank(card.order) === rank(order)) return { order }
  const said =
    position === 'top'
      ? storedText(HISTORY.movedTop, { column })
      : position === 'bottom'
        ? storedText(HISTORY.movedBottom, { column })
        : moved
          ? storedText(HISTORY.movedBefore, { column, before: before! })
          : storedText(HISTORY.movedBeforeIn, { column, before: before! })
  return { order, said }
}

/**
 * Puts cards at the top of a column in the order given; the column's other cards keep their order below them. The
 * listed cards have to be in that column already (this never moves cards between columns), and only the user puts
 * Done in order. An agent's or the Assistant's list adds a line to each card it moved.
 */
export function reorderTasks(column: TaskColumn, numbers: unknown, actor: TaskActor): Promise<TaskCard[]> {
  return boardLock(workspace, () => reorderTasksLocked(column, numbers, actor))
}

async function reorderTasksLocked(column: TaskColumn, numbers: unknown, actor: TaskActor): Promise<TaskCard[]> {
  if (!isTaskColumn(column)) throw unknownColumn(column)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(ERR.onlyUserDone)
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.orderNone', defaultMessage: 'cards: list the card numbers in the order wanted.', description: 'An error: a call to put cards in order listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > 500) throw hiveError(ERR.cardsTooMany, { max: 500 }, { kind: 'invalid' })
  const nums = checkedNumbers(numbers)
  const ws = workspace
  const by = actorName(actor)
  const W = COLUMN_WORD[column]
  const all = await boardPlaces(ws)
  const list = all.filter((c) => c.column === column && !c.archived)
  // A confined agent orders its project's cards only, and they stay where the project's cards are in the column.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  for (const x of nums) {
    if (own.some((c) => c.number === x)) continue
    const other = all.find((c) => c.number === x && inScope(c, scope))
    if (!other) throw hiveError(ERR.noCard, { n: x }, { kind: 'invalid' })
    // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
    if (other.archived) throw hiveError(msg({ id: 'tasks.error.orderArchived', defaultMessage: '#{n} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card #{n} (a number) was listed to be put in order in the column {column}, but it is archived (select: a board column; translate each).' }), { n: x, column }, { kind: 'conflict' })
    throw hiveError(msg({ id: 'tasks.error.orderElsewhere', defaultMessage: '#{n} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card #{n} (a number) was listed to be put in order in the column {column}, but it is in the column {other} (select: board columns; translate each).' }), { n: x, other: other.column, column }, { kind: 'invalid' })
  }
  // The listed cards take the place of the first of the cards in view, in the order given; the rest keep theirs below.
  const first = own[0]
  const above = list[list.indexOf(first) - 1]
  const orderAt = (i: number): number => (above ? above.order + ((first.order - above.order) * (i + 1)) / (nums.length + 1) : first.order - nums.length + i)
  for (const [i, x] of nums.entries()) {
    const was = own.findIndex((c) => c.number === x)
    await withFileLock(cardFile(x, ws), async () => {
      const card = await getTask(x, ws)
      // Every write is the caller's to make on the card as it is now: moved to another project since the list was
      // read, it is unknown to a confined agent (its order and history stay as they are).
      if (!inScope(card, scope)) throw unknownTask(x)
      // Moved or archived since the list was read: the order asked for no longer holds.
      if (card.column !== column || card.archived) throw hiveError(msg({ id: 'tasks.error.orderChanged', defaultMessage: '#{n} changed while the cards were being put in order; read the board again.', description: 'An error: card #{n} (a number) moved or was archived while the cards were being put in order, so the order asked for no longer holds.' }), { n: x }, { kind: 'conflict' })
      card.order = orderAt(i)
      if (was !== i && actor.kind !== 'user') note(card, by, i === 0 ? storedText(HISTORY.movedTop, { column }) : storedText(HISTORY.placed, { place: i + 1, column }))
      await saveCard(ws, x, card)
    }).catch((e) => {
      if (i) changed(ws)
      throw e
    })
  }
  log.info(`${W} put in order by ${userText(by)}: ${nums.map((x) => `#${x}`).join(', ')}`)
  changed(ws)
  return (await allTasks(ws)).filter((c) => c.column === column && !c.archived && inScope(c, scope))
}

/** Words quoted in a history line, cut short. */
const clip = (s: string, max = 80): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A history line's English, from its message and values: what agents read and Hive's own code matches (`what`). */
const englishSaid = (s: StoredText): string => {
  const t = storedLineText(s, (m, values) => englishText(values ? withValues(m, values) : m), providerMessage)
  if (t === null) throw new Error(`No history line ${s.id}`) // i18n-ignore: a mistake in Hive's code, never shown
  return t
}

/**
 * A line in the card's history: its English (`what`), and as data (`whatText`, #846) for the window to show in its
 * language. Text from elsewhere (an agent-facing note, noteOnCard) is kept in English only.
 */
function note(card: TaskCard, by: string, said: StoredText | string): void {
  const at = new Date().toISOString()
  card.history = [...card.history, entryOf(at, by, said)].slice(-MAX_HISTORY)
  card.updatedAt = at
}

const entryOf = (at: string, by: string, said: StoredText | string): TaskHistoryEntry =>
  typeof said === 'string' ? { at, by, what: said, id: entryId() } : { at, by, what: englishSaid(said), whatText: said, id: entryId() }

/** Column names in English, for the log. */
const COLUMN_WORD = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>

const unknownColumn = (column: unknown): HiveError => hiveError(ERR.unknownColumn, { column: String(column), choices: COLUMN_CHOICES }, { kind: 'invalid' })

/** Card numbers as a call lists them ("#3" or 3), each checked: a whole number, listed once. */
function checkedNumbers(numbers: unknown[]): number[] {
  const nums = numbers.map((x) => Number(String(x).replace(/^#/, '')))
  const seen = new Set<number>()
  for (const x of nums) {
    if (!Number.isInteger(x) || x < 1) throw hiveError(ERR.cardsNotNumber, { value: String(x) }, { kind: 'invalid' })
    if (seen.has(x)) throw hiveError(ERR.cardsTwice, { n: x }, { kind: 'invalid' })
    seen.add(x)
  }
  return nums
}

/** Who can return a failed card for review: its own agent (its hive tools, or the Agent API with its token) or the user. */
const returnsCard = (actor: TaskActor, card: TaskCard): boolean => actor.kind === 'user' || (actor.kind === 'agent' && !!card.agent && actor.self?.agentId === card.agent)

export function createTask(...args: Parameters<typeof createTaskLocked>): Promise<TaskCard> {
  return boardLock(workspace, () => createTaskLocked(...args))
}

async function createTaskLocked(
  input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; blocked?: string | null; blockedBy?: number[]; links?: number[] },
  actor: TaskActor
): Promise<TaskCard> {
  if (!workspace.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const title = text(input.title, MAX_TITLE, 'title').trim()
  if (!title) throw hiveError(ERR.needsTitle, undefined, { kind: 'invalid' })
  const column = input.column ?? 'todo'
  if (!isTaskColumn(column)) throw unknownColumn(column)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserDone', defaultMessage: 'Only the user puts cards in Done.', description: 'An error: an agent or the Assistant tried to add a card straight into Done (a board column), which only the user does.' }))
  checkHold(column, actor)
  // A confined agent's cards are its project's (by default too); never another project's or the workspace's.
  const scope = scopeOf(actor)
  const project = await projectName(scope !== null && input.project === undefined ? scope : input.project)
  if (!inScope({ project }, scope)) throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.addOwnOnly', defaultMessage: 'You can add cards only to your project ({project}).', description: "An error: an agent tried to add a card to another project, or to the whole workspace; it adds cards only to its own project ({project}, its folder name)." }), { project: scope ?? '' }))
  // An agent that puts a new card straight into Doing, naming no agent, is taking it.
  const own = column === 'doing' && input.agent === undefined ? selfIn(actor, project) : null
  const agent = input.agent ? await agentOf(project, input.agent) : own ? await agentOf(project, own) : null
  const ws = workspace
  await mkdir(tasksDir(ws), { recursive: true })
  const by = actorName(actor)
  const now = new Date().toISOString()
  const blockedBy = input.blockedBy ? await cardRefs(input.blockedBy, null, 'blockedBy', scope) : []
  const links = input.links ? await cardRefs(input.links, null, 'links', scope) : []
  const n = await nextNumber(ws)
  const card: TaskCard = {
    number: n,
    title,
    description: text(input.description, MAX_TEXT, 'description'),
    project,
    agent: agent?.id ?? null,
    ...(agent ? { agentName: agent.name } : {}),
    column,
    order: orderIn(await boardPlaces(ws), column, null, null),
    labels: input.labels ? labelsOf(input.labels) : [],
    blocked: input.blocked?.trim() ? text(input.blocked.trim(), 1000, 'blockedReason') : null,
    blockedBy,
    links,
    comments: [],
    history: [entryOf(now, by, storedText(HISTORY.created, { column }))],
    archived: false,
    createdAt: now,
    createdBy: by,
    updatedAt: now
  }
  await saveCard(ws, n, card)
  log.info(`#${n} created by ${userText(by)}: ${userText(title)}`)
  changed(ws)
  return card
}

/**
 * Changes a card. Anyone moves it between columns, Done included (each move is in its history, with who made it),
 * except into On Hold (the user's and the Assistant's); putting Done in order is the user's. An archived card only
 * changes once the user brings it back.
 */
/**
 * Changes a card. `comment` is the same call's comment (the hive tools' and PATCH's): saved with the change in one write,
 * so nothing that reads the card meanwhile (a card watch waking its agent, the board) sees the move without it.
 */
export function updateTask(...args: Parameters<typeof updateTaskLocked>): Promise<TaskCard> {
  return boardLock(workspace, () => updateTaskLocked(...args))
}

async function updateTaskLocked(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[]; comment?: string; commit?: () => void } = {}): Promise<TaskCard> {
  const ws = workspace
  const by = actorName(actor)
  const comment = opts.comment === undefined ? null : commentText(opts.comment)
  let handoff: LoopEvent['kind'] | null = null
  const result = await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    const scope = scopeOf(actor)
    if (!inScope(card, scope)) throw unknownTask(n)
    // The caller's own conditions, on the card as it is now (Start: not archived or done meanwhile).
    opts.check?.(card)
    if (card.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { n }))
    // A card in Doing with another agent is that agent's work in progress: a project agent can't move it on to Review or
    // Done (a reviewer whose review ended when it came back for more work, say). Checked on the card as it is, before
    // anything else in the change (giving it to itself in the same call doesn't get round it). A project agent is one
    // calling with its own token (actor.self); the user, the Assistant and scripts with the workspace token can.
    // A review verdict or start is refused on a card in Doing anyway (reviewChange), with its own reason.
    const moving = patch.review === undefined && (patch.column === 'review' || patch.column === 'passed' || patch.column === 'done')
    if (actor.kind === 'agent' && actor.self && moving && card.column === 'doing' && card.agent && card.agent !== actor.self.agentId) {
      const column = patch.column!
      throw new TaskConflictError(
        card.agentName
          ? withValues(msg({ id: 'tasks.error.inDoingWith', defaultMessage: "#{n} is in Doing with {agent}, who is working on it: newer work is in progress, so it can't be moved to {column, select, review {Review} passed {Passed} done {Done} other {{column}}} by another agent. Leave it where it is; {agent} moves it to Review when done, and the user can move it.", description: 'An error: an agent tried to move card #{n} (a number) on to {column} (select: a board column; translate each), but the card is in Doing with another agent ({agent}, its name), whose work is in progress. Doing and Review are board columns.' }), { n, agent: card.agentName, column })
          : withValues(msg({ id: 'tasks.error.inDoingWithAnother', defaultMessage: "#{n} is in Doing with another agent, who is working on it: newer work is in progress, so it can't be moved to {column, select, review {Review} passed {Passed} done {Done} other {{column}}} by another agent. Leave it where it is; another agent moves it to Review when done, and the user can move it.", description: "An error: an agent tried to move card #{n} (a number) on to {column} (select: a board column; translate each), but the card is in Doing with another agent (whose name isn't known), whose work is in progress. Doing and Review are board columns." }), { n, column })
      )
    }
    const said: StoredText[] = []
    // Whether a move to Review returns a failed card for review (#214): decided on the card as it is before this change,
    // by whoever has it now, so giving it to the caller in the same change never makes it the caller's to return.
    const returning = patch.column === 'review' && patch.review === undefined && returnsCard(actor, card) ? returnRound(card) : null
    const { agent: hadAgent, project: hadProject } = card
    // A card moved within its column: saved, but not worth a line in its history.
    let reordered = false
    let transferred = false
    if (patch.title !== undefined) {
      const t = text(patch.title, MAX_TITLE, 'title').trim()
      if (!t) throw hiveError(ERR.needsTitle, undefined, { kind: 'invalid' })
      if (t !== card.title) said.push(storedText(HISTORY.renamed, { title: t }))
      card.title = t
    }
    if (patch.description !== undefined) {
      const d = text(patch.description, MAX_TEXT, 'description')
      if (d !== card.description) said.push(storedText(HISTORY.description))
      card.description = d
    }
    if (patch.project !== undefined) {
      const p = await projectName(patch.project)
      if (!inScope({ project: p }, scope)) throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.staysInProject', defaultMessage: 'Cards stay in your project ({project}).', description: "An error: an agent tried to move a card to another project, or to the whole workspace; its cards stay in its own project ({project}, its folder name)." }), { project: scope ?? '' }))
      if (p !== card.project) {
        // A card that changes project always leaves its agent (of the old project): giving it to one of the new
        // project's agents is a change of its own, after this one.
        if (patch.agent) throw hiveError(msg({ id: 'tasks.error.projectThenAgent', defaultMessage: 'Move the card to the other project first, then give it to one of its agents.', description: "An error: one change both moved a card to another project and gave it to an agent; those are two changes, in that order." }), undefined, { kind: 'invalid' })
        said.push(p ? storedText(HISTORY.toProject, { project: p }) : storedText(HISTORY.toWorkspace))
        if (card.agent) said.push(card.project ? storedText(HISTORY.takenFromOf, { agent: card.agentName ?? card.agent, project: card.project }) : storedText(HISTORY.takenFromOfWorkspace, { agent: card.agentName ?? card.agent }))
        if (card.review) {
          said.push(storedText(HISTORY.reviewStopped, { agent: card.review.agentName }))
          delete card.review
        }
        card.project = p
        card.agent = null
        delete card.agentName
        transferred = true
      }
    }
    // An agent that moves a card into Doing from another column, naming no agent, is taking it (not in a project
    // change): also from another agent, who wasn't working on it since it wasn't in Doing ("Given to …" in its history).
    const own = !transferred && patch.agent === undefined && patch.column === 'doing' && card.column !== 'doing' ? selfIn(actor, card.project) : null
    const agent = patch.agent !== undefined ? patch.agent : (own ?? undefined)
    if (agent !== undefined && !(transferred && !agent)) {
      if (agent) {
        const a = await agentOf(card.project, agent)
        if (a.id !== card.agent) said.push(storedText(HISTORY.given, { agent: a.name }))
        card.agent = a.id
        card.agentName = a.name
      } else if (card.agent) {
        said.push(card.agentName ? storedText(HISTORY.takenFrom, { agent: card.agentName }) : storedText(HISTORY.takenFromAgent))
        card.agent = null
        delete card.agentName
      }
    }
    // A review renewed by its reviewer changes the card (when it started) without a line in its history: saved too.
    const reviewed = patch.review !== undefined && (await reviewChange(card, patch, actor, said))
    if (patch.column !== undefined || patch.before !== undefined || patch.position !== undefined) {
      const column = patch.column ?? card.column
      if (!isTaskColumn(column)) throw unknownColumn(column)
      if (column !== card.column) checkHold(column, actor, n)
      const place = placement(await boardPlaces(ws), card, column, patch, actor)
      if (column !== card.column) said.push(place.said ?? storedText(HISTORY.moved, { column }))
      else {
        // Moved to Review by its agent (or the user, on the board) while still there after a failed review: returned for
        // its next round, which wakes a reviewer waiting for it to come back (#214). Not when this change also gives it to
        // another agent or project (that starts a new round of its own); any other move in place is no change.
        if (returning && card.agent === hadAgent && card.project === hadProject) said.push(storedText(HISTORY.returned, { round: returning }))
        if (place.said) said.push(place.said)
      }
      // A review is of the card in Review: moved on without a verdict, it stops.
      if (card.review && column !== 'review') {
        said.push(storedText(HISTORY.reviewStopped, { agent: card.review.agentName }))
        delete card.review
      }
      const order = place.order
      reordered = order !== card.order
      card.order = order
      card.column = column
    }
    if (patch.decision !== undefined) {
      // Recorded by whoever calls (the user, the Assistant, an agent), decided by the user: agents only write down what
      // the user decided (their tool's description says so). Editing or removing one is the user's (editDecision).
      const t = text(patch.decision, MAX_DECISION, 'decision').trim()
      if (!t) throw hiveError(ERR.emptyDecision)
      const list = card.decisions ?? []
      if (list.length >= MAX_DECISIONS) throw hiveError(msg({ id: 'tasks.error.tooManyDecisions', defaultMessage: 'A card can have up to {max} decisions.', description: 'An error: a card already has as many decisions as it may have ({max}, a number).' }), { max: MAX_DECISIONS })
      card.decisions = [...list, { id: entryId(), text: t, decidedBy: 'user', recordedBy: by, at: new Date().toISOString() }]
      said.push(storedText(HISTORY.decision, { decision: clip(t) }))
    }
    if (patch.labels !== undefined) {
      card.labels = labelsOf(patch.labels)
      said.push(card.labels.length ? storedText(HISTORY.labels, { labels: card.labels.join(', ') }) : storedText(HISTORY.labelsRemoved))
    }
    if (patch.blocked !== undefined) {
      const b = patch.blocked?.trim() ? text(patch.blocked.trim(), 1000, 'blockedReason') : null
      if (b !== card.blocked) said.push(b ? storedText(HISTORY.blocked, { reason: b }) : storedText(HISTORY.unblocked))
      card.blocked = b
    }
    if (patch.blockedBy !== undefined) {
      card.blockedBy = await cardRefs(patch.blockedBy, n, 'blockedBy', scope, card.blockedBy)
      said.push(card.blockedBy.length ? storedText(HISTORY.dependsOn, { cards: card.blockedBy.map((x) => `#${x}`).join(', ') }) : storedText(HISTORY.noDependencies))
    }
    if (patch.links !== undefined) {
      card.links = await cardRefs(patch.links, n, 'links', scope, card.links)
      said.push(card.links.length ? storedText(HISTORY.linked, { cards: card.links.map((x) => `#${x}`).join(', ') }) : storedText(HISTORY.linksRemoved))
    }
    // What changed, in the history's words (English), for a caller that confirms it (the hive tools' short replies).
    opts.said?.push(...said.map(englishSaid))
    if (!said.length && !reordered && !reviewed && !comment) return card
    for (const s of said) note(card, by, s)
    if (comment) addComment(card, by, comment)
    // The last thing before the write, after every read above: a caller whose authority can change while those awaits run
    // (the Assistant's control and session) checks it here, so a revoked change saves nothing. Unlike `check`, it doesn't
    // see the card as it was before this change.
    opts.commit?.()
    await saveCard(ws, n, card)
    handoff = said.some((x) => x.id === HISTORY.reviewPassed.id || x.id === HISTORY.reviewFailed.id) ? 'verdict' : said.some(intoReview) ? 'review' : null
    return card
  })
  changed(ws)
  if (handoff) {
    try {
      loopEvents?.({ ws, card: result, kind: handoff, actor })
    } catch (e) {
      log.warn('a loop handoff', e)
    }
  }
  return result
}

/** A batch changes at most this many cards (its reply names each one). */
export const MAX_CHANGE_BATCH = 100

/** The fields a batch sets on every card it names (hive_update_tasks): comments, decisions and titles stay on the single call. */
export type BatchPatch = Pick<TaskPatch, 'column' | 'position' | 'blocked' | 'labels' | 'agent'>

/** What a batch did with one card: its change's history lines, or why it was refused (the card left as it was). */
export interface BatchItem {
  number: number
  card: TaskCard | null
  said: string[]
  error: string | null
}

/** The card numbers of a batch: at least one, at most MAX_CHANGE_BATCH, each once. Checked before anything changes or is counted. */
export function batchNumbers(numbers: unknown): number[] {
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.changeNone', defaultMessage: 'cards: list the card numbers to change.', description: 'An error: a call to change several cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_CHANGE_BATCH) throw hiveError(ERR.cardsTooMany, { max: MAX_CHANGE_BATCH }, { kind: 'invalid' })
  return checkedNumbers(numbers)
}

/**
 * Changes many cards with the same fields, in the order given. Each card goes through updateTask: under its own lock,
 * authorised against the card as it is then, with the same refusals and history lines as a single call. A refused card
 * (unknown, another project's, archived, in Doing with another agent, say) is left as it was and the others still apply:
 * each card is all or nothing, the batch is not. Its error is the one a missing card gets, so it reveals no more.
 * Position applies to each card in turn, so the last listed ends at the top (or bottom): hive_reorder_tasks sets an order.
 */
export async function updateTasks(numbers: number[], patch: BatchPatch, actor: TaskActor, opts: { commit?: () => void } = {}): Promise<BatchItem[]> {
  const items: BatchItem[] = []
  for (const n of numbers) {
    const said: string[] = []
    try {
      const card = await updateTask(n, patch, actor, { said, commit: opts.commit })
      items.push({ number: n, card, said, error: null })
    } catch (e) {
      items.push({ number: n, card: null, said: [], error: (e as Error).message })
    }
  }
  return items
}

/**
 * A review (TaskPatch.review): the calling agent marks the card in Review that it reviews ("start"; the card keeps the
 * agent that did the work), or ends its review with a verdict ("passed", "failed"). One reviewer at a time: another
 * is refused, naming it; the same agent starting again only renews its mark. A verdict is only for the review the
 * caller has going on the card now: once the card has moved on (out of Review, say, for fixes, which ends the review)
 * an old verdict can't settle newer work. The user, the Assistant and scripts don't review through this (they have no
 * agent of the project to mark the card with). Returns whether the card changed (a renewal changes it without a line in
 * its history). Runs under the card's lock, with the card as it is now.
 */
async function reviewChange(card: TaskCard, patch: TaskPatch, actor: TaskActor, said: StoredText[]): Promise<boolean> {
  const me = selfIn(actor, card.project)
  if (!me) throw new TaskPermissionError(msg({ id: 'tasks.error.reviewAgentsOnly', defaultMessage: "Only an agent of the card's project reviews it, through its own hive tools.", description: "An error: the user, the Assistant or a script tried to start or end a card's review; only an agent of the card's project does that, with its hive tools (a name: keep it)." }))
  const since = (r: NonNullable<TaskCard['review']>): string => r.since.slice(0, 16).replace('T', ' ')
  const n = card.number
  if (patch.review === 'start') {
    if (patch.column !== undefined || patch.agent !== undefined) throw hiveError(msg({ id: 'tasks.error.reviewOnItsOwn', defaultMessage: 'Start a review on its own: the card stays where it is, with its agent.', description: 'An error: a call started a review and also moved the card or gave it to an agent; a review starts on its own.' }))
    if (card.column !== 'review') throw hiveError(msg({ id: 'tasks.error.reviewNotInReview', defaultMessage: '#{n} is in {column, select, hold {On Hold} todo {Todo} doing {Doing} passed {Passed} done {Done} other {{column}}}. A card is reviewed in Review; if it needs more work, that is work on it (move it to doing).', description: 'An error: an agent tried to review card #{n} (a number), which is in the column {column} (select: a board column; translate each), not in Review. "doing" is the value the call takes: keep it as it is.' }), { n, column: card.column })
    if (card.review && card.review.agent !== me) throw hiveError(msg({ id: 'tasks.error.reviewTaken', defaultMessage: '{agent} is already reviewing #{n} (since {since} UTC).', description: 'An error: another agent ({agent}, its name) is already reviewing card #{n} (a number), since {since} (a date and time, UTC).' }), { agent: card.review.agentName, n, since: since(card.review) })
    const a = await agentOf(card.project, me)
    if (!card.review) said.push(storedText(HISTORY.reviewStarted))
    card.review = { agent: a.id, agentName: a.name, since: new Date().toISOString() }
    return true
  }
  if (patch.review !== 'passed' && patch.review !== 'failed') throw hiveError(msg({ id: 'tasks.error.unknownReview', defaultMessage: 'Unknown review "{review}": start, passed or failed.', description: 'An error: the call\'s review was {review}, which it doesn\'t take. "start", "passed" and "failed" are the values it takes: keep them as they are.' }), { review: String(patch.review) })
  // A failed card stays in Review for its fixes: never on to Passed or Done with its verdict.
  if (patch.review === 'failed' && patch.column !== undefined && patch.column !== 'review') throw hiveError(msg({ id: 'tasks.error.failedStays', defaultMessage: 'A failed review leaves #{n} in Review: give the verdict without column.', description: 'An error: a failed review also moved card #{n} (a number) out of Review; a failed card stays in Review. "column" is the name of the call\'s field: keep it as it is.' }), { n }, { kind: 'invalid' })
  if (card.review && card.review.agent !== me) throw hiveError(msg({ id: 'tasks.error.verdictNotYours', defaultMessage: '{agent} is reviewing #{n}: its verdict is its own.', description: "An error: an agent tried to give a verdict on card #{n} (a number), which another agent ({agent}, its name) is reviewing." }), { agent: card.review.agentName, n })
  if (!card.review || card.column !== 'review') {
    throw hiveError(msg({ id: 'tasks.error.notReviewing', defaultMessage: 'You aren\'t reviewing #{n} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.', description: 'An error: an agent tried to give a verdict on card #{n} (a number), but it has no review going on it. "review" and "start" are the call\'s field and value: keep them as they are.' }), { n })
  }
  said.push(storedText(patch.review === 'passed' ? HISTORY.reviewPassed : HISTORY.reviewFailed))
  delete card.review
  return true
}

/**
 * Notes on a card something Hive did about it without changing it (#420: an agent's watch on it ended), as Hive: English
 * text (kept as it is), or a message of the card history's (shared/taskHistory.ts), which the window shows in its language.
 */
export async function noteOnCard(n: number, what: string | StoredText, ws: WorkspaceService = workspace): Promise<void> {
  await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    note(card, BY.hive, what)
    await saveCard(ws, n, card)
  })
  changed(ws)
}

/**
 * A comment from Hive itself on a card (#606: its agent's model changed after a safeguard stop), for whoever reads the
 * card. `still`: whether the card, as it is under its lock, is still the one meant (its column, project and agent may
 * have changed since it was chosen). True when it was written. `said`: English text, or a message of the card history's
 * (shared/taskHistory.ts), kept as its English (`text`) and as data (`hiveText`, #846) for the window to show in its language.
 */
export async function commentAsHive(n: number, said: string | StoredText, ws: WorkspaceService = workspace, still: (card: TaskCard) => boolean = () => true): Promise<boolean> {
  const done = await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    if (card.archived || !still(card)) return false
    addComment(card, BY.hive, typeof said === 'string' ? said : englishSaid(said), typeof said === 'string' ? undefined : said)
    await saveCard(ws, n, card)
    return true
  })
  if (done) changed(ws)
  return done
}

/** Why an agent's reviews stop, as its callers say it (in English), and its key in the history line's message. */
export type ReviewEnd = 'its session ended' | 'the agent was removed'
const REVIEW_END: Record<ReviewEnd, string> = { 'its session ended': 'sessionEnded', 'the agent was removed': 'agentRemoved' }

/**
 * Stops the reviews an agent has going (its session ended, or it was removed), so a card never shows a reviewer that
 * has gone. A review started again meanwhile by another agent is left alone.
 */
export async function endReviews(project: string, agentId: string, why: ReviewEnd, ws: WorkspaceService = workspace): Promise<number[]> {
  const mine = (await allTasks(ws)).filter((c) => c.review?.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
  const out: number[] = []
  for (const c of mine) {
    const ended = await withFileLock(cardFile(c.number, ws), async () => {
      const card = await getTask(c.number, ws)
      if (card.review?.agent !== agentId) return false
      note(card, BY.hive, storedText(HISTORY.reviewEnded, { agent: card.review.agentName, why: REVIEW_END[why] }))
      delete card.review
      await saveCard(ws, c.number, card)
      return true
    }).catch((e) => {
      log.warn(`Could not end the review of #${c.number}`, e)
      return false
    })
    if (ended) out.push(c.number)
  }
  if (out.length) changed(ws)
  return out
}

/**
 * A card's newest comment (the last one added; comments are kept in the order they were added, so equal times
 * don't matter), or null when it has none. Read as `readTask` reads: a confined agent can't read another project's.
 */
export async function latestComment(n: number, actor: TaskActor): Promise<{ number: number; comment: TaskComment | null }> {
  const c = await readTask(n, actor)
  const last = c.comments.at(-1)
  return { number: c.number, comment: last ? withoutId(last) : null }
}

/** A comment or history entry as callers see it: its id is the card watches' (#224). */
export const withoutId = <T extends { id?: string }>({ id: _id, ...rest }: T): Omit<T, 'id'> => rest

/** A comment's text, checked: within the limit and not empty. */
function commentText(comment: string): string {
  const t = text(comment, MAX_TEXT, 'comment').trim()
  if (!t) throw hiveError(msg({ id: 'tasks.error.emptyComment', defaultMessage: 'The comment is empty.', description: 'An error: a comment on a card has no text.' }), undefined, { kind: 'invalid' })
  return t
}

/** Adds a comment; one Hive writes itself can carry its text as data (`hiveText`) beside its English. */
function addComment(c: TaskCard, by: string, t: string, hiveText?: StoredText): void {
  const at = new Date().toISOString()
  c.comments = [...c.comments, { at, by, text: t, ...(hiveText ? { hiveText } : {}), id: entryId() }].slice(-MAX_COMMENTS)
  c.updatedAt = at
}

export async function commentTask(n: number, comment: string, actor: TaskActor): Promise<TaskCard> {
  const ws = workspace
  const t = commentText(comment)
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    if (c.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { n }))
    addComment(c, actorName(actor), t)
    await saveCard(ws, n, c)
    return c
  })
  changed(ws)
  return card
}

/**
 * Changes the words of one of a card's decisions, or removes it (text null): the user's alone (#357). Agents and the
 * Assistant only record decisions; the history keeps what each said.
 */
export async function editDecision(n: number, id: string, newText: string | null, actor: TaskActor): Promise<TaskCard> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.decisionsUsers', defaultMessage: "Only the user changes or removes a card's decisions.", description: "An error: an agent or the Assistant tried to change or remove a decision on a card; only the user does that (they only record them)." }))
  const ws = workspace
  const t = newText === null ? null : text(newText, MAX_DECISION, 'decision').trim()
  if (t === '') throw hiveError(msg({ id: 'tasks.error.decisionEmptied', defaultMessage: 'The decision is empty: remove it instead.', description: "An error: the user emptied a decision's text; to take it off the card, remove it." }))
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    const d = c.decisions?.find((x) => x.id === id)
    if (!d) throw hiveError(msg({ id: 'tasks.error.decisionGone', defaultMessage: 'That decision is no longer on #{n}.', description: 'An error: the decision being changed was removed from card #{n} (a number) meanwhile.' }), { n })
    if (t === null) {
      c.decisions = c.decisions!.filter((x) => x.id !== id)
      if (!c.decisions.length) delete c.decisions
      note(c, BY.you, storedText(HISTORY.decisionRemoved, { decision: clip(d.text) }))
    } else {
      if (t === d.text) return c
      note(c, BY.you, storedText(HISTORY.decisionChanged, { decision: clip(t), was: clip(d.text) }))
      d.text = t
      d.editedAt = new Date().toISOString()
    }
    await saveCard(ws, n, c)
    return c
  })
  changed(ws)
  return card
}

/** Archives a card (hidden from the board, kept) or brings it back. The user's alone. */
export function archiveTask(n: number, archived: boolean): Promise<TaskCard> {
  return boardLock(workspace, () => archiveTaskLocked(n, archived))
}

async function archiveTaskLocked(n: number, archived: boolean): Promise<TaskCard> {
  const ws = workspace
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    if (c.archived === archived) return c
    c.archived = archived
    if (archived) c.archivedFor = 'user'
    else delete c.archivedFor
    // Brought back on its own, it leaves its batch: that batch's Undo no longer moves it.
    delete c.archivedBatch
    note(c, BY.you, storedText(archived ? HISTORY.archived : HISTORY.unarchived))
    // Back at the end of its column.
    if (!archived) c.order = orderIn(await boardPlaces(ws), c.column, n, null)
    await saveCard(ws, n, c)
    return c
  })
  changed(ws)
  return card
}

// ---------------------------------------------------------------------------
// Bulk archiving (#351): the user's Archive All in a column and Archive All Cards. Each is a batch, recorded with its
// columns as they were, so Undo and "Unarchive this batch" bring its cards back where they were. One batch at a time
// on the board (the batches file's lock), and the board is told once, not once a card.
// ---------------------------------------------------------------------------

const MAX_BATCH = 5000
const KEEP_BATCHES = 50

const batchesFile = (ws: WorkspaceService): string => join(tasksDir(ws), 'archive-batches.json')

const isBatch = (b: unknown): b is ArchiveBatch => {
  const x = b as ArchiveBatch | null
  return !!x && typeof x.id === 'string' && typeof x.at === 'string' && typeof x.label === 'string' && Array.isArray(x.cards) && !!x.columns && typeof x.columns === 'object'
}

async function readBatches(ws: WorkspaceService): Promise<ArchiveBatch[]> {
  const raw = await readJson<{ batches?: unknown }>(batchesFile(ws), {})
  return Array.isArray(raw.batches) ? raw.batches.filter(isBatch) : []
}

/** The bulk archives kept (the latest 50), oldest first. */
export async function archiveBatches(ws: WorkspaceService = workspace): Promise<ArchiveBatch[]> {
  return ws.path ? readBatches(ws) : []
}

/**
 * Archives the cards listed, as one batch: the user's alone (agents and the Assistant never archive). Each card is checked
 * again as it is when it is archived (under its lock), against what the user asked for: still in the column and project
 * the board showed and matching its search, and, unless `includeBusy`, not one an agent is on now (`busy`: its running
 * agent in Doing, its reviewer, an agent watching it). Those that aren't, or can't be read or saved, stay on the board
 * and come back in `skipped` with why; cards already archived or gone are passed over. Returns the batch (null when
 * nothing was archived) and the cards it archived.
 */
export async function archiveBatch(numbers: unknown, req: ArchiveRequest, actor: TaskActor, opts: { busy?: (card: TaskCard) => string | null } = {}): Promise<ArchiveResult> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserArchives', defaultMessage: 'Only the user archives cards.', description: 'An error: an agent or the Assistant tried to archive cards; only the user does that.' }))
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.archiveNone', defaultMessage: 'cards: list the cards to archive.', description: 'An error: a call to archive cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_BATCH) throw hiveError(ERR.cardsTooMany, { max: MAX_BATCH }, { kind: 'invalid' })
  const nums = [...new Set(numbers.map((x) => Number(x)))]
  if (nums.some((x) => !Number.isInteger(x) || x < 1)) throw hiveError(msg({ id: 'tasks.error.archiveNumbers', defaultMessage: 'cards: card numbers only.', description: 'An error: the list of cards to archive has something other than card numbers in it. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (req.column !== null && !isTaskColumn(req.column)) throw unknownColumn(req.column)
  const ws = workspace
  if (!ws.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const what = String(req.label ?? '').trim().slice(0, 80) || 'Archive All' // i18n-ignore: the batch's name, stored in English and quoted in its cards' history (the window words it, archiveBatchText)
  const project = typeof req.project === 'string' ? req.project : null
  const query = typeof req.query === 'string' ? req.query : ''
  const busy = req.includeBusy === true ? null : (opts.busy ?? null)
  // Why a card, as it is now, isn't one the user asked to archive (null: it is). Only the window reads it: in its language.
  const outside = (c: TaskCard): string | null =>
    req.column !== null && c.column !== req.column
      ? tr(msg({ id: 'tasks.skipped.movedColumn', defaultMessage: 'moved to {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: 'Why Archive All left a card on the board (after its number, "#12 moved to Doing"): it moved to the column {column} meanwhile (select: a board column; translate each). Lower case: it follows the number.' }), { column: c.column })
      : project !== null && c.project.toLowerCase() !== project.toLowerCase()
        ? tr(msg({ id: 'tasks.skipped.movedProject', defaultMessage: 'moved to another project', description: 'Why Archive All left a card on the board (after its number, "#12 moved to another project"): it moved to another project meanwhile. Lower case: it follows the number.' }))
        : !cardMatches(c, query)
          ? tr(msg({ id: 'tasks.skipped.noMatch', defaultMessage: 'no longer matches the search', description: 'Why Archive All left a card on the board (after its number, "#12 no longer matches the search"): it changed meanwhile, and the board\'s search no longer finds it. Lower case: it follows the number.' }))
          : (busy?.(c) ?? null)
  await mkdir(tasksDir(ws), { recursive: true })
  const result = await withFileLock(batchesFile(ws), async (): Promise<ArchiveResult> => {
    const all = await boardPlaces(ws)
    const want = new Set(nums)
    const going = all.filter((c) => want.has(c.number) && !c.archived)
    if (!going.length) return { batch: null, archived: [], skipped: [] }
    // Each column the batch leaves, as it is now: where its cards come back to.
    const columns: Partial<Record<TaskColumn, number[]>> = {}
    for (const c of going) columns[c.column] ??= all.filter((x) => x.column === c.column && !x.archived).map((x) => x.number)
    const batch: ArchiveBatch = { id: `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, at: new Date().toISOString(), by: BY.you, label: what, cards: going.map((c) => c.number), columns }
    const kept = await readBatches(ws)
    // Recorded first: a card is in the batch only once it is archived with its id, so a batch cut short brings back
    // only what it archived.
    await writeJsonAtomic(batchesFile(ws), { version: 1, batches: [...kept, batch].slice(-KEEP_BATCHES) })
    const done: number[] = []
    const skipped: { number: number; why: string }[] = []
    for (const c of going) {
      await withFileLock(cardFile(c.number, ws), async () => {
        if (!existsSync(cardFile(c.number, ws))) return
        const fresh = await getTask(c.number, ws).catch(() => null)
        if (!fresh) return void skipped.push({ number: c.number, why: tr(msg({ id: 'tasks.skipped.unreadable', defaultMessage: "couldn't be read", description: 'Why Archive All left a card on the board (after its number, "#12 couldn\'t be read"): its file could not be read. Lower case: it follows the number.' })) })
        if (fresh.archived) return
        const why = outside(fresh)
        if (why) return void skipped.push({ number: c.number, why })
        fresh.archived = true
        fresh.archivedFor = 'user'
        fresh.archivedBatch = batch.id
        note(fresh, BY.you, storedText(HISTORY.archivedInBatch, { n: going.length, label: what }))
        await saveCard(ws, c.number, fresh)
        done.push(c.number)
      }).catch((e) => {
        log.warn(`Could not archive #${c.number} with its batch`, e)
        skipped.push({ number: c.number, why: tr(msg({ id: 'tasks.skipped.unsaved', defaultMessage: "couldn't be saved", description: 'Why Archive All left a card on the board (after its number, "#12 couldn\'t be saved"): its file could not be written. Lower case: it follows the number.' })) })
      })
    }
    if (done.length !== batch.cards.length) {
      batch.cards = done
      await writeJsonAtomic(batchesFile(ws), { version: 1, batches: [...kept, ...(done.length ? [batch] : [])].slice(-KEEP_BATCHES) })
    }
    return { batch: done.length ? batch : null, archived: done, skipped }
  })
  if (result.archived.length) {
    log.info(`Archived ${result.archived.length} card(s) in batch ${result.batch!.id} (${what})${result.skipped.length ? `; ${result.skipped.length} left on the board` : ''}`)
    changed(ws)
  }
  return result
}

/**
 * Brings a batch back (Undo, "Unarchive this batch"): the user's alone. Each of its cards still archived with it goes back
 * to its column, where it was among the cards there (restoreOrders); one brought back on its own meanwhile, archived
 * again since, or deleted is left as it is. A card that can't be read or saved stays archived with the batch and is in
 * `failed`: the batch is kept, so bringing it back again retries those. Once nothing failed, the batch is forgotten.
 */
export function unarchiveBatch(id: string, actor: TaskActor): Promise<UnarchiveResult> {
  return boardLock(workspace, () => unarchiveBatchLocked(id, actor))
}

async function unarchiveBatchLocked(id: string, actor: TaskActor): Promise<UnarchiveResult> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserUnarchives', defaultMessage: 'Only the user brings archived cards back.', description: 'An error: an agent or the Assistant tried to bring archived cards back onto the board; only the user does that.' }))
  const ws = workspace
  if (!ws.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const result = await withFileLock(batchesFile(ws), async (): Promise<UnarchiveResult> => {
    const batches = await readBatches(ws)
    const batch = batches.find((b) => b.id === id)
    if (!batch) throw hiveError(msg({ id: 'tasks.error.batchGone', defaultMessage: 'That batch is no longer kept: unarchive its cards from Archived.', description: "An error: the Archive All batch to bring back is no longer kept (Hive keeps the latest 50); its cards can still be brought back one by one from the board's Archived list." }))
    const failed = new Set<number>()
    // The batch's own list, read card by card: one that can't be read now still belongs to it.
    const back: TaskCard[] = []
    for (const n of batch.cards) {
      if (!existsSync(cardFile(n, ws))) continue
      const c = await getTask(n, ws).catch(() => null)
      if (!c) failed.add(n)
      else if (c.archived && c.archivedBatch === id) back.push(c)
    }
    const all = await boardPlaces(ws)
    const restored: number[] = []
    for (const { id: column } of TASK_COLUMNS) {
      const mine = back.filter((c) => c.column === column)
      if (!mine.length) continue
      const orders = restoreOrders(
        all.filter((c) => c.column === column && !c.archived),
        batch.columns[column] ?? [],
        mine.map((c) => c.number)
      )
      for (const c of mine) {
        await withFileLock(cardFile(c.number, ws), async () => {
          if (!existsSync(cardFile(c.number, ws))) return
          const fresh = await getTask(c.number, ws).catch(() => null)
          if (!fresh) return void failed.add(c.number)
          if (!fresh.archived || fresh.archivedBatch !== id) return
          fresh.archived = false
          delete fresh.archivedFor
          delete fresh.archivedBatch
          fresh.order = orders.get(c.number) ?? orderIn(await boardPlaces(ws), column, c.number, null)
          note(fresh, BY.you, storedText(HISTORY.backWithBatch, { label: batch.label }))
          await saveCard(ws, c.number, fresh)
          restored.push(c.number)
        }).catch((e) => {
          log.warn(`Could not bring #${c.number} back with its batch`, e)
          failed.add(c.number)
        })
      }
    }
    // Kept while any of its cards couldn't come back: bringing it back again tries those (the others aren't its any more).
    if (!failed.size) await writeJsonAtomic(batchesFile(ws), { version: 1, batches: batches.filter((b) => b.id !== id) })
    return { restored, failed: [...failed] }
  })
  if (result.restored.length) {
    log.info(`Brought back ${result.restored.length} card(s) of batch ${id}${result.failed.length ? `; ${result.failed.length} couldn't be` : ''}`)
    changed(ws)
  }
  return result
}

/** The open cards (not archived or done) given to one agent of a project. */
export async function agentCards(project: string, agentId: string, ws: WorkspaceService = workspace): Promise<TaskCard[]> {
  return (await allTasks(ws)).filter((c) => !c.archived && c.column !== 'done' && c.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
}

/**
 * Takes an agent's open cards from it (it is being removed): nobody has them, and Doing ones go back to Todo. A card
 * given to someone else meanwhile is left alone.
 */
export async function releaseAgentCards(project: string, agentId: string, actor: TaskActor): Promise<number[]> {
  const out: number[] = []
  for (const c of await agentCards(project, agentId)) {
    try {
      await updateTask(c.number, { agent: null, ...(c.column === 'doing' ? { column: 'todo' as const } : {}) }, actor, {
        check: (now) => {
          if (now.agent !== agentId || now.archived || now.column === 'done') throw new Error('changed meanwhile') // i18n-ignore: only logged
        }
      })
      out.push(c.number)
    } catch (e) {
      log.info(`#${c.number} left as it is: ${userText((e as Error).message)}`)
    }
  }
  return out
}

/** Deletes a card (to the Recycle Bin). The user's alone. Other cards' references to it are dropped. */
export async function deleteTask(n: number): Promise<void> {
  const ws = workspace
  const file = cardFile(n, ws)
  // Under the card's lock, like every change: a change already reading it finishes first, and one waiting finds
  // it gone rather than writing it back.
  const gone = await withFileLock(file, async () => {
    if (!existsSync(file)) return false
    await trash(file)
    return true
  })
  if (!gone) return
  await dropRefs(ws, new Set([n]))
  changed(ws)
}

/** Drops references to cards that are gone from the others' blockedBy and links. */
async function dropRefs(ws: WorkspaceService, gone: Set<number>): Promise<void> {
  for (const c of await allTasks(ws)) {
    if (!c.blockedBy.some((x) => gone.has(x)) && !c.links.some((x) => gone.has(x))) continue
    await withFileLock(cardFile(c.number, ws), async () => {
      const fresh = await getTask(c.number, ws).catch(() => null)
      if (!fresh) return
      fresh.blockedBy = fresh.blockedBy.filter((x) => !gone.has(x))
      fresh.links = fresh.links.filter((x) => !gone.has(x))
      await saveCard(ws, c.number, fresh)
    })
  }
}

/**
 * When a card last went into Done: its latest "Moved to Done", "Created in Done" or bringing back from the
 * archive (a card the user brought back gets its days again). Its last change when its history has none.
 */
export function doneSince(card: TaskCard): number {
  const at = card.history.filter((h) => /^(Moved to Done|Created in Done|Brought back)/.test(h.what)).map((h) => Date.parse(h.at))
  const t = Math.max(...at.filter(Number.isFinite))
  return Number.isFinite(t) ? t : Date.parse(card.updatedAt) || 0
}

/** Archives the cards that have been in Done for Settings → Board's days (none when that is 0). */
export async function archiveOldDone(ws: WorkspaceService, now = Date.now()): Promise<number[]> {
  const days = Number(config.settings.board?.archiveDoneDays) || 0
  if (!ws.path || days <= 0) return []
  const cutoff = now - days * 86_400_000
  const out: number[] = []
  for (const c of await allTasks(ws)) {
    if (c.archived || c.column !== 'done' || doneSince(c) > cutoff) continue
    await withFileLock(cardFile(c.number, ws), async () => {
      // As it is now: moved out of Done or archived meanwhile, it stays.
      const fresh = await getTask(c.number, ws).catch(() => null)
      if (!fresh || fresh.archived || fresh.column !== 'done' || doneSince(fresh) > cutoff) return
      fresh.archived = true
      fresh.archivedFor = 'done'
      note(fresh, BY.hive, storedText(HISTORY.archivedDone, { days }))
      await saveCard(ws, c.number, fresh)
      out.push(c.number)
    })
  }
  if (out.length) {
    log.info(`Archived ${out.length} card(s) done for ${days}+ days: ${out.map((n) => `#${n}`).join(', ')}`)
    changed(ws)
  }
  return out
}

// ---------------------------------------------------------------------------
// A project leaving Hive: its cards are archived (Hide, Remove) or deleted (Delete), and come back on Restore.
// ---------------------------------------------------------------------------

export async function projectCards(ws: WorkspaceService, project: string): Promise<TaskCard[]> {
  return (await allTasks(ws)).filter((c) => c.project.toLowerCase() === project.toLowerCase())
}

/** Archives the project's cards that are on the board, marked so restoring the project brings them back. */
export async function archiveProjectCards(ws: WorkspaceService, project: string, why: 'project-hidden' | 'project-removed'): Promise<TaskCard[]> {
  const out: TaskCard[] = []
  for (const c of await projectCards(ws, project)) {
    if (c.archived) continue
    await withFileLock(cardFile(c.number, ws), async () => {
      const fresh = await getTask(c.number, ws)
      fresh.archived = true
      fresh.archivedFor = why
      note(fresh, BY.you, storedText(why === 'project-hidden' ? HISTORY.archivedHidden : HISTORY.archivedRemoved, { project }))
      await saveCard(ws, c.number, fresh)
      out.push(fresh)
    })
  }
  if (out.length) changed(ws)
  return out
}

/** Brings back the cards archived when the project was hidden or removed. */
export async function restoreProjectCards(ws: WorkspaceService, project: string): Promise<number> {
  let n = 0
  for (const c of await projectCards(ws, project)) {
    if (!c.archived || (c.archivedFor !== 'project-hidden' && c.archivedFor !== 'project-removed')) continue
    await withFileLock(cardFile(c.number, ws), async () => {
      const fresh = await getTask(c.number, ws)
      fresh.archived = false
      delete fresh.archivedFor
      note(fresh, BY.you, storedText(HISTORY.restored, { project }))
      await saveCard(ws, c.number, fresh)
      n++
    })
  }
  if (n) changed(ws)
  return n
}

/** Deletes the project's cards (to the Recycle Bin), with other cards' references to them. */
export async function deleteProjectCards(ws: WorkspaceService, project: string): Promise<number> {
  const gone = new Set<number>()
  for (const c of await projectCards(ws, project)) {
    const f = cardFile(c.number, ws)
    await withFileLock(f, async () => {
      if (existsSync(f)) await trash(f)
    })
    gone.add(c.number)
  }
  if (gone.size) {
    await dropRefs(ws, gone)
    changed(ws)
  }
  return gone.size
}

/**
 * Adds cards from another board (a removed project's, packed in its folder): each gets a new number, and their
 * references to each other follow; references to cards that didn't come along are dropped.
 */
export function importCards(ws: WorkspaceService, cards: TaskCard[], project: string): Promise<number> {
  return boardLock(ws, () => importCardsLocked(ws, cards, project))
}

async function importCardsLocked(ws: WorkspaceService, cards: TaskCard[], project: string): Promise<number> {
  if (!cards.length) return 0
  await mkdir(tasksDir(ws), { recursive: true })
  const map = new Map<number, number>()
  for (const c of cards) map.set(c.number, await nextNumber(ws))
  const all = await boardPlaces(ws)
  for (const raw of cards) {
    const c = clean(raw, map.get(raw.number)!)
    c.project = project
    c.blockedBy = c.blockedBy.flatMap((x) => (map.has(x) ? [map.get(x)!] : []))
    c.links = c.links.flatMap((x) => (map.has(x) ? [map.get(x)!] : []))
    if (c.archivedFor === 'project-removed' || c.archivedFor === 'project-hidden') {
      c.archived = false
      delete c.archivedFor
    }
    c.order = orderIn(all, c.column, null, null) + c.order / 1e6
    note(c, BY.you, storedText(HISTORY.imported, { project, was: raw.number }))
    await saveCard(ws, c.number, c)
  }
  changed(ws)
  return cards.length
}

