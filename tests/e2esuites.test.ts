// The e2e suites (tests/e2e/suites.mjs): sorted by name, so suites added on different branches don't conflict, each one
// names a suite that exists, and the runner's helpers: which suites a change needs (affected.mjs) and the code's
// fingerprint in a run record (record.mjs).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { AREAS, EVERYTHING, affectedSuites, under } from './e2e/affected.mjs'
// @ts-expect-error: plain .mjs modules without types
import { fingerprint } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { parentSuite, parseArgs, portBase, recordStatus, repeatStatus, selectSuites } from './e2e/runner.mjs'
// @ts-expect-error: plain .mjs modules without types
import { recordMarkdown } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { buildStamp, ensureBuild } from './e2e/build.mjs'
// @ts-expect-error: plain .mjs modules without types
import { KEEP_RUNS, finishRunDirs, logsRootFor, newRunDir, pruneRunDirs, runDirActive, runDirsInOrder } from './e2e/logs.mjs'
import { createRequire } from 'module'
import { ProgressStore } from '../src/main/progress'

type Suite = { name: string; needs?: string[]; serial?: string }
type Area = { paths: string[]; suites: string[] }
const suites = SUITES as Suite[]
const names = suites.map((s) => s.name)
const dir = join(__dirname, 'e2e')
const root = join(__dirname, '..')

describe('the e2e suite list', () => {
  it('is sorted by name, without repeats', () => {
    expect(names.length).toBeGreaterThan(50)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
  })

  it('names suites that exist, and every suite file is listed', () => {
    for (const n of names) expect(existsSync(join(dir, `${n}.cjs`)), n).toBe(true)
    const helpers = ['lib', 'fake-bridge']
    const files = execFileSync('git', ['ls-files', 'tests/e2e/*.cjs'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((f) => f.replace(/^tests\/e2e\//, '').replace(/\.cjs$/, ''))
      .filter((f) => !f.includes('/'))
    for (const f of files) if (!helpers.includes(f)) expect(names, `${f}.cjs isn't in suites.mjs`).toContain(f)
  })

  it('says why a suite must run alone', () => {
    for (const s of suites) if ('serial' in s) expect(typeof s.serial === 'string' && s.serial.length > 3, s.name).toBe(true)
  })

  it('no fixed wait of 1 s or more without a reason: wait for the condition (lib.until) instead', () => {
    // A long sleep is slower and flakier than waiting for what the next check needs. The ones left say why: they check
    // that something does NOT happen, are a loop's poll interval, or are a race's timeout.
    const unexplained: string[] = []
    for (const n of names) {
      readFileSync(join(dir, `${n}.cjs`), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const m = /sleep\((\d+)\)/.exec(line)
          if (m && Number(m[1]) >= 1000 && !/on purpose|poll interval|Promise\.race/.test(line)) unexplained.push(`${n}.cjs:${i + 1}`)
        })
    }
    expect(unexplained).toEqual([])
  })

  it('suites that run side by side take their port from the runner, not a fixed number', () => {
    for (const s of suites) {
      if (s.serial || s.needs?.length) continue
      const src = readFileSync(join(dir, `${s.name}.cjs`), 'utf8')
      expect(/HIVE_API_PORT:\s*'\d{5}'|const PORT = '?\d{5}'?(?!\))|127\.0\.0\.1:\d{5}/.test(src), `${s.name}: use lib.port()`).toBe(false)
    }
  })
})

describe('the suites a change needs (affected.mjs)', () => {
  const areas = AREAS as Area[]

  it('puts every suite in an area, and names only real suites and paths', () => {
    const inAreas = new Set(areas.flatMap((a) => a.suites))
    for (const n of names) expect(inAreas.has(n), `${n} is in no area`).toBe(true)
    for (const s of inAreas) expect(names, s).toContain(s)
    for (const p of [...areas.flatMap((a) => a.paths), ...(EVERYTHING as string[])]) expect(existsSync(join(root, p.replace(/\/$/, ''))), p).toBe(true)
  })

  it('covers every source file: in an area, or one every suite needs', () => {
    const src = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    for (const f of src) expect(under(f, EVERYTHING) || areas.some((a) => under(f, a.paths)), `${f} is in no area`).toBe(true)
  })

  it('picks an area’s suites, a suite’s own file, and about for docs the app bundles', () => {
    expect(affectedSuites(['src/renderer/src/components/Progress.tsx'], names).suites).toEqual(['progress', 'progressreport', 'replysize'])
    expect(affectedSuites(['tests/e2e/carddialog.cjs', 'docs/SPEC.md', 'CHANGELOG.md'], names).suites).toEqual(['about', 'carddialog'])
    expect(affectedSuites(['docs/USER_GUIDE.md'], names).suites).toEqual(['about', 'tipcorner', 'tips'])
    expect(affectedSuites(['README.md'], names).suites).toEqual([])
  })

  it('maps runtime resources and every user of a shared test helper (review round 1)', () => {
    expect(affectedSuites(['resources/skills/card-loop/SKILL.md'], names).suites).toEqual(expect.arrayContaining(['skills', 'skillaudience', 'skilldelivery', 'cardloop']))
    expect(affectedSuites(['resources/personas/planner.md'], names).suites).toEqual(expect.arrayContaining(['assistant', 'assistant-control']))
    expect(affectedSuites(['tests/e2e/fake-codex/fake-codex.cjs'], names).suites).toEqual(['attention', 'skilldelivery'])
    expect(affectedSuites(['tests/e2e/fake-bridge.cjs'], names).all).toBe(true)
    expect(affectedSuites(['resources/tray.png'], names).all).toBe(true)
    expect(affectedSuites(['scripts/release.mjs'], names).all).toBe(true)
    expect(affectedSuites(['docs/SPEC.md'], names).suites).toEqual(['about'])
    expect(affectedSuites(['tests/progress.test.ts', 'AGENTS.md'], names).suites).toEqual([])
    // Every suite file that uses the fake Codex is selected by it.
    const users = names.filter((n) => readFileSync(join(dir, `${n}.cjs`), 'utf8').includes('fake-codex'))
    expect(affectedSuites(['tests/e2e/fake-codex/fake-codex.cjs'], names).suites).toEqual(expect.arrayContaining(users))
  })

  it('errs towards more: shared files and unknown code mean every suite', () => {
    expect(affectedSuites(['src/renderer/src/store.ts'], names).all).toBe(true)
    expect(affectedSuites(['tests/e2e/lib.cjs'], names).all).toBe(true)
    expect(affectedSuites(['src/main/brandNewThing.ts'], names).all).toBe(true)
    expect(affectedSuites(['SRC\\Renderer\\src\\components\\Progress.tsx'], names).suites).toContain('progress')
  })
})

describe('the code fingerprint in a run record (record.mjs)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hive-fp-'))
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' })

  it('is HEAD when clean, changes with any edit or new file, and ignores line endings and the notices file', () => {
    git('init', '-q')
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n')
    git('add', '.')
    git('commit', '-qm', 'one')
    const head = git('rev-parse', '--short=12', 'HEAD').trim()
    expect(fingerprint(repo)).toBe(head)
    writeFileSync(join(repo, 'a.ts'), 'one\nTWO\n')
    const edited = fingerprint(repo)
    expect(edited).toMatch(new RegExp(`^${head}\\+[0-9a-f]{12}$`))
    writeFileSync(join(repo, 'a.ts'), 'one\r\nTWO\r\n')
    expect(fingerprint(repo)).toBe(edited)
    writeFileSync(join(repo, 'new.ts'), 'x')
    const withNew = fingerprint(repo)
    expect(withNew).not.toBe(edited)
    writeFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'rewritten by a build')
    expect(fingerprint(repo)).toBe(withNew)
  })
})

describe('the runner command line and run records (runner.mjs)', () => {
  const parse = (...a: string[]) => parseArgs(a, names)
  const pick = (...a: string[]): string[] => selectSuites(suites, parse(...a)).map((s: Suite) => s.name)

  it('keeps every suite named, and takes a flag value only when it is one', () => {
    expect(parse('--affected', 'board')).toMatchObject({ affected: 'main', named: ['board'] })
    expect(parse('--affected', 'origin/main', 'board')).toMatchObject({ affected: 'origin/main', named: ['board'] })
    expect(parse('board', '--affected')).toMatchObject({ affected: 'main', named: ['board'] })
    expect(parse('--jobs', '2', 'board')).toMatchObject({ jobs: 2, named: ['board'] })
    expect(parse('--jobs', 'board').error).toMatch(/--jobs needs/)
    expect(parse('--nope').error).toMatch(/Unknown option/)
    expect(parse('nosuch').error).toMatch(/Unknown suite/)
  })

  it('--all runs every eligible suite, also with names, and conflicts with --affected', () => {
    const everything = suites.filter((s) => !s.needs?.includes('packaged')).map((s) => s.name)
    expect(pick('--all')).toEqual(everything)
    expect(pick('--all', 'board')).toEqual(everything)
    expect(pick()).toEqual(everything)
    expect(parse('--all', '--affected').error).toMatch(/one of them/)
    expect(pick('board', 'tips')).toEqual(['board', 'tips'])
  })

  it('with --affected, named suites always run, and nothing needed means none (not everything)', () => {
    const o = parse('--affected', 'board')
    expect(selectSuites(suites, o, { suites: [] }).map((s: Suite) => s.name)).toEqual(['board'])
    expect(selectSuites(suites, o, { suites: ['tips'] }).map((s: Suite) => s.name)).toEqual(['board', 'tips'])
    expect(selectSuites(suites, parse('--affected'), { suites: [] })).toEqual([])
    expect(selectSuites(suites, parse('--affected'), { all: true }).length).toBeGreaterThan(50)
  })

  it('installer suites only with --packaged (or named)', () => {
    expect(pick('--all')).not.toContain('packaged-mcp')
    expect(pick('--all', '--packaged')).toContain('packaged-mcp')
    expect(pick('packaged-mcp')).toEqual(['packaged-mcp'])
  })

  it("a record is valid only for unchanged code and a fresh build, and says why not first", () => {
    expect(recordStatus({ before: 'abc+1', after: 'abc+1', buildStale: false })).toEqual({ valid: true, problems: [] })
    const changed = recordStatus({ before: 'abc', after: 'abc+2', buildStale: false })
    expect(changed.valid).toBe(false)
    expect(changed.problems[0]).toMatch(/changed while the suites ran/)
    expect(recordStatus({ before: 'abc', after: 'abc', buildStale: true }).problems[0]).toMatch(/isn't known to be from this source/)
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [{ name: 'board', ok: true, seconds: 3 }], logDir: 'x', summary: '1 passed', problems: changed.problems })
    expect(md.split('\n')[0]).toMatch(/^\*\*Not valid/)
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 1, results: [], logDir: 'x', summary: 's' })).toMatch(/^\*\*e2e run record\*\* · code `abc`/)
  })
})

describe('whether the dev build is from this source (build.mjs)', () => {
  const buildDir = mkdtempSync(join(tmpdir(), 'hive-build-'))
  afterAll(() => rmSync(buildDir, { recursive: true, force: true }))
  mkdirSync(join(buildDir, 'src'), { recursive: true })
  writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(buildDir, 'src', 'b.ts'), 'b\n')
  let builds = 0
  // A build that writes its output newer than every source file, as a real one does.
  const runBuild = (): void => {
    builds++
    mkdirSync(join(buildDir, 'out', 'main'), { recursive: true })
    writeFileSync(join(buildDir, 'out', 'main', 'index.js'), `built ${builds}`)
  }
  const check = (build: boolean, during?: () => void): { stale: boolean; built: boolean; why: string | null } =>
    ensureBuild({ root: buildDir, build, runBuild: () => { runBuild(); during?.() } })
  const old = new Date('2001-01-01')

  it('no build: stale, and --build builds once, then skips while nothing changed', () => {
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/no dev build/) })
    expect(check(true)).toEqual({ stale: false, built: true, why: null })
    expect(builds).toBe(1)
    expect(check(false)).toEqual({ stale: false, built: false, why: null })
    expect(check(true).built).toBe(false)
    expect(builds).toBe(1)
  })

  it('a build made without --build holds unknown code', () => {
    rmSync(join(buildDir, 'out', '.e2e-build.json'))
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/unknown/) })
    expect(check(true)).toMatchObject({ stale: false, built: true })
  })

  it('a source file deleted after the build makes it stale (every remaining file is still older)', () => {
    unlinkSync(join(buildDir, 'src', 'b.ts'))
    const r = check(false)
    expect(r).toMatchObject({ stale: true, why: expect.stringMatching(/other source/) })
    // …and a record of that run is not valid, though the code didn't change while the suites ran.
    expect(recordStatus({ before: 'abc+1', after: 'abc+1', buildStale: r.stale }).valid).toBe(false)
    const n = builds
    expect(check(true)).toMatchObject({ stale: false, built: true })
    expect(builds).toBe(n + 1)
  })

  it('changed content with an older time, or an older copy restored, makes it stale', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a changed\n')
    utimesSync(join(buildDir, 'src', 'a.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\n')
    utimesSync(join(buildDir, 'src', 'a.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
    writeFileSync(join(buildDir, 'src', 'new.ts'), 'added\n')
    utimesSync(join(buildDir, 'src', 'new.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
  })

  it('line endings alone keep it fresh; a source change while building leaves no stamp at all', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\r\n')
    expect(check(false).stale).toBe(false)
    writeFileSync(join(buildDir, 'src', 'b.ts'), 'b again\n')
    expect(check(true, () => writeFileSync(join(buildDir, 'src', 'a.ts'), 'edited mid-build\n'))).toMatchObject({ stale: true, built: true, why: expect.stringMatching(/changed while/) })
    expect(buildStamp(buildDir)).toBeNull()
    expect(check(false).stale).toBe(true)
  })

  it("a rebuild interrupted by the source going back doesn't leave the old stamp to match it", () => {
    // Source A, built and stamped.
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'A\n')
    expect(check(true)).toMatchObject({ stale: false, built: true })
    // Source B; while B builds (its output replaces A's), the source goes back to A.
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'B\n')
    expect(check(true, () => writeFileSync(join(buildDir, 'src', 'a.ts'), 'A\n')).stale).toBe(true)
    // The source is A again, but out/ holds B's build: stale without --build, and --build really rebuilds.
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/unknown/) })
    const n = builds
    expect(check(true)).toMatchObject({ stale: false, built: true })
    expect(builds).toBe(n + 1)
  })

  it('a failed build leaves no stamp', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'C\n')
    expect(() => ensureBuild({ root: buildDir, build: true, runBuild: () => { throw new Error('build failed') } })).toThrow('build failed')
    expect(buildStamp(buildDir)).toBeNull()
    expect(check(false).stale).toBe(true)
  })
})

describe("progressreport's estimate check (lib.hadEstimate)", () => {
  const { hadEstimate } = createRequire(import.meta.url)('./e2e/lib.cjs') as { hadEstimate: (run: unknown) => boolean }
  const caller = { source: 'api' as const, workspacePath: 'C:\\ws' }

  it('a run that outlasts its estimate ends with 0 left, and still had one; a run never given one did not', () => {
    let now = 1_000_000
    const store = new ProgressStore({ now: () => now, changed: () => undefined, ownerRunning: () => true, emitEveryMs: 250 })
    // As Hive's unit runner reports: an estimate from earlier runs at the start, then steps without one.
    const run = store.start(caller, { title: 'unit: 2 files', total: 2, step: 0, estimateMs: 500 })
    now += 400
    store.update(caller, run.id, { step: 1 })
    now += 600
    store.update(caller, run.id, { step: 2 })
    const done = store.finish(caller, run.id, { ok: true, summary: '2 passed, 0 failed' })
    expect(done).toMatchObject({ state: 'passed', estimateMs: 0 })
    expect(hadEstimate(done)).toBe(true)
    const first = store.start(caller, { title: 'unit: 2 files', total: 2, step: 0 })
    now += 1000
    store.update(caller, first.id, { step: 2 })
    expect(hadEstimate(store.finish(caller, first.id, { ok: true }))).toBe(false)
    expect(hadEstimate(undefined)).toBe(false)
  })
})

describe("each run's own log folder (logs.mjs)", () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'hive-logs-'))
  afterAll(() => rmSync(logsDir, { recursive: true, force: true }))
  const second = new Date(2026, 9, 4, 15, 0, 2)

  it('two runs in the same second get folders of their own, and keep their records and logs', () => {
    const a = newRunDir(logsDir, second)
    const b = newRunDir(logsDir, second)
    const c = newRunDir(logsDir, second)
    expect([a, b, c].map((d) => d.slice(logsDir.length + 1))).toEqual(['run-20261004-150002', 'run-20261004-150002-2', 'run-20261004-150002-3'])
    writeFileSync(join(a, 'run-record.md'), 'first')
    writeFileSync(join(a, 'board.log'), 'first board')
    writeFileSync(join(b, 'run-record.md'), 'second')
    writeFileSync(join(b, 'board.log'), 'second board')
    expect(readFileSync(join(a, 'run-record.md'), 'utf8')).toBe('first')
    expect(readFileSync(join(a, 'board.log'), 'utf8')).toBe('first board')
    expect(readFileSync(join(b, 'run-record.md'), 'utf8')).toBe('second')
  })

  it('keeps the newest ten in time order, suffixes after their base (and -10 after -9), and leaves nested/ alone', () => {
    expect(runDirsInOrder(['run-20261004-150002-10', 'run-20261004-150003', 'nested', 'run-record.md', 'run-20261004-150002-9', 'run-20261004-150002'])).toEqual(['run-20261004-150002', 'run-20261004-150002-9', 'run-20261004-150002-10', 'run-20261004-150003'])
    for (let i = 0; i < 12; i++) newRunDir(logsDir, new Date(2026, 9, 4, 16, 0, i))
    mkdirSync(join(logsDir, 'nested', 'run-20261004-170000'), { recursive: true })
    writeFileSync(join(logsDir, 'run-record.md'), 'latest')
    finishRunDirs(runDirsInOrder(readdirSync(logsDir)).map((n: string) => join(logsDir, n)))
    const removed = pruneRunDirs(logsDir)
    expect(removed).toEqual(['run-20261004-150002', 'run-20261004-150002-2', 'run-20261004-150002-3', 'run-20261004-160000', 'run-20261004-160001'])
    const left = readdirSync(logsDir)
    expect(left.filter((n) => n.startsWith('run-2'))).toHaveLength(KEEP_RUNS)
    expect(left).toContain('nested')
    expect(left).toContain('run-record.md')
    expect(left).toContain('run-20261004-160011')
  })

  it('a repeat of more than ten runs in one second keeps every one of its folders until its record is saved, then the next run trims to ten', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'hive-repeat-'))
    try {
      // Older runs from before.
      finishRunDirs(Array.from({ length: 4 }, (_, i) => newRunDir(runsDir, new Date(2026, 9, 4, 14, 0, i))))
      // The repeat, as run.mjs does it: a folder per run (all in one second), each suite's log written as it ends, no
      // pruning until the end.
      const frozen = new Date(2026, 9, 4, 15, 0, 2)
      const mine: string[] = []
      for (let k = 1; k <= 11; k++) {
        const runDir = newRunDir(runsDir, frozen)
        writeFileSync(join(runDir, 'one.log'), `run ${k}`)
        mine.push(runDir)
      }
      expect(new Set(mine).size).toBe(11)
      // The one record for the repeat, saved into every run's folder, then the latest.
      for (const runDir of mine) writeFileSync(join(runDir, 'run-record.md'), 'all 11 passed')
      writeFileSync(join(runsDir, 'run-record.md'), 'all 11 passed')
      finishRunDirs(mine)
      const removed = pruneRunDirs(runsDir, KEEP_RUNS, mine)
      expect(removed).toHaveLength(4)
      for (const [k, runDir] of mine.entries()) {
        expect(readFileSync(join(runDir, 'run-record.md'), 'utf8')).toBe('all 11 passed')
        expect(readFileSync(join(runDir, 'one.log'), 'utf8')).toBe(`run ${k + 1}`)
      }
      expect(readdirSync(runsDir).filter((n) => n.startsWith('run-2'))).toHaveLength(11)
      // The next runner, in the same second again: a new name above the others, and it trims to the newest ten.
      const next = newRunDir(runsDir, frozen)
      expect(next.endsWith('run-20261004-150002-12')).toBe(true)
      finishRunDirs([next])
      pruneRunDirs(runsDir, KEEP_RUNS, [next])
      const left = runDirsInOrder(readdirSync(runsDir))
      expect(left).toHaveLength(KEEP_RUNS)
      expect(left.at(-1)).toBe('run-20261004-150002-12')
      expect(left[0]).toBe('run-20261004-150002-3')
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it("a runner never prunes another runner's run still going: a slow run overlapping a fast repeat of more than ten", () => {
    const shared = mkdtempSync(join(tmpdir(), 'hive-overlap-'))
    try {
      const A = 111
      const B = 222
      const running = new Set([A, B])
      const alive = (pid: number): boolean => running.has(pid)
      const sameSecond = new Date(2026, 9, 4, 15, 0, 2)
      // A: a slow run, started first (the base name), still running its suite.
      const a = newRunDir(shared, sameSecond, A)
      // B: a fast repeat of 11 in the same sameSecond, then its record, then it finishes and prunes.
      const b = Array.from({ length: 11 }, () => newRunDir(shared, sameSecond, B))
      for (const runDir of b) writeFileSync(join(runDir, 'run-record.md'), 'B: 11 of 11 runs passed')
      finishRunDirs(b)
      running.delete(B)
      expect(pruneRunDirs(shared, KEEP_RUNS, b, alive)).toEqual([])
      // A finishes its suite and saves its record: its folder is still there.
      writeFileSync(join(a, 'one.log'), 'A passed')
      writeFileSync(join(a, 'run-record.md'), 'A: 1 passed')
      expect(readFileSync(join(a, 'run-record.md'), 'utf8')).toBe('A: 1 passed')
      for (const runDir of b) expect(readFileSync(join(runDir, 'run-record.md'), 'utf8')).toBe('B: 11 of 11 runs passed')
      // A is done and prunes: the finished runs come down to the newest ten, A's own kept.
      finishRunDirs([a])
      running.delete(A)
      // A's own run is the oldest but protected while A prunes: the newest ten finished runs plus A's.
      expect(pruneRunDirs(shared, KEEP_RUNS, [a], alive)).toEqual(['run-20261004-150002-2'])
      expect(runDirsInOrder(readdirSync(shared))).toHaveLength(KEEP_RUNS + 1)
      expect(readFileSync(join(a, 'one.log'), 'utf8')).toBe('A passed')
      // The next runner's prune keeps the newest ten finished runs.
      expect(pruneRunDirs(shared, KEEP_RUNS, [], alive)).toEqual(['run-20261004-150002'])
      expect(runDirsInOrder(readdirSync(shared))).toHaveLength(KEEP_RUNS)
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })

  it("a run folder counts as still going only while its runner's process is alive (a crashed runner's is pruned)", () => {
    const crashed = mkdtempSync(join(tmpdir(), 'hive-crash-'))
    try {
      const runDir = newRunDir(crashed, new Date(2026, 9, 4, 15, 0, 2), 333)
      expect(runDirActive(runDir, () => true)).toBe(true)
      expect(runDirActive(runDir, () => false)).toBe(false)
      // A marker a day old is stale even if the process id is in use again.
      expect(runDirActive(runDir, () => true, Date.now() + 25 * 60 * 60_000)).toBe(false)
      expect(runDirActive(newRunDir(crashed, new Date(2026, 9, 4, 15, 0, 3)))).toBe(true)
      expect(pruneRunDirs(crashed, 0, [], () => false)).toHaveLength(2)
    } finally {
      rmSync(crashed, { recursive: true, force: true })
    }
  })

  it('a name pruned away is never given to a newer run in the same second (it would sort as the oldest)', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'hive-reuse-'))
    try {
      const when = new Date(2026, 9, 4, 15, 0, 2)
      const first = newRunDir(runsDir, when)
      newRunDir(runsDir, when)
      rmSync(first, { recursive: true })
      const again = newRunDir(runsDir, when)
      expect(again.endsWith('run-20261004-150002-3')).toBe(true)
      expect(runDirsInOrder(readdirSync(runsDir)).at(-1)).toBe('run-20261004-150002-3')
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it("a runner started inside a suite keeps its runs under logs/nested, and its ports clear of the suite's", () => {
    expect(logsRootFor('W', {})).toBe(join('W', 'logs'))
    expect(portBase({})).toBe(48300)
    // In the suite itself: the runner set both.
    expect(logsRootFor('W', { HIVE_E2E_PORT: '48302', E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302' })).toBe(join('W', 'logs', 'nested'))
    // In an agent's shell in the Hive the suite started: Hive dropped the HIVE_ variables, E2E_RUN_* remain.
    const inSession = { E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302', HIVE_API_URL: undefined }
    expect(parentSuite(inSession)).toEqual({ name: 'progressreport', port: 48302 })
    expect(logsRootFor('W', inSession)).toBe(join('W', 'logs', 'nested'))
    expect(portBase(inSession)).toBe(49302)
    // A suite run on its own, one at a time: no port, still inside a suite.
    expect(portBase({ E2E_RUN_SUITE: 'progressreport' })).toBe(49300)
    // An agent session in a real Hive (no suite): neither.
    expect(parentSuite({ HIVE_API_URL: 'http://127.0.0.1:47821' })).toBeNull()
  })
})

describe('--repeat N: runs until the first failure, one record for all (runner.mjs, record.mjs)', () => {
  const suiteNames = ['board', 'about']

  it('parses --repeat: a whole number of 1 or more, 1 by default', () => {
    expect(parseArgs(['board'], suiteNames).repeat).toBe(1)
    expect(parseArgs(['--repeat', '3', 'board'], suiteNames)).toMatchObject({ repeat: 3, named: ['board'] })
    expect(parseArgs(['board', '--repeat', '1'], suiteNames).repeat).toBe(1)
    for (const bad of [['--repeat'], ['--repeat', 'board'], ['--repeat', 'two'], ['--repeat', '0'], ['--repeat', '-1'], ['--repeat', '1.5']]) expect(parseArgs(bad, suiteNames).error).toMatch(/--repeat needs a whole number/)
  })

  const run = (ok: boolean): { ok: boolean } => ({ ok })
  const same = { before: 'abc+1', after: 'abc+1', buildStale: false }

  it('is valid only when every run passed, on unchanged code, with a build from it', () => {
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true), run(true)], ...same })).toEqual({ valid: true, problems: [] })
    const stopped = repeatStatus({ repeat: 3, runs: [run(true), run(false)], ...same })
    expect(stopped.valid).toBe(false)
    expect(stopped.problems[0]).toBe('stopped after run 2 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(false)], ...same }).problems[0]).toBe('stopped after run 1 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true), run(false)], ...same }).problems[0]).toBe('run 3 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true)], ...same }).problems[0]).toBe('only 2 of 3 runs ran')
    const changed = repeatStatus({ repeat: 3, runs: [run(true), run(true), run(true)], before: 'abc+1', after: 'abc+2', buildStale: false })
    expect(changed.valid).toBe(false)
    expect(changed.problems[0]).toMatch(/changed while the suites ran/)
    expect(repeatStatus({ repeat: 2, runs: [run(true), run(true)], ...same, buildStale: true }).valid).toBe(false)
    // One run: a failed suite shows in the record, which is still a true one.
    expect(repeatStatus({ repeat: 1, runs: [run(false)], ...same }).valid).toBe(true)
  })

  it("the record lists each run (result, logs) and each suite's result in each run, and says first when it is not valid", () => {
    const r = (ok: boolean, seconds: number) => [{ name: 'board', ok: true, seconds }, { name: 'about', ok, seconds: 6, failed: ok ? [] : ['FAIL x'] }]
    const runs = Object.assign([
      { ok: true, results: r(true, 13), logDir: 'L1', summary: '2 passed, 0 failed, 0 skipped in 0.3 min' },
      { ok: false, results: r(false, 14), logDir: 'L2', summary: '1 passed, 1 failed, 0 skipped in 0.3 min' }
    ], { repeat: 3 })
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: runs[1].results, logDir: 'L2', summary: '1 of 3 runs passed (stopped after run 2)', problems: ['stopped after run 2 of 3 failed'], runs })
    const lines = md.split('\n')
    expect(lines[0]).toBe("**Not valid — don't trust this record:** stopped after run 2 of 3 failed.")
    expect(md).toContain('· 2 of 3 runs')
    expect(md).toContain('| 1 | pass: 2 passed, 0 failed, 0 skipped in 0.3 min | `L1` |')
    expect(md).toContain('| 2 | **FAIL**: 1 passed, 1 failed, 0 skipped in 0.3 min | `L2` |')
    expect(md).toContain('| Suite | Run 1 | Run 2 |')
    expect(md).toContain('| board | pass 13s | pass 14s |')
    expect(md).toContain('| about | pass 6s | **FAIL** (1 check) 6s |')
  })
})
