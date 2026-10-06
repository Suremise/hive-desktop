// The concurrency checker's temporary worktrees (concurrency.mjs, #207). Two checkers at once (from one worktree or
// two) must never remove each other's: each invocation makes its own folder, concurrency/run-<pid>-<time> (made
// atomically, with its owner's process id in owner.json), keeps everything it makes in there (the other worktrees, the
// decoy repository, the heavy-run pool) and removes only that folder. A worktree whose setup fails part way is removed
// at once, so a failed setup leaves none registered. A folder whose checker is gone (crashed, killed) is removed by the
// next checker; one kept with --keep stays until removed by hand. A worktree's node_modules is a junction to the
// checkout's: it is always removed on its own first (rmdir removes only the link), never by a recursive delete that
// could follow it.
import { execFileSync, spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve, sep } from 'path'
import { processAlive } from './logs.mjs'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** Where the checkers' folders are. */
export const CONCURRENCY_DIR = join(runContext.TEST_ROOT, 'concurrency')

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: runContext.baseEnv() })
const OWNER = 'owner.json'

/** This invocation's own folder in base: a new one, never another's (mkdir fails if it exists). */
export function invocationDir({ base = CONCURRENCY_DIR, owner = process.pid } = {}) {
  mkdirSync(base, { recursive: true })
  for (let i = 0; ; i++) {
    const dir = join(base, `run-${owner}-${Date.now().toString(36)}${i ? `-${i}` : ''}`)
    try {
      mkdirSync(dir)
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    writeFileSync(join(dir, OWNER), JSON.stringify({ pid: owner, at: Date.now() }))
    return dir
  }
}

/** Marks dir as kept (--keep): no later checker removes it. */
export function keepDir(dir) {
  const o = JSON.parse(readFileSync(join(dir, OWNER), 'utf8'))
  writeFileSync(join(dir, OWNER), JSON.stringify({ ...o, kept: true }))
}

/** Whether wt is inside dir (its own folder): removeWorktree removes nothing else. */
const inside = (dir, wt) => resolve(wt).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep)

/**
 * A worktree of root at dir/name: root's HEAD and uncommitted changes, sharing its node_modules (a junction). If a step
 * fails, what was made is removed (worktree, junction, folder) before it throws.
 */
export function addWorktree(root, dir, name) {
  const wt = join(dir, name)
  try {
    git(root, 'worktree', 'add', '--detach', '--force', wt, 'HEAD')
    const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, maxBuffer: 256 * 1024 * 1024, env: runContext.baseEnv() })
    if (diff.length) execFileSync('git', ['apply', '--whitespace=nowarn'], { cwd: wt, input: diff, env: runContext.baseEnv() })
    for (const f of git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
      mkdirSync(dirname(join(wt, f)), { recursive: true })
      copyFileSync(join(root, f), join(wt, f))
    }
    spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(wt, 'node_modules'), join(root, 'node_modules')], { stdio: 'ignore', env: runContext.baseEnv() })
    if (!existsSync(join(wt, 'node_modules', 'electron'))) throw new Error(`Couldn't link node_modules into ${wt}`)
    return wt
  } catch (e) {
    removeWorktree(root, dir, wt)
    throw e
  }
}

/** Removes the junction at nm (only the link: rmdir never follows it); throws if it is still there. */
function unlinkJunction(nm) {
  if (existsSync(nm)) spawnSync('cmd.exe', ['/c', 'rmdir', nm], { stdio: 'ignore', env: runContext.baseEnv() })
  if (existsSync(nm)) throw new Error(`Couldn't remove the node_modules link ${nm}; remove it by hand (rmdir, not a recursive delete)`)
}

/** Removes a worktree of root that is in dir: its node_modules junction first, then the worktree and its registration. */
export function removeWorktree(root, dir, wt) {
  if (!inside(dir, wt)) throw new Error(`${wt} isn't in this checker's folder ${dir}`)
  unlinkJunction(join(wt, 'node_modules'))
  spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root, stdio: 'ignore', env: runContext.baseEnv() })
  rmSync(wt, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore', env: runContext.baseEnv() })
}

/** Whether p is a worktree (its .git a file naming the repository), not a repository of its own (the decoy). */
const isWorktree = (p) => {
  try {
    return statSync(join(p, '.git')).isFile()
  } catch {
    return false
  }
}

/** Removes this invocation's folder: each worktree in it (removeWorktree), then the rest. */
export function removeInvocation(root, dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && isWorktree(join(dir, e.name))) removeWorktree(root, dir, join(dir, e.name))
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Removes the folders in base of checkers that are gone (not kept): their junctions first; a folder whose junction
 * won't go is left. A worktree they registered in another checkout stays listed there until it prunes (git worktree
 * prune, or its next checker); in root it is pruned now. Returns the folders removed.
 *
 * Two checkers starting at once sweep the same folders (#221): a folder in this sweep's list may be removed by the
 * other at any step. That is what this sweep wanted anyway, so a folder that has gone (or goes part way through) is
 * passed over, never an error that stops the checker starting. Only gone counts: a live owner, a kept folder or one
 * just made (its owner not written yet) is still left alone, and a junction that won't go still keeps its folder.
 */
export function removeStale(root, { base = CONCURRENCY_DIR, alive = processAlive } = {}) {
  if (!existsSync(base)) return []
  const removed = []
  let names
  try {
    names = readdirSync(base).filter((n) => n.startsWith('run-'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  for (const name of names) {
    const dir = join(base, name)
    let o
    try {
      o = JSON.parse(readFileSync(join(dir, OWNER), 'utf8'))
    } catch {
      // Just made, its owner not written yet; or left so by a crash, once it is a minute old. Gone: another checker
      // removed it.
      let age
      try {
        age = Date.now() - statSync(dir).mtimeMs
      } catch (e) {
        if (e.code === 'ENOENT') continue
        throw e
      }
      o = age > 60_000 ? { pid: null } : null
    }
    if (!o || o.kept || (o.pid && alive(o.pid))) continue
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlinkJunction(join(dir, e.name, 'node_modules'))
    } catch {
      // A junction that won't go: the folder stays (removing it recursively could follow the link). Or the folder
      // went meanwhile: nothing to do.
      continue
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    if (!existsSync(dir)) removed.push(dir)
  }
  if (removed.length) spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore', env: runContext.baseEnv() })
  return removed
}
