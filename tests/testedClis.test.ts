// The CLI versions a Hive release was tested with (#365): read from the real tier's run record (never typed by hand),
// written into resources/tested-clis.json by `npm run tested-clis`, checked by `npm run release`, and compared with the
// installed version for Agent Setup, Copy Diagnostics and the Agent API.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { CLI_PROVIDERS, MANIFEST, manifestFromRecord, manifestStale } from '../scripts/testedClis.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { readCliLog, realCliVersions, recordJson, recordMarkdown } from './e2e/record.mjs'
import { compareTested, noteSelectedCli } from '../src/main/testedClis'
import { compareVersions } from '../src/main/providers/common'
import { PROVIDERS } from '../src/shared/providers'
import { testedComparison, testedNote, testedSummary } from '../src/shared/testedClis'

type Suite = { name: string; needs?: string[] }
type Cli = { provider: string; version: string; path: string | null }
const suites = SUITES as Suite[]
const real = (need: string) => suites.filter((s) => s.needs?.includes(need)).map((s) => s.name)
const CLAUDE: Cli = { provider: 'claude-code', version: '2.1.292', path: 'C:\\Users\\t\\.local\\bin\\claude.exe' }
const CODEX: Cli = { provider: 'codex', version: '0.160.1', path: 'C:\\Users\\t\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' }
/** A passed suite whose test copies of Hive selected these CLIs (both, as Hive looks for both). */
const pass = (name: string, clis: Cli[] = []) => ({ name, ok: true, seconds: 3, clis })
const realResults = () => [pass('about'), ...real('claude').map((n) => pass(n, [CLAUDE, CODEX])), ...real('codex').map((n) => pass(n, [CLAUDE, CODEX]))]
/** A run record of the whole real tier (and one fake suite), every suite passed, as run.mjs writes it. */
const fullRecord = (over: Record<string, unknown> = {}) => {
  const results = realResults()
  return { ...recordJson({ code: '0123456789ab', when: '2026-10-07 14:32', results, clis: realCliVersions(results, suites) }), ...over }
}
type Result = ReturnType<typeof realResults>[number]

describe('the run record says which real CLIs ran, as Hive selected them (#365)', () => {
  it("reads the suite's log of what its Hive selected, once each, skipping lines it can't read", () => {
    const log = [JSON.stringify(CLAUDE), JSON.stringify(CODEX), JSON.stringify(CLAUDE), '{"provider":"codex"', JSON.stringify({ provider: 'codex' }), ''].join('\n')
    expect(readCliLog(log)).toEqual([CLAUDE, CODEX])
    expect(readCliLog('')).toEqual([])
  })

  it("takes each real CLI's versions from its own real suites only, and names them in the records", () => {
    // A Codex suite's Hive also finds Claude Code: that isn't a run of Claude Code's suites.
    const results = [pass('about', [{ ...CLAUDE, version: '9.9.9' }]), pass(real('claude')[0], [CLAUDE]), pass(real('codex')[0], [{ ...CLAUDE, version: '2.1.1' }, CODEX])]
    expect(realCliVersions(results, suites)).toEqual({ claude: ['2.1.292'], codex: ['0.160.1'] })
    const clis = { claude: ['2.1.292'], codex: ['0.160.1', '0.161.0'] }
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '3 passed', clis })
    expect(md).toContain('Real CLIs (as Hive selected them): Claude Code 2.1.292, Codex 0.160.1 and 0.161.0.')
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [pass('about')], logDir: 'x', summary: '1 passed' })).not.toContain('Real CLIs')
    const json = recordJson({ code: 'abc', when: 'now', results: [pass('a', [CLAUDE]), { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true }], problems: ['code changed'], clis: { claude: ['2.1.292'] } })
    expect(json).toEqual({ code: 'abc', when: 'now', valid: false, problems: ['code changed'], clis: { claude: ['2.1.292'] }, results: [{ name: 'a', ok: true, skipped: null, environment: false, clis: [CLAUDE] }, { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true, clis: [] }], notRun: [] })
  })
})

describe('npm run tested-clis: the manifest from a run record (#365)', () => {
  it('takes each CLI whose real suites all ran and passed, with the version their Hive selected', () => {
    const { manifest, updated, problems } = manifestFromRecord(fullRecord(), suites)
    expect(problems).toEqual([])
    expect(updated).toEqual(['claude-code', 'codex'])
    expect(manifest).toEqual({ 'claude-code': { version: '2.1.292', testedAt: '2026-10-07', record: '0123456789ab' }, codex: { version: '0.160.1', testedAt: '2026-10-07', record: '0123456789ab' } })
  })

  it("never vouches for a CLI the record doesn't show working, and keeps its earlier entry", () => {
    const current = { codex: { version: '0.159.0', testedAt: '2026-09-01', record: 'fedcba987654' } }
    const changed = (name: string, change: (r: Result) => object) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? change(r) : r)) })
    // A real suite skipped for the environment, or failed: no result for that CLI.
    let out = manifestFromRecord(changed(real('codex')[0], (r) => ({ ...r, skipped: 'environment: usage limit', environment: true })), suites, current)
    expect(out.updated).toEqual(['claude-code'])
    expect(out.manifest.codex).toEqual(current.codex)
    expect(out.problems).toEqual([`Codex: not all of its real suites passed (${real('codex')[0]})`])
    expect(manifestFromRecord(changed(real('claude')[0], (r) => ({ ...r, ok: false })), suites).problems).toEqual([`Claude Code: not all of its real suites passed (${real('claude')[0]})`])
    // Only some of its suites ran (an --affected run), or none (the fake tier).
    const some = fullRecord({ results: fullRecord().results.filter((r: Result) => r.name !== real('claude')[0]) })
    expect(manifestFromRecord(some, suites).problems).toEqual([`Claude Code: not all of its real suites ran (${real('claude')[0]} didn't)`])
    out = manifestFromRecord(fullRecord({ results: [pass('about')] }), suites, current)
    expect(out.updated).toEqual([])
    expect(out.manifest).toEqual(current)
    expect(out.problems).toEqual(['Claude Code: none of its real suites ran', 'Codex: none of its real suites ran'])
  })

  it('takes the version only from what every suite of the CLI ran: none unsaid, all the same', () => {
    const changed = (name: string, clis: Cli[]) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? { ...r, clis } : r)) })
    // A suite whose Hive didn't say (an older runner, or it never looked), or said only the other CLI.
    expect(manifestFromRecord(changed(real('codex')[1], []), suites).problems).toEqual([`Codex: the record doesn't say which version Hive used in ${real('codex')[1]}`])
    expect(manifestFromRecord(changed(real('claude')[0], [CODEX]), suites).problems).toEqual([`Claude Code: the record doesn't say which version Hive used in ${real('claude')[0]}`])
    // One suite ran another version (updated mid-run, or another copy): refused, not one of them picked.
    expect(manifestFromRecord(changed(real('codex')[2], [CLAUDE, { ...CODEX, version: '0.161.0' }]), suites).problems).toEqual(['Codex: its real suites ran different versions (0.160.1, 0.161.0)'])
    // The record's top-level summary is never the source: only what each suite's Hive selected.
    expect(manifestFromRecord(fullRecord({ clis: { claude: ['1.0.0'], codex: ['0.1.0'] } }), suites).manifest.codex.version).toBe('0.160.1')
  })

  it('refuses a record that is not valid, or not a record', () => {
    expect(manifestFromRecord(fullRecord({ valid: false, problems: ['the code changed while the suites ran'] }), suites)).toEqual({ manifest: {}, updated: [], problems: ["the record isn't valid: the code changed while the suites ran"] })
    expect(manifestFromRecord({ hello: 1 }, suites).problems).toEqual(["it isn't a run record (run-record.json)"])
  })

  it('maps each real CLI of the suites to a provider Hive has', () => {
    const needs = new Set(suites.flatMap((s) => s.needs ?? []).filter((n) => n !== 'packaged'))
    expect([...needs].sort()).toEqual(Object.keys(CLI_PROVIDERS).sort())
    for (const p of Object.values(CLI_PROVIDERS) as { id: string; name: string }[]) expect(PROVIDERS.find((x) => x.id === p.id)?.name).toBe(p.name)
  })
})

describe('npm run release: the manifest must be of the code released (#365)', () => {
  const manifest = manifestFromRecord(fullRecord(), suites).manifest
  it('takes one tested on HEAD, or on the commit before with only the manifest changed since', () => {
    expect(manifestStale(manifest, () => [])).toBeNull()
    expect(manifestStale(manifest, () => [MANIFEST])).toBeNull()
  })
  it('refuses one that is missing a CLI, comes from uncommitted changes, an unknown commit, or older code', () => {
    expect(manifestStale(null, () => [])).toBe('it has no tested version for Claude Code and Codex')
    expect(manifestStale({ 'claude-code': manifest['claude-code'] }, () => [])).toBe('it has no tested version for Codex')
    expect(manifestStale({ ...manifest, codex: { ...manifest.codex, record: '0123456789ab+fedcba987654' } }, () => [])).toBe("Codex's entry comes from a run on uncommitted changes (0123456789ab+fedcba987654)")
    expect(manifestStale(manifest, () => null)).toBe("Claude Code's entry comes from a commit git doesn't know (0123456789ab)")
    expect(manifestStale(manifest, () => [MANIFEST, 'src/main/sessions.ts', 'package.json'])).toBe("Claude Code's entry was tested on 0123456789ab, and 2 files have changed since (src/main/sessions.ts, package.json)")
  })
})

describe('the shipped manifest (#365)', () => {
  // Between releases it may lack a provider (Claude Code's real tier runs in the default home until #368, so its entry
  // is written by the release's run); npm run release refuses it until every provider has one (manifestStale).
  it("names only Hive's providers, each entry as npm run tested-clis writes it from a run record of the real tier", () => {
    const shipped = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    expect(Object.keys(shipped).length).toBeGreaterThan(0)
    for (const id of Object.keys(shipped)) expect(PROVIDERS.map((p) => p.id), id).toContain(id)
    for (const p of PROVIDERS.filter((x) => shipped[x.id])) {
      const e = shipped[p.id]
      expect(e.version, p.id).toMatch(/^\d+\.\d+\.\d+/)
      expect(e.testedAt, p.id).toMatch(/^\d{4}-\d\d-\d\d$/)
      // The record's code: written by npm run tested-clis from a run record, never typed.
      expect(e.record, p.id).toMatch(/^[0-9a-f]{12}(\+[0-9a-f]{12})?$/)
    }
  })
})

describe('the installed version against the tested one (#365)', () => {
  const isNewer = (a: string, b: string) => compareVersions(a, b) > 0
  const tested = { version: '2.1.287', testedAt: '2026-10-07' }
  it('compares by the provider\'s version order', () => {
    expect(compareTested(tested, '2.1.287', isNewer).installed).toBe('same')
    expect(compareTested(tested, '2.1.290', isNewer).installed).toBe('newer')
    expect(compareTested(tested, '2.1.30', isNewer).installed).toBe('older')
    expect(compareTested(tested, '2.10.0', isNewer).installed).toBe('newer')
    expect(compareTested(tested, null, isNewer)).toEqual({ ...tested, installed: 'unknown' })
  })
  it('says it calmly: a tick for the same, a note for newer, older or unknown', () => {
    const t = (installed: 'same' | 'newer' | 'older' | 'unknown') => ({ ...tested, installed })
    expect(testedSummary(t('newer'), '2.1.290')).toBe('Tested with 2.1.287 · installed 2.1.290')
    expect(testedSummary(t('unknown'), null)).toBe('Tested with 2.1.287 · installed version unknown')
    expect(testedNote(t('same'))).toBeNull()
    expect(testedNote(t('newer'))).toBe('This version came out after this Hive release was tested. Most updates work; if something behaves oddly, report it (Copy Diagnostics).')
    expect(testedNote(t('older'))).toBe('Older than tested; consider updating.')
    expect(testedNote(t('unknown'))).toMatch(/couldn't tell which version is installed/)
    expect(['same', 'newer', 'older', 'unknown'].map((k) => testedComparison(t(k as 'same')))).toEqual(['the tested version', 'newer than tested', 'older than tested', 'version unknown'])
  })
})

describe('the run record\'s versions are what Hive selected, not the first copy on PATH (#365)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-tested-clis-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  /** Puts an environment variable back as it was. */
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  /** A stand-in CLI that says this version for any arguments. */
  const fake = (folder: string, version: string) => {
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'claude.cmd')
    writeFileSync(file, `@echo ${version} (Claude Code)\r\n`)
    return file
  }

  it("an editor extension's copy first on PATH, at another version: Hive selects the standalone CLI, and notes that one", async () => {
    const extension = fake(join(dir, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9', 'resources'), '9.9.9')
    const standalone = fake(join(dir, 'standalone'), '2.1.292')
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    // Its PATH candidates in where.exe's order: the extension's copy first.
    const adapter = claudeCode as unknown as { candidates: () => Promise<{ path: string; source: string }[]> }
    const before = adapter.candidates
    adapter.candidates = async () => [{ path: extension, source: 'PATH' }, { path: standalone, source: 'PATH' }]
    try {
      const info = await claudeCode.locate()
      expect({ path: info.path, version: info.version, rejected: info.rejected }).toEqual({ path: standalone, version: '2.1.292', rejected: [extension] })
      // A test copy of Hive notes what it selected for the run record.
      const log = join(dir, 'hive-clis.jsonl')
      const env = { user: process.env.HIVE_USER_DATA, log: process.env.HIVE_TEST_CLI_LOG }
      process.env.HIVE_USER_DATA = join(dir, 'profile')
      process.env.HIVE_TEST_CLI_LOG = log
      try {
        await noteSelectedCli(info)
      } finally {
        restore('HIVE_USER_DATA', env.user)
        restore('HIVE_TEST_CLI_LOG', env.log)
      }
      expect(readCliLog(readFileSync(log, 'utf8'))).toEqual([{ provider: 'claude-code', version: '2.1.292', path: standalone }])
    } finally {
      adapter.candidates = before
    }
  })

  it('notes nothing outside a test copy, or for a CLI not found', async () => {
    const log = join(dir, 'none.jsonl')
    const info = { provider: 'claude-code', found: true, path: 'x', version: '1.0.0' } as never
    const was = process.env.HIVE_TEST_CLI_LOG
    process.env.HIVE_TEST_CLI_LOG = log
    const user = process.env.HIVE_USER_DATA
    delete process.env.HIVE_USER_DATA
    try {
      await noteSelectedCli(info)
      process.env.HIVE_USER_DATA = join(dir, 'profile')
      await noteSelectedCli({ provider: 'claude-code', found: false, path: null, version: null } as never)
    } finally {
      restore('HIVE_TEST_CLI_LOG', was)
      restore('HIVE_USER_DATA', user)
    }
    expect(() => readFileSync(log, 'utf8')).toThrow()
  })
})
