import { randomBytes } from 'crypto'
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'original-fs/promises'
import { join } from 'path'
import { BENCHMARK_LIMITS, aboutOf, compareScopeKey, parseArtifact, readEntry, readKept, summaryOf, type Artifact, type CompareScope, type ImportResult, type KeptEntry, type ParseResult } from '../shared/benchmark'
import type { MetricsReport } from '../shared/metrics'
import { renameRetrying, writeTextAtomic } from './fsutil'
import { createLogger } from './logger'
import type { WorkspaceService } from './workspace'

/**
 * Kept comparisons (#117): scenario benchmarks and Performance exports a user imported (or kept from the page), each a
 * validated, normalised artifact in the workspace's `.hive/metrics/benchmarks` (git-ignored with the metrics), at most
 * BENCHMARK_LIMITS.kept: when full, the oldest unpinned one goes, once the new one is safely kept. Each scope (the whole
 * workspace, its own work, a project) has its own list and remembers its chosen baseline and run; a project's page sees
 * only its own project's.
 *
 * The index is the only authority, and it records every change in progress: an entry being added (`adding`) or removed
 * (`removing`), with the change's id. Nothing is deleted except what a validated index says is being removed, or the file
 * of an add whose change never finished; a removal stays recorded until its file is really gone. A file the index doesn't
 * account for is never deleted: it is moved, once, to `quarantine/` (bounded). A damaged index is set aside (bounded) and
 * rebuilt from the valid files, and is never acted on.
 *
 * Every operation is bound to the workspace it started in: its folder and lifetime are taken before anything is awaited
 * (a dialog, a read, the queue), every write is staged and renamed into place only while that workspace is still open,
 * and an operation whose workspace closed or switched meanwhile is refused rather than written into the next one.
 */

const log = createLogger('benchmarks')

/**
 * How files are written (atomically), renamed (one attempt: the retries are renameRetrying's) and removed: replaced in
 * tests to show what a failed or held write, rename or removal leaves.
 */
export const benchIo = { write: writeTextAtomic, renameOnce: (from: string, to: string): Promise<void> => rename(from, to), unlink: (path: string): Promise<void> => unlink(path) }

/** A rename for this workspace's work: retried while Windows holds a file, the workspace checked before every attempt. */
const guardedRename = (ctx: BenchContext, from: string, to: string): Promise<void> => renameRetrying(from, to, 20, () => live(ctx), (a, b) => benchIo.renameOnce(a, b))

/** Index and kept files are read with a cap: they are Hive's, but on disk. */
const INDEX_BYTES = 512 * 1024
const KEPT_BYTES = 4 * 1024 * 1024
const MAX_SELECTED = 200
const MAX_PENDING = 20
const PENDING_MS = 10 * 60_000
/** Damaged indexes kept aside, and files kept in quarantine: the newest of each. */
const MAX_DAMAGED = 10
const MAX_QUARANTINE = 100
const ID = /^[0-9a-f]{12}$/
const ARTIFACT = /^([0-9a-f]{12})\.json$/
/**
 * Entries an index may hold in all (kept, being added, being removed): what the reader accepts and the writer keeps to.
 * Removals that can't finish (a file in use) hold their place until they do, so a keep that would go past this is
 * refused until they have.
 */
const MAX_ENTRIES = BENCHMARK_LIMITS.kept * 2
/** A quarantined file's name: when it was quarantined (sortable), a sequence for files moved in the same moment, its id. */
const QUARANTINED = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-(\d{4})-([0-9a-f]{12})\.json$/

/** Where an operation works: the workspace's folder and lifetime as they were when it started. */
export interface BenchContext {
  dir: string
  lifetime: AbortSignal
  workspacePath: string
}

/** The context of a workspace now (synchronously: call it before awaiting anything). */
export function benchContext(w: WorkspaceService): BenchContext {
  if (!w.path || w.lifetime.aborted) throw new Error('No workspace is open.')
  return { dir: join(w.path, '.hive', 'metrics', 'benchmarks'), lifetime: w.lifetime, workspacePath: w.path }
}

/** Refuses work whose workspace closed or switched since it started. */
function live(ctx: BenchContext): void {
  if (ctx.lifetime.aborted) throw new Error('The workspace was closed or switched: nothing was changed.')
}

/** An index entry: a kept comparison, or one being added or removed by change `txn`. */
interface IndexEntry extends KeptEntry {
  state?: 'adding' | 'removing'
  txn?: string
}

interface Index {
  version: 1
  entries: IndexEntry[]
  /** Each scope's chosen baseline and run (by scope key). */
  selected: Record<string, { base?: string; run?: string }>
}

/** One change at a time per folder; a settled chain is forgotten. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(ctx: BenchContext, fn: () => Promise<T>): Promise<T> {
  const key = ctx.dir.toLowerCase()
  const next = (chains.get(key) ?? Promise.resolve()).then(
    () => (live(ctx), fn()),
    () => (live(ctx), fn())
  )
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return next
}

/** A file's text, if it is at most `max` bytes (reading no more than max + 1 to tell, whatever its size was before). */
export async function readCapped(path: string, max: number): Promise<string | null> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(max + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null)
      if (!bytesRead) break
      n += bytesRead
    }
    return n > max ? null : buf.toString('utf8', 0, n)
  } finally {
    await fh.close()
  }
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/** What a recovery or a clean-up did, said on the page once. */
const notices = new Map<string, string[]>()
const notice = (ctx: BenchContext, text: string): void => {
  const list = notices.get(ctx.dir) ?? []
  if (!list.includes(text) && list.length < 5) list.push(text)
  notices.set(ctx.dir, list)
}

/**
 * Writes a file through a staged copy: written beside it, then the workspace checked, then renamed into place. Work whose
 * workspace closed or switched during the write commits nothing (the staged copy goes).
 */
async function commit(ctx: BenchContext, path: string, textValue: string): Promise<void> {
  live(ctx)
  await mkdir(ctx.dir, { recursive: true })
  const staged = `${path}.staged-${randomBytes(4).toString('hex')}`
  try {
    await benchIo.write(staged, textValue)
    // Windows can refuse a rename for a moment (a scanner or the indexer holding the target): retried, the workspace
    // checked before every attempt, so a retry after it closed commits nothing.
    await guardedRename(ctx, staged, path)
  } catch (e) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw e
  }
}

/** Whether the reader accepts an index: within the bounds, every entry unique. Every index written is checked first. */
function acceptable(index: Index): boolean {
  const ids = new Set(index.entries.map((e) => e.id))
  return index.entries.length <= MAX_ENTRIES && ids.size === index.entries.length && index.entries.filter((e) => !e.state).length <= BENCHMARK_LIMITS.kept
}

async function writeIndex(ctx: BenchContext, index: Index): Promise<void> {
  if (!acceptable(index)) throw new Error('Hive refused to write a list of kept comparisons it couldn’t read back: nothing was changed.')
  await commit(ctx, join(ctx.dir, 'index.json'), JSON.stringify(index, null, 2))
}

/** Removes a kept file; a file already gone counts as removed. Whether it is gone. */
async function removeFile(ctx: BenchContext, id: string): Promise<boolean> {
  try {
    live(ctx)
    await benchIo.unlink(join(ctx.dir, `${id}.json`))
    return true
  } catch (e) {
    if (isMissing(e)) return true
    log.warn('removing a kept comparison', e)
    return false
  }
}

/** A kept artifact read back through the normalisers (null: missing, too big or not valid). */
async function readArtifactFile(ctx: BenchContext, id: string): Promise<Artifact | null> {
  const textValue = await readCapped(join(ctx.dir, `${id}.json`), KEPT_BYTES).catch((e) => {
    if (isMissing(e)) return null
    throw e
  })
  if (textValue === null) return null
  try {
    return readKept(JSON.parse(textValue))
  } catch {
    return null
  }
}

/** An index entry re-read: a valid entry, its change state and id (both or neither), or null. */
function readIndexEntry(raw: unknown): IndexEntry | null {
  const e = readEntry(raw)
  if (!e) return null
  const o = raw as Record<string, unknown>
  if (o.state === undefined && o.txn === undefined) return e
  if ((o.state === 'adding' || o.state === 'removing') && typeof o.txn === 'string' && /^[0-9a-f]{8,32}$/.test(o.txn)) return { ...e, state: o.state, txn: o.txn }
  return null
}

/**
 * The index, validated as a whole (every entry valid and unique, within the limit and the cap; damaged otherwise), then
 * reconciled with the folder: changes in progress finished (settle), files it doesn't account for moved to quarantine,
 * an active entry whose file is gone dropped. Missing with no kept files: none yet; missing with files, or damaged:
 * recovered. Unreadable for another reason (permissions, I/O): an error, and nothing is written.
 */
async function readIndex(ctx: BenchContext): Promise<Index> {
  let textValue: string | null
  let missing = false
  try {
    textValue = await readCapped(join(ctx.dir, 'index.json'), INDEX_BYTES)
  } catch (e) {
    if (!isMissing(e)) throw new Error(`The kept comparisons can’t be read: ${(e as Error).message}`, { cause: e })
    textValue = null
    missing = true
  }
  const names = await readdir(ctx.dir).catch((e) => {
    if (isMissing(e)) return [] as string[]
    throw new Error(`The kept comparisons can’t be read: ${(e as Error).message}`, { cause: e })
  })
  // Staged copies are never authoritative: one left by an interrupted write goes.
  for (const f of names.filter((x) => /\.staged-[0-9a-f]+$/.test(x))) await rm(join(ctx.dir, f), { force: true }).catch(() => undefined)
  const files = names.map((f) => ARTIFACT.exec(f)?.[1]).filter((x): x is string => !!x)
  if (missing) return files.length ? recover(ctx, 'the list of kept comparisons was missing') : { version: 1, entries: [], selected: {} }
  let data: Record<string, unknown> | null = null
  try {
    data = textValue === null ? null : (JSON.parse(textValue) as Record<string, unknown>)
  } catch {
    data = null
  }
  if (!data || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES) return recover(ctx, 'the list of kept comparisons was damaged', data)
  const entries: IndexEntry[] = []
  for (const raw of data.entries) {
    const e = readIndexEntry(raw)
    if (!e || entries.some((x) => x.id === e.id)) return recover(ctx, 'an entry of the list of kept comparisons was damaged', data)
    entries.push(e)
  }
  if (entries.filter((e) => !e.state).length > BENCHMARK_LIMITS.kept) return recover(ctx, 'the list of kept comparisons had too many entries', data)
  const selected: Index['selected'] = {}
  const sel = data.selected && typeof data.selected === 'object' && !Array.isArray(data.selected) ? (data.selected as Record<string, unknown>) : {}
  for (const [k, v] of Object.entries(sel).slice(0, MAX_SELECTED)) {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    const id = (x: unknown): string | undefined => (typeof x === 'string' && ID.test(x) ? x : undefined)
    if (/^(workspace|own|project:[^\0]{1,255})$/.test(k)) selected[k] = { base: id(o.base), run: id(o.run) }
  }
  return reconcile(ctx, { version: 1, entries, selected }, new Set(files))
}

/**
 * Brings a validated index and the folder into agreement, deleting only what the index proves: an add whose change never
 * finished is rolled back (its file goes, the entries its change was evicting are kept again); a removal (of a finished
 * change, or an explicit Remove) is retried, and stays recorded until its file is gone. A file the index doesn't account
 * for goes to quarantine; an active entry whose file is gone is dropped (nothing to delete). Writes the index once if
 * anything changed.
 */
async function reconcile(ctx: BenchContext, index: Index, files: Set<string>): Promise<Index> {
  let changed = false
  const unfinished = new Set(index.entries.filter((e) => e.state === 'adding').map((e) => e.txn!))
  const next: IndexEntry[] = []
  for (const e of index.entries) {
    if (e.state === 'adding') {
      // Its change never finished: the new file goes (only if it is really gone is the entry dropped).
      if (await removeFile(ctx, e.id)) changed = true
      else next.push(e)
      continue
    }
    if (e.state === 'removing' && unfinished.has(e.txn!)) {
      // Evicted by an add that never finished: kept again.
      next.push({ ...e, state: undefined, txn: undefined })
      changed = true
      continue
    }
    if (e.state === 'removing') {
      if (await removeFile(ctx, e.id)) {
        changed = true
        notice(ctx, 'An interrupted removal was finished.')
      } else next.push(e)
      continue
    }
    if (!files.has(e.id)) {
      changed = true
      notice(ctx, 'A kept comparison’s file was gone: it was taken off the list.')
      continue
    }
    next.push(e)
  }
  const accounted = new Set(next.map((e) => e.id))
  const strays = [...files].filter((id) => !accounted.has(id) && !index.entries.some((e) => e.id === id && e.state === 'adding'))
  if (strays.length) await quarantine(ctx, strays, `${strays.length} file${strays.length === 1 ? '' : 's'} not in the list ${strays.length === 1 ? 'was' : 'were'} moved to quarantine/`)
  const result: Index = { ...index, entries: next.map(({ state, txn, ...rest }) => (state ? { ...rest, state, txn } : rest)) }
  if (changed) await writeIndex(ctx, result)
  return result
}

/** Moves files out of the active folder into quarantine/ (never deleted there except past its cap, the oldest first). */
async function quarantine(ctx: BenchContext, ids: string[], why: string): Promise<void> {
  live(ctx)
  const q = join(ctx.dir, 'quarantine')
  await mkdir(q, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Named by when (and, in the same moment, in which order) they came, so the oldest go first whatever their ids.
  let seq = 0
  for (const id of ids) {
    const name = `${stamp}-${String(seq++).padStart(4, '0')}-${id}.json`
    await guardedRename(ctx, join(ctx.dir, `${id}.json`), join(q, name)).catch((e) => log.warn('moving a file to quarantine', e))
  }
  // Past the cap, the oldest recognised quarantine files go (by time, then sequence, then id); anything else is left.
  const recognised = (await readdir(q).catch(() => [] as string[]))
    .map((f) => ({ f, m: QUARANTINED.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => a.m[1].localeCompare(b.m[1]) || a.m[2].localeCompare(b.m[2]) || a.m[3].localeCompare(b.m[3]))
  live(ctx)
  for (const { f } of recognised.slice(0, Math.max(0, recognised.length - MAX_QUARANTINE))) await rm(join(q, f), { force: true }).catch(() => undefined)
  notice(ctx, `${why}.`)
}

/**
 * A damaged or missing index set aside (as index.damaged-<time>.json; the newest MAX_DAMAGED kept) and rebuilt: every
 * valid kept file is adopted, with what the old index still said about it (its pin, when it was kept) where that part was
 * readable. Nothing is deleted: invalid files, and valid ones past the limit, go to quarantine, so the rebuilt index
 * accounts for every file and stays valid afterwards.
 */
async function recover(ctx: BenchContext, why: string, old?: Record<string, unknown> | null): Promise<Index> {
  live(ctx)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const setAside = await guardedRename(ctx, join(ctx.dir, 'index.json'), join(ctx.dir, `index.damaged-${stamp}-${randomBytes(3).toString('hex')}.json`)).then(
    () => true,
    (e) => {
      // The workspace went away: stop here, nothing more is done.
      if (ctx.lifetime.aborted) throw e
      if (!isMissing(e)) log.warn('setting a damaged index aside', e)
      return false
    }
  )
  const damaged = (await readdir(ctx.dir)).filter((f) => f.startsWith('index.damaged-')).sort()
  live(ctx)
  for (const f of damaged.slice(0, Math.max(0, damaged.length - MAX_DAMAGED))) await rm(join(ctx.dir, f), { force: true }).catch(() => undefined)
  const known = new Map<string, { pinned: boolean; keptAt: string }>()
  for (const raw of Array.isArray(old?.entries) ? (old!.entries as unknown[]).slice(0, 200) : []) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (r && typeof r.id === 'string' && ID.test(r.id)) known.set(r.id, { pinned: r.pinned === true, keptAt: typeof r.keptAt === 'string' && Number.isFinite(Date.parse(r.keptAt)) ? r.keptAt : '' })
  }
  const adopted: KeptEntry[] = []
  const invalid: string[] = []
  for (const f of (await readdir(ctx.dir)).filter((x) => ARTIFACT.test(x)).sort()) {
    const id = f.slice(0, 12)
    const a = await readArtifactFile(ctx, id).catch(() => null)
    if (!a) {
      invalid.push(id)
      continue
    }
    const was = known.get(id)
    const keptAt = was?.keptAt || (await stat(join(ctx.dir, f)).catch(() => null))?.mtime.toISOString() || new Date().toISOString()
    adopted.push({ id, label: a.label, kind: a.kind, scope: a.scope, createdAt: a.createdAt, keptAt, pinned: was?.pinned === true, about: aboutOf(a) })
  }
  // The newest (pinned first) are listed, up to the limit; the rest go to quarantine with the invalid ones.
  adopted.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.keptAt.localeCompare(x.keptAt))
  const entries = adopted.slice(0, BENCHMARK_LIMITS.kept)
  const overflow = adopted.slice(BENCHMARK_LIMITS.kept).map((e) => e.id)
  if (invalid.length) await quarantine(ctx, invalid, `${invalid.length} file${invalid.length === 1 ? '' : 's'} that couldn’t be read ${invalid.length === 1 ? 'was' : 'were'} moved to quarantine/`)
  if (overflow.length) await quarantine(ctx, overflow, `${overflow.length} more than can be listed ${overflow.length === 1 ? 'was' : 'were'} moved to quarantine/`)
  const index: Index = { version: 1, entries, selected: {} }
  await writeIndex(ctx, index)
  notice(ctx, `Recovered: ${why}. ${entries.length} kept comparison${entries.length === 1 ? ' is' : 's are'} listed again${setAside ? '; the old list is kept as index.damaged-….json' : ''}`)
  log.warn(`Rebuilt the kept comparisons' index (${why}): ${entries.length} listed, ${invalid.length} invalid and ${overflow.length} extra in quarantine`)
  return index
}

/**
 * Keeps an artifact, as one change recorded in the index: (1) the index gets the new entry as `adding` and the evicted
 * ones (the oldest unpinned, when full; refused if all are pinned) as `removing`, under one change id; (2) the file is
 * written; (3) the new entry becomes kept. Then each evicted file is removed, and its entry dropped only once its file is
 * gone (a failed removal stays recorded and is retried). Interrupted before (3), the change is rolled back by the next
 * read: the new file goes and the evicted entries are kept again.
 */
function keep(ctx: BenchContext, a: Artifact): Promise<KeptEntry> {
  return serial(ctx, async () => {
    const index = await readIndex(ctx)
    const active = index.entries.filter((e) => !e.state)
    const evicted: IndexEntry[] = []
    while (active.length - evicted.length >= BENCHMARK_LIMITS.kept) {
      const oldest = active.filter((e) => !e.pinned && !evicted.includes(e)).sort((x, y) => x.keptAt.localeCompare(y.keptAt))[0]
      if (!oldest) throw new Error(`${BENCHMARK_LIMITS.kept} are kept and all are pinned: unpin or remove one first.`)
      evicted.push(oldest)
    }
    // The change adds one entry to the index (the evicted ones stay, as removing, until their files are gone): refused,
    // before anything is recorded, if that would pass what the index may hold.
    if (index.entries.length + 1 > MAX_ENTRIES) {
      const waiting = index.entries.filter((e) => e.state === 'removing').length
      throw new Error(`${waiting} removed comparison${waiting === 1 ? '’s file' : 's’ files'} couldn’t be deleted yet (in use?): nothing more can be kept until ${waiting === 1 ? 'it is' : 'they are'}. Hive retries each time it reads the list.`)
    }
    const txn = randomBytes(6).toString('hex')
    const id = randomBytes(6).toString('hex')
    const entry: KeptEntry = { id, label: a.label, kind: a.kind, scope: a.scope, createdAt: a.createdAt, keptAt: new Date().toISOString(), pinned: false, about: aboutOf(a) }
    const others = index.entries.filter((e) => !evicted.includes(e))
    // (1) Recorded: nothing is touched yet.
    await writeIndex(ctx, { ...index, entries: [...others, ...evicted.map((e) => ({ ...e, state: 'removing' as const, txn })), { ...entry, state: 'adding', txn }] })
    try {
      // (2) The file, (3) committed.
      await commit(ctx, join(ctx.dir, `${id}.json`), JSON.stringify(a))
      await writeIndex(ctx, { ...index, entries: [...others, ...evicted.map((e) => ({ ...e, state: 'removing' as const, txn })), entry] })
    } catch (e) {
      // Rolled back now if the workspace is still open (else by the next read): the new file goes, the evicted stay.
      if (!ctx.lifetime.aborted) {
        if (await removeFile(ctx, id)) await writeIndex(ctx, index).catch(() => undefined)
      }
      throw e
    }
    // The evicted files go; each entry is dropped only once its file is gone.
    if (!ctx.lifetime.aborted && evicted.length) {
      const gone = new Set<string>()
      for (const e of evicted) if (await removeFile(ctx, e.id)) gone.add(e.id)
      if (gone.size) await writeIndex(ctx, { ...index, entries: [...others, ...evicted.filter((e) => !gone.has(e.id)).map((e) => ({ ...e, state: 'removing' as const, txn })), entry] }).catch((err) => log.warn('recording evicted comparisons as removed', err))
      if (gone.size < evicted.length) notice(ctx, 'An evicted comparison couldn’t be removed yet: Hive will try again.')
    }
    return entry
  })
}

/** Files picked in a dialog and waiting for an answer, by token: bound to the workspace, scope and lifetime they were picked for. */
const pending = new Map<string, { path: string; dir: string; scope: string; lifetime: AbortSignal; at: number }>()

/**
 * Imports a file for a scope: `path` from the main process's own open dialog, or a `token` from an earlier answer that
 * asked whether to use a workspace export's project part (used once, for the same workspace and scope, within 10
 * minutes). Read with a cap and checked as untrusted input (shared/benchmark.ts parseArtifact).
 */
export async function importBenchmark(ctx: BenchContext, scope: CompareScope, from: { path?: string; token?: string; useProjectPart?: boolean }): Promise<ImportResult> {
  live(ctx)
  let path = from.path
  if (from.token) {
    const p = pending.get(from.token)
    pending.delete(from.token)
    if (!p || Date.now() - p.at > PENDING_MS || p.lifetime !== ctx.lifetime || p.lifetime.aborted || p.dir !== ctx.dir || p.scope !== compareScopeKey(scope)) return { error: 'That file is no longer waiting: import it again.' }
    path = p.path
  }
  if (!path) return { error: 'No file.' }
  const textValue = await readCapped(path, BENCHMARK_LIMITS.fileBytes)
  live(ctx)
  if (textValue === null) return { error: `It is over ${BENCHMARK_LIMITS.fileBytes / 1024 / 1024} MB.` }
  const parsed: ParseResult = parseArtifact(textValue, scope, { useProjectPart: from.useProjectPart })
  if ('error' in parsed) return parsed
  if ('projectPart' in parsed) {
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS || v.lifetime.aborted) pending.delete(k)
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
    const token = randomBytes(12).toString('hex')
    pending.set(token, { path, dir: ctx.dir, scope: compareScopeKey(scope), lifetime: ctx.lifetime, at: Date.now() })
    return { ask: { token, project: parsed.projectPart.project } }
  }
  return { entry: await keep(ctx, parsed.artifact) }
}

/**
 * Keeps a report (the page's current query: scope, range, filters) as a comparison. The report must be of the context's
 * workspace (taken before it was read).
 */
export async function keepReport(ctx: BenchContext, report: MetricsReport, appVersion: string, label?: string): Promise<KeptEntry> {
  live(ctx)
  if (report.workspacePath.toLowerCase() !== ctx.workspacePath.toLowerCase()) throw new Error('The workspace was switched: nothing was kept.')
  const s = summaryOf(report, report.scope.kind === 'project' ? report.scope.project : undefined)
  const scope: CompareScope = report.scope.kind === 'project' ? { kind: 'project', project: report.scope.project } : report.filters?.own ? { kind: 'workspace', own: true } : { kind: 'workspace' }
  const a: Artifact = { schema: 'hive-metrics/1', kind: 'export', label: (label?.trim() || `Kept ${s.from.slice(0, 10)} to ${s.to.slice(0, 10)}`).slice(0, 80), createdAt: new Date().toISOString(), appVersion, scope, summary: s }
  return keep(ctx, a)
}

/** The kept (not being added or removed) entries of a scope. */
const keptOf = (index: Index, scope: CompareScope): KeptEntry[] => index.entries.filter((e) => !e.state && compareScopeKey(e.scope) === compareScopeKey(scope))

/** A scope's kept artifacts (only its own), newest first, its chosen baseline and run, and what a recovery or clean-up did. */
export async function listBenchmarks(ctx: BenchContext, scope: CompareScope): Promise<{ entries: KeptEntry[]; base: string | null; run: string | null; notice?: string }> {
  const index = await serial(ctx, () => readIndex(ctx))
  const said = notices.get(ctx.dir)
  notices.delete(ctx.dir)
  const entries = keptOf(index, scope)
    .map(({ state: _s, txn: _t, ...e }: IndexEntry) => e)
    .sort((a, b) => b.keptAt.localeCompare(a.keptAt))
  const sel = index.selected[compareScopeKey(scope)] ?? {}
  const has = (id?: string): string | null => (id && entries.some((e) => e.id === id) ? id : null)
  return { entries, base: has(sel.base), run: has(sel.run), ...(said?.length ? { notice: said.join(' ') } : {}) }
}

/** One kept artifact, if it is this scope's: its index entry, the file itself and the scope asked for must all agree. */
export async function readBenchmark(ctx: BenchContext, scope: CompareScope, id: string): Promise<Artifact> {
  if (!ID.test(id)) throw new Error('No such comparison')
  const index = await serial(ctx, () => readIndex(ctx))
  const entry = keptOf(index, scope).find((e) => e.id === id)
  if (!entry) throw new Error('No such comparison for this scope')
  const a = await readArtifactFile(ctx, id)
  live(ctx)
  if (!a) throw new Error('That comparison file is missing or damaged: remove it and import it again.')
  if (compareScopeKey(a.scope) !== compareScopeKey(entry.scope)) throw new Error('That comparison file doesn’t match its scope: remove it and import it again.')
  return a
}

/**
 * Removes a kept comparison, as a recorded change: the entry is marked `removing` (off the list), its file removed, and
 * only then the entry dropped. A file that can't be removed stays recorded (retried on the next read) and the call says
 * so; it never comes back to the list.
 */
export function removeBenchmark(ctx: BenchContext, scope: CompareScope, id: string): Promise<void> {
  return serial(ctx, async () => {
    const index = await readIndex(ctx)
    const entry = keptOf(index, scope).find((e) => e.id === id)
    if (!entry) return
    const txn = randomBytes(6).toString('hex')
    const marked: Index = { ...index, entries: index.entries.map((e) => (e.id === id ? { ...e, state: 'removing' as const, txn } : e)) }
    await writeIndex(ctx, marked)
    if (!(await removeFile(ctx, id))) throw new Error('It is off the list, but its file couldn’t be removed yet: Hive will try again.')
    await writeIndex(ctx, { ...index, entries: index.entries.filter((e) => e.id !== id) })
  })
}

export function pinBenchmark(ctx: BenchContext, scope: CompareScope, id: string, pinned: boolean): Promise<void> {
  return serial(ctx, async () => {
    const index = await readIndex(ctx)
    const entry = keptOf(index, scope).find((e) => e.id === id) as IndexEntry | undefined
    if (!entry) return
    entry.pinned = pinned
    await writeIndex(ctx, index)
  })
}

export function selectBenchmarks(ctx: BenchContext, scope: CompareScope, base: string | null, run: string | null): Promise<void> {
  return serial(ctx, async () => {
    const index = await readIndex(ctx)
    const key = compareScopeKey(scope)
    const mine = (id: string | null): string | undefined => (id && keptOf(index, scope).some((e) => e.id === id) ? id : undefined)
    // Selections of scopes with nothing kept go (bounded however many projects came and went).
    const scopes = new Set(index.entries.map((e) => compareScopeKey(e.scope)))
    const selected = Object.fromEntries(Object.entries(index.selected).filter(([k]) => scopes.has(k)))
    selected[key] = { base: mine(base), run: mine(run) }
    await writeIndex(ctx, { ...index, selected })
  })
}
