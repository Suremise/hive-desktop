// The e2e suites (tests/e2e/suites.mjs): sorted by name, so suites added on different branches don't conflict, each one
// names a suite that exists, and the runner's helpers: which suites a change needs (affected.mjs) and the code's
// fingerprint in a run record (record.mjs).
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { AREAS, EVERYTHING, REAL_TIER, affectedSuites, under } from './e2e/affected.mjs'
// @ts-expect-error: plain .mjs modules without types
import { fingerprint } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { isRealCli, parentSuite, parseArgs, portBase, realNotRun, recordStatus, repeatStatus, selectSuites, suiteOutcome } from './e2e/runner.mjs'
// @ts-expect-error: plain .mjs modules without types
import { recordMarkdown } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { buildLock, buildStamp, devBuild, ensureBuild } from './e2e/build.mjs'
// @ts-expect-error: plain .mjs modules without types
import { LANES, LANE_PORTS, claimHeld, claimLane, lanePorts, laneWork, pickLane, portFree } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { describeClaim, heavySlots, isHeavy, needsSlot, trySlot, waitForSlot } from './e2e/slots.mjs'
// @ts-expect-error: plain .mjs modules without types
import { addWorktree, invocationDir, keepDir, removeInvocation, removeStale, removeWorktree } from './e2e/tempWorktrees.mjs'
// @ts-expect-error: plain .mjs modules without types
import { KEEP_RUNS, finishRunDirs, logsRootFor, newRunDir, pruneRunDirs, runDirActive, runDirsInOrder } from './e2e/logs.mjs'
import { createRequire } from 'module'
import { ProgressStore } from '../src/main/progress'

type Suite = { name: string; needs?: string[]; serial?: string }
type Area = { paths: string[]; suites: string[] }
const suites = SUITES as Suite[]
const names = suites.map((s) => s.name)
const realNames = suites.filter(isRealCli).map((s) => s.name)
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
    const helpers = ['lib', 'fake-bridge', 'runContext']
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
    expect(affectedSuites(['tests/e2e/fake-codex/fake-codex.cjs'], names).suites).toEqual(['attention', 'footerfit', 'models', 'sessiontree', 'skilldelivery'])
    expect(affectedSuites(['tests/e2e/fake-bridge.cjs'], names).all).toBe(true)
    expect(affectedSuites(['resources/tray.png'], names).all).toBe(true)
    expect(affectedSuites(['scripts/release.mjs'], names).all).toBe(true)
    expect(affectedSuites(['docs/SPEC.md'], names).suites).toEqual(['about'])
    expect(affectedSuites(['tests/progress.test.ts', 'AGENTS.md'], names).suites).toEqual([])
    // The skills for developing Hive are notes for agents, neither shipped nor read by the app (#197).
    expect(affectedSuites(['.claude/skills/verify-hive-ui/SKILL.md', '.agents/skills/verify-hive-ui/SKILL.md'], names, realNames)).toEqual({ suites: [], why: [] })
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

  it('picks real-CLI suites only for changes to what they cover (card #191)', () => {
    const pick = (...files: string[]) => affectedSuites(files, names, realNames)
    for (const p of REAL_TIER as string[]) expect(existsSync(join(root, p.replace(/\/$/, ''))), p).toBe(true)
    // Hive's side of every CLI: every real suite, with every fake one.
    for (const f of ['src/main/sessions.ts', 'src/main/providers/types.ts', 'tests/e2e/lib.cjs', 'src/shared/providers.ts']) expect(pick(f), f).toMatchObject({ all: true, real: realNames })
    // Not shared by every part of Hive, but still every CLI's: every real suite and the area's fakes.
    expect(pick('src/main/transcripts.ts').suites).toEqual(expect.arrayContaining([...realNames, 'transcript']))
    // A provider's own adapter: only its area's real suites.
    const claude = pick('src/main/providers/claude/adapter.ts')
    expect(claude.all).toBe(true)
    expect(claude.real).toEqual(expect.arrayContaining(['claude-real', 'mode', 'compact']))
    expect(claude.real).not.toContain('codex')
    expect(pick('src/main/providers/codex/rollout.ts').real).not.toContain('agents')
    // Shared, but not a CLI's: every fake suite, no real one; an area naming a real suite picks it.
    expect(pick('src/renderer/src/store.ts')).toMatchObject({ all: true, real: [] })
    expect(pick('src/renderer/src/components/Progress.tsx').suites.filter((n: string) => realNames.includes(n))).toEqual([])
    expect(pick('src/main/power.ts').suites).toContain('quit')
    // Code no area names: everything, real tier included (errs towards more).
    expect(pick('src/main/brandNewThing.ts')).toMatchObject({ all: true, real: realNames })
    // A real suite's own file.
    expect(pick('tests/e2e/codex.cjs').suites).toEqual(['codex'])
  })
})

describe('the real tier and environment failures (card #191)', () => {
  const parse = (...a: string[]) => parseArgs(a, names)
  const pick = (a: string[], affected: unknown = null): string[] => selectSuites(suites, parse(...a), affected).map((s: Suite) => s.name)
  const fakes = suites.filter((s) => !isRealCli(s) && !s.needs?.includes('packaged')).map((s) => s.name)

  it('the full set is the fake tier; --real adds the real one, --only-real runs only it', () => {
    expect(realNames).toEqual(expect.arrayContaining(['claude-real', 'mode', 'codex', 'codex-setup']))
    // Suites about Hive's own behaviour run the fake Claude Code (#194, #195); claude-real keeps what needs the real one.
    for (const n of ['quit', 'windows', 'launchrace', 'resume', 'agents', 'image', 'assistant', 'restart']) expect(realNames, n).not.toContain(n)
    expect(pick(['--all'])).toEqual(fakes)
    expect(pick([])).toEqual(fakes)
    expect(pick(['--all', '--real'])).toEqual(names.filter((n) => !n.startsWith('packaged')))
    expect(pick(['--only-real'])).toEqual(realNames)
    expect(pick(['--all', '--only-real'])).toEqual(realNames)
    expect(parse('--real', '--only-real').error).toMatch(/one of them/)
    // Named suites always run, real or not.
    expect(pick(['agents', 'board'])).toEqual(['agents', 'board'])
    expect(pick(['--all', 'agents'])).toEqual(names.filter((n) => fakes.includes(n) || n === 'agents'))
    // The left-out real tier is listed.
    const chosen = selectSuites(suites, parse('--all'))
    expect(realNotRun(suites, chosen).map((s: Suite) => s.name)).toEqual(realNames)
    expect(realNotRun(suites, selectSuites(suites, parse('--all', '--real')))).toEqual([])
  })

  it('--affected takes the real suites the changes need, and --real or --only-real on top', () => {
    expect(pick(['--affected'], { all: true, real: ['mode'] })).toEqual(names.filter((n) => fakes.includes(n) || n === 'mode'))
    expect(pick(['--affected'], { suites: ['board', 'mode'] })).toEqual(['board', 'mode'])
    expect(pick(['--affected', '--only-real'], { suites: ['board', 'mode'] })).toEqual(['mode'])
    expect(pick(['--affected', '--only-real'], { all: true, real: ['mode'] })).toEqual(['mode'])
    expect(pick(['--affected', '--real'], { suites: ['board'] })).toEqual(names.filter((n) => n === 'board' || realNames.includes(n)))
  })

  it('a suite is a SKIP only when it skipped itself, with every FAIL line put down to its failed CLI step (review round 1)', () => {
    const skipped = 'SKIPPED environment: usage or rate limit: …API Error: 429… (in "the prompt’s turn", session:c:\\p#a)'
    // cliStep: the step's failed check, then the skip.
    expect(suiteOutcome({ code: 0, out: `PASS a\nFAIL prompt makes it working\n${skipped}\nSKIPPED-FAILS 1\n` })).toMatchObject({ skipped: skipped.slice(8), environment: true })
    // An ENVIRONMENT line alone never makes a skip (the reviewer's case: an unrelated Hive failure).
    expect(suiteOutcome({ code: 1, out: 'ENVIRONMENT usage or rate limit: API Error: 429\nFAIL saved project settings were lost\n' })).toMatchObject({ ok: false, failed: ['FAIL saved project settings were lost'] })
    // A FAIL line the step didn't count (a check before it, a page error): a FAIL.
    expect(suiteOutcome({ code: 0, out: `FAIL settings lost\nFAIL prompt makes it working\n${skipped}\nSKIPPED-FAILS 1\n` })).toMatchObject({ ok: false })
    expect(suiteOutcome({ code: 1, out: `${skipped}\nSKIPPED-FAILS 0\n` })).toMatchObject({ ok: false })
    expect(suiteOutcome({ code: 1, out: 'FAIL x\n' })).toMatchObject({ ok: false })
    // A pass is a pass, whatever the CLI said on the way.
    expect(suiteOutcome({ code: 0, out: 'ENVIRONMENT usage or rate limit: x\nPASS a\n' })).toEqual({ ok: true, failed: [] })
    // A suite that skipped itself (lib.skip).
    expect(suiteOutcome({ code: 0, out: 'SKIPPED environment: Codex is not signed in\n' })).toEqual({ skipped: 'environment: Codex is not signed in', environment: true })
    expect(suiteOutcome({ code: 0, out: 'SKIPPED no dist\n' })).toEqual({ skipped: 'no dist', environment: false })
    expect(suiteOutcome({ code: 1, out: 'SKIPPED x\nFAIL y\n' })).toMatchObject({ ok: false })
  })

  it('suites that mark CLI steps are real-CLI suites whose checks report to lib.checked', () => {
    const marking = names.filter((n) => readFileSync(join(dir, `${n}.cjs`), 'utf8').includes('lib.cliStep('))
    expect(marking).toEqual(expect.arrayContaining(['codex', 'codex-background', 'codex-extra', 'codex-handover']))
    for (const n of marking) {
      expect(realNames, n).toContain(n)
      expect(readFileSync(join(dir, `${n}.cjs`), 'utf8'), n).toMatch(/const check = [^\n]*\n?\s*lib\.checked\(ok\)/)
    }
  })

  it('a failed CLI step is the environment’s only with a new environment failure in its own session, and nothing failed before (review round 1)', () => {
    type Problems = Map<string, { why: string; at: number }[]>
    const { stepVerdict } = createRequire(import.meta.url)('./e2e/lib.cjs') as { stepVerdict: (o: object) => { skip?: string; note?: string } | null }
    const p = (n: number, why = 'usage or rate limit: …429…') => Array.from({ length: n }, (_, at) => ({ why, at }))
    const map = (o: Record<string, number>): Problems => new Map(Object.entries(o).map(([k, n]) => [k, p(n)]))
    const base = { name: 'turn', session: 'session:c:\\p#a', stepFailed: 1, error: null, failedBefore: 0, wired: true }
    // A new rate limit in the step's session while it failed: a skip, saying where.
    expect(stepVerdict({ ...base, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toEqual({ skip: 'environment: usage or rate limit: …429… (in "turn", session:c:\\p#a)' })
    // An exception is never the environment's, even with a fresh error in the same session (review round 2): a bug, a
    // rejected IPC call, a file error. A note at most, so cliStep throws it on; also when a check failed beside it.
    const fs = Object.assign(new Error("ENOENT: no such file or directory, open 'notes.txt'"), { code: 'ENOENT' })
    for (const error of [new TypeError("Cannot read properties of undefined (reading 'sessionId')"), new Error("Error invoking remote method 'session:start': Error: Project not found"), fs])
      for (const stepFailed of [0, 1]) {
        const v = stepVerdict({ ...base, stepFailed, error, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })
        expect(v?.skip, `${error.message} (${stepFailed} failed)`).toBeUndefined()
        expect(v?.note).toMatch(/not a skip: the step threw/)
      }
    // The step didn't fail: nothing to put down to the environment.
    expect(stepVerdict({ ...base, stepFailed: 0, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toBeNull()
    // Another session's failure (several sessions): not this step's.
    expect(stepVerdict({ ...base, before: map({}), after: map({ 'session:c:\\p#b': 1 }) })).toBeNull()
    // Recovered: the error was there before the step and no new one came: the step's failure is Hive's.
    expect(stepVerdict({ ...base, before: map({ 'session:c:\\p#a': 1 }), after: map({ 'session:c:\\p#a': 1 }) })).toBeNull()
    // A failure before the step, or checks lib can't see: a note, never a skip.
    expect(stepVerdict({ ...base, failedBefore: 1, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toMatchObject({ note: expect.stringMatching(/not a skip: 1 check\(s\) failed before it/) })
    expect(stepVerdict({ ...base, wired: false, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toMatchObject({ note: expect.stringMatching(/don't report/) })
    // No session named: any session's new failure.
    expect(stepVerdict({ ...base, session: null, before: map({}), after: map({ 'session:c:\\p#b': 2 }) })?.skip).toMatch(/session:c:\\p#b/)
  })

  it("lib.cjs knows the CLIs' environment failures from their output, and nothing else", () => {
    const { environmentProblem } = createRequire(import.meta.url)('./e2e/lib.cjs') as { environmentProblem: (t: string) => string | null }
    const env = {
      'usage or rate limit': ['\x1b[31m  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'Claude usage limit reached. Your limit will reset at 3pm', "You've hit your limit · resets 5pm (Europe/London)", "■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours."],
      'the API is overloaded': ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'],
      'not signed in': ['Invalid API key · Please run /login', 'Select login method:', 'OAuth token has expired. Please obtain a new token or refresh your existing token.', 'Sign in with ChatGPT'],
      network: ['API Error: Connection error.', 'Unable to connect to Anthropic API', 'stream error: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'getaddrinfo ENOTFOUND api.anthropic.com']
    }
    for (const [why, texts] of Object.entries(env)) for (const t of texts) expect(environmentProblem(t), t).toMatch(new RegExp(`^${why}: `))
    // Hive's own failures, and ordinary output that mentions limits.
    for (const t of ['PreToolUse hook error: connect ECONNREFUSED 127.0.0.1:51234', 'Context limit reached · /compact or /clear to continue', 'Error: Cannot read properties of undefined', '? for shortcuts', 'The rate limiter in src/limits.ts']) expect(environmentProblem(t), t).toBeNull()
  })

  it('the record lists the real tier not run and the suites skipped for the environment', () => {
    const results = [
      { name: 'board', ok: true, seconds: 3 },
      { name: 'codex', skipped: 'environment: usage or rate limit: | API Error: 429', environment: true, seconds: 40 }
    ]
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '1 passed, 1 skipped', notRun: ['agents', 'quit'] })
    expect(md).toContain('| codex | skipped: environment: usage or rate limit: / API Error: 429 | 40s |')
    expect(md).toContain('Not run: the real tier (`--real`): agents, quit.')
    expect(md).toMatch(/\*\*Skipped for the environment\*\* .*: codex\./)
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [results[0]], logDir: 'x', summary: 's' })).not.toMatch(/Not run|environment/)
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

  it('--all runs every eligible suite of the fake tier, also with names, and conflicts with --affected', () => {
    const everything = suites.filter((s) => !s.needs?.includes('packaged') && !isRealCli(s)).map((s) => s.name)
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
  const lockDir = join(buildDir, 'locks')
  const runBuild = (): void => {
    builds++
    mkdirSync(join(buildDir, 'out', 'main'), { recursive: true })
    writeFileSync(join(buildDir, 'out', 'main', 'index.js'), `built ${builds}`)
  }
  const check = (build: boolean, during?: () => void): { stale: boolean; built: boolean; waited: boolean; why: string | null } =>
    ensureBuild({ root: buildDir, build, runBuild: () => { runBuild(); during?.() }, lock: { dir: lockDir } })
  const old = new Date('2001-01-01')

  it('no build: stale, and --build builds once, then skips while nothing changed', () => {
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/no dev build/) })
    expect(check(true)).toEqual({ stale: false, built: true, waited: false, why: null })
    expect(builds).toBe(1)
    expect(check(false)).toEqual({ stale: false, built: false, waited: false, why: null })
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
    expect(() => ensureBuild({ root: buildDir, build: true, runBuild: () => { throw new Error('build failed') }, lock: { dir: lockDir } })).toThrow('build failed')
    expect(buildLock(buildDir, { dir: lockDir }).heldByOther()).toBe(false)
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
    // A runner of its own: its lane's ports (lanes.mjs).
    expect(portBase({}, 47960)).toBe(47960)
    // In the suite itself: the runner set both.
    expect(logsRootFor('W', { HIVE_E2E_PORT: '48302', E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302' })).toBe(join('W', 'logs', 'nested'))
    // In an agent's shell in the Hive the suite started: Hive dropped the HIVE_ variables, E2E_RUN_* remain.
    const inSession = { E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302', HIVE_API_URL: undefined }
    expect(parentSuite(inSession)).toEqual({ name: 'progressreport', port: 48302 })
    expect(logsRootFor('W', inSession)).toBe(join('W', 'logs', 'nested'))
    expect(portBase(inSession)).toBe(49302)
    // A suite run on its own, one at a time: no port, still inside a suite.
    expect(portBase({ E2E_RUN_SUITE: 'progressreport' }, 47940)).toBe(48940)
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

describe("each runner's own lane: ports and suite folders (lanes.mjs)", () => {
  const alive = (pid: number) => pid === 100 || pid === 200
  const now = Date.parse('2026-10-04T12:00:00Z')

  it("lanes' ports are their own, clear of Hive's, of the suites' defaults and of Windows' dynamic range", () => {
    const ranges = Array.from({ length: LANES }, (_, k) => lanePorts(k))
    for (const [k, r] of ranges.entries()) {
      expect(r.last - r.first + 1).toBe(LANE_PORTS)
      // The CLI lane (base − 1) and eight slots (--jobs is at most 8).
      expect(r.first).toBe(r.base - 1)
      expect(r.last).toBeGreaterThanOrEqual(r.base + 7)
      if (k) expect(r.first).toBeGreaterThan(ranges[k - 1].last)
    }
    // The suites' own defaults (lib.port(<default>)), the installed and dev Hives' ports and the scenarios' (harness.cjs).
    const defaults = new Set([47821, 47822, 47930])
    expect(readFileSync(join(__dirname, 'scenarios', 'harness.cjs'), 'utf8')).toContain('opts.port ?? 47930')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.cjs'))) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/lib\.port\((\d+)\)/g)) defaults.add(Number(m[1]))
    expect(defaults.size).toBeGreaterThan(10)
    const top = ranges.at(-1)!.last
    for (const p of defaults) expect(p < ranges[0].first || p > top).toBe(true)
    // A runner inside a suite takes 1000 above its parent's slot: still below 49152, where Windows hands ports out.
    expect(portBase({ E2E_RUN_SUITE: 's', E2E_RUN_PORT: String(top) })).toBeLessThan(49152)
    expect(portBase({ E2E_RUN_SUITE: 's', E2E_RUN_PORT: String(top) }) - 1 + LANE_PORTS).toBeLessThan(49152)
  })

  it("each lane's suites have a folder of their own, never the work folder a suite run on its own uses", () => {
    const folders = Array.from({ length: LANES }, (_, k) => laneWork('W', k))
    expect(folders[0]).toBe(join('W', 'lanes', '0'))
    expect(folders[3]).toBe(join('W', 'lanes', '3'))
    expect(new Set(folders).size).toBe(LANES)
    expect(folders).not.toContain('W')
  })

  it('scenario runs claim a lane too: their folders and Agent API port, never the shared 47930 or scenarios folder (#183, #184)', () => {
    const run = readFileSync(join(__dirname, 'scenarios', 'run.mjs'), 'utf8')
    // The same pool as the e2e runner's (runContext.LANES_DIR).
    expect(run).toContain('const lane = await claimLane(runContext.LANES_DIR, { root: lib.ROOT })')
    expect(readFileSync(join(dir, 'run.mjs'), 'utf8')).toContain('await claimLane(runContext.LANES_DIR, { root })')
    expect(run).toContain("const workRoot = laneWork(join(lib.WORK, '..', 'scenarios'), lane.lane)")
    expect(run).toMatch(/runScenario\(sc, provider, \{[^}]*workRoot, port: lane\.first/)
    expect(run).toContain('process.on(\'exit\', lane.release)')
  })

  it('takes the lowest lane no live claim holds and whose ports are free', () => {
    expect(pickLane([], new Set(), alive, now)).toBe(0)
    // Held by a running runner: skipped.
    expect(pickLane([{ pid: 100, at: now - 60_000 }], new Set(), alive, now)).toBe(1)
    // A crashed runner's claim (its process is gone), or a day-old one: free again.
    expect(pickLane([{ pid: 999, at: now - 60_000 }], new Set(), alive, now)).toBe(0)
    expect(pickLane([{ pid: 100, at: now - 25 * 3600_000 }], new Set(), alive, now)).toBe(0)
    expect(claimHeld({ pid: 'x', at: now }, alive, now)).toBe(false)
    // Ports in use (an older runner, another app): the next lane.
    expect(pickLane([{ pid: 100, at: now }], new Set([1]), alive, now)).toBe(2)
    // Every lane taken.
    const all = Array.from({ length: LANES }, () => ({ pid: 200, at: now }))
    expect(pickLane(all, new Set(), alive, now)).toBeNull()
  })

  it('runners claiming at the same time each get a lane of their own; a released lane is taken again', async () => {
    const lanesDir = mkdtempSync(join(tmpdir(), 'hive-lanes-'))
    try {
      const free = async () => true
      type Claim = { lane: number; base: number; release: () => void }
      const claims: Claim[] = await Promise.all([101, 102, 103, 104].map((pid) => claimLane(lanesDir, { owner: pid, alive: () => true, free })))
      expect(claims.map((c) => c.lane).sort()).toEqual([0, 1, 2, 3])
      expect(new Set(claims.map((c) => c.base)).size).toBe(4)
      const first = claims.find((c) => c.lane === 0)!
      first.release()
      expect(existsSync(join(lanesDir, 'lane-0.json'))).toBe(false)
      expect((await claimLane(lanesDir, { owner: 105, alive: () => true, free })).lane).toBe(0)
      // release() leaves a claim that is no longer its runner's.
      first.release()
      expect(existsSync(join(lanesDir, 'lane-0.json'))).toBe(true)
      expect(readdirSync(lanesDir).includes('.claiming')).toBe(false)
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
  })

  it("skips a lane whose ports are busy, takes over a crashed runner's, and breaks a lock left by a crash", async () => {
    const lanesDir = mkdtempSync(join(tmpdir(), 'hive-lanes-'))
    try {
      // Lane 0 claimed by a process that is gone: taken over.
      writeFileSync(join(lanesDir, 'lane-0.json'), JSON.stringify({ pid: 999, at: Date.now() }))
      const living = (pid: number) => pid !== 999
      // Lane 1's ports are in use.
      const busy = lanePorts(1).first + 3
      const free = async (p: number) => p !== busy
      // A lock from a runner that crashed while holding it.
      mkdirSync(join(lanesDir, '.claiming'))
      const old = new Date(Date.now() - 60_000)
      utimesSync(join(lanesDir, '.claiming'), old, old)
      const a = await claimLane(lanesDir, { owner: 300, alive: living, free })
      expect(a.lane).toBe(0)
      expect(JSON.parse(readFileSync(join(lanesDir, 'lane-0.json'), 'utf8')).pid).toBe(300)
      const b = await claimLane(lanesDir, { owner: 301, alive: living, free })
      expect(b.lane).toBe(2)
      // Every lane held: none.
      for (let k = 0; k < LANES; k++) writeFileSync(join(lanesDir, `lane-${k}.json`), JSON.stringify({ pid: 400 + k, at: Date.now() }))
      expect(await claimLane(lanesDir, { owner: 302, alive: living, free })).toBeNull()
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
  })

  it('sees a port something listens on as busy (portFree)', async () => {
    // A port the system picks, never a lane's: a runner may be using those while the unit tests run (progressreport
    // runs this file inside a suite).
    const { createServer } = await import('net')
    const srv = createServer()
    const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)))
    expect(await portFree(port)).toBe(false)
    await new Promise((r) => srv.close(r))
    expect(await portFree(port)).toBe(true)
  })
})

describe("answering Claude Code's trust question (lib.acceptClaudeTrust, #188)", () => {
  type Accept = (inv: (ch: string, ...a: unknown[]) => Promise<unknown>, proj: string, agentId: string, ms?: number) => Promise<boolean>
  const { acceptClaudeTrust } = createRequire(import.meta.url)('./e2e/lib.cjs') as { acceptClaudeTrust: Accept }
  /** A session whose terminal shows `screen` and whose Hive status is `status`. */
  const session = (screen: string, status = 'starting') => {
    const writes: string[] = []
    const inv = async (ch: string, ...a: unknown[]) => {
      if (ch === 'pty:buffer') return screen
      if (ch === 'session:live') return [{ projectPath: 'C:\\P', agentId: 'a1', status }]
      writes.push(String(a[1]))
      return undefined
    }
    return { writes, run: async () => { const t = Date.now(); const r = await acceptClaudeTrust(inv, 'c:\\p', 'a1', 4000); return { r, ms: Date.now() - t } } }
  }

  it('answers the trust question: Down, then Enter', async () => {
    const s = session('Quick safety check: Is this a project you created or one you trust? \x1b[1m❯\x1b[0m 1. Yes, I trust this folder  2. No, exit')
    expect((await s.run()).r).toBe(true)
    expect(s.writes).toEqual(['\x1b[B', '\r'])
  })

  it("in a trusted folder it returns at once: Claude Code 2.1.289's mode footer, the old one, or Hive's ready status", async () => {
    for (const screen of ['> \x1b[2m⏵⏵ auto mode on (shift+tab to cycle)\x1b[0m', '>  ⏸ manual mode on', '> ? for shortcuts']) {
      const s = session(screen)
      const { r, ms } = await s.run()
      expect(r, screen).toBe(false)
      expect(ms, screen).toBeLessThan(1000)
      expect(s.writes).toEqual([])
    }
    const ready = session('Claude Code v2.1.290', 'ready')
    expect(await ready.run()).toMatchObject({ r: false })
    expect(ready.writes).toEqual([])
  })

  it('answers nothing else: a sign-in screen waits out the timeout untouched', async () => {
    const s = session('Select login method: 1. Claude account with subscription 2. Anthropic Console account', 'waiting')
    const { r, ms } = await s.run()
    expect(r).toBe(false)
    expect(ms).toBeGreaterThanOrEqual(3900)
    expect(s.writes).toEqual([])
  })
})

describe('sending a prompt to a CLI until it takes it (lib.sendPrompt, #190)', () => {
  type Send = (inv: (ch: string, ...a: unknown[]) => Promise<unknown>, key: string, text: string, o: { submitted: () => Promise<boolean>; tries?: number; waitMs?: number }) => Promise<number>
  const { sendPrompt } = createRequire(import.meta.url)('./e2e/lib.cjs') as { sendPrompt: Send }
  const text = 'Use apply_patch to add a file notes.txt containing hi.'
  /** A terminal that drops the first `dropText` prompts typed and ignores the first `dropEnter` Enters. */
  const terminal = ({ dropText = 0, dropEnter = 0 }) => {
    const t = { writes: [] as string[], screen: '', input: '', submitted: false }
    const inv = async (ch: string, _key: unknown, data?: unknown) => {
      if (ch === 'pty:buffer') return t.screen
      const d = String(data)
      t.writes.push(d)
      if (d === '\r') {
        if (dropEnter-- > 0) t.input += '\n'
        else if (t.input.trim()) t.submitted = true
      } else if (dropText-- <= 0) {
        t.input = d.replace(/^\x15/, '')
        t.screen += `\x1b[2m> ${t.input}`
      }
      return undefined
    }
    return { t, run: (tries?: number) => sendPrompt(inv, 'k', text, { submitted: async () => t.submitted, waitMs: 50, ...(tries ? { tries } : {}) }) }
  }

  it('taken at once: one prompt, one Enter', async () => {
    const { t, run } = terminal({})
    expect(await run()).toBe(1)
    expect(t.writes).toEqual([text, '\r'])
  })

  it('an Enter that became a new line: Enter again, without typing the prompt twice', async () => {
    const { t, run } = terminal({ dropEnter: 1 })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([text, '\r', '\r'])
  })

  it('a prompt dropped while the CLI was drawing: typed again over a cleared line', async () => {
    const { t, run } = terminal({ dropText: 1 })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([text, '\r', `\x15${text}`, '\r'])
  })

  it('never taken: 0 after the tries', async () => {
    const { t, run } = terminal({ dropEnter: 9 })
    expect(await run(3)).toBe(0)
    expect(t.writes.filter((w) => w === '\r')).toHaveLength(3)
  })
})

describe('the shared Codex test home: changes to its config.toml under a lock (lib.cjs)', () => {
  type Lib = { trustForCodex: (folder: string, home?: string) => void }
  const { trustForCodex } = createRequire(import.meta.url)('./e2e/lib.cjs') as Lib
  const libPath = join(dir, 'lib.cjs')
  /** Another runner's suite trusting a folder in that home: a process of its own. */
  const trustIn = async (home: string, folder: string) => {
    const env: Record<string, string | undefined> = { ...process.env, HIVE_TEST_CODEX_HOME: home, HIVE_E2E_DIR: join(home, 'work') }
    delete env.ELECTRON_RUN_AS_NODE
    // Its error output is kept: a runner that fails says why in the test's failure (#181), rather than only exit 1.
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(libPath)}).trustForCodex(${JSON.stringify(folder)})`], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d) => (err += d))
    return new Promise<number | null>((resolve) =>
      child.on('exit', (code) => {
        if (code) failures.push(`${folder}: exit ${code}\n${err.trim().split('\n').slice(0, 8).join('\n')}`)
        resolve(code)
      })
    )
  }
  /** The runners that failed in this test file, with their error output, for the assertion messages. */
  const failures: string[] = []
  const entries = (home: string) => [...readFileSync(join(home, 'config.toml'), 'utf8').matchAll(/^\[projects\.'([^']+)'\]$/gm)].map((m) => m[1]).sort()

  it("waits while another runner changes it, and keeps that runner's change", async () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-codex-home-'))
    try {
      writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
      // This runner holds the lock (mid-change: it has read the file and not yet written it back).
      mkdirSync(join(home, 'config.toml.lock'))
      const other = trustIn(home, 'C:/lane1/codex-ws/demo')
      await new Promise((r) => setTimeout(r, 1500))
      // The other runner is waiting: the file is as this one read it.
      expect(entries(home)).toEqual([])
      writeFileSync(join(home, 'config.toml'), `${readFileSync(join(home, 'config.toml'), 'utf8')}\n[projects.'C:/lane0/codex-ws/demo']\ntrust_level = "trusted"\n`)
      rmSync(join(home, 'config.toml.lock'), { recursive: true })
      expect(await other, failures.join('\n\n')).toBe(0)
      // Neither change lost.
      expect(entries(home)).toEqual(['C:/lane0/codex-ws/demo', 'C:/lane1/codex-ws/demo'])
      expect(readFileSync(join(home, 'config.toml'), 'utf8').match(/^\[windows\]/gm)).toHaveLength(1)
      expect(existsSync(join(home, 'config.toml.lock'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('several runners at once: every folder trusted once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-codex-home-'))
    try {
      const folders = Array.from({ length: 6 }, (_, k) => `C:/lanes/${k}/codex-ws/demo`)
      expect(await Promise.all(folders.map((f) => trustIn(home, f))), failures.join('\n\n')).toEqual(folders.map(() => 0))
      expect(entries(home)).toEqual([...folders].sort())
      // Again: nothing added twice. A folder whose name starts with another's is its own entry.
      trustForCodex(folders[0], home)
      trustForCodex(`${folders[0]}2`, home)
      expect(entries(home)).toEqual([...folders, `${folders[0]}2`].sort())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('breaks a lock left by a runner that crashed while holding it', () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-codex-home-'))
    try {
      const lock = join(home, 'config.toml.lock')
      mkdirSync(lock)
      const old = new Date(Date.now() - 120_000)
      utimesSync(lock, old, old)
      trustForCodex('C:/ws/demo', home)
      expect(entries(home)).toEqual(['C:/ws/demo'])
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("Windows' in-use answers (EPERM, EACCES, EBUSY) while taking or letting go of the lock mean busy, not a failure (#181)", () => {
    type Lock = (file: string, fn: () => unknown, o?: { staleMs?: number; timeoutMs?: number }) => unknown
    const req = createRequire(import.meta.url)
    const { withFileLock } = req('./e2e/lib.cjs') as { withFileLock: Lock }
    const nodeFs = req('fs') as typeof import('fs')
    const home = mkdtempSync(join(tmpdir(), 'hive-codex-home-'))
    const file = join(home, 'config.toml')
    const lock = `${file}.lock`
    const fail = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })
    const mkdir = nodeFs.mkdirSync
    const rm = nodeFs.rmSync
    try {
      // Taking it: in use twice (another runner still had the folder open), then free.
      let refusals = ['EPERM', 'EBUSY', 'EACCES']
      const spyMk = vi.spyOn(nodeFs, 'mkdirSync').mockImplementation(((p: string, o?: object) => {
        if (p === lock && refusals.length) throw fail(refusals.shift()!)
        return mkdir(p, o as never)
      }) as never)
      // Letting go: in use once, then gone.
      let busyRm = 1
      const spyRm = vi.spyOn(nodeFs, 'rmSync').mockImplementation(((p: string, o?: object) => {
        if (p === lock && busyRm-- > 0) throw fail('EBUSY')
        return rm(p, o as never)
      }) as never)
      let ran = 0
      expect(withFileLock(file, () => ++ran)).toBe(1)
      expect(ran).toBe(1)
      expect(existsSync(lock)).toBe(false)
      // A permission problem that doesn't pass still ends, at the timeout, naming its error.
      refusals = Array(10_000).fill('EPERM')
      expect(() => withFileLock(file, () => ++ran, { timeoutMs: 200 })).toThrow(/is still held \(EPERM\)/)
      // Anything else is a failure at once (its parent folder missing, say).
      refusals = []
      expect(() => withFileLock(join(home, 'no', 'such', 'config.toml'), () => ++ran)).toThrow(/ENOENT/)
      expect(ran).toBe(1)
      // Refused with its age unreadable (stat fails): a paced poll, never a busy loop (review round 1). A refusal that
      // clears is taken after a few paced tries; one that lasts ends at the timeout after about timeout / 25 ms tries.
      let tries = 0
      const spyStat = vi.spyOn(nodeFs, 'statSync').mockImplementation(((p: string) => {
        if (p === lock) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`unexpected stat of ${p}`)
      }) as never)
      spyMk.mockImplementation(((p: string, o?: object) => {
        if (p === lock && (tries++, refusals.length)) throw fail(refusals.shift()!)
        return mkdir(p, o as never)
      }) as never)
      refusals = ['EPERM', 'EACCES', 'EBUSY']
      const t0 = Date.now()
      expect(withFileLock(file, () => ++ran)).toBe(2)
      expect(tries).toBe(4)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 20)
      tries = 0
      refusals = Array(100_000).fill('EPERM')
      expect(() => withFileLock(file, () => ++ran, { timeoutMs: 200 })).toThrow(/is still held \(EPERM\)/)
      expect(tries).toBeGreaterThan(2)
      expect(tries).toBeLessThan(20)
      spyStat.mockRestore()
      spyMk.mockRestore()
      spyRm.mockRestore()
    } finally {
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the run context: what a test starts gets only the allowlist and its own context (runContext.cjs, #203)', () => {
  type Env = Record<string, string | undefined>
  type Ctx = {
    ALLOW: string[]
    PASS_ENV: Record<string, string>
    CARRIED: string[]
    baseEnv: (parent?: Env) => Env
    childEnv: (vars?: Env, parent?: Env) => Env
    hiveEnv: (vars?: Env, parent?: Env) => Env
    isHiveEnv: (env: unknown) => boolean
    suiteEnv: (o: { name: string; port?: number | null; work?: string | null; runDir: string }, parent?: Env) => Env
  }
  const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as Ctx
  /** An agent's shell in Hive, inside an outer hive-progress, in a suite of a runner, with a person's settings. */
  const parent: Env = {
    Path: 'C:\\Windows;C:\\node',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\t',
    LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
    https_proxy: 'http://proxy:8080',
    NO_COLOR: '1',
    FORCE_COLOR: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    CLAUDE_CONFIG_DIR: 'C:\\mine\\claude',
    ANTHROPIC_API_KEY: 'k',
    GIT_DIR: 'C:\\repo\\.git',
    HIVE_API_URL: 'http://127.0.0.1:47821',
    HIVE_API_TOKEN: 'secret',
    HIVE_PROJECT: 'hive',
    HIVE_PROGRESS_WRAPPED: '1',
    HIVE_PROGRESS_RUN_AS_NODE: '1',
    HIVE_PROGRESS_DATA: 'C:\\progress',
    HIVE_E2E_NATIVE: '1',
    HIVE_TEST_SLOW_IPC: 'tasks:list=9000',
    HIVE_TEST_CODEX_HOME: 'C:\\codex-test',
    HIVE_E2E_PORT: '47950',
    E2E_RUN_SUITE: 'progressreport',
    E2E_RUN_DIR: 'C:\\lanes\\0',
    E2E_RUN_PORT: '47950'
  }
  const has = (env: Env, k: string) => Object.keys(env).some((x) => x.toUpperCase() === k.toUpperCase())

  it('no suite, runner or harness builds a child environment from process.env: they use lib.hiveEnv, lib.childEnv or runContext', () => {
    // The fake CLIs are left out: they stand for Claude Code and Codex, which start their MCP servers from their own
    // environment (a test Hive's session's, already the run context's).
    const exempt = ['runContext.cjs', 'fake-bridge.cjs']
    const files = [
      ...readdirSync(dir).filter((f) => /\.(c|m)js$/.test(f) && !exempt.includes(f)).map((f) => join(dir, f)),
      ...readdirSync(join(__dirname, 'scenarios')).filter((f) => /\.(c|m)js$/.test(f)).map((f) => join(__dirname, 'scenarios', f))
    ]
    expect(files.length).toBeGreaterThan(80)
    const found: string[] = []
    for (const f of files)
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\.\.\.\s*process\.env\b|env\s*:\s*process\.env\b|Object\.assign\(\s*\{\s*\}\s*,\s*process\.env\b|(const|let|var)\s+\w+\s*=\s*process\.env\s*($|[;,])/.test(line)) found.push(`${f.slice(root.length + 1)}:${i + 1}`)
        })
    expect(found).toEqual([])
  })

  it("a suite's environment: the allowlist, the test settings passed on by name, and its run context; nothing else", () => {
    const env = ctx.suiteEnv({ name: 'board', port: 47961, work: 'C:\\lanes\\1', runDir: 'C:\\lanes\\1' }, parent)
    expect(env).toMatchObject({ Path: parent.Path, SystemRoot: 'C:\\Windows', https_proxy: 'http://proxy:8080', HIVE_TEST_CODEX_HOME: 'C:\\codex-test', HIVE_E2E_DIR: 'C:\\lanes\\1', HIVE_E2E_PORT: '47961', HIVE_API_PORT: '47961', E2E_RUN_SUITE: 'board', E2E_RUN_DIR: 'C:\\lanes\\1', E2E_RUN_PORT: '47961' })
    for (const k of ['NO_COLOR', 'FORCE_COLOR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'GIT_DIR', 'HIVE_API_URL', 'HIVE_API_TOKEN', 'HIVE_PROJECT', 'HIVE_PROGRESS_WRAPPED', 'HIVE_PROGRESS_RUN_AS_NODE', 'HIVE_PROGRESS_DATA', 'HIVE_E2E_NATIVE', 'HIVE_TEST_SLOW_IPC']) expect(has(env, k), k).toBe(false)
    // Without a port (a serial suite of a runner inside a suite): none inherited from the runner that started this one.
    const nested = ctx.suiteEnv({ name: 'about', runDir: 'C:\\lanes\\0\\nested' }, parent)
    for (const k of ['HIVE_E2E_PORT', 'HIVE_API_PORT', 'E2E_RUN_PORT', 'HIVE_E2E_DIR']) expect(has(nested, k), k).toBe(false)
  })

  it('every variable Hive sets for its sessions and its hive-progress wrapper is left out (#202)', () => {
    const src = ['src/main/progressReporters/wrapper.ts', 'src/main/progressReporters/shims.ts', 'src/main/ptyHost.ts', 'src/main/sessions.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
    const sessionVars = [...new Set([...src.matchAll(/\b(HIVE_[A-Z0-9_]+|ELECTRON_RUN_AS_NODE|NO_COLOR|FORCE_COLOR)\b/g)].map((m) => m[1]))]
    expect(sessionVars).toEqual(expect.arrayContaining(['HIVE_PROGRESS_WRAPPED', 'HIVE_PROGRESS_RUN_AS_NODE', 'HIVE_PROGRESS_DATA', 'HIVE_HOOK_TOKEN', 'HIVE_PROJECT']))
    const everywhere = Object.fromEntries(sessionVars.map((n) => [n, 'set']))
    const suite = ctx.suiteEnv({ name: 'x', runDir: 'C:\\w' }, everywhere)
    const hive = ctx.hiveEnv({ HIVE_USER_DATA: 'C:\\p' }, everywhere)
    const child = ctx.childEnv({}, everywhere)
    const contextSets = ['HIVE_USER_DATA', 'HIVE_TEST_QUIET', 'HIVE_TEST_TIPS', 'HIVE_API_PORT', 'HIVE_E2E_DIR', 'HIVE_E2E_PORT']
    for (const n of sessionVars.filter((x) => !contextSets.includes(x))) {
      expect(has(suite, n), `suite: ${n}`).toBe(false)
      expect(has(hive, n), `test Hive: ${n}`).toBe(false)
      expect(has(child, n), `child: ${n}`).toBe(false)
    }
    // And no Hive session variable is ever allowlisted or passed on.
    for (const n of [...ctx.ALLOW, ...Object.keys(ctx.PASS_ENV)]) expect(/^(HIVE_API|HIVE_PROGRESS_(WRAPPED|RUN_AS_NODE|DATA)$|HIVE_PROJECT|HIVE_WORKSPACE|HIVE_AGENT|ELECTRON|CLAUDE|ANTHROPIC|NO_COLOR|FORCE_COLOR)/.test(n), n).toBe(false)
  })

  it("a test Hive's environment: quiet, tips off, the suite's port and the carried run variables, then the suite's own", () => {
    const env = ctx.hiveEnv({ HIVE_USER_DATA: 'C:\\profile', CLAUDE_CONFIG_DIR: 'C:\\test-claude', HIVE_TEST_SLOW_IPC: undefined }, parent)
    expect(env).toMatchObject({ HIVE_USER_DATA: 'C:\\profile', HIVE_TEST_QUIET: '1', HIVE_TEST_TIPS: 'off', HIVE_API_PORT: '47950', E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: 'C:\\lanes\\0', E2E_RUN_PORT: '47950', CLAUDE_CONFIG_DIR: 'C:\\test-claude', Path: parent.Path })
    for (const k of ['NO_COLOR', 'ELECTRON_RUN_AS_NODE', 'HIVE_API_TOKEN', 'HIVE_PROGRESS_WRAPPED', 'HIVE_TEST_SLOW_IPC', 'HIVE_E2E_NATIVE', 'HIVE_TEST_CODEX_HOME', 'ANTHROPIC_API_KEY']) expect(has(env, k), k).toBe(false)
    // HIVE_TEST_QUIET=0 for the run shows the copies; a suite's own setting wins.
    expect(ctx.hiveEnv({}, { ...parent, HIVE_TEST_QUIET: '0' }).HIVE_TEST_QUIET).toBe('0')
    expect(ctx.hiveEnv({ HIVE_TEST_QUIET: '0' }, parent).HIVE_TEST_QUIET).toBe('0')
    // A suite's variable replaces the allowlisted one in another case, rather than adding a second.
    const path = ctx.hiveEnv({ PATH: 'C:\\only' }, parent)
    expect(Object.keys(path).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH'])
    // Only what hiveEnv built starts a test Hive (lib.cjs's _electron.launch): not a copy, not process.env.
    expect(ctx.isHiveEnv(env)).toBe(true)
    expect(ctx.isHiveEnv({ ...env })).toBe(false)
    expect(ctx.isHiveEnv(process.env)).toBe(false)
  })

  it("a child that is part of Hive gets the allowlist and what it is given; nothing is passed that wasn't allowed", () => {
    const env = ctx.childEnv({ HIVE_API_URL: 'http://127.0.0.1:1', ELECTRON_RUN_AS_NODE: '1' }, parent)
    expect(Object.keys(env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'HIVE_API_URL', 'LOCALAPPDATA', 'Path', 'SystemRoot', 'USERPROFILE', 'https_proxy'])
    expect(Object.keys(ctx.baseEnv(parent)).every((k) => ctx.ALLOW.includes(k.toUpperCase()))).toBe(true)
  })

  it('every child the runners and the harness start themselves is given its environment, never left to inherit the shell (#208)', () => {
    // The runners, their modules, lib.cjs and the scenario harness run in the shell a person or an agent started them
    // from; a child_process call without env inherits all of it (GIT_DIR, NODE_OPTIONS…). The suites are left out:
    // their own environment is already the run context's (suiteEnv), and so is what their children inherit.
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith('.mjs') || f === 'lib.cjs').map((f) => join(dir, f)),
      ...readdirSync(join(__dirname, 'scenarios')).filter((f) => /\.(c|m)js$/.test(f)).map((f) => join(__dirname, 'scenarios', f))
    ]
    const found: string[] = []
    let calls = 0
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\(/g)) {
        // The call's arguments, to its closing parenthesis.
        let depth = 0
        let end = m.index + m[0].length - 1
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++
          else if (text[end] === ')' && --depth === 0) break
        }
        calls++
        if (!/\benv\s*:|\{\s*env\b|,\s*env\s*[,}]/.test(text.slice(m.index, end))) found.push(`${f.slice(root.length + 1)}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(calls).toBeGreaterThan(20)
    expect(found).toEqual([])
  })

  it("a shell's GIT_DIR, GIT_WORK_TREE and NODE_OPTIONS reach neither the runners' git nor the build (#208)", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-shellenv-'))
    const repo = (name: string, file: string) => {
      const d = join(tmp, name)
      mkdirSync(d)
      writeFileSync(join(d, file), 'x\n')
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: d, env: ctx.baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      git('add', '.')
      git('commit', '-qm', name)
      return { d, head: git('rev-parse', 'HEAD').trim() }
    }
    const project = repo('project', 'a.txt')
    const decoy = repo('decoy', 'decoy.txt')
    writeFileSync(join(project.d, 'untracked.txt'), 'new\n')
    const req = createRequire(import.meta.url)
    const lib = req('./e2e/lib.cjs') as { git: (cwd: string, cmd: string | string[]) => string }
    const { sourceFingerprint } = req('./scenarios/harness.cjs') as { sourceFingerprint: (root: string) => { head: string; dirty: string | null } }
    const clean = { fp: fingerprint(project.d), scenario: sourceFingerprint(project.d) }
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, NODE_OPTIONS: process.env.NODE_OPTIONS }
    try {
      Object.assign(process.env, { GIT_DIR: join(decoy.d, '.git'), GIT_WORK_TREE: decoy.d, NODE_OPTIONS: `--require "${join(tmp, 'missing.cjs')}"` })
      // git follows them, from a shell that has them (so the check below means something).
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.d, encoding: 'utf8' }).trim()).toBe(decoy.head)
      expect(fingerprint(project.d)).toBe(clean.fp)
      expect(fingerprint(project.d)).toMatch(new RegExp(`^${project.head.slice(0, 12)}\\+`))
      expect(sourceFingerprint(project.d)).toEqual(clean.scenario)
      expect(lib.git(project.d, ['rev-parse', 'HEAD']).trim()).toBe(project.head)
      expect(lib.git(project.d, 'rev-parse HEAD').trim()).toBe(project.head)
      // The build's command gets the allowlist: a Node with that NODE_OPTIONS wouldn't start at all.
      const out = join(tmp, 'build-env.json')
      writeFileSync(join(tmp, 'build.cjs'), `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))\n`)
      devBuild(project.d, { command: `"${process.execPath}" "${join(tmp, 'build.cjs')}"` })
      const env = JSON.parse(readFileSync(out, 'utf8')) as Env
      for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS']) expect(has(env, k), k).toBe(false)
      expect(has(env, 'PATH')).toBe(true)
      // And a failed build throws with its exit code.
      expect(() => devBuild(project.d, { command: `"${process.execPath}" -e "process.exit(3)"` })).toThrow(/exit 3/)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("the concurrency checker's temporary worktrees: each invocation's own (tempWorktrees.mjs, #207)", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-tempwt-'))
  afterAll(() => {
    // Junctions first (rmdir removes only the link), as the module does.
    for (const base of readdirSync(tmp).filter((n) => n.startsWith('concurrency')))
      for (const run of readdirSync(join(tmp, base))) {
        const nm = join(tmp, base, run, 'worktree', 'node_modules')
        if (existsSync(nm)) execFileSync('cmd.exe', ['/c', 'rmdir', nm], { stdio: 'ignore', env: ctx.baseEnv() })
      }
    rmSync(tmp, { recursive: true, force: true })
  })
  const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', env: ctx.baseEnv() })
  /** A checkout with a commit, an uncommitted change, an untracked file and a node_modules (with electron, or not). */
  const checkout = (name: string, electron = true) => {
    const d = join(tmp, name)
    mkdirSync(join(d, 'node_modules', electron ? 'electron' : 'other'), { recursive: true })
    writeFileSync(join(d, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(d, 'a.txt'), 'one\n')
    git(d, 'init', '-q')
    git(d, 'add', '.')
    git(d, 'commit', '-qm', 'init')
    writeFileSync(join(d, 'a.txt'), 'two\n')
    writeFileSync(join(d, 'new.txt'), 'new\n')
    return d
  }
  const registered = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length - 1

  it('two invocations get folders of their own; removing one leaves the other\'s worktree, junction and registration', async () => {
    const repo = checkout('repo')
    const base = join(tmp, 'concurrency')
    const a = invocationDir({ base, owner: 101 })
    const b = invocationDir({ base, owner: 101 })
    expect(a).not.toBe(b)
    expect(JSON.parse(readFileSync(join(a, 'owner.json'), 'utf8'))).toMatchObject({ pid: 101 })
    const wa = addWorktree(repo, a, 'worktree')
    const wb = addWorktree(repo, b, 'worktree')
    expect(wa).not.toBe(wb)
    // Each is repo's HEAD with its uncommitted changes, sharing its node_modules.
    for (const w of [wa, wb]) {
      // (Line endings as the machine's git config checks files out.)
      expect(readFileSync(join(w, 'a.txt'), 'utf8')).toMatch(/^two\r?\n$/)
      expect(readFileSync(join(w, 'new.txt'), 'utf8')).toBe('new\n')
      expect(existsSync(join(w, 'node_modules', 'electron'))).toBe(true)
    }
    expect(registered(repo)).toBe(2)
    removeInvocation(repo, a)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(join(wb, 'node_modules', 'electron')) && existsSync(join(wb, 'a.txt'))).toBe(true)
    expect(registered(repo)).toBe(1)
    // The junction went, never what it pointed to.
    expect(existsSync(join(repo, 'node_modules', 'electron'))).toBe(true)
    removeInvocation(repo, b)
    expect(registered(repo)).toBe(0)
  })

  it('a setup that fails part way leaves no worktree registered or folder behind, and nothing outside its folder is removed', () => {
    const repo = checkout('no-electron', false)
    const own = invocationDir({ base: join(tmp, 'concurrency2'), owner: 102 })
    expect(() => addWorktree(repo, own, 'worktree')).toThrow(/Couldn't link node_modules/)
    expect(registered(repo)).toBe(0)
    expect(existsSync(join(own, 'worktree'))).toBe(false)
    expect(existsSync(join(repo, 'node_modules', 'other'))).toBe(true)
    expect(() => removeWorktree(repo, own, join(tmp, 'repo'))).toThrow(/isn't in this checker's folder/)
  })

  it("the next checker removes a gone checker's folder (junction first), and leaves a live or kept one", () => {
    const repo = checkout('stale-repo')
    const base = join(tmp, 'concurrency3')
    const gone = invocationDir({ base, owner: 201 })
    const live = invocationDir({ base, owner: 202 })
    const kept = invocationDir({ base, owner: 203 })
    for (const d of [gone, live, kept]) addWorktree(repo, d, 'worktree')
    keepDir(kept)
    const alive = (pid: number) => pid === 202
    expect(removeStale(repo, { base, alive })).toEqual([gone])
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(join(live, 'worktree', 'node_modules', 'electron')) && existsSync(join(kept, 'worktree', 'a.txt'))).toBe(true)
    expect(existsSync(join(repo, 'node_modules', 'electron'))).toBe(true)
    // Its registration is pruned in this checkout; the other two stay.
    expect(registered(repo)).toBe(2)
  })
})

describe('the build lock: runners started together in one worktree build it once (build.mjs, #200)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-buildlock-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const locks = join(tmp, 'locks')
  const buildMjs = pathToFileURL(join(dir, 'build.mjs')).href
  /** A worktree with a source file and no build. */
  const worktree = (name: string) => {
    const r = join(tmp, name)
    mkdirSync(join(r, 'src'), { recursive: true })
    writeFileSync(join(r, 'src', 'a.ts'), `${name}\n`)
    return r
  }
  /**
   * Another runner: a process of its own that calls ensureBuild on root, whose build takes ms and counts itself in
   * builds.txt. Resolves with its result.
   */
  const runner = (wt: string, { build = true, ms = 1500, fail = false } = {}) => {
    const script = `
      import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
      import { join } from 'path'
      const { ensureBuild } = await import(${JSON.stringify(buildMjs)})
      const root = ${JSON.stringify(wt)}
      try {
        const r = ensureBuild({ root, build: ${build}, lock: { dir: ${JSON.stringify(locks)}, pollMs: 50 }, runBuild: () => {
          appendFileSync(join(root, 'builds.txt'), 'b')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})
          if (${fail}) throw new Error('build failed')
          mkdirSync(join(root, 'out', 'main'), { recursive: true })
          writeFileSync(join(root, 'out', 'main', 'index.js'), 'built')
        } })
        console.log(JSON.stringify(r))
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }))
      }`
    return new Promise<{ stale?: boolean; built?: boolean; waited?: boolean; error?: string }>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1) || '{}')))
    })
  }
  const builds = (wt: string) => (existsSync(join(wt, 'builds.txt')) ? readFileSync(join(wt, 'builds.txt'), 'utf8').length : 0)

  it('two runners in one worktree with a stale build: one builds, the other waits and finds it fresh; another worktree builds at the same time', async () => {
    const a = worktree('a')
    const b = worktree('b')
    const results = await Promise.all([runner(a), runner(a), runner(b)])
    expect(builds(a)).toBe(1)
    expect(builds(b)).toBe(1)
    const inA = results.slice(0, 2)
    expect(inA.every((r) => r.stale === false)).toBe(true)
    expect(inA.filter((r) => r.built).length).toBe(1)
    expect(inA.find((r) => !r.built)?.waited).toBe(true)
    expect(results[2]).toMatchObject({ stale: false, built: true, waited: false })
    expect(buildStamp(a)).not.toBeNull()
    // Nothing left held.
    expect(readdirSync(locks)).toEqual([])
  }, 30_000)

  it('a runner that only checks waits while another builds, so it never looks at half a build', async () => {
    const c = worktree('c')
    const building = runner(c, { ms: 2000 })
    const t0 = Date.now()
    while (!readdirSync(locks).length && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20))
    const r = ensureBuild({ root: c, build: false, runBuild: () => undefined, lock: { dir: locks, pollMs: 50 } })
    expect(r).toMatchObject({ stale: false, waited: true })
    expect((await building).built).toBe(true)
  }, 30_000)

  it('a failed build lets go of the lock (the next runner builds); a lock whose runner is gone is broken', async () => {
    const d = worktree('d')
    expect((await runner(d, { fail: true, ms: 10 })).error).toMatch(/build failed/)
    expect(readdirSync(locks)).toEqual([])
    expect(buildStamp(d)).toBeNull()
    // A crashed runner's lock: its process is gone.
    const lock = buildLock(d, { dir: locks, owner: 999_999_999 })
    expect(lock.take()).toBe(false)
    const r = ensureBuild({ root: d, build: true, runBuild: () => { mkdirSync(join(d, 'out', 'main'), { recursive: true }); writeFileSync(join(d, 'out', 'main', 'index.js'), 'x') }, lock: { dir: locks, alive: (pid: number) => pid !== 999_999_999 } })
    expect(r).toMatchObject({ stale: false, built: true, waited: false })
    // One that crashed before writing its owner: broken once it is 30 s old.
    const held = buildLock(d, { dir: locks })
    mkdirSync(held.folder, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(held.folder, old, old)
    expect(held.heldByOther()).toBe(false)
    expect(held.take()).toBe(false)
    held.release()
    expect(readdirSync(locks)).toEqual([])
  }, 30_000)
})

describe('heavy runs: at most a few at once on the machine, the rest queue in order (slots.mjs, #204)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-slots-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  let n = 0
  const newPool = () => join(tmp, `pool-${++n}`)
  const live = new Set([101, 102, 103, 104])
  const alive = (pid: number) => live.has(pid)
  let clock = 1_000_000
  const now = () => clock
  const ask = (dir2: string, owner: number, more: object = {}) => trySlot(dir2, { slots: 2, owner, alive, now, what: `run ${owner}`, root: `C:/wt${owner}`, ...more })

  it('a heavy run: more than five suites or scenarios, or a repeat; HIVE_TEST_HEAVY_SLOTS says how many at once (default 2)', () => {
    expect(isHeavy({ count: 5 })).toBe(false)
    expect(isHeavy({ count: 6 })).toBe(true)
    expect(isHeavy({ count: 1, repeat: 2 })).toBe(true)
    expect(heavySlots({})).toBe(2)
    expect(heavySlots({ HIVE_TEST_HEAVY_SLOTS: '3' })).toBe(3)
    for (const bad of ['0', '-1', '1.5', 'x', '']) expect(heavySlots({ HIVE_TEST_HEAVY_SLOTS: bad })).toBe(2)
    expect(parseArgs(['--all', '--no-wait'], names)).toMatchObject({ all: true, noWait: true })
    expect(parseArgs(['--all'], names)).toMatchObject({ noWait: false })
  })

  it('a heavy run started inside a suite waits for no slot, e2e or scenarios: its parent holds one (#211)', () => {
    const heavy = { count: 1, repeat: 2 }
    expect(needsSlot(heavy, {})).toBe(true)
    expect(needsSlot({ count: 3 }, {})).toBe(false)
    // In a suite's own environment, and in the agent shell of a test Hive it started (which keeps only E2E_RUN_*).
    expect(needsSlot(heavy, { HIVE_E2E_PORT: '47950', E2E_RUN_SUITE: 'progressreport' })).toBe(false)
    expect(needsSlot(heavy, { E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: 'C:\\lanes\\0', E2E_RUN_PORT: '47950' })).toBe(false)
    // Both runners ask needsSlot, never isHeavy alone (the scenario runner did, and queued behind its parent).
    for (const f of ['e2e/run.mjs', 'scenarios/run.mjs']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).toMatch(/if \(needsSlot\(\{ count: chosen\.length, repeat: \w+(\.repeat)? \}\)\) \{/)
      expect(src, f).not.toMatch(/\bisHeavy\b/)
    }
  })

  it('two take the slots; the others wait in the order they asked, and the first to ask gets the next free one', async () => {
    const dir2 = newPool()
    expect(await ask(dir2, 101)).toEqual({ slot: 0 })
    expect(await ask(dir2, 102)).toEqual({ slot: 1 })
    clock += 10
    const third = await ask(dir2, 103)
    expect(third).toMatchObject({ ahead: 0 })
    expect((third as { holders: { pid: number }[] }).holders.map((c) => c.pid).sort()).toEqual([101, 102])
    clock += 10
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 1 })
    // 101 finishes: 104 looks first, but 103 asked earlier and gets the slot.
    rmSync(join(dir2, 'slot-0.json'))
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 1 })
    expect(await ask(dir2, 103)).toEqual({ slot: 0 })
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 0 })
    expect(readdirSync(dir2).filter((f) => f.startsWith('wait-'))).toEqual(['wait-104.json'])
  })

  it("a crashed run's slot, and its place in the queue, expire", async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    await ask(dir2, 103)
    live.delete(102)
    live.delete(103)
    try {
      expect(await ask(dir2, 104)).toEqual({ slot: 1 })
      expect(readdirSync(dir2).sort()).toEqual(['slot-0.json', 'slot-1.json'])
    } finally {
      live.add(102)
      live.add(103)
    }
  })

  it('--no-wait: refused at once with who holds the slots, leaving no place in the queue', async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    const r = await waitForSlot(dir2, { slots: 2, owner: 103, alive, now, wait: false })
    expect(r.refused?.holders.map((c: { pid: number }) => c.pid).sort()).toEqual([101, 102])
    expect(readdirSync(dir2).some((f) => f.startsWith('wait-'))).toBe(false)
    expect(describeClaim({ pid: 101, at: clock - 3 * 60_000, what: 'e2e: 68 suites', root: 'D:/wt' }, clock)).toBe('e2e: 68 suites in D:/wt (process 101, 3 min)')
  })

  it('waiting: says so at each look, and takes the slot once one is let go', async () => {
    const dir2 = newPool()
    const first = await waitForSlot(dir2, { slots: 1, owner: 101, alive, now })
    const seen: number[] = []
    const second = waitForSlot(dir2, { slots: 1, owner: 102, alive, now, pollMs: 30, onWait: (r: { holders: { pid: number }[] }) => seen.push(r.holders[0].pid) })
    await new Promise((r) => setTimeout(r, 150))
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen)).toEqual(new Set([101]))
    first.release()
    const got = await second
    expect(got.slot).toBe(0)
    expect(got.waitedMs).toBeGreaterThan(100)
    got.release()
    expect(readdirSync(dir2).filter((f) => f.endsWith('.json'))).toEqual([])
  })
})

describe("a suite's git waits out the Hive under test's own (lib.git, #199)", () => {
  type Git = (cwd: string, cmd: string | string[], opts?: { timeoutMs?: number }) => string
  const { git } = createRequire(import.meta.url)('./e2e/lib.cjs') as { git: Git }
  const repo = mkdtempSync(join(tmpdir(), 'hive-gitlock-'))
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init -q -b main')
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  const lock = join(repo, '.git', 'index.lock')
  /** Another process (the Hive under test's git status) holding index.lock for ms, then letting go. */
  const holdLock = (ms: number) => {
    writeFileSync(lock, '')
    spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), ${ms})`], { stdio: 'ignore' })
  }

  it('a write while another git holds index.lock waits for it, then runs', () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    holdLock(600)
    const t0 = Date.now()
    git(repo, 'add -A')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt')
    holdLock(300)
    git(repo, 'commit -q -m "a"')
    expect(git(repo, 'log --oneline').trim()).toMatch(/ a$/)
  })

  it('a lock that stays is an error after the timeout; any other failure throws at once', () => {
    writeFileSync(lock, '')
    try {
      expect(() => git(repo, 'add -A', { timeoutMs: 300 })).toThrow(/index\.lock/)
    } finally {
      rmSync(lock, { force: true })
    }
    const t0 = Date.now()
    expect(() => git(repo, 'no-such-command')).toThrow(/not a git command/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('the suites that write to a repository while their Hive runs use it', () => {
    for (const s of ['agents', 'agents-ui', 'resume', 'inbox', 'unmerged', 'paneheader']) expect(readFileSync(join(dir, `${s}.cjs`), 'utf8'), s).toMatch(/= \([^)]*\) => lib\.git\(/)
  })
})
