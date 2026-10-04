import { basename, join } from 'path'
import { mkdir, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { projectAgents } from '../shared/defaults'
import { isTaskColumn, sortCards } from '../shared/tasks'
import { ordinal } from '../shared/toolReplies'
import type { TaskCard, TaskColumn, TaskComment, TaskPatch } from '../shared/types'
import { config } from './config'
import { emit } from './events'
import { readJson, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { workspace, type WorkspaceService } from './workspace'

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
const MAX_HISTORY = 300

function tasksDir(ws: WorkspaceService = workspace): string {
  return join(ws.hiveDir, 'tasks')
}

const cardFile = (n: number, ws?: WorkspaceService): string => join(tasksDir(ws), `${n}.json`)

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
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  }
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
export async function reorderTasks(column: TaskColumn, numbers: unknown, actor: TaskActor): Promise<TaskCard[]> {
  if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": todo, doing, review or done.`)
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

function note(card: TaskCard, by: string, what: string): void {
  const at = new Date().toISOString()
  card.history = [...card.history, { at, by, what }].slice(-MAX_HISTORY)
  card.updatedAt = at
}

const COLUMN_WORD: Record<TaskColumn, string> = { todo: 'Todo', doing: 'Doing', review: 'Review', done: 'Done' }

export async function createTask(
  input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; blocked?: string | null; blockedBy?: number[]; links?: number[] },
  actor: TaskActor
): Promise<TaskCard> {
  if (!workspace.path) throw new Error('No workspace is open')
  const title = text(input.title, MAX_TITLE, 'title').trim()
  if (!title) throw new Error('A task needs a title.')
  const column = input.column ?? 'todo'
  if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": todo, doing, review or done.`)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError('Only the user puts cards in Done.')
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
    history: [{ at: now, by, what: `Created in ${COLUMN_WORD[column]}` }],
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
 * Changes a card. Anyone moves it between columns, Done included (each move is in its history, with who made it);
 * putting Done in order is the user's. An archived card only changes once the user brings it back.
 */
export async function updateTask(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[] } = {}): Promise<TaskCard> {
  const ws = workspace
  const by = actorName(actor)
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
    const moving = patch.review === undefined && (patch.column === 'review' || patch.column === 'done')
    if (actor.kind === 'agent' && actor.self && moving && card.column === 'doing' && card.agent && card.agent !== actor.self.agentId) {
      const who = card.agentName ?? 'another agent'
      throw new TaskConflictError(`#${n} is in Doing with ${who}, who is working on it: newer work is in progress, so it can't be moved to ${patch.column === 'done' ? 'Done' : 'Review'} by another agent. Leave it where it is; ${who} moves it to Review when done, and the user can move it.`)
    }
    const said: string[] = []
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
      if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": todo, doing, review or done.`)
      const all = await allTasks(ws)
      const place = placement(all, card, column, patch, actor)
      if (column !== card.column) said.push(place.said ?? `Moved to ${COLUMN_WORD[column]}`)
      else if (place.said) said.push(place.said)
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
    if (!said.length && !reordered && !reviewed) return card
    for (const s of said) note(card, by, s)
    await writeJsonAtomic(cardFile(n, ws), card)
    return card
  })
  changed(ws)
  return result
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
  if (card.review && card.review.agent !== me) throw new Error(`${card.review.agentName} is reviewing #${card.number}: its verdict is its own.`)
  if (!card.review || card.column !== 'review') {
    throw new Error(`You aren't reviewing #${card.number} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.`)
  }
  said.push(patch.review === 'passed' ? 'Review passed' : 'Review failed')
  delete card.review
  return true
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
  return { number: c.number, comment: c.comments.at(-1) ?? null }
}

export async function commentTask(n: number, comment: string, actor: TaskActor): Promise<TaskCard> {
  const ws = workspace
  const t = text(comment, MAX_TEXT, 'comment').trim()
  if (!t) throw new Error('The comment is empty.')
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    if (c.archived && actor.kind !== 'user') throw new TaskPermissionError(`#${n} is archived. Only the user can bring it back.`)
    const at = new Date().toISOString()
    c.comments = [...c.comments, { at, by: actorName(actor), text: t }].slice(-MAX_COMMENTS)
    c.updatedAt = at
    await writeJsonAtomic(cardFile(n, ws), c)
    return c
  })
  changed(ws)
  return card
}

/** Archives a card (hidden from the board, kept) or brings it back. The user's alone. */
export async function archiveTask(n: number, archived: boolean): Promise<TaskCard> {
  const ws = workspace
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
    if (c.archived === archived) return c
    c.archived = archived
    if (archived) c.archivedFor = 'user'
    else delete c.archivedFor
    note(c, 'You', archived ? 'Archived' : 'Brought back from the archive')
    // Back at the end of its column.
    if (!archived) c.order = orderIn(await allTasks(ws), c.column, n, null)
    await writeJsonAtomic(cardFile(n, ws), c)
    return c
  })
  changed(ws)
  return card
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
    await shell.trashItem(file)
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
      if (existsSync(f)) await shell.trashItem(f)
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
export async function importCards(ws: WorkspaceService, cards: TaskCard[], project: string): Promise<number> {
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

