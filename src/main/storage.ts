// Project Settings → Storage: what Hive keeps per project (backups, archive, images, worktrees), measured in the
// background, and Clean Up…, which moves what its preview listed to the Recycle Bin.
import { basename, join, resolve, sep } from 'path'
import { lstat, opendir, readdir } from 'original-fs/promises'
import { shell } from 'electron'
import { ASSISTANT_NAME } from '../shared/assistant'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { planCleanup, type CleanupFacts, type CleanupSession } from '../shared/storage'
import type { CleanupItem, CleanupOptions, CleanupResult, ProjectStorage, WorkspaceStorage } from '../shared/types'
import { createLogger, userText } from './logger'
import { sessions, type ListContext } from './sessions'
import { workspace } from './workspace'

const log = createLogger('storage')

/** A folder's own files' total and its subfolders, as of its modified time. */
interface DirSize {
  mtimeMs: number
  files: number
  dirs: string[]
}

/** Folders whose files don't change in place (worktrees are walked again only where a folder changed; images are written once). */
const dirCache = new Map<string, DirSize>()
const MAX_CACHED_DIRS = 200_000

/**
 * A folder's size, read a directory at a time and handing the event loop back every few hundred entries so a large
 * worktree never holds up the window or a running session. Links and junctions aren't followed, and .asar files are
 * plain files (original-fs, #246). With `cache`, a folder whose modified time hasn't changed counts what it had last
 * time (its subfolders are still checked). `signal` stops it between entries.
 */
export async function folderSize(root: string, cache: 'use' | 'refresh' | 'none' = 'none', signal?: AbortSignal): Promise<number> {
  let total = 0
  let seen = 0
  const stack = [root]
  while (stack.length) {
    signal?.throwIfAborted()
    const dir = stack.pop()!
    const st = await lstat(dir).catch(() => null)
    if (!st?.isDirectory()) continue
    const key = dir.toLowerCase()
    const hit = cache === 'use' ? dirCache.get(key) : undefined
    if (hit && hit.mtimeMs === st.mtimeMs) {
      total += hit.files
      stack.push(...hit.dirs)
      continue
    }
    let files = 0
    const dirs: string[] = []
    try {
      for await (const e of await opendir(dir)) {
        const p = join(dir, e.name)
        if (e.isDirectory()) dirs.push(p)
        else if (e.isFile()) files += (await lstat(p).catch(() => null))?.size ?? 0
        if (++seen % 300 === 0) {
          await new Promise((r) => setImmediate(r))
          signal?.throwIfAborted()
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e
      // Gone or unreadable meanwhile: what was read counts.
    }
    if (cache !== 'none') {
      if (dirCache.size > MAX_CACHED_DIRS) dirCache.clear()
      dirCache.set(key, { mtimeMs: st.mtimeMs, files, dirs })
    }
    total += files
    stack.push(...dirs)
  }
  return total
}

/** A request whose window stopped waiting for it (storage:abandon). */
export class StorageStopped extends Error {
  constructor() {
    super('Measuring stopped: nothing waits for it.')
  }
}

/** A measurement under way: the waits for it, and its stop once none is left. */
interface Measuring {
  promise: Promise<ProjectStorage>
  abort: AbortController
  waiting: Set<object>
}

const results = new Map<string, ProjectStorage>()
const running = new Map<string, Measuring>()
/**
 * The requests a window can abandon, by the window that sent them (its web contents' id; none for a caller that isn't
 * a window) and its request id, each with its waits' stops. A window abandons only its own, and all of them when its
 * page goes (abandonWindowStorage, #260): closing a window or reloading its page runs none of the page's clean-up.
 */
const requests = new Map<string, { window: number | undefined; stops: Set<() => void> }>()
const requestKey = (request: string, window: number | undefined): string => `${window ?? ''}:${request}`

/**
 * What Hive keeps for a project or the Assistant. The last result comes back at once unless `refresh`; one
 * measurement runs per project at a time. With `request`, the window (`window`, its web contents' id) can abandon the
 * call (abandonStorage), or abandons it by going: the measurement, which walks every file of every worktree, stops once
 * nothing waits for it.
 */
export function projectStorage(projectPath: string, refresh = false, request?: string, window?: number): Promise<ProjectStorage> {
  projectPath = workspace.assertSessionHost(projectPath)
  return asRequest(request, window, (key) => storageOf(projectPath, refresh, key))
}

/** The window no longer waits for this request: its call fails, and a measurement only it waited for stops. */
export function abandonStorage(request: string, window?: number): void {
  abandon(requestKey(request, window))
}

/** The window's page went (closed or reloaded): it waits for none of its requests any more. */
export function abandonWindowStorage(window: number): void {
  for (const [key, r] of [...requests]) if (r.window === window) abandon(key)
}

function abandon(key: string): void {
  const r = requests.get(key)
  requests.delete(key)
  for (const stop of r?.stops ?? []) stop()
}

async function asRequest<T>(request: string | undefined, window: number | undefined, run: (key: string | undefined) => Promise<T>): Promise<T> {
  if (request === undefined) return run(undefined)
  const key = requestKey(request, window)
  const mine = { window, stops: new Set<() => void>() }
  requests.set(key, mine)
  try {
    return await run(key)
  } finally {
    // Only its own entry: the same id sent again meanwhile has its own.
    if (requests.get(key) === mine) requests.delete(key)
  }
}

/** `request`: the request's key in `requests`, if it can be abandoned. */
function storageOf(projectPath: string, refresh: boolean, request: string | undefined): Promise<ProjectStorage> {
  const stops = request === undefined ? undefined : requests.get(request)?.stops
  if (request !== undefined && !stops) return Promise.reject(new StorageStopped())
  const key = projectPath.toLowerCase()
  const last = results.get(key)
  if (last && !refresh) return Promise.resolve(last)
  const m = running.get(key) ?? startMeasuring(projectPath, refresh)
  const wait = {}
  m.waiting.add(wait)
  return new Promise((settle, fail) => {
    const stop = (): void => {
      if (!m.waiting.delete(wait)) return
      fail(new StorageStopped())
      if (m.waiting.size) return
      // Nothing waits any more: stop walking, and let the next call start afresh.
      m.abort.abort()
      if (running.get(key) === m) running.delete(key)
    }
    stops?.add(stop)
    m.promise.then(settle, fail).finally(() => {
      m.waiting.delete(wait)
      stops?.delete(stop)
    })
  })
}

function startMeasuring(projectPath: string, refresh: boolean): Measuring {
  const key = projectPath.toLowerCase()
  const abort = new AbortController()
  const promise = measure(projectPath, refresh, abort.signal).finally(() => {
    if (running.get(key)?.promise === promise) running.delete(key)
  })
  const m: Measuring = { abort, waiting: new Set(), promise }
  running.set(key, m)
  return m
}

async function measure(projectPath: string, refresh: boolean, signal: AbortSignal): Promise<ProjectStorage> {
  const assistant = workspace.isAssistantHome(projectPath)
  const hive = join(projectPath, HIVE_DIR)
  const cache = refresh ? 'refresh' : 'use'
  // Backups grow in place, so they are always measured afresh (a few files).
  const backups = await folderSize(join(hive, 'sessions'), 'none', signal)
  const archive = await folderSize(join(hive, 'archive'), 'none', signal)
  const images = await folderSize(join(hive, 'images'), cache, signal)
  const worktrees: ProjectStorage['worktrees'] = []
  if (!assistant) {
    for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
      if (a.worktree) worktrees.push({ agent: a.name, path: a.worktree.path, bytes: await folderSize(a.worktree.path, cache, signal) })
    }
  }
  const result: ProjectStorage = {
    path: projectPath,
    name: assistant ? ASSISTANT_NAME : basename(projectPath),
    ...(assistant ? { assistant: true } : {}),
    sessions: backups,
    archive,
    images,
    worktrees,
    total: backups + archive + images + worktrees.reduce((n, w) => n + w.bytes, 0),
    computedAt: new Date().toISOString()
  }
  results.set(projectPath.toLowerCase(), result)
  return result
}

/** Every project's storage and the Assistant's, biggest first (one project at a time); `request` as for projectStorage. */
export function workspaceStorage(refresh = false, request?: string, window?: number): Promise<WorkspaceStorage> {
  return asRequest(request, window, async (key) => {
    const hosts = [...(await workspace.listProjectPaths()), workspace.assistantHome]
    const projects: ProjectStorage[] = []
    for (const p of hosts) {
      try {
        projects.push(await storageOf(workspace.assertSessionHost(p), refresh, key))
      } catch (e) {
        if (e instanceof StorageStopped) throw e
        log.warn(`measuring ${userText(p)}`, e)
      }
    }
    projects.sort((a, b) => b.total - a.total)
    return { projects, total: projects.reduce((n, p) => n + p.total, 0) }
  })
}

/** What Clean Up needs to know about a project's sessions and images. */
async function cleanupFacts(projectPath: string): Promise<CleanupFacts> {
  const file = await workspace.sessionsFile(projectPath)
  const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath) }
  const live = sessions.projectStates(projectPath)
  const liveNames = new Set(live.flatMap((s) => [s.sessionId, `run-${s.runId}`]).filter(Boolean).map((n) => n.toLowerCase()))
  const list: CleanupSession[] = []
  for (const rec of file.sessions) {
    const files = sessions.backupFiles(projectPath, rec.id)
    const backups = await Promise.all(files.map(async (path) => ({ path, bytes: (await lstat(path).catch(() => null))?.size ?? 0 })))
    // Only an archived session with backups could be cleaned up: the CLI is asked about no other.
    const inCli = rec.archived && backups.length ? !!(await sessions.providerTranscript(projectPath, rec.id, ctx).catch(() => null)) : false
    list.push({ id: rec.id, name: rec.name, archived: rec.archived, lastActiveAt: rec.lastActiveAt, running: live.some((s) => s.sessionId === rec.id), inCli, backups })
  }
  const imagesDir = join(projectPath, HIVE_DIR, 'images')
  const imageFolders: CleanupFacts['imageFolders'] = []
  for (const e of await readdir(imagesDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    const path = join(imagesDir, e.name)
    imageFolders.push({ name: e.name, path, bytes: await folderSize(path, 'use') })
  }
  return { sessions: list, imageFolders, liveNames, now: Date.now() }
}

/** What Clean Up… would remove with these options (nothing is changed). */
export async function cleanupPreview(projectPath: string, opts: CleanupOptions): Promise<CleanupItem[]> {
  projectPath = workspace.assertSessionHost(projectPath)
  return planCleanup(await cleanupFacts(projectPath), opts)
}

/**
 * Moves an image folder to the Recycle Bin, checked again just before: its session wasn't unarchived, resumed or (for
 * an orphan) recorded since, and it can't be resumed while it goes (whileCleaning).
 */
async function trashImages(projectPath: string, i: CleanupItem): Promise<void> {
  const name = basename(i.path).toLowerCase()
  await sessions.whileCleaning(projectPath, name, async () => {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id.toLowerCase() === name)
    if (i.kind === 'archived-images' && !rec?.archived) throw new Error('The session is no longer archived.')
    if (i.kind === 'orphan-images' && rec) throw new Error('The folder belongs to a session again.')
    // After the read above: nothing is awaited between this check and the removal.
    if (sessions.projectStates(projectPath).some((s) => s.sessionId.toLowerCase() === name || `run-${s.runId}`.toLowerCase() === name)) throw new Error('The session is running.')
    await shell.trashItem(i.path)
  })
}

/**
 * Removes what the preview listed (`listed`, its paths), to the Recycle Bin, after checking each still qualifies:
 * nothing it didn't list goes, and what changed since (a session resumed or unarchived) is skipped. Removing a
 * session's last copy deletes the session as Delete Session does, so its usage still counts.
 */
export async function cleanup(projectPath: string, opts: CleanupOptions, listed: string[]): Promise<CleanupResult> {
  projectPath = workspace.assertSessionHost(projectPath)
  const now = planCleanup(await cleanupFacts(projectPath), opts)
  const want = new Set(listed.map((p) => p.toLowerCase()))
  const items = now.filter((i) => want.has(i.path.toLowerCase()))
  const qualifying = new Set(items.map((i) => i.path.toLowerCase()))
  const skipped = listed.filter((p) => !qualifying.has(p.toLowerCase())).map((p) => `${p}: no longer qualifies`)
  const imagesRoot = resolve(projectPath, HIVE_DIR, 'images').toLowerCase() + sep
  let removed = 0
  let bytes = 0
  const done = (i: CleanupItem): void => {
    removed++
    bytes += i.bytes
  }
  for (const i of items.filter((x) => x.kind === 'archived-images' || x.kind === 'orphan-images')) {
    if (!resolve(i.path).toLowerCase().startsWith(imagesRoot)) continue
    try {
      await trashImages(projectPath, i)
      done(i)
    } catch (e) {
      skipped.push(`${i.path}: ${(e as Error).message}`)
    }
  }
  // Backups go a session at a time, and only when the preview listed every copy of it. The session is checked again
  // with its backups locked: unarchived, resumed or with other copies since, it's skipped.
  const bySession = new Map<string, CleanupItem[]>()
  for (const i of items) if (i.sessionId && (i.kind === 'archived-backup' || i.kind === 'gone-backup')) bySession.set(i.sessionId, [...(bySession.get(i.sessionId) ?? []), i])
  for (const [id, group] of bySession) {
    const paths = group.map((i) => i.path)
    try {
      if (group[0].kind === 'gone-backup') await sessions.delete(projectPath, id, paths)
      else await sessions.removeBackups(projectPath, id, paths)
      group.forEach(done)
    } catch (e) {
      skipped.push(...group.map((i) => `${i.path}: ${(e as Error).message}`))
    }
  }
  log.info(`Clean Up in ${userText(projectPath)}: ${removed} item(s), ${bytes} bytes${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  results.delete(projectPath.toLowerCase())
  return { removed, bytes, skipped }
}
