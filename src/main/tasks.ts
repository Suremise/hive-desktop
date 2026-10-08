import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { mkdir, readdir } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { projectAgents } from '../shared/defaults'
import { COLUMN_CHOICES, TASK_COLUMNS, cardMatches, isTaskColumn, restoreOrders, sortCards } from '../shared/tasks'
import { ordinal } from '../shared/toolReplies'
import type { ArchiveBatch, ArchiveRequest, ArchiveResult, TaskCard, TaskDecision, TaskColumn, TaskComment, TaskPatch, UnarchiveResult } from '../shared/types'
import { returnRound } from '../shared/watch'
import { config } from './config'
import { emit } from './events'
import { readJson, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { workspace, type WorkspaceService } from './workspace'
import { trash } from './trash'

const log = createLogger('tasks')

/**
 * The workspace's task board: one JSON file per card in .hive/tasks (<number>.json), and board.json with the next
 * number. Cards belong to a project (by folder name) and can be given to one of its agents.
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
export const unknownTask = (n: number): Error => new Error(`Unknown task #${n}`)

/** The calling agent, when a card of `project` going into Doing with no agent named should be given to it. */
const selfIn = (actor: TaskActor, project: string): string | null =>
  actor.kind === 'agent' && actor.self && project && actor.self.project.toLowerCase() === project.toLowerCase() ? actor.self.agentId : null

export const actorName = (a: TaskActor): string => (a.kind === 'user' ? 'You' : a.kind === 'assistant' ? 'Assistant' : a.name)

/** A change only the user may make (or the Assistant once the user said yes): thrown for others. */
export class TaskPermissionError extends Error {}

/** A change the card's state rules out now (another agent is working on it): the Agent API's 409. */
export class TaskConflictError extends Error {}

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

/** A card read from disk, with anything missing or of the wrong type made safe (the files can be edited by hand). */
function clean(raw: Partial<TaskCard>, n: number): TaskCard {
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [])
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const now = new Date(0).toISOString()
  return {
    number: n,
    title: typeof raw.title === 'string' ? raw.title : `Task ${n}`,
    description: typeof raw.description === 'string' ? raw.description : '',
    project: typeof raw.project === 'string' ? raw.project : '',
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
  const out: TaskCard[] = []
  for (const n of numbers) {
    const raw = await readJson<Partial<TaskCard> | null>(cardFile(n, ws), null)
    if (raw && typeof raw === 'object') out.push(withoutGone(clean(raw, n), (x) => numbers.has(x)))
  }
  return sortCards(out)
}

/** Cards on the board, filtered; with `scope`, only that project's (asking for another project is refused). */
export async function listTasks(opts: { project?: string; column?: TaskColumn; archived?: boolean; scope?: string | null } = {}): Promise<TaskCard[]> {
  const scope = opts.scope ?? null
  if (scope !== null && opts.project !== undefined && opts.project.toLowerCase() !== scope.toLowerCase()) {
    throw new TaskPermissionError(`You can see only your project's cards (${scope}).`)
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
  if (!Number.isInteger(n) || n < 1) throw new Error(`Unknown task #${n}`)
  const raw = await readJson<Partial<TaskCard> | null>(cardFile(n, ws), null)
  if (!raw || typeof raw !== 'object') throw new Error(`Unknown task #${n}`)
  return withoutGone(clean(raw, n), (x) => existsSync(cardFile(x, ws)))
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
  if (!hit) throw new Error(`Unknown project "${v}"`)
  return hit
}

/** An agent of the project, by id or name: its id and name. */
async function agentOf(project: string, agent: string): Promise<{ id: string; name: string }> {
  if (!project) throw new Error('Choose a project before giving the task to an agent.')
  const cfg = await workspace.projectConfig(join(workspace.path!, project))
  const a = projectAgents(cfg).find((x) => x.id === agent || x.name.toLowerCase() === agent.toLowerCase())
  if (!a) throw new Error(`Unknown agent "${agent}" in ${project}`)
  return { id: a.id, name: a.name }
}

const text = (v: unknown, max: number, what: string): string => {
  const s = String(v ?? '')
  if (s.length > max) throw new Error(`The ${what} is too long (at most ${max.toLocaleString()} characters).`)
  return s
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('labels must be a list')
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].map((l) => l.slice(0, 40))
  if (out.length > MAX_LABELS) throw new Error(`A card can have up to ${MAX_LABELS} labels.`)
  return out
}

/**
 * The cards a list names (blockedBy, links), checked. A confined agent can only name its project's cards; when it
 * changes a card's list, the cards from other projects already on it (`kept`, which it sees only as numbers) stay.
 */
async function cardRefs(v: unknown, self: number | null, what: string, scope: string | null = null, kept: number[] = []): Promise<number[]> {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list of card numbers`)
  const nums = [...new Set(v.map((x) => Number(String(x).replace(/^#/, ''))))]
  const hidden = await refsOutside(kept, scope)
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${what}: "${n}" is not a card number`)
    if (n === self) throw new Error(`${what}: a card can't refer to itself`)
    if (!existsSync(cardFile(n))) throw new Error(`${what}: there is no card #${n}`)
    if (!hidden.includes(n) && !inScope(await getTask(n), scope)) throw new Error(`${what}: there is no card #${n}`)
  }
  return [...nums, ...hidden.filter((n) => !nums.includes(n))]
}

/** The order that puts a card before `before` in `column` (at the end without one). */
function orderIn(cards: TaskCard[], column: TaskColumn, self: number | null, before: number | null | undefined): number {
  const list = cards.filter((c) => c.column === column && !c.archived && c.number !== self)
  const i = before ? list.findIndex((c) => c.number === before) : -1
  if (i < 0) return (list.length ? Math.max(...list.map((c) => c.order)) : 0) + 1
  const prev = i > 0 ? list[i - 1].order : list[i].order - 2
  return (prev + list[i].order) / 2
}

const OUT_OF_DONE = 'Only the user puts the cards in Done in order.'

/**
 * On Hold is the user's and the Assistant's (#170): parked work nobody picks up. A project agent (its own token) can't
 * park a card, by a move or by creating it there; taking one out (the user asked it to work on it) is a move like any.
 */
function checkHold(column: TaskColumn, actor: TaskActor, n?: number): void {
  if (column === 'hold' && actor.kind === 'agent' && actor.self) throw new TaskPermissionError(`Only the user or the Assistant puts cards On Hold: ask the user to park ${n ? `#${n}` : 'it'}.`)
}

/**
 * Where a change puts a card in `column`: before a card, at the top or bottom, or (without either) at the end. An
 * agent's or the Assistant's explicit placement is checked (the card it names has to be in the column; never in
 * Done) and, when it moves the card, says so for the history; the user's drags are saved quietly.
 */
function placement(all: TaskCard[], card: TaskCard, column: TaskColumn, patch: TaskPatch, actor: TaskActor): { order: number; said?: string } {
  const { before, position } = patch
  const placed = (before !== undefined && before !== null) || position !== undefined
  if (position !== undefined && position !== 'top' && position !== 'bottom') throw new Error(`Unknown position "${String(position)}": top or bottom.`)
  if (placed && before !== undefined && before !== null && position !== undefined) throw new Error('Give before or position, not both.')
  const list = all.filter((c) => c.column === column && !c.archived && c.number !== card.number)
  const W = COLUMN_WORD[column]
  // A confined agent places its card among its project's cards: the top and bottom of those, never past another project's.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  if (placed && actor.kind !== 'user') {
    if (column === 'done') throw new TaskPermissionError(OUT_OF_DONE)
    if (before != null && !own.some((c) => c.number === before)) {
      const other = all.find((c) => c.number === before && inScope(c, scope))
      throw new Error(
        before === card.number
          ? "A card can't go before itself."
          : !other
            ? `There is no card #${before}.`
            : `#${before} is ${other.archived ? 'archived' : `in ${COLUMN_WORD[other.column]}`}, not in ${W}: #${card.number} can only go before a card in the column it's in.`
      )
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
      ? `Moved to the top of ${W}`
      : position === 'bottom'
        ? `Moved to the bottom of ${W}`
        : moved
          ? `Moved to ${W}, before #${before}`
          : `Moved before #${before} in ${W}`
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
  if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": ${COLUMN_CHOICES}.`)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(OUT_OF_DONE)
  if (!Array.isArray(numbers) || !numbers.length) throw new Error('cards: list the card numbers in the order wanted.')
  if (numbers.length > 500) throw new Error('cards: at most 500 cards at once.')
  const nums = numbers.map((x) => Number(String(x).replace(/^#/, '')))
  const seen = new Set<number>()
  for (const x of nums) {
    if (!Number.isInteger(x) || x < 1) throw new Error(`cards: "${x}" is not a card number`)
    if (seen.has(x)) throw new Error(`cards: #${x} is listed twice`)
    seen.add(x)
  }
  const ws = workspace
  const by = actorName(actor)
  const W = COLUMN_WORD[column]
  const all = await allTasks(ws)
  const list = all.filter((c) => c.column === column && !c.archived)
  // A confined agent orders its project's cards only, and they stay where the project's cards are in the column.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  for (const x of nums) {
    if (own.some((c) => c.number === x)) continue
    const other = all.find((c) => c.number === x && inScope(c, scope))
    throw new Error(!other ? `There is no card #${x}.` : `#${x} is ${other.archived ? 'archived' : `in ${COLUMN_WORD[other.column]}`}, not in ${W}. Only cards already in ${W} can be put in order there.`)
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
      if (card.column !== column || card.archived) throw new Error(`#${x} changed while the cards were being put in order; read the board again.`)
      card.order = orderAt(i)
      if (was !== i && actor.kind !== 'user') note(card, by, i === 0 ? `Moved to the top of ${W}` : `Placed ${ordinal(i + 1)} in ${W}`)
      await writeJsonAtomic(cardFile(x, ws), card)
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

function note(card: TaskCard, by: string, what: string): void {
  const at = new Date().toISOString()
  card.history = [...card.history, { at, by, what, id: entryId() }].slice(-MAX_HISTORY)
  card.updatedAt = at
}

const COLUMN_WORD = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>

/** Who can return a failed card for review: its own agent (its hive tools, or the Agent API with its token) or the user. */
const returnsCard = (actor: TaskActor, card: TaskCard): boolean => actor.kind === 'user' || (actor.kind === 'agent' && !!card.agent && actor.self?.agentId === card.agent)

export function createTask(...args: Parameters<typeof createTaskLocked>): Promise<TaskCard> {
  return boardLock(workspace, () => createTaskLocked(...args))
}

async function createTaskLocked(
  input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; blocked?: string | null; blockedBy?: number[]; links?: number[] },
  actor: TaskActor
): Promise<TaskCard> {
  if (!workspace.path) throw new Error('No workspace is open')
  const title = text(input.title, MAX_TITLE, 'title').trim()
  if (!title) throw new Error('A task needs a title.')
  const column = input.column ?? 'todo'
  if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": ${COLUMN_CHOICES}.`)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError('Only the user puts cards in Done.')
  checkHold(column, actor)
  // A confined agent's cards are its project's (by default too); never another project's or the workspace's.
  const scope = scopeOf(actor)
  const project = await projectName(scope !== null && input.project === undefined ? scope : input.project)
  if (!inScope({ project }, scope)) throw new TaskPermissionError(`You can add cards only to your project (${scope}).`)
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
    order: orderIn(await allTasks(ws), column, null, null),
    labels: input.labels ? labelsOf(input.labels) : [],
    blocked: input.blocked?.trim() ? text(input.blocked.trim(), 1000, 'blocked reason') : null,
    blockedBy,
    links,
    comments: [],
    history: [{ at: now, by, what: `Created in ${COLUMN_WORD[column]}`, id: entryId() }],
    archived: false,
    createdAt: now,
    createdBy: by,
    updatedAt: now
  }
  await writeJsonAtomic(cardFile(n, ws), card)
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
  const result = await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    const scope = scopeOf(actor)
    if (!inScope(card, scope)) throw unknownTask(n)
    // The caller's own conditions, on the card as it is now (Start: not archived or done meanwhile).
    opts.check?.(card)
    if (card.archived && actor.kind !== 'user') throw new TaskPermissionError(`#${n} is archived. Only the user can bring it back.`)
    // A card in Doing with another agent is that agent's work in progress: a project agent can't move it on to Review or
    // Done (a reviewer whose review ended when it came back for more work, say). Checked on the card as it is, before
    // anything else in the change (giving it to itself in the same call doesn't get round it). A project agent is one
    // calling with its own token (actor.self); the user, the Assistant and scripts with the workspace token can.
    // A review verdict or start is refused on a card in Doing anyway (reviewChange), with its own reason.
    const moving = patch.review === undefined && (patch.column === 'review' || patch.column === 'passed' || patch.column === 'done')
    if (actor.kind === 'agent' && actor.self && moving && card.column === 'doing' && card.agent && card.agent !== actor.self.agentId) {
      const who = card.agentName ?? 'another agent'
      throw new TaskConflictError(`#${n} is in Doing with ${who}, who is working on it: newer work is in progress, so it can't be moved to ${COLUMN_WORD[patch.column!]} by another agent. Leave it where it is; ${who} moves it to Review when done, and the user can move it.`)
    }
    const said: string[] = []
    // Whether a move to Review returns a failed card for review (#214): decided on the card as it is before this change,
    // by whoever has it now, so giving it to the caller in the same change never makes it the caller's to return.
    const returning = patch.column === 'review' && patch.review === undefined && returnsCard(actor, card) ? returnRound(card) : null
    const { agent: hadAgent, project: hadProject } = card
    // A card moved within its column: saved, but not worth a line in its history.
    let reordered = false
    let transferred = false
    if (patch.title !== undefined) {
      const t = text(patch.title, MAX_TITLE, 'title').trim()
      if (!t) throw new Error('A task needs a title.')
      if (t !== card.title) said.push(`Renamed to "${t}"`)
      card.title = t
    }
    if (patch.description !== undefined) {
      const d = text(patch.description, MAX_TEXT, 'description')
      if (d !== card.description) said.push('Changed the description')
      card.description = d
    }
    if (patch.project !== undefined) {
      const p = await projectName(patch.project)
      if (!inScope({ project: p }, scope)) throw new TaskPermissionError(`Cards stay in your project (${scope}).`)
      if (p !== card.project) {
        // A card that changes project always leaves its agent (of the old project): giving it to one of the new
        // project's agents is a change of its own, after this one.
        if (patch.agent) throw new Error('Move the card to the other project first, then give it to one of its agents.')
        said.push(p ? `Moved to ${p}` : 'Moved to the workspace')
        if (card.agent) said.push(`Taken from ${card.agentName ?? card.agent} of ${card.project || 'the workspace'}`)
        if (card.review) {
          said.push(`Review by ${card.review.agentName} stopped`)
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
        if (a.id !== card.agent) said.push(`Given to ${a.name}`)
        card.agent = a.id
        card.agentName = a.name
      } else if (card.agent) {
        said.push(`Taken from ${card.agentName ?? 'its agent'}`)
        card.agent = null
        delete card.agentName
      }
    }
    // A review renewed by its reviewer changes the card (when it started) without a line in its history: saved too.
    const reviewed = patch.review !== undefined && (await reviewChange(card, patch, actor, said))
    if (patch.column !== undefined || patch.before !== undefined || patch.position !== undefined) {
      const column = patch.column ?? card.column
      if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": ${COLUMN_CHOICES}.`)
      if (column !== card.column) checkHold(column, actor, n)
      const all = await allTasks(ws)
      const place = placement(all, card, column, patch, actor)
      if (column !== card.column) said.push(place.said ?? `Moved to ${COLUMN_WORD[column]}`)
      else {
        // Moved to Review by its agent (or the user, on the board) while still there after a failed review: returned for
        // its next round, which wakes a reviewer waiting for it to come back (#214). Not when this change also gives it to
        // another agent or project (that starts a new round of its own); any other move in place is no change.
        if (returning && card.agent === hadAgent && card.project === hadProject) said.push(`Returned for review, round ${returning}`)
        if (place.said) said.push(place.said)
      }
      // A review is of the card in Review: moved on without a verdict, it stops.
      if (card.review && column !== 'review') {
        said.push(`Review by ${card.review.agentName} stopped`)
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
      if (!t) throw new Error('The decision is empty.')
      const list = card.decisions ?? []
      if (list.length >= MAX_DECISIONS) throw new Error(`A card can have up to ${MAX_DECISIONS} decisions.`)
      card.decisions = [...list, { id: entryId(), text: t, decidedBy: 'user', recordedBy: by, at: new Date().toISOString() }]
      said.push(`Recorded a decision: "${clip(t)}"`)
    }
    if (patch.labels !== undefined) {
      card.labels = labelsOf(patch.labels)
      said.push(card.labels.length ? `Labels: ${card.labels.join(', ')}` : 'Removed the labels')
    }
    if (patch.blocked !== undefined) {
      const b = patch.blocked?.trim() ? text(patch.blocked.trim(), 1000, 'blocked reason') : null
      if (b !== card.blocked) said.push(b ? `Blocked: ${b}` : 'No longer blocked')
      card.blocked = b
    }
    if (patch.blockedBy !== undefined) {
      card.blockedBy = await cardRefs(patch.blockedBy, n, 'blockedBy', scope, card.blockedBy)
      said.push(card.blockedBy.length ? `Depends on ${card.blockedBy.map((x) => `#${x}`).join(', ')}` : 'No longer depends on other cards')
    }
    if (patch.links !== undefined) {
      card.links = await cardRefs(patch.links, n, 'links', scope, card.links)
      said.push(card.links.length ? `Linked to ${card.links.map((x) => `#${x}`).join(', ')}` : 'Removed the links')
    }
    // What changed, in the history's words, for a caller that confirms it (the hive tools' short replies).
    opts.said?.push(...said)
    if (!said.length && !reordered && !reviewed && !comment) return card
    for (const s of said) note(card, by, s)
    if (comment) addComment(card, by, comment)
    // The last thing before the write, after every read above: a caller whose authority can change while those awaits run
    // (the Assistant's control and session) checks it here, so a revoked change saves nothing. Unlike `check`, it doesn't
    // see the card as it was before this change.
    opts.commit?.()
    await writeJsonAtomic(cardFile(n, ws), card)
    return card
  })
  changed(ws)
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
  if (!Array.isArray(numbers) || !numbers.length) throw new Error('cards: list the card numbers to change.')
  if (numbers.length > MAX_CHANGE_BATCH) throw new Error(`cards: at most ${MAX_CHANGE_BATCH} cards at once.`)
  const nums = numbers.map((x) => Number(String(x).replace(/^#/, '')))
  const seen = new Set<number>()
  for (const x of nums) {
    if (!Number.isInteger(x) || x < 1) throw new Error(`cards: "${x}" is not a card number`)
    if (seen.has(x)) throw new Error(`cards: #${x} is listed twice`)
    seen.add(x)
  }
  return nums
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
async function reviewChange(card: TaskCard, patch: TaskPatch, actor: TaskActor, said: string[]): Promise<boolean> {
  const me = selfIn(actor, card.project)
  if (!me) throw new TaskPermissionError("Only an agent of the card's project reviews it, through its own hive tools.")
  const since = (r: NonNullable<TaskCard['review']>): string => r.since.slice(0, 16).replace('T', ' ')
  if (patch.review === 'start') {
    if (patch.column !== undefined || patch.agent !== undefined) throw new Error('Start a review on its own: the card stays where it is, with its agent.')
    if (card.column !== 'review') throw new Error(`#${card.number} is in ${COLUMN_WORD[card.column]}. A card is reviewed in Review; if it needs more work, that is work on it (move it to doing).`)
    if (card.review && card.review.agent !== me) throw new Error(`${card.review.agentName} is already reviewing #${card.number} (since ${since(card.review)} UTC).`)
    const a = await agentOf(card.project, me)
    if (!card.review) said.push('Started reviewing')
    card.review = { agent: a.id, agentName: a.name, since: new Date().toISOString() }
    return true
  }
  if (patch.review !== 'passed' && patch.review !== 'failed') throw new Error(`Unknown review "${String(patch.review)}": start, passed or failed.`)
  // A failed card stays in Review for its fixes: never on to Passed or Done with its verdict.
  if (patch.review === 'failed' && patch.column !== undefined && patch.column !== 'review') throw new Error(`A failed review leaves #${card.number} in Review: give the verdict without column.`)
  if (card.review && card.review.agent !== me) throw new Error(`${card.review.agentName} is reviewing #${card.number}: its verdict is its own.`)
  if (!card.review || card.column !== 'review') {
    throw new Error(`You aren't reviewing #${card.number} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.`)
  }
  said.push(patch.review === 'passed' ? 'Review passed' : 'Review failed')
  delete card.review
  return true
}

/** Notes on a card something Hive did about it without changing it (#420: an agent's watch on it ended), as Hive. */
export async function noteOnCard(n: number, what: string, ws: WorkspaceService = workspace): Promise<void> {
  await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    note(card, 'Hive', what)
    await writeJsonAtomic(cardFile(n, ws), card)
  })
  changed(ws)
}

/**
 * Stops the reviews an agent has going (its session ended, or it was removed), so a card never shows a reviewer that
 * has gone. A review started again meanwhile by another agent is left alone.
 */
export async function endReviews(project: string, agentId: string, why: string, ws: WorkspaceService = workspace): Promise<number[]> {
  const mine = (await allTasks(ws)).filter((c) => c.review?.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
  const out: number[] = []
  for (const c of mine) {
    const ended = await withFileLock(cardFile(c.number, ws), async () => {
      const card = await getTask(c.number, ws)
      if (card.review?.agent !== agentId) return false
      note(card, 'Hive', `Review by ${card.review.agentName} stopped: ${why}`)
      delete card.review
      await writeJsonAtomic(cardFile(c.number, ws), card)
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
  if (!t) throw new Error('The comment is empty.')
  return t
}

function addComment(c: TaskCard, by: string, t: string): void {
  const at = new Date().toISOString()
  c.comments = [...c.comments, { at, by, text: t, id: entryId() }].slice(-MAX_COMMENTS)
  c.updatedAt = at
}

export async function commentTask(n: number, comment: string, actor: TaskActor): Promise<TaskCard> {
  const ws = workspace
  const t = commentText(comment)
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    if (c.archived && actor.kind !== 'user') throw new TaskPermissionError(`#${n} is archived. Only the user can bring it back.`)
    addComment(c, actorName(actor), t)
    await writeJsonAtomic(cardFile(n, ws), c)
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
  if (actor.kind !== 'user') throw new TaskPermissionError("Only the user changes or removes a card's decisions.")
  const ws = workspace
  const t = newText === null ? null : text(newText, MAX_DECISION, 'decision').trim()
  if (t === '') throw new Error('The decision is empty: remove it instead.')
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    const d = c.decisions?.find((x) => x.id === id)
    if (!d) throw new Error(`That decision is no longer on #${n}.`)
    if (t === null) {
      c.decisions = c.decisions!.filter((x) => x.id !== id)
      if (!c.decisions.length) delete c.decisions
      note(c, 'You', `Removed a decision: "${clip(d.text)}"`)
    } else {
      if (t === d.text) return c
      note(c, 'You', `Changed a decision to "${clip(t)}" (was "${clip(d.text)}")`)
      d.text = t
      d.editedAt = new Date().toISOString()
    }
    await writeJsonAtomic(cardFile(n, ws), c)
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
    note(c, 'You', archived ? 'Archived' : 'Brought back from the archive')
    // Back at the end of its column.
    if (!archived) c.order = orderIn(await allTasks(ws), c.column, n, null)
    await writeJsonAtomic(cardFile(n, ws), c)
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
  if (actor.kind !== 'user') throw new TaskPermissionError('Only the user archives cards.')
  if (!Array.isArray(numbers) || !numbers.length) throw new Error('cards: list the cards to archive.')
  if (numbers.length > MAX_BATCH) throw new Error(`cards: at most ${MAX_BATCH} cards at once.`)
  const nums = [...new Set(numbers.map((x) => Number(x)))]
  if (nums.some((x) => !Number.isInteger(x) || x < 1)) throw new Error('cards: card numbers only.')
  if (req.column !== null && !isTaskColumn(req.column)) throw new Error(`Unknown column "${String(req.column)}": ${COLUMN_CHOICES}.`)
  const ws = workspace
  if (!ws.path) throw new Error('No workspace is open')
  const what = String(req.label ?? '').trim().slice(0, 80) || 'Archive All'
  const project = typeof req.project === 'string' ? req.project : null
  const query = typeof req.query === 'string' ? req.query : ''
  const busy = req.includeBusy === true ? null : (opts.busy ?? null)
  // Why a card, as it is now, isn't one the user asked to archive (null: it is).
  const outside = (c: TaskCard): string | null =>
    req.column !== null && c.column !== req.column
      ? `moved to ${COLUMN_WORD[c.column]}`
      : project !== null && c.project.toLowerCase() !== project.toLowerCase()
        ? 'moved to another project'
        : !cardMatches(c, query)
          ? 'no longer matches the search'
          : (busy?.(c) ?? null)
  await mkdir(tasksDir(ws), { recursive: true })
  const result = await withFileLock(batchesFile(ws), async (): Promise<ArchiveResult> => {
    const all = await allTasks(ws)
    const want = new Set(nums)
    const going = all.filter((c) => want.has(c.number) && !c.archived)
    if (!going.length) return { batch: null, archived: [], skipped: [] }
    // Each column the batch leaves, as it is now: where its cards come back to.
    const columns: Partial<Record<TaskColumn, number[]>> = {}
    for (const c of going) columns[c.column] ??= all.filter((x) => x.column === c.column && !x.archived).map((x) => x.number)
    const batch: ArchiveBatch = { id: `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, at: new Date().toISOString(), by: 'You', label: what, cards: going.map((c) => c.number), columns }
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
        if (!fresh) return void skipped.push({ number: c.number, why: "couldn't be read" })
        if (fresh.archived) return
        const why = outside(fresh)
        if (why) return void skipped.push({ number: c.number, why })
        fresh.archived = true
        fresh.archivedFor = 'user'
        fresh.archivedBatch = batch.id
        note(fresh, 'You', `Archived in a batch of ${going.length} (${what})`)
        await writeJsonAtomic(cardFile(c.number, ws), fresh)
        done.push(c.number)
      }).catch((e) => {
        log.warn(`Could not archive #${c.number} with its batch`, e)
        skipped.push({ number: c.number, why: "couldn't be saved" })
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
  if (actor.kind !== 'user') throw new TaskPermissionError('Only the user brings archived cards back.')
  const ws = workspace
  if (!ws.path) throw new Error('No workspace is open')
  const result = await withFileLock(batchesFile(ws), async (): Promise<UnarchiveResult> => {
    const batches = await readBatches(ws)
    const batch = batches.find((b) => b.id === id)
    if (!batch) throw new Error('That batch is no longer kept: unarchive its cards from Archived.')
    const failed = new Set<number>()
    // The batch's own list, read card by card: one that can't be read now still belongs to it.
    const back: TaskCard[] = []
    for (const n of batch.cards) {
      if (!existsSync(cardFile(n, ws))) continue
      const c = await getTask(n, ws).catch(() => null)
      if (!c) failed.add(n)
      else if (c.archived && c.archivedBatch === id) back.push(c)
    }
    const all = await allTasks(ws)
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
          fresh.order = orders.get(c.number) ?? orderIn(await allTasks(ws), column, c.number, null)
          note(fresh, 'You', `Brought back with its batch (${batch.label})`)
          await writeJsonAtomic(cardFile(c.number, ws), fresh)
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
          if (now.agent !== agentId || now.archived || now.column === 'done') throw new Error('changed meanwhile')
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
      await writeJsonAtomic(cardFile(c.number, ws), fresh)
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
      note(fresh, 'Hive', `Archived after ${days} day${days === 1 ? '' : 's'} in Done`)
      await writeJsonAtomic(cardFile(c.number, ws), fresh)
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
      note(fresh, 'You', why === 'project-hidden' ? `Archived: ${project} was hidden` : `Archived: ${project} was removed from Hive`)
      await writeJsonAtomic(cardFile(c.number, ws), fresh)
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
      note(fresh, 'You', `Brought back: ${project} was restored`)
      await writeJsonAtomic(cardFile(c.number, ws), fresh)
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
  const all = await allTasks(ws)
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
    note(c, 'You', `Brought back with ${project} (it was #${raw.number})`)
    await writeJsonAtomic(cardFile(c.number, ws), c)
  }
  changed(ws)
  return cards.length
}

