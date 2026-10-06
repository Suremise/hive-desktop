// Test housekeeping (#253, tests/e2e/clean.mjs and evidence.cjs): what goes from %LOCALAPPDATA%\hive-test and what
// always stays, whichever deletes it: the clean-up, the e2e runner (suite folders, log pruning) or the scenario runner.
import { createRequire } from 'module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { clean, holdLane, plan } from './e2e/clean.mjs'
// @ts-expect-error: plain .mjs modules without types
import { claimLane } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { pruneRunDirs } from './e2e/logs.mjs'

const require = createRequire(import.meta.url)
const { citedBy, readCards, evidence, freshFolder, clearSuiteDir } = require('./e2e/evidence.cjs')
const { pruneResults, saveBaseline } = require('./scenarios/benchmark.cjs')

type Card = { number: number; text: string }
type Ev = { ok: boolean; why: string | null; protects: (p: string) => string | null }

const temps: string[] = []
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60_000
const card = (number: number, text: string): Card => ({ number, text: text.toLowerCase().replace(/\\+/g, '/') })
/** The evidence rules for a hive-test at root, with these cards (or none readable: null). */
const rules = (root: string, cards: Card[] | null): Ev => (cards ? evidence({ cards, testRoot: root }) : evidence({ tasksDir: null, testRoot: root }))

/** Makes each path (a folder when it ends in /, else a file) and dates everything under root `days` old. */
function tree(root: string, paths: Record<string, number>): void {
  for (const p of Object.keys(paths)) {
    const full = join(root, p)
    if (p.endsWith('/')) mkdirSync(full, { recursive: true })
    else {
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x'.repeat(100))
    }
  }
  // Each folder on the way as old as the newest thing in it; deepest first, so dating a child doesn't make its folder
  // new again.
  const ages = new Map<string, number>()
  for (const [p, days] of Object.entries(paths)) {
    const parts = p.split('/').filter(Boolean)
    for (let k = 1; k <= parts.length; k++) {
      const at = parts.slice(0, k).join('/')
      ages.set(at, Math.min(ages.get(at) ?? Infinity, days))
    }
  }
  for (const [p, days] of [...ages].sort(([a], [b]) => b.split('/').length - a.split('/').length)) {
    const t = new Date(Date.now() - days * DAY)
    utimesSync(join(root, p), t, t)
  }
}

describe('what cards cite (they keep it)', () => {
  it('a path ending with its folder and name cites it, in either slash and any case, a full stop after it too', () => {
    expect(citedBy('e2e/review158-live-left-dark.png', [card(227, 'See `e2e\\review158-live-left-dark.png`.')])).toBe(227)
    expect(citedBy('e2e/lanes/0/board', [card(9, 'C:\\Users\\X\\AppData\\Local\\hive-test\\e2e\\lanes\\0\\board\\board.png')])).toBe(9)
    expect(citedBy('evidence', [card(3, 'In %LOCALAPPDATA%\\hive-test\\evidence.')])).toBe(3)
  })

  it('a path inside a folder keeps the folder', () => {
    expect(citedBy('evidence', [card(246, 'evidence\\246-before.png')], ['246-before.png', 'other.png'])).toBe(246)
    expect(citedBy('evidence', [card(246, 'evidence\\gone.png')], ['246-before.png'])).toBe(null)
  })

  it('a folder cited as a whole keeps everything in it: a lane, a scenario lane, a suite folder', () => {
    expect(citedBy('e2e/lanes/0/board', [card(7, 'everything in hive-test\\e2e\\lanes\\0 is the evidence')])).toBe(7)
    expect(citedBy('e2e/lanes/0/board/board-ws', [card(7, 'see lanes\\0\\board\\ for the run')])).toBe(7)
    expect(citedBy('scenarios/lanes/2/review-card-fake', [card(8, '%LOCALAPPDATA%\\hive-test\\scenarios\\lanes\\2')])).toBe(8)
    expect(citedBy('scenarios/lanes/2/review-card-fake/ws', [card(8, 'scenarios\\lanes\\2\\review-card-fake: kept with --keep')])).toBe(8)
  })

  it('…but a path through a folder keeps only what it names, and a name only with its boundary', () => {
    // lanes\0\board\board.png keeps the board suite's folder, not the rest of lane 0.
    expect(citedBy('e2e/lanes/0/about', [card(9, 'lanes\\0\\board\\board.png')])).toBe(null)
    // lanes\0 doesn't keep lanes\01.
    expect(citedBy('e2e/lanes/01/board', [card(9, 'hive-test\\e2e\\lanes\\0')])).toBe(null)
    expect(citedBy('e2e/lanes/0/board', [card(9, 'hive-test\\e2e\\lanes\\01')])).toBe(null)
    // The areas themselves, named when cards talk about the tests, keep nothing.
    expect(citedBy('e2e/review12-probe', [card(9, 'Everything goes in %LOCALAPPDATA%\\hive-test\\e2e.')])).toBe(null)
    expect(citedBy('scratch/claudio-2026-10-01', [card(9, 'probes go in hive-test\\scratch\\<agent>-<date>')])).toBe(null)
  })

  it("a name alone isn't a citation, nor a longer name, nor the same word in another path", () => {
    expect(citedBy('charts-132', [card(253, 'One-off folders (`charts-132`, `evidence`) to remove')], ['a.png'])).toBe(null)
    expect(citedBy('scripts', [card(185, 'the renderer libraries in `scripts/licenses.mjs`')], ['probe.cjs'])).toBe(null)
    expect(citedBy('e2e/review1', [card(5, 'e2e\\review158-dark.png')])).toBe(null)
    expect(citedBy('e2e/view.png', [card(5, 'e2e\\preview.png')])).toBe(null)
  })

  it("reads the cards that aren't Done or archived; a card it can't read means nothing may go", () => {
    const dir = temp('hive-clean-board-')
    const write = (n: number, c: object) => writeFileSync(join(dir, `${n}.json`), JSON.stringify({ number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    write(1, { description: 'hive-test\\e2e\\a.png' })
    write(2, { column: 'done', description: 'hive-test\\e2e\\b.png' })
    write(3, { archived: true, description: 'hive-test\\e2e\\c.png' })
    write(4, { column: 'passed', comments: [{ text: 'e2e\\D.png' }] })
    writeFileSync(join(dir, 'board.json'), '{"next":6}')
    const read = readCards(dir)
    expect(read.ok).toBe(true)
    expect(read.cards.map((c: Card) => c.number).sort()).toEqual([1, 4])
    expect(citedBy('e2e/d.png', read.cards)).toBe(4)
    expect(citedBy('e2e/b.png', read.cards)).toBe(null)
    writeFileSync(join(dir, '5.json'), '{ damaged')
    const damaged = readCards(dir)
    expect(damaged.ok).toBe(false)
    expect(damaged.why).toMatch(/card 5\.json .* can't be read/)
    const ev = evidence({ tasksDir: dir, testRoot: 'C:\\hive-test' })
    expect(ev.protects('C:\\hive-test\\e2e\\anything')).toMatch(/can't be read/)
  })
})

describe('the clean-up (clean.mjs)', () => {
  /** A hive-test with something of each kind; lane 1 held by a runner (pid 4242). */
  function machine() {
    const root = temp('hive-clean-root-')
    const lanesDir = join(root, 'e2e-lanes')
    tree(root, {
      'codex/auth.json': 30,
      'codex/packages/': 30,
      'claude/.credentials.json': 30,
      'scenarios/results/run1/results.json': 30,
      'scenarios/lanes/0/old-scenario/': 10,
      'scenarios/lanes/0/new-scenario/': 0,
      'scenarios/lanes/2/kept-scenario/ws/': 10,
      'e2e/logs/run-20260101-000000/board.log': 30,
      'e2e/lanes/0/board-profile/Cache/data': 0,
      'e2e/lanes/0/board.png': 0,
      'e2e/lanes/0/board/board.png': 0,
      'e2e/lanes/0/about/about-profile/x': 10,
      'e2e/lanes/0/about-2/about-profile/x': 10,
      'e2e/lanes/1/board-profile/x': 0,
      'e2e/lanes/1/about/': 10,
      'e2e/lanes/3/board-profile/x': 10,
      'e2e/lanes/3/about/': 10,
      'e2e/review12-probe/': 10,
      'e2e/review13-cited/shot.png': 10,
      'e2e/review14-done/': 10,
      'e2e/board-profile/': 1,
      'charts-132/': 10,
      'evidence/246-before.png': 10,
      'short tmp/': 0,
      'checks.txt': 10,
      'scratch/claudio-2026-10-01/': 10,
      'scratch/claudio-2026-10-06/': 0,
      'progress-timings.json': 30,
      'heavy-slots/': 30,
      'build-locks/': 30
    })
    mkdirSync(lanesDir, { recursive: true })
    writeFileSync(join(lanesDir, 'lane-1.json'), JSON.stringify({ pid: 4242, at: Date.now() }))
    const cards = [
      card(300, 'kept: hive-test\\e2e\\review13-cited\\shot.png'),
      card(301, 'see evidence\\246-before.png'),
      card(302, 'the whole lane: %LOCALAPPDATA%\\hive-test\\e2e\\lanes\\3'),
      card(303, 'kept with --keep: hive-test\\scenarios\\lanes\\2\\kept-scenario')
    ]
    const alive = (pid: number) => pid === 4242
    return { root, lanesDir, cards, alive }
  }
  const run = (m: ReturnType<typeof machine>, o: { cards?: Card[] | null; [k: string]: unknown } = {}) => {
    const { cards = m.cards, ...rest } = o
    return clean({ root: m.root, lanesDir: m.lanesDir, ev: rules(m.root, cards), alive: m.alive, owner: 777, ...rest })
  }
  const there = (root: string, p: string) => existsSync(join(root, p))

  it('removes stale leftovers and keeps sign-ins, results, logs, held lanes, new things and what open cards cite', async () => {
    const m = machine()
    const r = await run(m)
    const gone = r.removed.map((x: { rel: string }) => x.rel).sort()
    expect(gone).toEqual(['charts-132', 'checks.txt', 'e2e/lanes/0/about', 'e2e/lanes/0/about-2', 'e2e/lanes/0/board-profile', 'e2e/lanes/0/board.png', 'e2e/review12-probe', 'e2e/review14-done', 'scenarios/lanes/0/old-scenario', 'scratch/claudio-2026-10-01'])
    // Never the test homes' sign-ins, scenario results, logs, the claims and the timings.
    for (const p of ['codex/auth.json', 'codex/packages', 'claude/.credentials.json', 'scenarios/results/run1/results.json', 'e2e/logs/run-20260101-000000/board.log', 'progress-timings.json', 'heavy-slots', 'build-locks'])
      expect(there(m.root, p), p).toBe(true)
    // A lane a runner holds: nothing in it, legacy or old.
    expect(there(m.root, 'e2e/lanes/1/board-profile/x')).toBe(true)
    expect(there(m.root, 'e2e/lanes/1/about')).toBe(true)
    // An idle lane: a recent suite folder stays (its screenshots); scenario lanes go by age.
    expect(there(m.root, 'e2e/lanes/0/board/board.png')).toBe(true)
    expect(there(m.root, 'scenarios/lanes/0/new-scenario')).toBe(true)
    // Cited by an open card: kept, and said so; a lane or a scenario folder cited as a whole keeps what is in it.
    expect(there(m.root, 'e2e/review13-cited/shot.png')).toBe(true)
    expect(there(m.root, 'evidence/246-before.png')).toBe(true)
    expect(r.items.find((i: { rel: string }) => i.rel === 'evidence').why).toBe('cited by #301')
    expect(there(m.root, 'e2e/lanes/3/board-profile/x')).toBe(true)
    expect(there(m.root, 'e2e/lanes/3/about')).toBe(true)
    expect(r.items.find((i: { rel: string }) => i.rel === 'e2e/lanes/3/about').why).toBe('cited by #302')
    expect(there(m.root, 'scenarios/lanes/2/kept-scenario/ws')).toBe(true)
    // New things stay.
    for (const p of ['short tmp', 'e2e/board-profile', 'scratch/claudio-2026-10-06']) expect(there(m.root, p), p).toBe(true)
    expect(r.freed).toBeGreaterThan(0)
    // The lane it cleaned is free again; the runner's claim is untouched.
    expect(readdirSync(m.lanesDir).sort()).toEqual(['lane-1.json'])
  })

  it('a dry run removes nothing', async () => {
    const m = machine()
    const dry = await run(m, { dryRun: true })
    expect(dry.removed).toEqual([])
    expect(dry.items.filter((i: { remove: boolean }) => i.remove).length).toBe(10)
    expect(there(m.root, 'charts-132')).toBe(true)
  })

  it("while the board can't be read, nothing at all goes (lanes too), and it says why", async () => {
    const m = machine()
    const blind = await run(m, { cards: null })
    expect(blind.removed).toEqual([])
    expect(blind.blocked).toMatch(/no board was found/)
    expect(blind.items.every((i: { remove: boolean }) => !i.remove)).toBe(true)
    for (const p of ['charts-132', 'e2e/lanes/0/board-profile', 'e2e/lanes/0/about', 'scenarios/lanes/0/old-scenario']) expect(there(m.root, p), p).toBe(true)
  })

  it('--days 0 empties idle lanes but still keeps what is held, cited and kept', async () => {
    const m = machine()
    await run(m, { days: 0 })
    expect(readdirSync(join(m.root, 'e2e', 'lanes', '0'))).toEqual([])
    expect(there(m.root, 'e2e/lanes/1/board-profile/x')).toBe(true)
    expect(there(m.root, 'e2e/lanes/3/about')).toBe(true)
    expect(there(m.root, 'e2e/review13-cited')).toBe(true)
    expect(there(m.root, 'codex/auth.json')).toBe(true)
  })

  it("never follows a link out (a worktree's node_modules junction)", async () => {
    const m = machine()
    const outside = temp('hive-clean-outside-')
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    symlinkSync(outside, join(m.root, 'charts-132', 'node_modules'), 'junction')
    const r = await run(m, { days: 0 })
    expect(r.failed).toEqual([])
    expect(there(m.root, 'charts-132')).toBe(false)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
  })

  it('a lane being cleaned is claimed: a runner takes another; a held lane is not cleaned', async () => {
    const dir = temp('hive-clean-lanes-')
    const release = await holdLane(dir, 0, { owner: 10, alive: () => true })
    expect(release).toBeTypeOf('function')
    const runner = await claimLane(dir, { owner: 11, alive: () => true, free: async () => true })
    expect(runner.lane).toBe(1)
    expect(await holdLane(dir, 1, { owner: 12, alive: () => true })).toBe(null)
    release()
    expect(existsSync(join(dir, 'lane-0.json'))).toBe(false)
    expect(existsSync(join(dir, 'lane-1.json'))).toBe(true)
  })

  it('plan says why for each thing it looked at', () => {
    const m = machine()
    const items = plan({ root: m.root, ev: rules(m.root, m.cards), held: (k: number) => k === 1 })
    const why = (rel: string) => items.find((i: { rel: string }) => i.rel === rel)?.why
    expect(why('e2e/lanes/1')).toBe('a runner holds the lane')
    expect(why('e2e/lanes/0/board-profile')).toMatch(/before suites had folders of their own/)
    expect(why('e2e/lanes/0/about-2')).toMatch(/days old/)
    expect(why('charts-132')).toMatch(/days old/)
    expect(why('short tmp')).toBe('newer than 3 days')
    expect(why('codex')).toBe(undefined)
  })
})

describe("the runners' own deletions keep evidence too", () => {
  it("a suite's folder: reused when nothing in it is cited, else the next free one; never another run's evidence", () => {
    const root = temp('hive-clean-suite-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'board/board.png': 0, 'board/board-profile/x': 0, 'about/about.png': 0, 'about/about-ws/a.ts': 0 })
    const ev = rules(root, [card(400, 'failed: hive-test\\e2e\\lanes\\0\\board\\board.png')])
    // Cited: kept as it was, the run gets board-2.
    expect(freshFolder(join(lane, 'board'), ev)).toBe(join(lane, 'board-2'))
    expect(readFileSync(join(lane, 'board', 'board.png'), 'utf8')).toHaveLength(100)
    expect(readdirSync(join(lane, 'board-2'))).toEqual([])
    // Not cited: emptied and reused.
    expect(freshFolder(join(lane, 'about'), ev)).toBe(join(lane, 'about'))
    expect(readdirSync(join(lane, 'about'))).toEqual([])
  })

  it("…and while the board can't be read, an earlier folder is never emptied", () => {
    const root = temp('hive-clean-suite-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'about/about.png': 0 })
    expect(freshFolder(join(lane, 'about'), rules(root, null))).toBe(join(lane, 'about-2'))
    expect(existsSync(join(lane, 'about', 'about.png'))).toBe(true)
  })

  it('after a pass its folders go and its files stay, except a folder a card cited meanwhile', () => {
    const root = temp('hive-clean-suite-')
    const dir = join(root, 'e2e', 'lanes', '0', 'board')
    tree(dir, { 'board-profile/Cache/x': 0, 'board-ws/a.ts': 0, 'evidence/shot.png': 0, 'board.png': 0, 'replysize.json': 0 })
    const ev = rules(root, [card(401, 'lanes\\0\\board\\evidence\\shot.png')])
    expect(clearSuiteDir(dir, ev)).toEqual({ removed: 2, kept: ['cited by #401'] })
    expect(readdirSync(dir).sort()).toEqual(['board.png', 'evidence', 'replysize.json'])
    expect(lstatSync(join(dir, 'evidence', 'shot.png')).isFile()).toBe(true)
  })

  /** A real board folder: cards written as Hive writes them, so a test can change one between two looks. */
  function board(root: string) {
    const dir = join(root, 'board')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'board.json'), '{"next":500}')
    const write = (n: number, c: object) => writeFileSync(join(dir, `${n}.json`), JSON.stringify({ number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    write(1, { description: 'nothing cited' })
    return { dir, write }
  }

  it('a card that cites a folder after an earlier look still keeps it: every deletion reads the board afresh', () => {
    const root = temp('hive-clean-live-')
    const b = board(root)
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    const dir = join(root, 'e2e', 'lanes', '0', 'board')
    const profile = join(dir, 'board-profile')
    tree(dir, { 'board-profile/evidence.txt': 0, 'board-ws/a.ts': 0 })
    // Looked at while nothing cited it…
    expect(ev.protects(profile)).toBe(null)
    // …then a card in Review cites a file in it, and the suite passes at once.
    b.write(2, { column: 'review', comments: [{ text: 'see hive-test/e2e/lanes/0/board/board-profile/evidence.txt' }] })
    expect(clearSuiteDir(dir, ev)).toEqual({ removed: 1, kept: ['cited by #2'] })
    expect(readFileSync(join(profile, 'evidence.txt'), 'utf8')).toHaveLength(100)
    // The same for a folder the next run would take over, and for the clean-up's removals.
    expect(freshFolder(dir, ev)).toBe(`${dir}-2`)
    expect(existsSync(join(profile, 'evidence.txt'))).toBe(true)
  })

  it("a fresh folder cited during the run, then the board unreadable at its clean-up: nothing goes, and it says why", () => {
    const root = temp('hive-clean-live-')
    const b = board(root)
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    const lane = join(root, 'e2e', 'lanes', '0')
    const dir = freshFolder(join(lane, 'about'), ev)
    expect(dir).toBe(join(lane, 'about'))
    tree(dir, { 'evidence/shot.png': 0, 'about-profile/x': 0, 'about.png': 0 })
    b.write(3, { description: 'hive-test\\e2e\\lanes\\0\\about\\evidence\\shot.png' })
    // A card being saved badly (or the board gone) when the suite passes: everything stays.
    writeFileSync(join(b.dir, '4.json'), '{ half-written')
    const r = clearSuiteDir(dir, ev)
    expect(r.removed).toBe(0)
    expect(r.kept).toHaveLength(2)
    expect(r.kept[0]).toMatch(/card 4\.json .* can't be read/)
    expect(readdirSync(dir).sort()).toEqual(['about-profile', 'about.png', 'evidence'])
    // Readable again: the cited folder still stays, the rest goes.
    b.write(4, { description: 'fixed' })
    expect(clearSuiteDir(dir, ev)).toEqual({ removed: 1, kept: ['cited by #3'] })
    expect(readdirSync(dir).sort()).toEqual(['about.png', 'evidence'])
  })

  it("the clean-up checks each removal against the board as it is then, not as it was when it listed them", async () => {
    const root = temp('hive-clean-live-')
    const b = board(root)
    tree(root, { 'charts-132/a.png': 10, 'evidence-old/b.png': 10 })
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    // The listing sees both as stale; a card cites one between the listing and its removal.
    const real = ev.snapshot
    ev.snapshot = () => {
      const s = real()
      b.write(5, { description: 'hive-test\\evidence-old\\b.png' })
      return s
    }
    const r = await clean({ root, lanesDir: join(root, 'e2e-lanes'), ev, owner: 778 })
    expect(r.removed.map((x: { rel: string }) => x.rel)).toEqual(['charts-132'])
    expect(r.failed).toEqual([{ rel: 'evidence-old', error: 'cited by #5' }])
    expect(existsSync(join(root, 'evidence-old', 'b.png'))).toBe(true)
  })

  it('log pruning keeps a run a card cites (beyond KEEP_RUNS), and every run while the board is unreadable', () => {
    const root = temp('hive-clean-logs-')
    const logs = join(root, 'e2e', 'logs')
    const names = Array.from({ length: 6 }, (_, k) => `run-20261005-23000${k}`)
    for (const n of names) tree(logs, { [`${n}/board.log`]: 0 })
    const ev = rules(root, [card(256, 'C:\\Users\\X\\AppData\\Local\\hive-test\\e2e\\logs\\run-20261005-230000 has the failure')])
    const gone = pruneRunDirs(logs, 2, [], () => false, (p: string) => ev.protects(p))
    expect(gone).toEqual(names.slice(1, 4))
    expect(readdirSync(logs).sort()).toEqual([names[0], names[4], names[5]])
    expect(pruneRunDirs(logs, 0, [], () => false, (p: string) => rules(root, null).protects(p))).toEqual([])
  })

  it('scenario results and older baselines a card cites stay', () => {
    const root = temp('hive-clean-sc-')
    const results = join(root, 'scenarios', 'results')
    for (const n of ['2026-10-01T00-00-00-fake', '2026-10-02T00-00-00-fake', '2026-10-03T00-00-00-fake']) tree(results, { [`${n}/results.json`]: 0 })
    const ev = rules(root, [card(272, 'hive-test/scenarios/results/2026-10-01T00-00-00-fake/summary.md')])
    pruneResults(results, 1, (p: string) => ev.protects(p))
    expect(readdirSync(results).sort()).toEqual(['2026-10-01T00-00-00-fake', '2026-10-03T00-00-00-fake'])
    // Older copies of a baseline: one cited stays when the newest few are kept.
    const baselines = join(root, 'scenarios', 'baselines')
    const file = join(root, 'b.json')
    const cited = rules(root, [card(272, 'hive-test\\scenarios\\baselines\\x.2026-01-01T00-00-00.json')])
    mkdirSync(baselines, { recursive: true })
    for (let k = 0; k < 7; k++) {
      writeFileSync(file, JSON.stringify({ createdAt: `2026-01-0${k + 1}T00:00:00.000Z` }))
      saveBaseline(baselines, 'x', file, (p: string) => cited.protects(p))
    }
    expect(readdirSync(baselines)).toContain('x.2026-01-01T00-00-00.json')
  })
})
