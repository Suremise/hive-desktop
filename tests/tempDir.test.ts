// Tests' temp folders (#448): every test makes them with tempDir() (tests/tempDir.ts), by their long, real paths, never
// under os.tmpdir() itself, whose path is the 8.3 short form on GitHub's runner (C:\Users\RUNNER~1\…). A test that wants
// another name for a folder makes one on purpose (tests/pathAliases.ts): checked here on this machine.
import { spawnSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { junction, shortPath } from './pathAliases'
import { tempDir, tempRoot } from './tempDir'

const here = __dirname
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const dir = (prefix: string): string => {
  const d = tempDir(prefix)
  made.push(d)
  return d
}
const same = (a: string, b: string): boolean => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase()

/** The tests' code files (unit tests, helpers, e2e suites and runners, scenarios), not their fixtures. */
function code(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (['fixtures', 'node_modules'].includes(e.name) ? [] : code(join(d, e.name))) : /\.(ts|mts|cts|js|cjs|mjs)$/.test(e.name) ? [join(d, e.name)] : []
  )
}

/**
 * The only lines outside the helper (and this, its guard) that may name the temp folder itself, each in its own file,
 * exactly as written: anywhere else, the same text is refused.
 */
const ALLOWED: Record<string, string[]> = {
  // The hive-test root is %LOCALAPPDATA%\hive-test, in the temp folder only where LOCALAPPDATA is unset.
  'e2e/runContext.cjs': ['const LOCAL = process.env.LOCALAPPDATA || os.tmpdir()'],
  'e2e/build.mjs': ["import { tmpdir } from 'os'", "export const BUILD_LOCKS = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'build-locks')"],
  'progressReport.mts': ["import { tmpdir } from 'node:os'", "const timings = (): string => process.env.HIVE_TEST_PROGRESS_TIMINGS || join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'progress-timings.json')"],
  // npm run e2e -- --clear-dir: a folder the user names may be in the temp folder (one nothing here made).
  'e2e/evidence.cjs': ['function clearDir(target, { board = {}, temp = os.tmpdir(), testRoot = runContext.TEST_ROOT, homes = [runContext.CODEX_HOME, runContext.CLAUDE_TEST_HOME] } = {}) {']
}
const OWN = ['tempDir.ts', 'tempDir.test.ts']

/** Where these files name the temp folder themselves (os.tmpdir, TEMP or TMP), other than ALLOWED: `file:line` each. */
function rawTempUses(files: { name: string; text: string }[]): string[] {
  const found: string[] = []
  for (const { name, text } of files) {
    if (OWN.includes(name)) continue
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (!/\btmpdir\b|\benv\s*(\.\s*(TEMP|TMP)\b|\[\s*['"`](TEMP|TMP)['"`])/i.test(line)) return
      if (ALLOWED[name]?.includes(line.trim())) return
      found.push(`${name}:${i + 1}`)
    })
  }
  return found
}

describe('temp folders for tests (#448)', () => {
  it('no test uses os.tmpdir() itself: tempDir() and tempRoot() give the long, real path', () => {
    const files = code(here).map((f) => ({ name: relative(here, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }))
    expect(files.length).toBeGreaterThan(150)
    expect(rawTempUses(files)).toEqual([])
    // Each allowance is still there: one that isn't goes from the list.
    for (const [name, lines] of Object.entries(ALLOWED)) {
      const text = files.find((f) => f.name === name)?.text ?? ''
      for (const l of lines) expect(text.split(/\r?\n/).map((x) => x.trim()), `${name}: ${l}`).toContain(l)
    }
  })

  it('the guard refuses each way of reaching the temp folder, and an allowed line anywhere but its own file', () => {
    const fallback = ALLOWED['e2e/runContext.cjs'][0]
    const refused = [
      "const d = mkdtempSync(join(tmpdir(), 'x-'))",
      "const d = mkdtempSync(join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-bypass-'))",
      "const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'x-'))",
      "import { tmpdir } from 'os'",
      'const { tmpdir } = await import(\'os\')',
      'const t = os.tmpdir',
      "const d = join(process.env.TEMP ?? 'C:\\\\t', 'x')",
      "const d = join(process.env['TMP']!, 'x')",
      fallback
    ]
    const files = refused.map((text, i) => ({ name: i === refused.length - 1 ? 'raw.test.ts' : `raw${i}.test.ts`, text }))
    expect(rawTempUses(files)).toEqual(files.map((f) => `${f.name}:1`))
    // In its own file, only the line as allowed: another use there is refused.
    expect(rawTempUses([{ name: 'e2e/runContext.cjs', text: `${fallback}\nconst x = os.tmpdir()\n// os.tmpdir() in a comment` }])).toEqual(['e2e/runContext.cjs:2'])
  })

  it('tempDir makes a new, empty folder by its real path; tempRoot is the temp folder by its real path', () => {
    const a = dir('hive-tempdir-')
    const b = dir('hive-tempdir-')
    expect(a).not.toBe(b)
    expect(readdirSync(a)).toEqual([])
    expect(realpathSync.native(a)).toBe(a)
    expect(tempRoot()).toBe(realpathSync.native(tmpdir()))
    expect(a.startsWith(tempRoot())).toBe(true)
  })
})

describe('other names for a folder (tests/pathAliases.ts)', () => {
  it('shortPath gives the 8.3 name of a long one, the same folder (skipped where the volume makes no short names)', (ctx) => {
    const long = dir('hive-short-path-with-a-long-name-')
    const short = shortPath(long)
    if (short === null) return ctx.skip()
    expect(short).toMatch(/~\d/)
    expect(short.toLowerCase()).not.toBe(long.toLowerCase())
    expect(same(short, long)).toBe(true)
  })

  it('shortPath gives null where there is no other name: every part already short, or no such path', () => {
    expect(shortPath(process.env.SystemRoot ?? 'C:\\Windows')).toBeNull()
    expect(shortPath(join(tempRoot(), 'hive-no-such-folder-448', 'x'))).toBeNull()
  })

  it('junction gives another name for a folder on any machine: a different path, the same folder', () => {
    const d = dir('hive-junction-')
    const target = dir('hive-junction-target-')
    const via = junction(target, join(d, 'via'))
    expect(via.toLowerCase()).not.toBe(target.toLowerCase())
    expect(existsSync(via)).toBe(true)
    expect(same(via, target)).toBe(true)
  })
})

describe('git as on the runner (tests/noGlobalGit.ts)', () => {
  const git = (cwd: string, ...a: string[]): { status: number | null; out: string } => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it('no global config: none read, none can be written, so a commit needs its repository to say who', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    const d = dir('hive-no-global-git-')
    expect(git(d, 'config', '--global', '--list')).toMatchObject({ status: 0, out: '' })
    // Nothing a test or an earlier run writes stays for the next.
    expect(git(d, 'config', '--global', 'user.name', 'Left behind').status).not.toBe(0)
    expect(git(d, 'config', '--global', '--get', 'user.name')).toMatchObject({ status: 1, out: '' })
    expect(git(d, 'init', '-q').status).toBe(0)
    const anon = git(d, 'commit', '-q', '--allow-empty', '-m', 'x')
    expect(anon.status).not.toBe(0)
    expect(anon.out).toMatch(/Author identity unknown|Committer identity unknown|unable to auto-detect email address/)
    git(d, 'config', 'user.name', 'Test')
    git(d, 'config', 'user.email', 'test@example.com')
    expect(git(d, 'commit', '-q', '--allow-empty', '-m', 'x').status).toBe(0)
  })
})
