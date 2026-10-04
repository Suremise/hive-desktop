// hive-progress: runs a command with its output passed through and its exit code returned, and reports it to the Hive
// that launched the agent (report.mts) as a run with an estimate and, when the command prints step lines, steps.
// Outside Hive, or with Hive unreachable, it just runs the command. Node built-ins only (it runs outside the asar).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { estimateFor, ProgressRun, progressTarget, recordTiming, type Fetch } from './report.mts'

export const USAGE = `Usage: hive-progress [--title <title>] -- <command> [args...]

Runs the command, passing its output through and returning its exit code, and shows it in Hive's Progress panel
with the time it usually takes. A line the command prints like
  ##hive-progress step=4 total=12 name=carddialog
says step 4 of 12 (carddialog) is starting, and isn't shown. Give the total in a line within the first 2 seconds
for a bar with steps. Outside Hive it just runs the command. HIVE_PROGRESS=0 turns reporting off.`

export type WrapperArgs = { title?: string; command: string[] } | { help: true } | { error: string }

export function parseArgs(argv: string[]): WrapperArgs {
  let title: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') return argv.length > i + 1 ? { title, command: argv.slice(i + 1) } : { error: 'No command after --.' }
    if (a === '--help' || a === '-h') return { help: true }
    if (a === '--title') {
      if (i + 1 >= argv.length) return { error: '--title needs a value.' }
      title = argv[++i]
    } else if (a.startsWith('--title=')) title = a.slice(8)
    else if (a.startsWith('-')) return { error: `Unknown option ${a}.` }
    else return { title, command: argv.slice(i) }
  }
  return { error: 'No command given.' }
}

const STEP_PREFIX = '##hive-progress'

/** What a step line says: the step starting now (from 1), how many there are, and its name. */
export interface StepLine {
  step?: number
  total?: number
  name?: string
}

/** A step line ("##hive-progress step=4 total=12 name=carddialog": name is the rest of the line), or null. */
export function stepLine(line: string): StepLine | null {
  const m = /^##hive-progress(?:[ \t]+(.*?))?[ \t]*\r?\n?$/.exec(line)
  if (!m) return null
  const u: StepLine = {}
  let rest = m[1] ?? ''
  while (rest) {
    const kv = /^(\w+)=(\S*)[ \t]*/.exec(rest)
    if (!kv) break
    const [all, key, value] = kv
    if (key === 'name') {
      u.name = rest.slice(5).trim()
      break
    }
    const n = /^\d+$/.test(value) ? Number(value) : NaN
    if (key === 'step' && Number.isSafeInteger(n)) u.step = n
    else if (key === 'total' && Number.isSafeInteger(n)) u.total = n
    rest = rest.slice(all.length)
  }
  return u
}

/**
 * Passes output through, taking out step lines. A line is held back only while it may still turn out to be one
 * (it starts like "##hive-progress" and hasn't ended); any other partial line goes out at once, so prompts and
 * progress bars without a newline still show.
 */
export class StepFilter {
  private held: Buffer = Buffer.alloc(0)
  private atLineStart = true
  private readonly prefix = Buffer.from(STEP_PREFIX)
  constructor(
    private readonly write: (b: Buffer) => void,
    private readonly onStep: (u: StepLine) => void
  ) {}

  push(chunk: Buffer): void {
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk
    this.held = Buffer.alloc(0)
    const out: Buffer[] = []
    let i = 0
    while (i < data.length) {
      const nl = data.indexOf(10, i)
      if (!this.atLineStart) {
        out.push(data.subarray(i, nl === -1 ? data.length : nl + 1))
        if (nl === -1) break
        i = nl + 1
        this.atLineStart = true
        continue
      }
      if (nl === -1) {
        const rest = data.subarray(i)
        const n = Math.min(rest.length, this.prefix.length)
        if (rest.subarray(0, n).equals(this.prefix.subarray(0, n))) this.held = Buffer.from(rest)
        else {
          out.push(rest)
          this.atLineStart = false
        }
        break
      }
      const line = data.subarray(i, nl + 1)
      const step = line.subarray(0, this.prefix.length).equals(this.prefix) ? stepLine(line.toString('utf8')) : null
      if (step) this.onStep(step)
      else out.push(line)
      i = nl + 1
    }
    if (out.length) this.write(out.length === 1 ? out[0] : Buffer.concat(out))
  }

  /** The output ended: a held line goes out (or is taken as a step). */
  end(): void {
    if (!this.held.length) return
    const step = stepLine(this.held.toString('utf8'))
    if (step) this.onStep(step)
    else this.write(this.held)
    this.held = Buffer.alloc(0)
  }
}

// Windows: a command that isn't an .exe (npm.cmd, a .bat, a cmd built-in) needs cmd.exe, whose own parsing of the
// line has to be escaped: the approach cross-spawn takes (each argument quoted for the program, then cmd's special
// characters escaped with ^; twice for npm's node_modules\.bin shims, which hand the line to cmd again).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export function cmdEscapeCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1')
}

export function cmdEscapeArgument(arg: string, twice = false): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`.replace(CMD_META, '^$1')
  return twice ? a.replace(CMD_META, '^$1') : a
}

/** The file a command name runs (PATH and PATHEXT, as cmd looks it up), or null when it isn't a file. */
export function resolveCommand(cmd: string, env: Record<string, string | undefined>, cwd: string): string | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const isFile = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isFile()
    } catch {
      return false
    }
  }
  const tryAt = (base: string): string | null => {
    if (extname(base) && isFile(base)) return base
    for (const e of exts) if (isFile(base + e)) return base + e
    return null
  }
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return tryAt(isAbsolute(cmd) ? cmd : join(cwd, cmd))
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  for (const dir of [cwd, ...(pathKey ? (env[pathKey] ?? '').split(delimiter) : [])].filter(Boolean)) {
    const hit = tryAt(join(dir, cmd))
    if (hit) return hit
  }
  return null
}

/** How to start the command: directly, or (Windows, not an .exe) through cmd.exe with its line escaped. */
export function spawnSpec(command: string[], env: Record<string, string | undefined>, cwd: string, platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  const [cmd, ...args] = command
  if (platform !== 'win32') return { file: cmd, args, verbatim: false }
  const file = resolveCommand(cmd, env, cwd)
  if (file && /\.(exe|com)$/i.test(file)) return { file, args, verbatim: false }
  const twice = !!file && /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [cmdEscapeCommand(file ?? cmd), ...args.map((a) => cmdEscapeArgument(a, twice))].join(' ')
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** The command line as shown: arguments with spaces or quotes quoted. */
export function commandLabel(command: string[]): string {
  return command.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ')
}

/** What a run's timings are kept under: the command line in its folder (hashed: no paths or arguments are stored). */
export function timingKey(cwd: string, command: string[]): string {
  return createHash('sha256').update(`${cwd.toLowerCase()}\0${command.join('\0')}`).digest('hex').slice(0, 32)
}

export interface WrapperIo {
  env: Record<string, string | undefined>
  cwd: string
  stdout: { write(b: Buffer | string): unknown }
  stderr: { write(b: Buffer | string): unknown }
  stdin?: 'inherit' | 'ignore'
  /** For tests: the API calls (report.mts's fetch) and the update interval. */
  fetch?: Fetch
  minIntervalMs?: number
  /** How long the run waits for a step line with the total before it is reported without (default 2 s). */
  startWaitMs?: number
  /** Whether hive-progress runs in Hive's executable as Node (default: whether it does); tests set it. */
  viaElectron?: boolean
}

/**
 * The command's run as reported: it starts at the first step line that gives the total, or after `waitMs`, so steps
 * the command announces at once show as steps (the API takes the total only at the start). Step lines name the step
 * starting (from 1); the API counts the steps finished.
 */
class WrappedRun {
  private run: ProgressRun | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private total: number | undefined
  private step: number | undefined
  private name: string | undefined
  constructor(
    private readonly start: () => { title: string; command: string; estimateMs?: number; started: number },
    private readonly opts: { fetch?: Fetch; minIntervalMs?: number; target: NonNullable<ReturnType<typeof progressTarget>> },
    waitMs: number
  ) {
    this.timer = setTimeout(() => this.begin(), waitMs)
  }

  private begin(): void {
    if (this.run) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const s = this.start()
    const left = s.estimateMs === undefined ? undefined : Math.max(0, s.estimateMs - (Date.now() - s.started))
    this.run = new ProgressRun(this.opts.target, { title: s.title, command: s.command, total: this.total, step: this.step, stepName: this.name, estimateMs: left }, { fetch: this.opts.fetch, minIntervalMs: this.opts.minIntervalMs })
  }

  onStep(u: StepLine): void {
    if (u.step !== undefined) this.step = Math.max(0, u.step - 1)
    if (u.name !== undefined) this.name = u.name
    if (!this.run) {
      if (u.total !== undefined && u.total > 0) {
        this.total = u.total
        this.begin()
      }
      return
    }
    this.run.update({ ...(u.step !== undefined ? { step: this.step } : {}), ...(u.name !== undefined ? { stepName: u.name } : {}) })
  }

  async finish(ok: boolean, summary?: string): Promise<void> {
    this.begin()
    await this.run!.finish(ok, summary)
  }
}

/**
 * The command's environment: the caller's, without what hive-progress was started with. Run by Hive's executable as
 * Node (its shims), ELECTRON_RUN_AS_NODE is the shims' own: the command gets the caller's value back (kept in
 * HIVE_PROGRESS_RUN_AS_NODE; usually none), so an Electron app it starts runs as an app.
 */
export function commandEnv(env: Record<string, string | undefined>, viaElectron: boolean): Record<string, string | undefined> {
  const out = { ...env }
  if (viaElectron) {
    delete out.ELECTRON_RUN_AS_NODE
    if (env.HIVE_PROGRESS_RUN_AS_NODE) out.ELECTRON_RUN_AS_NODE = env.HIVE_PROGRESS_RUN_AS_NODE
  }
  delete out.HIVE_PROGRESS_RUN_AS_NODE
  delete out.HIVE_PROGRESS_DATA
  return out
}

/** Runs hive-progress with these arguments; resolves to the exit code to end with (the command's own). */
export async function runWrapped(argv: string[], io: WrapperIo): Promise<number> {
  const parsed = parseArgs(argv)
  if ('help' in parsed) {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if ('error' in parsed) {
    io.stderr.write(`hive-progress: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const target = progressTarget(io.env)
  const spec = spawnSpec(parsed.command, io.env, io.cwd)
  const env = commandEnv(io.env, io.viaElectron ?? !!process.versions.electron)
  const started = Date.now()
  // Not reporting: the command runs as if hive-progress weren't there (its own console, no filtering).
  if (!target) return run(spec, env, io, null)
  const label = commandLabel(parsed.command)
  const timings = io.env.HIVE_PROGRESS_DATA ? join(io.env.HIVE_PROGRESS_DATA, 'timings.json') : null
  const key = timingKey(io.cwd, parsed.command)
  const report = new WrappedRun(
    () => ({ title: parsed.title?.trim() || label, command: label, estimateMs: timings ? estimateFor(timings, key) : undefined, started }),
    { target, fetch: io.fetch, minIntervalMs: io.minIntervalMs },
    io.startWaitMs ?? 2000
  )
  const code = await run(spec, env, io, (u) => report.onStep(u))
  if (code === 0 && timings) recordTiming(timings, key, Date.now() - started)
  await report.finish(code === 0, code === 0 ? undefined : `exit code ${code}`)
  return code
}

function run(spec: { file: string; args: string[]; verbatim: boolean }, env: Record<string, string | undefined>, io: WrapperIo, onStep: ((u: StepLine) => void) | null): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(spec.file, spec.args, {
        cwd: io.cwd,
        env,
        stdio: [io.stdin ?? 'inherit', onStep ? 'pipe' : 'inherit', onStep ? 'pipe' : 'inherit'],
        windowsVerbatimArguments: spec.verbatim,
        // The wrapper runs as Electron (a GUI program) with no console of its own, so the command gets a new one: shown,
        // it is a terminal window popping up (Windows Terminal, when it is the default). Hidden, the output still comes
        // through, and windows the command opens itself still show (only cmd's own window is hidden).
        windowsHide: true
      })
    } catch (e) {
      io.stderr.write(`hive-progress: ${(e as Error).message}\n`)
      return resolve(127)
    }
    const filters: StepFilter[] = []
    if (onStep) {
      for (const [stream, to] of [
        [child.stdout, io.stdout],
        [child.stderr, io.stderr]
      ] as const) {
        const f = new StepFilter((b) => to.write(b), onStep)
        filters.push(f)
        stream?.on('data', (d: Buffer) => f.push(d))
      }
    }
    let settled = false
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      io.stderr.write(`hive-progress: ${e.code === 'ENOENT' ? `${spec.file}: command not found` : e.message}\n`)
      resolve(e.code === 'ENOENT' ? 127 : 1)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      for (const f of filters) f.end()
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}
