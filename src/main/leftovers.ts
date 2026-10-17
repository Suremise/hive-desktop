import { join, relative } from 'path'
import { lstat, readdir, rm } from 'original-fs/promises'
import { HIVE_DIR } from '../shared/defaults'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('leftovers')

/** A temp file of Hive's atomic writes: `<file>.<pid>-<counter>.tmp` (writeTextAtomic, syncCopy) or `<file>.<pid>-<hex>.tmp` (watches, deliveries). */
const TEMP = /^(.+)\.\d+-[0-9a-f]+\.tmp$/i
/** The copy the project-id migration (#508) kept of a record before first changing it. */
const BEFORE_IDS = /^(.+)\.before-ids\.bak$/i
/** A temp file older than this can't be a write still under way, in this Hive or another. */
export const TEMP_AGE_MS = 24 * 60 * 60 * 1000
/** A migration's copy is kept a week after it was made (an older Hive's workspace, just migrated, keeps it a while). */
export const BAK_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One of Hive's stores: a folder (relative to a .hive) and the files Hive writes there. Only a temp file of one of those
 * files (`temp`), or the migration's copy of one it migrated (`bak`), is ever removed: the same suffix on anything else
 * (the user's notes, attachments, a folder Hive doesn't know) is never taken for a failed save.
 */
export interface Store {
  dir: string
  temp: RegExp
  bak?: RegExp
}

/** The workspace's .hive: its settings and records, the board, metrics and the Assistant's home. */
export const WORKSPACE_STORES: Store[] = [
  { dir: '.', temp: /^(workspace|lanes|watches|project-names|handover-owners|bundled)\.json(\.bak)?$/i, bak: /^(lanes|watches)\.json$/i },
  { dir: 'tasks', temp: /^(\d+|board)\.json$/i, bak: /^\d+\.json$/i },
  { dir: 'metrics', temp: /^metrics\.json$/i },
  { dir: join('metrics', 'benchmarks'), temp: /^[\w-]+\.json$/i },
  { dir: 'assistant', temp: /^(project|sessions|deliveries|sync)\.json(\.bak)?$/i },
  { dir: join('assistant', 'sessions'), temp: /^[\w-]+\.jsonl$/i }
]

/** A project's .hive: its settings, sessions and deliveries, and its transcript backups. */
export const PROJECT_STORES: Store[] = [
  { dir: '.', temp: /^(project|sessions|deliveries|sync)\.json(\.bak)?$/i },
  { dir: 'sessions', temp: /^[\w-]+\.jsonl$/i }
]

/**
 * Whether a store's folder is where it says, inside its .hive: the .hive and every folder down to it a real folder, never
 * a link or junction (which would make a folder outside it look like Hive's store).
 */
async function plainDir(hive: string, dir: string): Promise<boolean> {
  let at = hive
  for (const part of ['', ...dir.split(/[\\/]/).filter((x) => x && x !== '.')]) {
    at = part ? join(at, part) : at
    const st = await lstat(at).catch(() => null)
    if (!st?.isDirectory() || st.isSymbolicLink()) return false
  }
  return true
}

export interface Swept {
  /** Removed files, by kind, per folder. */
  removed: { dir: string; temp: number; bak: number }[]
  temp: number
  bak: number
}

/**
 * Removes what Hive's writes left in its stores (#1016): temp files of its atomic writes a crash left (older than a day)
 * and the project-id migration's `*.before-ids.bak` copies (older than a week). Each root is a .hive with its stores;
 * only the files each store names are looked at, in that folder only (not its subfolders), and only in a store that is a
 * real folder inside its .hive, never one reached through a link or junction, and never a link to a file. What can't be removed (held
 * open) is left for the next open. Stops when `signal` is aborted, checked again just before each removal.
 */
export async function sweepLeftovers(roots: { hive: string; stores: Store[] }[], opts: { now?: number; signal?: AbortSignal } = {}): Promise<Swept> {
  const now = opts.now ?? Date.now()
  const out: Swept = { removed: [], temp: 0, bak: 0 }
  for (const root of roots) {
    for (const store of root.stores) {
      if (opts.signal?.aborted) return out
      const dir = join(root.hive, store.dir)
      if (!(await plainDir(root.hive, store.dir))) continue
      const names = await readdir(dir).catch(() => [] as string[])
      let temp = 0
      let bak = 0
      for (const name of names) {
        const t = TEMP.exec(name)?.[1]
        const b = t === undefined ? BEFORE_IDS.exec(name)?.[1] : undefined
        const kind = t !== undefined && store.temp.test(t) ? 'temp' : b !== undefined && store.bak?.test(b) ? 'bak' : null
        if (!kind) continue
        const file = join(dir, name)
        // The file itself, not what a link points to.
        const st = await lstat(file).catch(() => null)
        // Made when: a copy keeps its source's modified time on Windows, so its creation time says when it was made.
        if (!st?.isFile() || now - Math.max(st.mtimeMs, st.birthtimeMs) < (kind === 'temp' ? TEMP_AGE_MS : BAK_AGE_MS)) continue
        if (opts.signal?.aborted) break
        if (!(await rm(file).then(() => true, () => false))) continue
        if (kind === 'temp') temp++
        else bak++
      }
      if (temp || bak) {
        out.removed.push({ dir, temp, bak })
        out.temp += temp
        out.bak += bak
      }
    }
  }
  return out
}

/**
 * The sweep for a workspace as it opens: its .hive and its projects' (hidden ones too), told in the log once. The
 * workspace and its lifetime are taken together before anything is awaited: if it closes or the window opens another
 * meanwhile, nothing more is removed, and nothing of the next workspace's is ever looked at.
 */
export async function sweepWorkspaceLeftovers(ws: WorkspaceService): Promise<Swept | null> {
  const path = ws.path
  const life = ws.lifetime
  if (!path) return null
  const still = (): boolean => !life.aborted && ws.path === path
  const shown = await ws.listProjectPaths()
  if (!still()) return null
  const hidden = await ws.listProjectPaths({ hidden: true })
  if (!still()) return null
  const roots = [{ hive: join(path, HIVE_DIR), stores: WORKSPACE_STORES }, ...[...shown, ...hidden].map((p) => ({ hive: join(p, HIVE_DIR), stores: PROJECT_STORES }))]
  const swept = await sweepLeftovers(roots, { signal: life })
  if (swept.temp || swept.bak) {
    const where = swept.removed.map((r) => `${userText(relative(path, r.dir))} (${[r.bak ? `${r.bak} .before-ids.bak` : '', r.temp ? `${r.temp} .tmp` : ''].filter(Boolean).join(', ')})`).join('; ')
    log.info(`removed ${swept.bak} old migration backup(s) and ${swept.temp} leftover temp file(s) from ${userText(path)}: ${where}`)
  }
  return swept
}
