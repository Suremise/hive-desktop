// What the tests may delete in %LOCALAPPDATA%\hive-test (#253): never what a card that isn't Done cites as evidence,
// and nothing at all while the board can't be read. Every deletion of test output goes through here: the clean-up
// (clean.mjs), the e2e runner's suite folders and log pruning (run.mjs, logs.mjs), the scenario runner's lane folders,
// results and baselines (tests/scenarios). Removing never follows a link out (a worktree's node_modules is a junction).
//
// A card cites a path under hive-test by writing it (in its title, description or a comment, any slash and case):
// - the thing itself, ending with at least its folder and name: `e2e\review158-dark.png`, `lanes\0\board\board.png`,
//   `%LOCALAPPDATA%\hive-test\evidence`;
// - a path inside a folder keeps the folder: `evidence\x.png` keeps `evidence`, `lanes\0\board\board.png` keeps the
//   suite folder `lanes\0\board` (but not the rest of lane 0);
// - a folder as a whole keeps everything in it: `hive-test\e2e\lanes\0` (ending there) keeps lane 0. Only folders that
//   hold evidence count, not the areas themselves (`hive-test`, `e2e`, `e2e\lanes`, `scratch`…), which cards name when
//   they talk about the tests.
// A name alone isn't a citation: a card listing leftovers to remove names them (`charts-132`), and a folder named like
// a word (`scripts`) would be kept by any path with that word (`scripts/licenses.mjs`). Keeping a little more than
// needed is the safe side.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const runContext = require('./runContext.cjs')

/** Areas: folders that hold evidence rather than being it (relative to hive-test). Naming one keeps nothing. */
const AREAS = new Set(['', 'e2e', 'e2e/lanes', 'e2e/logs', 'e2e/logs/nested', 'scenarios', 'scenarios/lanes', 'scenarios/results', 'scenarios/baselines', 'scratch'])

/** Text written as a path: lower case, `/` for `\` (and for `\\` in JSON or Markdown). */
const pathText = (s) => String(s ?? '').toLowerCase().replace(/\\+/g, '/')

const NAME = /[a-z0-9._-]/
const isName = (c) => c !== undefined && NAME.test(c)

/**
 * Whether text has `part` as a path of its own, not inside a longer name before it. how: 'end' (it ends there: a
 * full stop or a slash closing a sentence or a folder isn't more of it), 'inside' (a path goes on into it: `part/x`),
 * 'either'.
 */
function mentions(text, part, how = 'either') {
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) {
    if (isName(text[i - 1])) continue
    const a = text[i + part.length]
    const b = text[i + part.length + 1]
    const inside = a === '/' && isName(b)
    const ends = !isName(a) ? !inside : a === '.' && !isName(b)
    if (how === 'inside' ? inside : how === 'end' ? ends : inside || ends) return true
  }
  return false
}

/** Its tails of at least two parts: ['hive-test','e2e','x'] → 'hive-test/e2e/x', 'e2e/x'. */
const tails = (parts) => Array.from({ length: Math.max(0, parts.length - 1) }, (_, k) => parts.slice(k).join('/'))

/**
 * The card citing a path under hive-test (rel: relative to it, e.g. `e2e/lanes/0/board`), or null. children: the names
 * in it when it is a folder (so `evidence\x.png` keeps `evidence`; deeper paths keep it too, as `x/…`).
 */
function citedBy(rel, cards, children = []) {
  const own = pathText(rel).split('/').filter(Boolean)
  const parts = ['hive-test', ...own]
  const ancestors = []
  for (let k = 1; k < own.length; k++) if (!AREAS.has(own.slice(0, k).join('/'))) ancestors.push(['hive-test', ...own.slice(0, k)])
  for (const { number, text } of cards) {
    for (const t of tails(parts)) if (mentions(text, t)) return number
    for (const c of children) for (const t of tails([...parts, pathText(c)])) if (mentions(text, t)) return number
    for (const a of ancestors) for (const t of tails(a)) if (mentions(text, t, 'end')) return number
  }
  return null
}

/** The workspace's cards folder (.hive\tasks) for the repository at root: found up from its main checkout, or null. */
function findBoard(root) {
  let dir
  try {
    dir = path.dirname(path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: runContext.baseEnv() }).trim()))
  } catch {
    dir = root
  }
  for (;;) {
    const tasks = path.join(dir, '.hive', 'tasks')
    if (fs.existsSync(path.join(tasks, 'board.json'))) return tasks
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * The cards that may cite evidence, from a board's folder: { ok: true, cards: [{ number, text }] } for every card that
 * is neither Done nor archived (its title, description and comments, as pathText), or { ok: false, why } when any card
 * can't be read (a card being saved is read again once first): then nothing may be deleted.
 */
function readCards(tasksDir) {
  let names
  try {
    names = fs.readdirSync(tasksDir).filter((n) => /^\d+\.json$/.test(n))
  } catch (e) {
    return { ok: false, why: `the board (${tasksDir}) can't be read: ${e.code ?? e.message}` }
  }
  const cards = []
  for (const name of names) {
    let c = null
    for (let attempt = 0; attempt < 2 && !c; attempt++) {
      try {
        c = JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') break // Archived or removed meanwhile: it cites nothing now.
        if (attempt) return { ok: false, why: `card ${name} on the board (${tasksDir}) can't be read` }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
    if (!c || c.archived || c.column === 'done') continue
    cards.push({ number: c.number, text: pathText([c.title, c.description, ...(c.comments ?? []).map((m) => m.text)].join('\n')) })
  }
  return { ok: true, cards }
}

/**
 * What may be deleted under testRoot, by the board's cards: protects(p) gives why p must stay (`cited by #n`, or that
 * the board can't be read), or null. Built from a board folder (tasksDir; null: none found, so nothing may go) or from
 * cards given (tests). Every protects() reads the board afresh (about 25 ms), so a deletion is never authorised by
 * an older look: a card that cites something a moment before it would go keeps it. snapshot() reads it once, for
 * listing many things (the clean-up's plan), never for deleting.
 */
function evidence({ tasksDir, cards, testRoot = runContext.TEST_ROOT } = {}) {
  const load = () => {
    if (cards) return { ok: true, cards }
    if (!tasksDir) return { ok: false, why: "no board was found (the workspace's .hive\\tasks, up from this repository's main checkout)" }
    return readCards(tasksDir)
  }
  /** Rules over one look (get: the cards, read when asked). */
  const rules = (get) => ({
    get ok() {
      return get().ok
    },
    get why() {
      return get().why ?? null
    },
    /** Why p (a path under testRoot) must stay, or null when it may go. */
    protects(p) {
      const s = get()
      if (!s.ok) return s.why
      const rel = path.relative(testRoot, p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside hive-test'
      const n = citedBy(rel.split(path.sep).join('/'), s.cards, safeList(p))
      return n === null ? null : `cited by #${n}`
    },
    /** One look at the board, for listing many things (not for deleting): the same ok, why and protects(p). */
    snapshot() {
      const s = get()
      return rules(() => s)
    }
  })
  return rules(load)
}

/** The evidence rules for the repository at root (its workspace's board). */
const evidenceFor = (root, opts = {}) => evidence({ tasksDir: findBoard(root), ...opts })

function safeList(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** A folder's or file's size in bytes, links counted as nothing (never followed). */
function sizeOf(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const name of safeList(p)) total += sizeOf(path.join(p, name))
  return total
}

/** Removes the links in a tree (junctions, symlinks) as links, without following them, so a recursive delete can't. */
function unlinkLinks(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p)
    } catch {
      fs.rmdirSync(p) // A junction to a folder.
    }
    return
  }
  if (st.isDirectory()) for (const name of safeList(p)) unlinkLinks(path.join(p, name))
}

/** Removes a file or folder (links in it as links): its size, or throws. Callers check protects() first. */
function removeTree(p) {
  const size = sizeOf(p)
  unlinkLinks(p)
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return size
}

/**
 * A folder of its own for a run to fill (a suite's in its lane, a scenario's): `dir` itself, emptied, unless something
 * in it must stay (ev.protects: cited, or the board can't be read), then the first of `dir-2`, `dir-3`… that is free or
 * may be emptied. So a run never deletes evidence from an earlier one. Returns the folder, made and empty.
 */
function freshFolder(dir, ev) {
  for (let n = 1; ; n++) {
    const d = n === 1 ? dir : `${dir}-${n}`
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true })
      return d
    }
    if (ev.protects(d)) continue
    try {
      removeTree(d)
      fs.mkdirSync(d, { recursive: true })
      return d
    } catch {
      // Still in use (a test Hive of a crashed run): take the next.
    }
  }
}

/**
 * A suite's folder after it passed (or skipped): its folders go (profiles, workspaces, test homes), its files stay
 * (screenshots, notification logs, reports) for a look afterwards; they go with the age rule. Each folder is checked
 * against the board as it is at that moment (ev.protects reads it afresh): one a card cites stays, and while the board
 * can't be read they all stay (the clean-up removes them once it can). Returns { removed, kept: [why] }.
 */
function clearSuiteDir(dir, ev) {
  const out = { removed: 0, kept: [] }
  for (const name of safeList(dir)) {
    const p = path.join(dir, name)
    try {
      const st = fs.lstatSync(p)
      if (!st.isDirectory() && !st.isSymbolicLink()) continue
      const why = ev.protects(p)
      if (why) {
        out.kept.push(why)
        continue
      }
      removeTree(p)
      out.removed++
    } catch {
      // Still in use (a test Hive just closing): the next clean-up removes it.
    }
  }
  return out
}

module.exports = { AREAS, pathText, mentions, citedBy, findBoard, readCards, evidence, evidenceFor, safeList, sizeOf, removeTree, freshFolder, clearSuiteDir }
