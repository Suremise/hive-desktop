import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { app } from 'electron'
import { emit, toast } from './events'
import { createLogger, userText } from './logger'
import { POWERSHELL } from './launchGate'
import { processCount, processLabel, type AgentLeftovers, type AgentProcess } from '../shared/agentProcesses'

/**
 * The processes each agent's launch starts, and the ones it leaves running when it stops (#507).
 *
 * Its CLI's process (the terminal's root) goes into a Windows job object of its own as it starts, and everything it
 * starts from then on joins that job by itself, however it was started: detached, hidden, through a shell that exited
 * since. Ending a terminal ends only what is attached to its console, so a preview server or a `tail -f` the agent
 * started in the background outlives it, holding its folder and ports. When the CLI exits, what is left in its job is
 * what it left running: listed for the user to end or keep, or ended (Settings → Agents). Only the job's processes
 * are ever ended, so nothing Hive didn't start is touched: a process started before the CLI joined its job, or that
 * broke away from it, is simply not tracked.
 *
 * Job objects need Win32 calls, which Node lacks: one hidden PowerShell per Hive holds the jobs (C# through Add-Type,
 * no files), answering one line per request. Without it (PowerShell blocked) nothing is tracked, and agents stop as
 * before. Its jobs don't end processes when it closes: quitting Hive leaves running what the user chose to keep.
 */

const log = createLogger('processes')


/** How long after the CLI exits its job is looked at: the terminal's own console processes end as it closes. */
const SETTLE_MS = 2000
/**
 * How long the helper gets to say it is ready (Add-Type compiles its C#, which antivirus may scan), and then to answer
 * each request. Test copies (unpackaged) can shorten it: HIVE_TEST_TRACKER_WAIT_MS.
 */
const WAIT_MS = 60_000
const waitMs = (): number => (!app.isPackaged && Number(process.env.HIVE_TEST_TRACKER_WAIT_MS) > 0 ? Number(process.env.HIVE_TEST_TRACKER_WAIT_MS) : WAIT_MS)
/** How often the leftovers are looked at again while there are any (they end by themselves too). */
const POLL_MS = 10_000
/** At most this many processes a job lists (the rest are counted, and ended with it). */
const MAX_LISTED = 50
/** Launches whose leftovers are kept per agent (an agent restarted and stopped over and over), and in all. */
const MAX_JOBS_PER_AGENT = 5
const MAX_JOBS = 100

// Raw: the C# keeps its backslashes.
const HOST_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
public static class HiveJobs {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  static Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  public static string Add(string id, int pid) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) {
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
      if (job == IntPtr.Zero) return "create failed: " + Marshal.GetLastWin32Error();
      jobs[id] = job;
    }
    // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
    IntPtr p = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);
    if (p == IntPtr.Zero) return "the process has gone (" + Marshal.GetLastWin32Error() + ")";
    uint code;
    // STILL_ACTIVE: a process that has exited (its id kept alive by a handle) isn't the launch's any more.
    if (!GetExitCodeProcess(p, out code) || code != 259) { CloseHandle(p); return "the process has exited"; }
    bool ok = AssignProcessToJobObject(job, p);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(p);
    return ok ? "ok" : "assign failed: " + err;
  }
  public static int[] List(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return new int[0];
    for (int n = 256; n <= 65536; n *= 4) {
      int size = 2 * 4 + IntPtr.Size * n;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) { if (Marshal.GetLastWin32Error() == 234) continue; return new int[0]; }
        int count = Marshal.ReadInt32(buf, 4);
        int[] r = new int[count];
        for (int i = 0; i < count; i++) r[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
        return r;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return new int[0];
  }
  public static bool Kill(string id) { IntPtr job; return jobs.TryGetValue(id, out job) && TerminateJobObject(job, 1); }
  public static void Forget(string id) { IntPtr job; if (jobs.TryGetValue(id, out job)) { CloseHandle(job); jobs.Remove(id); } }
  /** A JSON string. */
  public static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  /** The job's processes as JSON: how many, and the first max with their names and command lines. */
  public static string Describe(string id, int max) {
    int[] all = List(id);
    var b = new StringBuilder("{\"total\":" + all.Length + ",\"processes\":[");
    if (all.Length > 0) {
      var where = new StringBuilder();
      for (int i = 0; i < all.Length && i < max; i++) where.Append(i > 0 ? " OR " : "").Append("ProcessId=").Append(all[i]);
      bool first = true;
      using (var q = new ManagementObjectSearcher("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE " + where))
        foreach (ManagementObject p in q.Get()) {
          b.Append(first ? "" : ",").Append("{\"pid\":").Append(Convert.ToInt32(p["ProcessId"])).Append(",\"name\":").Append(Q((string)p["Name"])).Append(",\"cmd\":").Append(Q((string)p["CommandLine"])).Append('}');
          first = false;
        }
    }
    return b.Append("]}").ToString();
  }
  /** One request ("<n> <command> <job> [pid]") answered as "<n> <JSON>". */
  public static string Answer(string line) {
    string[] a = line.Split(' ');
    string r;
    try {
      switch (a.Length > 2 ? a[1] : "") {
        case "add": r = Q(Add(a[2], int.Parse(a[3]))); break;
        case "list": r = Describe(a[2], ${MAX_LISTED + 1}); break;
        case "kill": r = Kill(a[2]) ? "true" : "false"; break;
        case "forget": Forget(a[2]); r = "true"; break;
        default: r = Q("unknown command"); break;
      }
    } catch (Exception e) { r = Q("error: " + e.Message); }
    return a[0] + " " + r;
  }
}
`

/**
 * The host's loop: one request per line ("<n> <command> <job> [pid]"), one reply per line ("<n> <JSON>"), all in the
 * C#. No cmdlet but Add-Type, so PowerShell loads no other module (and writes no module cache, which goes into the
 * working folder when LOCALAPPDATA is unset).
 */
const HOST_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition @'
${HOST_SOURCE}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([HiveJobs]::Answer($line)) }
`

interface JobList {
  total: number
  processes: { pid: number; name: string; cmd: string }[]
}

/** The one PowerShell holding the jobs, started on first use; null once it couldn't start (nothing is tracked then). */
class JobHost {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<boolean> | null = null
  private next = 1
  private waiting = new Map<number, (reply: unknown) => void>()
  private failed = false

  /** False once the host couldn't start: then nothing is tracked, and launches aren't held for it. */
  get usable(): boolean {
    return !this.failed
  }

  /** Starts the host if it isn't running: whether it runs. */
  async ensure(): Promise<boolean> {
    return !this.failed && (await this.start())
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready
    // Test copies (unpackaged): HIVE_TEST_PROCESS_TRACKER=fail acts out a PC where PowerShell refuses the helper.
    if (!app.isPackaged && process.env.HIVE_TEST_PROCESS_TRACKER === 'fail') {
      problem = 'PowerShell refused to run its helper (HIVE_TEST_PROCESS_TRACKER)'
      this.failed = true
      return Promise.resolve(false)
    }
    this.ready = new Promise<boolean>((resolve) => {
      let up = false
      let p: ChildProcessWithoutNullStreams
      try {
        // Test copies: HIVE_TEST_PROCESS_TRACKER=silent acts out a helper that starts but never says it is ready.
        const silent = !app.isPackaged && process.env.HIVE_TEST_PROCESS_TRACKER === 'silent'
        const script = Buffer.from(silent ? '[System.Threading.Thread]::Sleep(-1)' : HOST_SCRIPT, 'utf16le').toString('base64')
        // In the temp folder: nothing it might write lands in whatever folder Hive was started from.
        p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { windowsHide: true, stdio: 'pipe', cwd: tmpdir() })
      } catch (e) {
        log.warn('could not start the process job host: agents\u2019 leftover processes are not tracked', e)
        problem = `PowerShell couldn't be started (${(e as Error).message})`
        this.failed = true
        return resolve(false)
      }
      this.proc = p
      // A helper that doesn't say it is ready in time is taken for broken, for the rest of this run: launches go on
      // untracked (decision B), rather than waiting for it.
      const readyBy = setTimeout(() => {
        if (up || this.proc !== p) return
        this.proc = null
        this.ready = null
        p.kill()
        log.warn(`the process job host didn't start within ${Math.round(waitMs() / 1000)} s: agents\u2019 leftover processes are not tracked`)
        problem = `its PowerShell helper didn't start within ${Math.round(waitMs() / 1000)} s`
        this.failed = true
        resolve(false)
      }, waitMs())
      let buf = ''
      let err = ''
      p.stdout.setEncoding('utf8')
      p.stderr.setEncoding('utf8')
      p.stderr.on('data', (d: string) => (err = (err + d).slice(-2000)))
      p.stdout.on('data', (d: string) => {
        buf += d
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!up && line === 'ready') {
            up = true
            clearTimeout(readyBy)
            resolve(true)
            continue
          }
          const sp = line.indexOf(' ')
          const n = Number(line.slice(0, sp))
          const done = this.waiting.get(n)
          if (!done) continue
          this.waiting.delete(n)
          try {
            done(JSON.parse(line.slice(sp + 1)))
          } catch {
            done(null)
          }
        }
      })
      const ended = (why: string): void => {
        clearTimeout(readyBy)
        if (this.proc !== p) return
        this.proc = null
        this.ready = null
        for (const done of this.waiting.values()) done(null)
        this.waiting.clear()
        if (!up) {
          log.warn(`the process job host didn't start (${why}): agents\u2019 leftover processes are not tracked. ${err.trim().slice(0, 300)}`)
          problem = /language mode|ConstrainedLanguage|Add-Type/i.test(err) ? 'PowerShell refused to run its helper (Constrained Language Mode or a policy)' : `its PowerShell helper didn't start (${why})`
          this.failed = true
          resolve(false)
        } else {
          // Its jobs went with it: what they held is no longer tracked (and keeps running).
          log.warn(`the process job host ended (${why})`)
          jobsLost(why)
        }
      }
      p.on('error', (e) => ended(e.message))
      p.on('exit', (code) => ended(`exit ${code}`))
      p.stdin.on('error', () => undefined)
    })
    return this.ready
  }

  /**
   * One request's reply (null: no host, or none). Starting the host is bounded by its own wait (start); once it runs,
   * a reply that doesn't come within waitMs() means it is stuck: it is closed, its jobs lost (jobsLost), and the next
   * request starts a new one. So nothing (a launch, End, quitting) waits on it for longer.
   */
  async request(command: 'add' | 'list' | 'kill' | 'forget', job: string, pid?: number): Promise<unknown> {
    if (this.failed || !/^[\w-]+$/.test(job)) return null
    if (!(await this.start()) || !this.proc) return null
    const p = this.proc
    const n = this.next++
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<unknown>((resolve) => {
      this.waiting.set(n, resolve)
      timer = setTimeout(() => {
        if (!this.waiting.delete(n)) return
        resolve(null)
        log.warn(`the process job host didn't answer within ${Math.round(waitMs() / 1000)} s (${command}): closing it`)
        if (this.proc === p) p.kill()
      }, waitMs())
    })
    p.stdin.write(`${n} ${command} ${job}${pid ? ` ${pid}` : ''}\n`)
    try {
      return await reply
    } finally {
      clearTimeout(timer)
    }
  }

  /** The helper's process id while it runs (tests: to end it as a crash would). */
  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  /** Closes the host (Hive quitting): its jobs close without ending anything. */
  close(): void {
    const p = this.proc
    this.proc = null
    this.ready = null
    try {
      p?.stdin.end()
    } catch {
      // Already gone.
    }
  }
}

const host = new JobHost()

/** A launch whose processes are tracked: its job is named by its run id. */
interface Launch {
  runId: string
  projectPath: string
  agentId: string
  agentName: string
}

/** Launches whose CLI is still running (or exited and being looked at). */
const running = new Map<string, Launch>()
/** What stopped launches left running, per launch, newest last. */
const left = new Map<string, Launch & { processes: AgentProcess[]; more: number; since: string }>()
let poll: ReturnType<typeof setInterval> | null = null

const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}\n${agentId}`

/** Whether a launch's processes are tracked, and if not, why. */
export type TrackResult = { tracked: true } | { tracked: false; reason: string }

/**
 * Puts a launch's terminal process (its gate, launchGate.ts) in the launch's job, so everything it starts is tracked.
 * Resolves once it is, or with why not. `cancelled` aborted meanwhile (the terminal exited): the job is let go, so
 * nothing is assigned to it after.
 */
export async function trackLaunch(launch: Launch, pid: number, cancelled?: AbortSignal): Promise<TrackResult> {
  if (process.platform !== 'win32') return { tracked: false, reason: 'tracking processes needs Windows' }
  running.set(launch.runId, launch)
  const r = await host.request('add', launch.runId, pid)
  if (r === 'ok' && !cancelled?.aborted) {
    if (host.usable) problem = null
    return { tracked: true }
  }
  if (r === 'ok') {
    running.delete(launch.runId)
    void host.request('forget', launch.runId)
    return { tracked: false, reason: 'it was stopped before it started' }
  }
  const reason = r === null ? (host.usable ? `Hive's process tracker didn't answer` : (problem ?? `Hive's process tracker couldn't start`)) : String(r)
  log.warn(`could not track the processes of ${userText(launch.agentName)}: ${reason}`)
  problem = reason
  return { tracked: false, reason }
}

/**
 * The launch's CLI has exited: what is still running in its job a moment later is what it left. Resolves with it once
 * known (none: the job is forgotten).
 */
export function launchEnded(runId: string): Promise<AgentLeftovers | null> {
  const p = findLeftovers(runId)
  settling.add(p)
  void p.finally(() => settling.delete(p))
  return p
}

/** Launches being looked at as their CLIs exit (launchEnded). */
const settling = new Set<Promise<unknown>>()

/** Once every launch that has exited has been looked at (Hive quitting asks about all their leftovers at once). */
export async function leftoversSettled(): Promise<void> {
  while (settling.size) await Promise.allSettled([...settling])
}

async function findLeftovers(runId: string): Promise<AgentLeftovers | null> {
  const launch = running.get(runId)
  if (!launch) return null
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  running.delete(runId)
  const list = await listJob(runId)
  if (!list || !list.processes.length) {
    void host.request('forget', runId)
    return null
  }
  left.set(runId, { ...launch, processes: list.processes, more: list.more, since: new Date().toISOString() })
  log.info(`${userText(launch.agentName)} left ${list.processes.length + list.more} process(es) running: ${userText(list.processes.map((p) => p.label).join('; '))}`)
  bound(launch)
  startPolling()
  const now = leftoversOf(launch.projectPath, launch.agentId)
  emit({ type: 'agent-leftovers', leftovers: now })
  return now
}

async function listJob(runId: string): Promise<{ processes: AgentProcess[]; more: number } | null> {
  const r = (await host.request('list', runId)) as JobList | string | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.processes)) return null
  const processes = r.processes
    // A console window's host belongs to a process of the job and ends with it: not one to list.
    .filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name))
    .map((p) => ({ pid: p.pid, name: p.name, label: processLabel(p.name, p.cmd) }))
    .sort((a, b) => a.pid - b.pid)
    .slice(0, MAX_LISTED)
  const hosts = r.processes.length - r.processes.filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name)).length
  return { processes, more: Math.max(0, r.total - hosts - processes.length) }
}

/** Keeps the newest launches' leftovers within the bounds, forgetting (not ending) the oldest. */
function bound(launch: Launch): void {
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === agentKey(launch.projectPath, launch.agentId))
  const over = [...mine.slice(0, Math.max(0, mine.length - MAX_JOBS_PER_AGENT)), ...[...left.values()].slice(0, Math.max(0, left.size - MAX_JOBS))]
  for (const l of over) {
    left.delete(l.runId)
    void host.request('forget', l.runId)
  }
}

function startPolling(): void {
  if (poll) return
  poll = setInterval(() => void refresh(), POLL_MS)
  poll.unref?.()
}

/** Looks at every launch's leftovers again: those that have ended by themselves go from the list. */
async function refresh(): Promise<void> {
  const changed = new Set<string>()
  for (const l of [...left.values()]) {
    const list = await listJob(l.runId)
    if (!left.has(l.runId)) continue
    if (list && !list.processes.length) {
      left.delete(l.runId)
      void host.request('forget', l.runId)
      changed.add(agentKey(l.projectPath, l.agentId))
    } else if (list && (list.processes.length !== l.processes.length || list.more !== l.more || list.processes.some((p, i) => p.pid !== l.processes[i]?.pid))) {
      left.set(l.runId, { ...l, processes: list.processes, more: list.more })
      changed.add(agentKey(l.projectPath, l.agentId))
    }
  }
  for (const k of changed) {
    const [projectPath, agentId] = k.split('\n')
    const first = [...left.values()].find((l) => agentKey(l.projectPath, l.agentId) === k)
    emit({ type: 'agent-leftovers', leftovers: first ? leftoversOf(first.projectPath, first.agentId) : { projectPath, agentId, agentName: '', processes: [], more: 0, since: '' } })
  }
  if (!left.size && poll) {
    clearInterval(poll)
    poll = null
  }
}

/** What an agent's stopped launches left running (empty processes when nothing). */
export function leftoversOf(projectPath: string, agentId: string): AgentLeftovers {
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === agentKey(projectPath, agentId))
  const last = mine.at(-1)
  return {
    projectPath: last?.projectPath ?? projectPath,
    agentId,
    agentName: last?.agentName ?? '',
    processes: mine.flatMap((l) => l.processes),
    more: mine.reduce((n, l) => n + l.more, 0),
    since: mine[0]?.since ?? ''
  }
}

/** Every agent with leftovers, optionally only those whose project `which` accepts. */
export function allLeftovers(which: (projectPath: string) => boolean = () => true): AgentLeftovers[] {
  const keys = new Map<string, Launch>()
  for (const l of left.values()) if (which(l.projectPath)) keys.set(agentKey(l.projectPath, l.agentId), l)
  return [...keys.values()].map((l) => leftoversOf(l.projectPath, l.agentId))
}

/**
 * Ends what an agent's stopped launches left running (their jobs, so only processes they started), or keeps it
 * running and stops listing it. Resolves with how many processes were ended or kept. A launch whose processes
 * couldn't be ended stays listed (to try again, or keep), and the call then fails, saying so.
 */
export async function settleLeftovers(projectPath: string, agentId: string, how: 'end' | 'keep'): Promise<number> {
  const k = agentKey(projectPath, agentId)
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === k)
  if (!mine.length) return 0
  let done = 0
  let failed = 0
  for (const l of mine) {
    if (how === 'end' && (killFailsForTests() || (await host.request('kill', l.runId)) !== true)) {
      failed += l.processes.length + l.more
      continue
    }
    left.delete(l.runId)
    void host.request('forget', l.runId)
    done += l.processes.length + l.more
  }
  const name = mine[0].agentName
  if (done) log.info(`${how === 'end' ? 'ended' : 'kept'} ${done} process(es) ${userText(name)} left running`)
  emit({ type: 'agent-leftovers', leftovers: leftoversOf(mine[0].projectPath, agentId) })
  if (failed) {
    log.warn(`could not end ${failed} process(es) ${userText(name)} left running`)
    throw new Error(`${processCount(failed)} ${failed === 1 ? 'is' : 'are'} still running: Windows didn't let Hive end ${failed === 1 ? 'it' : 'them'}. ${failed === 1 ? 'It stays' : 'They stay'} listed in the agent's pane header, to try again or keep.`)
  }
  return done
}

/** Ends or keeps every agent's leftovers (Hive quitting): those that can't be ended keep running. */
export async function settleAllLeftovers(how: 'end' | 'keep'): Promise<number> {
  let n = 0
  for (const l of allLeftovers()) n += await settleLeftovers(l.projectPath, l.agentId, how).catch(() => 0)
  return n
}

/** Test copies (unpackaged): HIVE_TEST_JOB_KILL_FAILS=1 makes ending a launch's processes fail, as Windows refusing would. */
const killFailsForTests = (): boolean => !app.isPackaged && process.env.HIVE_TEST_JOB_KILL_FAILS === '1'

/** Why launches can't be tracked (the host couldn't start), or why the latest one wasn't; null while all is well. */
let problem: string | null = null

/**
 * Whether launches can be tracked now: on Windows, with the job host running (started here if it isn't). A launch
 * waits for this, so it knows whether to go through its gate (launchGate.ts) or start directly, untracked.
 */
export async function trackingReady(): Promise<boolean> {
  return process.platform === 'win32' && (await host.ensure())
}

/** Why agents' processes aren't being tracked, for the notice and Diagnostics; null when they are. */
export function trackingProblem(): string | null {
  return process.platform !== 'win32' ? null : problem
}

/** Hive is quitting: the host closes, and its jobs with it, ending nothing. */
export function closeProcessTracking(): void {
  if (poll) clearInterval(poll)
  poll = null
  host.close()
}

/**
 * The host ended unexpectedly: its jobs closed, so their processes can't be told apart any more. Said at once (the
 * once-a-run notice) and kept for Diagnostics, even once a new host tracks later launches: running agents' processes
 * and what was listed as left running are no longer tracked (and keep running; nothing is ended).
 */
function jobsLost(why: string): void {
  const agents = allLeftovers()
  const listed = agents.reduce((n, a) => n + a.processes.length + a.more, 0)
  const launches = running.size
  running.clear()
  left.clear()
  for (const a of agents) emit({ type: 'agent-leftovers', leftovers: { ...a, processes: [], more: 0 } })
  lost = `the process tracker stopped at ${new Date().toISOString()} (${why}): ${launches} running launch(es) and ${listed} listed process(es) were no longer tracked`
  noteUntracked(`Hive's process tracker stopped (${why})`, `${listed ? `${processCount(listed)} listed as left running ${listed === 1 ? 'is' : 'are'} no longer tracked (still running), nor is ` : 'What '}${launches ? `what the ${launches === 1 ? 'running agent starts' : `${launches} running agents start`}` : 'running agents start'} until ${launches === 1 ? 'it restarts' : 'they restart'}.`)
}

/** Diagnostics: the tracker stopped earlier in this run, losing what it held; null if it never did. */
let lost: string | null = null

/** The once-a-run notice that agents' processes aren't (all) tracked has been shown. */
let told = false

/**
 * Agents' processes can't be tracked, or some no longer are (#507): said once a Hive run, in a notification, and in
 * Diagnostics (trackingProblem, trackingLost). Agents start and run all the same (decision B).
 */
export function noteUntracked(reason: string | null, detail?: string): void {
  if (told) return
  told = true
  log.warn(`agents' processes aren't tracked: ${userText(reason ?? 'unknown')}`)
  toast(
    'warning',
    "Hive can't keep track of agents' processes",
    `${reason ?? "Its process tracker isn't available"}. ${detail ?? "Agents start as usual, but processes they leave running when they stop aren't listed or offered to end."} Help → Copy Diagnostics says why.`
  )
}

/** Diagnostics: what the tracker lost earlier in this run when it stopped, or null. */
export function trackingLost(): string | null {
  return lost
}

/** Tests: the helper's process id while it runs. */
export function trackerPid(): number | null {
  return host.pid
}
