import { basename, join } from 'path'
import { mkdir, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { projectAgents } from '../shared/defaults'
import { isTaskColumn, sortCards } from '../shared/tasks'
import type { TaskCard, TaskColumn, TaskPatch } from '../shared/types'
import { emit } from './events'
import { readJson, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger } from './logger'
import { workspace, type WorkspaceService } from './workspace'

const log = createLogger('tasks')

/**
 * The workspace's task board: one JSON file per card in .hive/tasks (<number>.json), and board.json with the next
 * number. Cards belong to a project (by folder name) and can be given to one of its agents.
 */

/** Who changes a card: the user (Hive's window), the Hive Assistant, or an agent or script through the Agent API. */
export type TaskActor = { kind: 'user' } | { kind: 'assistant' } | { kind: 'agent'; name: string }

export const actorName = (a: TaskActor): string => (a.kind === 'user' ? 'You' : a.kind === 'assistant' ? 'Assistant' : a.name)

/** A change only the user may make (or the Assistant once the user said yes): thrown for others. */
export class TaskPermissionError extends Error {}

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

/** Every card on the board (archived ones too), in board order. */
export async function allTasks(ws: WorkspaceService = workspace): Promise<TaskCard[]> {
  if (!ws.path) return []
  const names = await readdir(tasksDir(ws)).catch(() => [] as string[])
  const out: TaskCard[] = []
  for (const f of names) {
    const m = /^(\d+)\.json$/.exec(f)
    if (!m) continue
    const raw = await readJson<Partial<TaskCard> | null>(join(tasksDir(ws), f), null)
    if (raw && typeof raw === 'object') out.push(clean(raw, Number(m[1])))
  }
  return sortCards(out)
}

export async function listTasks(opts: { project?: string; column?: TaskColumn; archived?: boolean } = {}): Promise<TaskCard[]> {
  return (await allTasks()).filter(
    (c) =>
      (opts.archived === undefined ? !c.archived : c.archived === opts.archived) &&
      (opts.project === undefined || c.project.toLowerCase() === opts.project.toLowerCase()) &&
      (!opts.column || c.column === opts.column)
  )
}

export async function getTask(n: number, ws: WorkspaceService = workspace): Promise<TaskCard> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Unknown task #${n}`)
  const raw = await readJson<Partial<TaskCard> | null>(cardFile(n, ws), null)
  if (!raw || typeof raw !== 'object') throw new Error(`Unknown task #${n}`)
  return clean(raw, n)
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

async function cardRefs(v: unknown, self: number | null, what: string): Promise<number[]> {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list of card numbers`)
  const nums = [...new Set(v.map((x) => Number(String(x).replace(/^#/, ''))))]
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${what}: "${n}" is not a card number`)
    if (n === self) throw new Error(`${what}: a card can't refer to itself`)
    if (!existsSync(cardFile(n))) throw new Error(`${what}: there is no card #${n}`)
  }
  return nums
}

/** The order that puts a card before `before` in `column` (at the end without one). */
function orderIn(cards: TaskCard[], column: TaskColumn, self: number | null, before: number | null | undefined): number {
  const list = cards.filter((c) => c.column === column && !c.archived && c.number !== self)
  const i = before ? list.findIndex((c) => c.number === before) : -1
  if (i < 0) return (list.length ? Math.max(...list.map((c) => c.order)) : 0) + 1
  const prev = i > 0 ? list[i - 1].order : list[i].order - 2
  return (prev + list[i].order) / 2
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
  const project = await projectName(input.project)
  const agent = input.agent ? await agentOf(project, input.agent) : null
  const ws = workspace
  await mkdir(tasksDir(ws), { recursive: true })
  const by = actorName(actor)
  const now = new Date().toISOString()
  const blockedBy = input.blockedBy ? await cardRefs(input.blockedBy, null, 'blockedBy') : []
  const links = input.links ? await cardRefs(input.links, null, 'links') : []
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
  log.info(`#${n} created by ${by}: ${title}`)
  changed(ws)
  return card
}

/**
 * Changes a card. Moving it into or out of Done is the user's: `allowDone` says the user did it (or said yes to
 * the Assistant). An archived card only changes once the user brings it back.
 */
export async function updateTask(n: number, patch: TaskPatch, actor: TaskActor, opts: { allowDone?: boolean; check?: (card: TaskCard) => void } = {}): Promise<TaskCard> {
  const ws = workspace
  const by = actorName(actor)
  const result = await withFileLock(cardFile(n, ws), async () => {
    const card = await getTask(n, ws)
    // The caller's own conditions, on the card as it is now (Start: not archived or done meanwhile).
    opts.check?.(card)
    if (card.archived && actor.kind !== 'user') throw new TaskPermissionError(`#${n} is archived. Only the user can bring it back.`)
    const said: string[] = []
    // A card moved within its column: saved, but not worth a line in its history.
    let reordered = false
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
      if (p !== card.project) {
        said.push(p ? `Moved to ${p}` : 'Moved to the workspace')
        card.project = p
        // Its agent belongs to the old project.
        if (patch.agent === undefined && card.agent) {
          card.agent = null
          delete card.agentName
        }
      }
    }
    if (patch.agent !== undefined) {
      if (patch.agent) {
        const a = await agentOf(card.project, patch.agent)
        if (a.id !== card.agent) said.push(`Given to ${a.name}`)
        card.agent = a.id
        card.agentName = a.name
      } else if (card.agent) {
        said.push(`Taken from ${card.agentName ?? 'its agent'}`)
        card.agent = null
        delete card.agentName
      }
    }
    if (patch.column !== undefined || patch.before !== undefined) {
      const column = patch.column ?? card.column
      if (!isTaskColumn(column)) throw new Error(`Unknown column "${String(column)}": todo, doing, review or done.`)
      if ((column === 'done') !== (card.column === 'done') && actor.kind !== 'user' && !opts.allowDone) {
        throw new TaskPermissionError(column === 'done' ? 'Only the user moves cards to Done.' : `#${n} is done: only the user moves it out of Done.`)
      }
      if (column !== card.column) said.push(`Moved to ${COLUMN_WORD[column]}`)
      const order = orderIn(await allTasks(ws), column, n, patch.before)
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
      card.blockedBy = await cardRefs(patch.blockedBy, n, 'blockedBy')
      said.push(card.blockedBy.length ? `Depends on ${card.blockedBy.map((x) => `#${x}`).join(', ')}` : 'No longer depends on other cards')
    }
    if (patch.links !== undefined) {
      card.links = await cardRefs(patch.links, n, 'links')
      said.push(card.links.length ? `Linked to ${card.links.map((x) => `#${x}`).join(', ')}` : 'Removed the links')
    }
    if (!said.length && !reordered) return card
    for (const s of said) note(card, by, s)
    await writeJsonAtomic(cardFile(n, ws), card)
    return card
  })
  changed(ws)
  return result
}

export async function commentTask(n: number, comment: string, actor: TaskActor): Promise<TaskCard> {
  const ws = workspace
  const t = text(comment, MAX_TEXT, 'comment').trim()
  if (!t) throw new Error('The comment is empty.')
  const card = await withFileLock(cardFile(n, ws), async () => {
    const c = await getTask(n, ws)
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

