// Progress reporters (#137): the hive-progress wrapper (main/progressReporters/wrapper.ts) and the reporting it shares with the
// test runners (main/progressReporters/report.mts), against a stand-in for #136's Agent API: output and exit codes pass
// through; Hive reachable, unreachable or absent; step lines; estimates after one run; updates coalesced.
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { estimateFor, ProgressRun, progressTarget, recordTiming } from '../src/main/progressReporters/report.mts'
import { cmdEscapeArgument, commandEnv, commandLabel, parseArgs, runWrapped, spawnSpec, StepFilter, stepLine, timingKey } from '../src/main/progressReporters/wrapper'
import { installShims, shimFiles, withBinOnPath } from '../src/main/progressReporters/shims'

const dir = mkdtempSync(join(tmpdir(), 'hive-progress-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * The stand-in Agent API: records each call; `refuse` answers the start with 401. Each call is also written to `seenFile`
 * as it arrives, so a command run under the wrapper can wait for what the wrapper has reported (`seenNode` below) instead of
 * guessing how long that takes on a loaded machine.
 */
const calls: { method: string; path: string; auth: string; body: Record<string, unknown> }[] = []
const seenFile = join(dir, 'seen.json')
let refuse = false
let server: Server
let url = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      calls.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : {} })
      writeFileSync(seenFile, JSON.stringify(calls))
      res.setHeader('Content-Type', 'application/json')
      if (refuse) return res.writeHead(401).end('{"error":"no"}')
      res.end(req.method === 'POST' && req.url === '/v1/progress' ? JSON.stringify({ id: `run-${calls.length}` }) : '{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  calls.length = 0
  refuse = false
  rmSync(seenFile, { force: true })
})

const node = process.execPath
const env = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, HIVE_API_URL: url, HIVE_API_TOKEN: 'agent-token', HIVE_PROGRESS_DATA: join(dir, 'data'), HIVE_PROGRESS: undefined, HIVE_API_TOKEN_FILE: undefined, HIVE_WORKSPACE: undefined, HIVE_TEST_SEEN: seenFile, ...extra })
/**
 * Runs the wrapper, collecting what it writes. By default the run is reported only at a step line with the total, or at
 * the end, however long the command takes to start; `startWaitMs` 0 reports it at once, before the command's output.
 */
async function wrap(argv: string[], e: Record<string, string | undefined>, startWaitMs = 60_000) {
  let out = ''
  let err = ''
  const code = await runWrapped(argv, { env: e, cwd: dir, stdout: { write: (b) => (out += String(b)) }, stderr: { write: (b) => (err += String(b)) }, stdin: 'ignore', minIntervalMs: 100, startWaitMs })
  return { code, out, err }
}
/**
 * Node with `seen(c => …)` for its script: it resolves once the stand-in API's calls so far pass the test, so the command
 * goes on only after the wrapper has reported what it should have; after 10 s it goes on anyway (the test's assertions
 * then fail, rather than the test hanging).
 */
const seenJs = join(dir, 'seen.js')
writeFileSync(seenJs, "globalThis.seen = (p) => new Promise((r) => { const end = Date.now() + 10000; const t = setInterval(() => { let c = []; try { c = JSON.parse(require('fs').readFileSync(process.env.HIVE_TEST_SEEN, 'utf8')) } catch {} if (p(c) || Date.now() > end) { clearInterval(t); r() } }, 10) })")
const seenNode = [node, '-r', seenJs]

describe('the hive-progress command line', () => {
  it('reads --title and the command after --, or the first word that is not an option', () => {
    expect(parseArgs(['--title', 'e2e', '--', 'npm', 'run', 'e2e'])).toEqual({ title: 'e2e', command: ['npm', 'run', 'e2e'] })
    expect(parseArgs(['--title=Build', 'npm', 'run', 'dist'])).toEqual({ title: 'Build', command: ['npm', 'run', 'dist'] })
    expect(parseArgs(['--', 'node', '--version'])).toEqual({ title: undefined, command: ['node', '--version'] })
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs(['--'])).toHaveProperty('error')
    expect(parseArgs(['--colour', 'x'])).toHaveProperty('error')
  })

  it('reads step lines; anything else is not one', () => {
    expect(stepLine('##hive-progress step=4 total=12 name=carddialog\n')).toEqual({ step: 4, total: 12, name: 'carddialog' })
    expect(stepLine('##hive-progress step=2 name=unit tests: tips\r\n')).toEqual({ step: 2, name: 'unit tests: tips' })
    expect(stepLine('##hive-progress total=3')).toEqual({ total: 3 })
    expect(stepLine('##hive-progress step=x')).toEqual({})
    expect(stepLine('##hive-progressive step=1')).toBeNull()
    expect(stepLine(' ##hive-progress step=1')).toBeNull()
  })

  it('takes step lines out of the output, however the chunks split, and holds back nothing else', () => {
    const run = (chunks: string[]) => {
      const out: string[] = []
      const steps: unknown[] = []
      const f = new StepFilter((b) => out.push(b.toString()), (u) => steps.push(u))
      for (const c of chunks) f.push(Buffer.from(c))
      const before = out.join('')
      f.end()
      return { before, out: out.join(''), steps }
    }
    expect(run(['a\n##hive-pro', 'gress step=1 total=2 name=x\nb\n'])).toEqual({ before: 'a\nb\n', out: 'a\nb\n', steps: [{ step: 1, total: 2, name: 'x' }] })
    // A prompt without a newline shows at once; a held line that ends up not a step line comes out whole.
    expect(run(['Continue? '])).toMatchObject({ before: 'Continue? ' })
    expect(run(['##hive', '-progressive\n'])).toMatchObject({ out: '##hive-progressive\n', steps: [] })
    expect(run(['x ##hive-progress step=1\n'])).toMatchObject({ out: 'x ##hive-progress step=1\n', steps: [] })
    // The last line without a newline: a step all the same.
    expect(run(['done\n##hive-progress step=3'])).toMatchObject({ out: 'done\n', steps: [{ step: 3 }] })
  })

  it('shows the command line quoted where needed, and keeps timings under a hash, not the command', () => {
    expect(commandLabel(['node', '-e', 'console.log("hi")'])).toBe('node -e "console.log(\\"hi\\")"')
    expect(commandLabel(['npm', 'run', 'e2e', '--', 'tips'])).toBe('npm run e2e -- tips')
    expect(timingKey('C:\\P', ['npm', 'test'])).toBe(timingKey('c:\\p', ['npm', 'test']))
    expect(timingKey('C:\\P', ['npm', 'test'])).not.toBe(timingKey('C:\\P', ['npm', 'test', 'x']))
    expect(timingKey('C:\\P', ['npm', 'test'])).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe.runIf(process.platform === 'win32')('starting a command on Windows', () => {
  it('runs an .exe directly, and anything else through cmd with each argument arriving as given', () => {
    expect(spawnSpec([node, '-v'], process.env, dir)).toMatchObject({ file: node, verbatim: false })
    const shim = join(dir, 'args.cmd')
    writeFileSync(shim, `@"${node}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`)
    const args = ['plain', 'two words', 'say "hi"', 'a&b|c', '100%', 'up^caret', 'trail\\', '(x)', '']
    const spec = spawnSpec([shim, ...args], process.env, dir)
    expect(spec).toMatchObject({ verbatim: true, args: ['/d', '/s', '/c', expect.any(String)] })
    const got = spawnSync(spec.file, spec.args, { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(got)).toEqual(args)
    expect(cmdEscapeArgument('a"b')).toBe('^"a\\^"b^"')
  })
})

describe('reporting a run', () => {
  it('reports start, steps and finish as the agent, passes output and the exit code through, and estimates after one run', async () => {
    const script = `console.log('one'); console.log('##hive-progress step=1 total=2 name=first'); console.error('warn'); console.log('##hive-progress step=2 name=second'); seen((c) => c.some((x) => x.body.stepName === 'second')).then(() => process.exit(3))`
    const r = await wrap(['--title', 'Build', '--', ...seenNode, '-e', script], env())
    expect(r).toEqual({ code: 3, out: 'one\n', err: 'warn\n' })
    // The first step line gives the total, so the run starts with it: step 1 of 2 starting is 0 finished.
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/progress', auth: 'Bearer agent-token' })
    expect(calls[0].body).toEqual({ title: 'Build', total: 2, step: 0, stepName: 'first', command: expect.stringContaining('-e') })
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.every((c) => c.path === '/v1/progress/run-1')).toBe(true)
    expect(Object.assign({}, ...patches.map((c) => c.body))).toEqual({ step: 1, stepName: 'second' })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/progress/run-1/finish', body: { ok: false, summary: 'exit code 3' } })

    // A run that failed isn't timed; one that passed is, and the next run of the same command has its estimate: the
    // time left when its start is reported.
    const timings = join(dir, 'data', 'timings.json')
    expect(estimateFor(timings, timingKey(dir, [...seenNode, '-e', script]))).toBeUndefined()
    calls.length = 0
    // (Its start is reported before it ends: at the end, the run would already be timed.)
    const ok = [...seenNode, '-e', `seen((c) => c.length > 0).then(() => console.log('fine'))`]
    expect(await wrap(['--', ...ok], env(), 0)).toEqual({ code: 0, out: 'fine\n', err: '' })
    expect(calls[0].body).not.toHaveProperty('estimateMs')
    expect(calls.at(-1)?.body).toEqual({ ok: true })
    expect(estimateFor(timings, timingKey(dir, ok))).toBeGreaterThanOrEqual(0)
    // Two long runs on record make the usual time ten minutes, so what is left of it when the start is reported doesn't
    // depend on how quickly this machine gets there.
    recordTiming(timings, timingKey(dir, ok), 600_000)
    recordTiming(timings, timingKey(dir, ok), 600_000)
    calls.length = 0
    await wrap(['--', ...ok], env(), 0)
    expect(calls[0].body.estimateMs).toBeGreaterThan(500_000)
    expect(calls[0].body.estimateMs).toBeLessThanOrEqual(600_000)
    // Titled with the command line (clipped: the temporary folder's path is long).
    expect(commandLabel(ok).startsWith(String(calls[0].body.title).replace(/…$/, ''))).toBe(true)
  })

  it('a total given after the run started (no step line at first) is not sent: its steps are, as the step running', async () => {
    // The step line comes only once the start has been reported (#145 is about showing a late total).
    const script = `seen((c) => c.length > 0).then(() => { console.log('##hive-progress step=2 total=5 name=late'); return seen((c) => c.some((x) => x.method === 'PATCH')) })`
    await wrap(['--', ...seenNode, '-e', script], env(), 0)
    expect(calls[0].body).not.toHaveProperty('total')
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.map((c) => c.body)).toEqual([{ step: 1, stepName: 'late' }])
  })

  it('with Hive unreachable, refusing, absent or turned off: the command runs as usual and nothing fails', async () => {
    const cmd = ['--', node, '-e', "console.log('out'); process.exit(4)"]
    const t0 = Date.now()
    expect(await wrap(cmd, env({ HIVE_API_URL: 'http://127.0.0.1:9' }))).toEqual({ code: 4, out: 'out\n', err: '' })
    expect(Date.now() - t0).toBeLessThan(5000)
    refuse = true
    expect(await wrap(cmd, env())).toEqual({ code: 4, out: 'out\n', err: '' })
    expect(calls.map((c) => c.path)).toEqual(['/v1/progress'])
    refuse = false
    calls.length = 0
    // Not reporting, the command has the console itself (nothing to collect here): only its exit code is checked.
    const quiet = ['--', node, '-e', 'process.exit(5)']
    expect((await wrap(quiet, env({ HIVE_API_URL: undefined }))).code).toBe(5)
    expect((await wrap(quiet, env({ HIVE_API_TOKEN: undefined }))).code).toBe(5)
    expect((await wrap(quiet, env({ HIVE_PROGRESS: '0' }))).code).toBe(5)
    expect(calls).toEqual([])
  })

  it('a command that is not there fails as a shell would, still reported as failed', async () => {
    const r = await wrap(['--', 'hive-no-such-command-137'], env())
    expect(r.code).not.toBe(0)
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false } })
  })

  it('coalesces quick updates: the latest state wins, in order, and the finish comes last', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `##hive-progress step=${i + 1} total=200 name=s${i + 1}`).join('\\n')
    await wrap(['--', ...seenNode, '-e', `console.log('${lines}'); seen((c) => c.some((x) => x.body.stepName === 's200'))`], env())
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.length).toBeLessThan(10)
    expect(calls[0].body).toMatchObject({ total: 200, step: 0, stepName: 's1' })
    expect(patches.at(-1)?.body).toMatchObject({ step: 199, stepName: 's200' })
    expect(calls.at(-1)?.path).toBe('/v1/progress/run-1/finish')
  })
})

describe('the shared reporter and timings', () => {
  it('finds its target: the agent token, or the file Hive keeps it in; HIVE_PROGRESS=0 turns it off', () => {
    const file = join(dir, 'token.json')
    writeFileSync(file, JSON.stringify({ token: 'from-file' }))
    expect(progressTarget({ HIVE_API_URL: 'http://h/', HIVE_API_TOKEN: 't', HIVE_WORKSPACE: 'W' })).toEqual({ url: 'http://h', token: 't', workspace: 'W' })
    expect(progressTarget({ HIVE_API_URL: 'http://h', HIVE_API_TOKEN_FILE: file })?.token).toBe('from-file')
    expect(progressTarget({ HIVE_API_URL: 'http://h', HIVE_API_TOKEN: '${HIVE_API_TOKEN}', HIVE_API_TOKEN_FILE: file })?.token).toBe('from-file')
    expect(progressTarget({ HIVE_API_URL: 'http://h' })).toBeNull()
    expect(progressTarget({ HIVE_API_TOKEN: 't' })).toBeNull()
    expect(progressTarget({ HIVE_API_URL: 'http://h', HIVE_API_TOKEN: 't', HIVE_PROGRESS: '0' })).toBeNull()
  })

  it('sends the workspace, clips long text, and does nothing at all without a target', async () => {
    const r = new ProgressRun({ url, token: 't', workspace: 'C:\\Work space' }, { title: 'x'.repeat(500), total: 3.4, estimateMs: -1 })
    expect(await r.reporting()).toBe(true)
    await r.finish(true)
    // The API's limit for titles is 120 characters; a step can't go past the total.
    expect(calls[0].body).toEqual({ title: expect.stringMatching(/^x{119}…$/), total: 3 })
    calls.length = 0
    const capped = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'y', total: 2 }, { minIntervalMs: 10 })
    capped.update({ step: 9 })
    await new Promise((res) => setTimeout(res, 100))
    await capped.finish(true)
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ step: 2 })
    calls.length = 2
    const none = new ProgressRun(null, { title: 'x' })
    none.update({ step: 1 })
    await none.finish(false)
    expect(await none.reporting()).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('estimates from the median of the last five runs, keeps the newest keys, and survives a damaged file', () => {
    const file = join(dir, 'timings', 'timings.json')
    expect(estimateFor(file, 'k')).toBeUndefined()
    for (const ms of [100, 900, 200, 300, 250, 260]) recordTiming(file, 'k', ms)
    expect(estimateFor(file, 'k')).toBe(260)
    for (let i = 0; i < 305; i++) recordTiming(file, `k${i}`, 1, 1000 + i)
    expect(estimateFor(file, 'k0')).toBeUndefined()
    expect(estimateFor(file, 'k304')).toBe(1)
    writeFileSync(file, '{ damaged')
    expect(estimateFor(file, 'k304')).toBeUndefined()
    recordTiming(file, 'k', 50)
    expect(estimateFor(file, 'k')).toBe(50)
  })
})

describe("the hive-progress command on a session's PATH (main/progressReporters/shims.ts)", () => {
  it('puts the bin folder first on PATH, once, whatever the variable is called', () => {
    expect(withBinOnPath({ Path: 'C:\\a;C:\\Hive\\bin;C:\\b' }, 'C:\\Hive\\bin')).toEqual({ Path: 'C:\\Hive\\bin;C:\\a;C:\\b' })
    expect(withBinOnPath({ PATH: '/usr/bin' }, '/h/bin', ':')).toEqual({ PATH: '/h/bin:/usr/bin' })
    expect(withBinOnPath({ X: '1' }, null)).toEqual({ X: '1' })
  })

  it('the .cmd and sh shims start the script with Hive as Node, passing every argument through and the exit code back', async () => {
    const bin = join(dir, 'bin dir')
    // A stand-in for hive-progress.js: shows what it was given, and ends with the code it was asked for.
    const script = join(dir, 'echo args.js')
    writeFileSync(script, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), data: process.env.HIVE_PROGRESS_DATA, node: process.env.ELECTRON_RUN_AS_NODE, callers: process.env.HIVE_PROGRESS_RUN_AS_NODE || null })); process.exit(Number(process.argv.at(-1)) || 0)")
    const data = join(dir, 'data dir')
    expect(await installShims(bin, { exec: node, script, data })).toBe(bin)
    const args = ['--title', 'two words', '--', 'node', 'a&b', '7']
    // The caller's own ELECTRON_RUN_AS_NODE (usually none) is kept for the command, beside the shim's.
    const base = { ...process.env }
    delete base.ELECTRON_RUN_AS_NODE
    for (const callers of [null, '1']) {
      const callerEnv = callers ? { ...base, ELECTRON_RUN_AS_NODE: callers } : base
      if (process.platform === 'win32') {
        // As typed at a cmd prompt.
        const line = [join(bin, 'hive-progress.cmd'), ...args].map((a) => (/[\s&]/.test(a) ? `"${a}"` : a)).join(' ')
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: callerEnv })
        expect([r.status, JSON.parse(r.stdout)]).toEqual([7, { args, data, node: '1', callers }])
      }
      const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh'
      if (existsSync(bash)) {
        const r = spawnSync(bash, [join(bin, 'hive-progress').replace(/\\/g, '/'), ...args], { encoding: 'utf8', env: callerEnv })
        const got = JSON.parse(r.stdout)
        expect([r.status, got.args, got.node, got.data.replace(/\//g, '\\'), got.callers]).toEqual([7, args, '1', data, callers])
      }
    }
    // Written again only when they change.
    const { mtimeMs } = statSync(join(bin, 'hive-progress.cmd'))
    await installShims(bin, { exec: node, script, data })
    expect(statSync(join(bin, 'hive-progress.cmd')).mtimeMs).toBe(mtimeMs)
    expect(shimFiles({ exec: 'C:\\H\\Hive.exe', script: 'C:\\H\\x.js', data: 'C:\\D' })['hive-progress']).toBe(
      "#!/bin/sh\nHIVE_PROGRESS_RUN_AS_NODE=\"${ELECTRON_RUN_AS_NODE-}\" ELECTRON_RUN_AS_NODE=1 HIVE_PROGRESS_DATA='C:/D' exec 'C:/H/Hive.exe' 'C:/H/x.js' \"$@\"\n"
    )
  })

  it("the command doesn't get what started hive-progress: in Hive's executable, ELECTRON_RUN_AS_NODE is the caller's own again", async () => {
    const shimmed = { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', HIVE_PROGRESS_DATA: 'd', HIVE_PROGRESS_RUN_AS_NODE: undefined, HIVE_API_URL: 'u' }
    expect(commandEnv(shimmed, true)).toEqual({ PATH: 'p', HIVE_API_URL: 'u' })
    expect(commandEnv({ ...shimmed, HIVE_PROGRESS_RUN_AS_NODE: '1' }, true)).toEqual({ PATH: 'p', HIVE_API_URL: 'u', ELECTRON_RUN_AS_NODE: '1' })
    // Run by plain Node, the variable is the caller's: left alone.
    expect(commandEnv(shimmed, false)).toEqual({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', HIVE_API_URL: 'u' })
    // The command itself, reporting on, unavailable and off: no ELECTRON_RUN_AS_NODE, no HIVE_PROGRESS_DATA.
    const probe = ['--', node, '-e', 'process.exit(process.env.ELECTRON_RUN_AS_NODE || process.env.HIVE_PROGRESS_DATA ? 23 : 0)']
    const viaShim = { ELECTRON_RUN_AS_NODE: '1' }
    for (const e of [env(viaShim), env({ ...viaShim, HIVE_API_URL: 'http://127.0.0.1:9' }), env({ ...viaShim, HIVE_PROGRESS: '0' })]) {
      const code = await runWrapped(probe, { env: e, cwd: dir, stdout: { write: () => true }, stderr: { write: () => true }, stdin: 'ignore', startWaitMs: 50, viaElectron: true })
      expect(code).toBe(0)
    }
  })
})

describe("Hive's own test runners (tests/progressReport.mts)", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    Object.assign(process.env, { HIVE_API_URL: url, HIVE_API_TOKEN: 'agent-token', HIVE_TEST_PROGRESS_TIMINGS: join(dir, 'runner-timings.json') })
    for (const k of ['HIVE_API_TOKEN_FILE', 'HIVE_WORKSPACE', 'HIVE_PROGRESS']) delete process.env[k]
  })
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('e2e: one step per suite, an estimate from the suites timed before (unknown ones as their average); off with --no-progress', async () => {
    const { e2eProgress } = await import('./progressReport.mts')
    const first = e2eProgress(['a', 'b'], [])
    first.suite(0, 'a')
    first.done('a', 1000, true)
    first.suite(1, 'b')
    first.done('b', 5000, false)
    await new Promise((r) => setTimeout(r, 700))
    await first.finish(false, '1 passed, 1 failed')
    expect(calls[0].body).toEqual({ title: 'e2e: 2 suites', total: 2, step: 0, command: 'npm run e2e -- a b' })
    // Each update counts the suites finished and names the one starting.
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ step: 1, stepName: 'b' })
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, summary: '1 passed, 1 failed' } })
    calls.length = 0
    // a took a second; b failed (not timed), so it counts as the average of the known ones.
    const second = e2eProgress(['a', 'b'], [])
    expect(await new Promise((r) => setTimeout(() => r(calls[0]?.body.estimateMs), 300))).toBe(2000)
    await second.finish(true)
    calls.length = 0
    const off = e2eProgress(['a'], ['--no-progress'])
    off.suite(0, 'a')
    await off.finish(true)
    process.env.HIVE_PROGRESS = '0'
    await e2eProgress(['a'], []).finish(true)
    expect(calls).toEqual([])
  })

  it('unit: a step per file as it finishes, finished with the counts; timed only when all passed', async () => {
    const { VitestProgress } = await import('./progressReport.mts')
    const v = new VitestProgress()
    v.onTestRunStart([{ moduleId: 'x.test.ts' }, { moduleId: 'y.test.ts' }])
    v.onTestModuleEnd({ moduleId: 'C:/r/x.test.ts', relativeModuleId: 'x.test.ts', ok: () => true })
    v.onTestModuleEnd({ moduleId: 'C:/r/y.test.ts', relativeModuleId: 'y.test.ts', ok: () => false })
    // (A finish drops an update not sent yet: give it its moment.)
    await new Promise((r) => setTimeout(r, 300))
    await v.onTestRunEnd([], [], 'failed')
    expect(calls[0].body).toEqual({ title: 'unit: 2 files', total: 2, step: 0, command: 'npm test' })
    expect(Object.assign({}, ...calls.filter((c) => c.method === 'PATCH').map((c) => c.body))).toEqual({ step: 2 })
    expect(calls.at(-1)?.body).toEqual({ ok: false, summary: '1 passed, 1 failed' })
  })
})
