import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { emit, toast } from './events'
import { readJson, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { POWERSHELL } from './launchGate'
import { hiveError } from './hiveError'
import { processLabel, type AgentLeftovers, type AgentProcess } from '../shared/agentProcesses'
import { englishText, shownText, withValues, type TextPart } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'

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
 *
 * What is listed is also kept in Hive's profile (leftovers.json, #614), each process by its id and start time: a quit
 * that doesn't ask (no window shown, or to install an update) or a crash leaves it there, and the next start lists again
 * those still running as the same processes (restoreLeftovers), to end by that identity (their jobs are gone by then).
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
/** How often the host adopts what escaped its jobs (Sweep, #543), while it holds any; listing and ending sweep first. */
const SWEEP_MS = 1000
/** How long the host gathers the exits of a job's processes before sweeping for what they left outside (Listen). */
const EXIT_BATCH_MS = 250

// Raw: the C# keeps its backslashes. Exported for the unit tests, which drive it with stale process identities.
export const HOST_SOURCE = String.raw`
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr proc, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
  [DllImport("kernel32.dll")] static extern void GetSystemTimeAsFileTime(out long now);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr proc, ref int len, StringBuilder name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry e);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry e);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr detail, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref PortInfo info, int len);
  [StructLayout(LayoutKind.Sequential)] struct PortInfo { public IntPtr key; public IntPtr port; }
  static Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  /** Processes each job adopted (Sweep), for the log. */
  static Dictionary<string, int> adopted = new Dictionary<string, int>();
  /** Requests (the main thread), the port's thread and the timer's take turns. */
  static readonly object turn = new object();
  static System.Threading.Timer sweeper;
  /** Every job reports to one port: a process joining it, and one ending (each job by its key). */
  static IntPtr port = IntPtr.Zero;
  static Dictionary<ulong, string> byKey = new Dictionary<ulong, string>();
  static ulong nextKey = 1;
  class Held { public string job; public IntPtr h; public long created; }
  /**
   * The jobs' processes, each held open from joining until it ends: while held, its id can't name another process, and
   * its start time can be read after it has exited, when its escaped children are adopted.
   */
  static Dictionary<int, Held> held = new Dictionary<int, Held>();
  /**
   * Escaped processes that aren't put in their parent's job, being in a job already (the Store's PowerShell is in its
   * package's, #659) or a packaged app's, which Windows puts in its package's job as it starts (#678): followed instead,
   * held open, listed and ended with the job, and their own escaped children taken in as they are found.
   */
  static Dictionary<int, Held> followed = new Dictionary<int, Held>();
  /**
   * Adopts what escaped the jobs (#543): a packaged app's process (the Microsoft Store's PowerShell 7) starts its
   * children outside every job, so they would neither be listed nor ended. Each live process whose parent is in a job
   * (running, or held as it ends), that is itself not in that job, joins it if it is in no job and isn't a packaged
   * app's (its own children join by themselves from then on), or is followed (Take); those it started before are found
   * in the same sweep. The parent must have started before the child: a parent id not held could name a later process
   * that took a dead parent's id.
   * Swept as each process of a job ends (so a shell that starts something and exits at once is caught), before listing
   * or ending a job, and every ${SWEEP_MS} ms (for an escaped child's own children).
   */
  public static int Sweep() {
    lock (turn) {
      if (jobs.Count == 0) return 0;
      var parents = new Dictionary<int, int>();
      // Taken before the snapshot: a process created after it can't be one the snapshot saw.
      long at; GetSystemTimeAsFileTime(out at);
      // TH32CS_SNAPPROCESS
      IntPtr snap = CreateToolhelp32Snapshot(2, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try {
        var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) if (e.pid != 0) parents[(int)e.pid] = (int)e.parent;
      } finally { CloseHandle(snap); }
      var owner = new Dictionary<int, string>();
      foreach (var j in jobs) foreach (int pid in List(j.Key)) owner[pid] = j.Key;
      foreach (var h in held) if (jobs.ContainsKey(h.Value.job)) owner[h.Key] = h.Value.job;
      foreach (var f in followed) if (jobs.ContainsKey(f.Value.job)) owner[f.Key] = f.Value.job;
      var tried = new HashSet<int>();
      int n = 0;
      for (bool found = true; found; ) {
        found = false;
        foreach (var kv in parents) {
          string id;
          if (owner.ContainsKey(kv.Key) || tried.Contains(kv.Key) || !owner.TryGetValue(kv.Value, out id)) continue;
          tried.Add(kv.Key);
          if (!Take(id, kv.Key, kv.Value, at)) continue;
          owner[kv.Key] = id;
          int c; adopted.TryGetValue(id, out c); adopted[id] = c + 1;
          n++;
          found = true;
        }
      }
      // Followed processes that have ended: their children were looked at above, while their ids were still held.
      foreach (int pid in new List<int>(followed.Keys)) {
        uint code;
        if (GetExitCodeProcess(followed[pid].h, out code) && code == 259) continue;
        CloseHandle(followed[pid].h);
        followed.Remove(pid);
      }
      return n;
    }
  }
  /**
   * Takes an escaped process into job id: adopted into it if it is in no job, else followed. pid and parent are as a
   * snapshot taken at time "at" saw them: an id may name another process by now, so a process opened by it (the
   * candidate, or a parent not held) that was created after the snapshot isn't the one it saw (#543). Public for the
   * unit tests, which hand it stale identities.
   */
  public static bool Take(string id, int pid, int parent, long at) {
    lock (turn) {
      IntPtr job;
      if (!jobs.TryGetValue(id, out job)) return false;
      // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
      IntPtr c = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);
      if (c == IntPtr.Zero) return false;
      bool keep = false;
      try {
        bool inJob, inAny; uint code; long cc, pc, x, k, u;
        if (!IsProcessInJob(c, job, out inJob) || inJob) return false;
        if (!GetExitCodeProcess(c, out code) || code != 259) return false;
        if (!GetProcessTimes(c, out cc, out x, out k, out u) || cc > at) return false;
        if (!Started(parent, at, out pc) || pc > cc) return false;
        // Only a process in no job joins: one in another job is followed (#659). Windows would nest the jobs: the Store's
        // PowerShell's is its package's, which every Store PowerShell started later joins, and when it had no parent it
        // became this launch's, so the next ones (any agent's or app's) were listed and ended with this launch. A packaged
        // app's process is followed even in no job: Windows puts it in its package's job only once it has started (a few
        // ms, more under load), and one assigned before then nests that job in this one just the same (#678).
        if (!IsProcessInJob(c, IntPtr.Zero, out inAny)) return false;
        if (!inAny && !Packaged(c) && AssignProcessToJobObject(job, c)) return true;
        followed[pid] = new Held { job = id, h = c, created = cc };
        keep = true;
        return true;
      } finally { if (!keep) CloseHandle(c); }
    }
  }
  /** Whether a process is a packaged app's (has a package identity); one that can't be told counts as packaged. */
  static bool Packaged(IntPtr proc) {
    int len = 0;
    // APPMODEL_ERROR_NO_PACKAGE
    return GetPackageFullName(proc, ref len, null) != 15700;
  }
  /** When a job's process started: held (its id kept), or looked up now, if created before "at". */
  static bool Started(int pid, long at, out long created) {
    Held h;
    if (held.TryGetValue(pid, out h) || followed.TryGetValue(pid, out h)) { created = h.created; return true; }
    created = 0;
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return false;
    long x, k, u;
    try { return GetProcessTimes(p, out created, out x, out k, out u) && created <= at; } finally { CloseHandle(p); }
  }
  /**
   * Holds a process the port says joined job id, if it is in that job: a notification read late may carry an id that
   * names another process by now (#543). Public for the unit tests.
   */
  public static bool Hold(string id, int pid) {
    lock (turn) {
      IntPtr job;
      if (held.ContainsKey(pid) || !jobs.TryGetValue(id, out job)) return false;
      // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION: Settle asks whether it has exited.
      IntPtr h = OpenProcess(0x100000 | 0x1000, false, pid);
      if (h == IntPtr.Zero) return false;
      bool inJob; long created, x, k, u;
      if (IsProcessInJob(h, job, out inJob) && inJob && GetProcessTimes(h, out created, out x, out k, out u)) {
        held[pid] = new Held { job = id, h = h, created = created };
        return true;
      }
      CloseHandle(h);
      return false;
    }
  }
  /** Follows pid in job id with a handle of the given access (the unit tests: one that can't end it). */
  public static bool Follow(string id, int pid, uint access) {
    lock (turn) {
      IntPtr h = OpenProcess(access | 0x1000, false, pid);
      long created, x, k, u;
      if (h == IntPtr.Zero || !jobs.ContainsKey(id) || !GetProcessTimes(h, out created, out x, out k, out u)) { if (h != IntPtr.Zero) CloseHandle(h); return false; }
      followed[pid] = new Held { job = id, h = h, created = created };
      return true;
    }
  }
  public static bool IsHeld(int pid) { lock (turn) return held.ContainsKey(pid); }
  public static bool IsFollowed(int pid) { lock (turn) return followed.ContainsKey(pid); }
  /** When pid started (FILETIME), while it runs; 0 when it doesn't (gone, exited) or can't be read. */
  public static long CreatedOf(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return 0;
    try { uint code; long c, x, k, u; return GetExitCodeProcess(p, out code) && code == 259 && GetProcessTimes(p, out c, out x, out k, out u) ? c : 0; } finally { CloseHandle(p); }
  }
  /** "pid:created,…" as pairs; malformed entries are left out. */
  static List<KeyValuePair<int, long>> Pairs(string list) {
    var r = new List<KeyValuePair<int, long>>();
    foreach (string e in list.Split(',')) {
      string[] pc = e.Split(':'); int pid; long created;
      if (pc.Length == 2 && int.TryParse(pc[0], out pid) && long.TryParse(pc[1], out created) && pid > 0 && created > 0) r.Add(new KeyValuePair<int, long>(pid, created));
    }
    return r;
  }
  /**
   * Processes kept from before Hive restarted, by id and start time ("pid:created,…", #614): those still running as
   * the same process, as JSON ["pid:created", …]: an identity is the pair, never the id alone. An id that names
   * another process by now (another start time) is left out.
   */
  public static string Identify(string list) {
    var b = new StringBuilder("[");
    bool first = true;
    foreach (var p in Pairs(list)) {
      if (CreatedOf(p.Key) != p.Value) continue;
      b.Append(first ? "" : ",").Append('"').Append(p.Key).Append(':').Append(p.Value).Append('"');
      first = false;
    }
    return b.Append(']').ToString();
  }
  /**
   * Ends processes by id and start time ("pid:created,…", #614), each only while it is still that process: one gone, or
   * whose id names another process by now, counts as ended. JSON {"ended":n,"failed":n}: those failed still run.
   */
  public static string EndExact(string list) {
    int ended = 0, failed = 0;
    foreach (var e in Pairs(list)) {
      // PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
      IntPtr p = OpenProcess(0x0001 | 0x100000 | 0x1000, false, e.Key);
      if (p == IntPtr.Zero) {
        // ERROR_INVALID_PARAMETER: no process has the id. Anything else: one does, and Windows won't let Hive end it.
        if (Marshal.GetLastWin32Error() == 87) ended++; else failed++;
        continue;
      }
      try {
        uint code; long c, x, k, u;
        if (!GetProcessTimes(p, out c, out x, out k, out u) || c != e.Value || !GetExitCodeProcess(p, out code) || code != 259) { ended++; continue; }
        if (TerminateProcess(p, 1) && WaitForSingleObject(p, 2000) == 0) ended++; else failed++;
      } finally { CloseHandle(p); }
    }
    return "{\"ended\":" + ended + ",\"failed\":" + failed + "}";
  }
  /** Exits gathered for the next Settle: each pid with the entry held for it as its exit was read (null: none). */
  static List<KeyValuePair<int, Held>> exits = new List<KeyValuePair<int, Held>>();
  /** When the gathered exits are settled (on clock), ${EXIT_BATCH_MS} ms after the first of them. */
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  static long due = 0;
  /**
   * A notification from the port for job id: a process joining is held, one ending is gathered for the next Settle with
   * the entry its job held for it then. Public for the unit tests, which give the events in an order of their own (#604).
   */
  public static void Notify(string id, uint message, int pid) {
    lock (turn) {
      // JOB_OBJECT_MSG_NEW_PROCESS
      if (message == 6) { Hold(id, pid); return; }
      // JOB_OBJECT_MSG_EXIT_PROCESS, JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS
      if (message != 7 && message != 8) return;
      Held h;
      if (!held.TryGetValue(pid, out h) || h.job != id) h = null;
      if (exits.Count == 0) due = clock.ElapsedMilliseconds + ${EXIT_BATCH_MS};
      exits.Add(new KeyValuePair<int, Held>(pid, h));
    }
  }
  /**
   * Sweeps for what the gathered exits left outside, then lets go of what was held for them. Only the entry held as an
   * exit was read, and only once its process has exited (#604): its job forgotten meanwhile, the id is free, and may
   * name another job's process by now, held under the same id; and a late join may have held, by an id already free
   * again, another process of the same job, which still runs. Either way that entry is another process's, let go at its
   * own exit. Public for the unit tests.
   */
  public static void Settle() {
    lock (turn) {
      try {
        Sweep();
        foreach (var e in exits) {
          Held h;
          if (e.Value == null || !held.TryGetValue(e.Key, out h) || !ReferenceEquals(h, e.Value) || WaitForSingleObject(h.h, 0) != 0) continue;
          CloseHandle(h.h);
          held.Remove(e.Key);
        }
      } finally { exits.Clear(); }
    }
  }
  /** The job holding pid (Hold), or null. Public for the unit tests. */
  public static string HeldBy(int pid) { lock (turn) { Held h; return held.TryGetValue(pid, out h) ? h.job : null; } }
  /**
   * The port's thread: holds each process as it joins a job. Those that end are swept for together, at most
   * ${EXIT_BATCH_MS} ms after the first of them (a build ends hundreds of processes, and a sweep's snapshot of every
   * process costs a few ms), adopting what they left outside; then they are let go.
   */
  static void Listen() {
    for (;;) {
      bool waiting; long left;
      lock (turn) { waiting = exits.Count > 0; left = due - clock.ElapsedMilliseconds; }
      if (waiting && left <= 0) {
        try { Settle(); } catch { }
        continue;
      }
      uint message; UIntPtr key; IntPtr detail;
      if (!GetQueuedCompletionStatus(port, out message, out key, out detail, waiting ? (uint)left : 0xFFFFFFFF)) continue;
      int pid = (int)detail.ToInt64();
      try {
        lock (turn) {
          string id;
          if (byKey.TryGetValue(key.ToUInt64(), out id)) Notify(id, message, pid);
        }
      } catch { }
    }
  }
  public static string Add(string id, int pid) {
    if (sweeper == null) sweeper = new System.Threading.Timer(_ => { try { Sweep(); } catch { } }, null, ${SWEEP_MS}, ${SWEEP_MS});
    if (port == IntPtr.Zero) {
      port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
      if (port != IntPtr.Zero) new System.Threading.Thread(Listen) { IsBackground = true }.Start();
    }
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) {
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
      if (job == IntPtr.Zero) return "create failed: " + Marshal.GetLastWin32Error();
      jobs[id] = job;
      // JobObjectAssociateCompletionPortInformation: without it, escaped children are still adopted by the sweeps.
      if (port != IntPtr.Zero) {
        ulong k = nextKey++;
        var info = new PortInfo { key = new IntPtr((long)k), port = port };
        if (SetInformationJobObject(job, 7, ref info, Marshal.SizeOf(typeof(PortInfo)))) byKey[k] = id;
      }
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
  /**
   * Ends the job's processes and the ones it follows. False when any still runs (a followed one Windows wouldn't end
   * stays followed and listed, so End can be tried again); one already gone counts as ended.
   */
  public static bool Kill(string id) {
    IntPtr job;
    Sweep();
    if (!jobs.TryGetValue(id, out job) || !TerminateJobObject(job, 1)) return false;
    bool all = true;
    foreach (var f in followed) {
      uint code;
      if (f.Value.job != id || TerminateProcess(f.Value.h, 1)) continue;
      if (!GetExitCodeProcess(f.Value.h, out code) || code == 259) all = false;
    }
    return all;
  }
  public static void Forget(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return;
    CloseHandle(job);
    jobs.Remove(id);
    adopted.Remove(id);
    foreach (var k in new List<ulong>(byKey.Keys)) if (byKey[k] == id) byKey.Remove(k);
    foreach (var pid in new List<int>(held.Keys)) if (held[pid].job == id) { CloseHandle(held[pid].h); held.Remove(pid); }
    foreach (var pid in new List<int>(followed.Keys)) if (followed[pid].job == id) { CloseHandle(followed[pid].h); followed.Remove(pid); }
  }
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
  /** The job's processes and the running ones it follows. */
  public static int[] Members(string id) {
    lock (turn) {
      var members = new List<int>(List(id));
      foreach (var f in followed) { uint code; if (f.Value.job == id && GetExitCodeProcess(f.Value.h, out code) && code == 259) members.Add(f.Key); }
      return members.ToArray();
    }
  }
  public static string Describe(string id, int max) {
    Sweep();
    int[] all = Members(id);
    int took; adopted.TryGetValue(id, out took);
    var b = new StringBuilder("{\"total\":" + all.Length + ",\"adopted\":" + took + ",\"processes\":[");
    if (all.Length > 0) {
      var where = new StringBuilder();
      for (int i = 0; i < all.Length && i < max; i++) where.Append(i > 0 ? " OR " : "").Append("ProcessId=").Append(all[i]);
      bool first = true;
      using (var q = new ManagementObjectSearcher("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE " + where))
        foreach (ManagementObject p in q.Get()) {
          b.Append(first ? "" : ",").Append("{\"pid\":").Append(Convert.ToInt32(p["ProcessId"])).Append(",\"name\":").Append(Q((string)p["Name"])).Append(",\"cmd\":").Append(Q((string)p["CommandLine"])).Append(",\"created\":\"").Append(CreatedOf(Convert.ToInt32(p["ProcessId"]))).Append("\"}");
          first = false;
        }
    }
    return b.Append("]}").ToString();
  }
  /** The memory each job's processes use now (working sets, as Task Manager counts them), for "job,job,…": a JSON array in the same order (#562). */
  public static string Memory(string ids) {
    var b = new StringBuilder("[");
    string[] list = ids.Split(',');
    for (int i = 0; i < list.Length; i++) {
      long bytes = 0;
      foreach (int pid in Members(list[i])) {
        try { using (var p = System.Diagnostics.Process.GetProcessById(pid)) bytes += p.WorkingSet64; } catch (Exception) { }
      }
      b.Append(i > 0 ? "," : "").Append(bytes);
    }
    return b.Append("]").ToString();
  }
  /** One request ("<n> <command> <job> [pid]") answered as "<n> <JSON>". */
  public static string Answer(string line) {
    string[] a = line.Split(' ');
    string r;
    try {
      lock (turn)
      switch (a.Length > 2 ? a[1] : "") {
        case "add": r = Q(Add(a[2], int.Parse(a[3]))); break;
        case "list": r = Describe(a[2], ${MAX_LISTED + 1}); break;
        case "kill": r = Kill(a[2]) ? "true" : "false"; break;
        case "forget": Forget(a[2]); r = "true"; break;
        case "identify": r = Identify(a[2]); break;
        case "endexact": r = EndExact(a[2]); break;
        case "memory": r = Memory(a[2]); break;
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
 * working folder when LOCALAPPDATA is unset). The C# comes first on its input, a line of base64 (HOST_INPUT): a command
 * line holds at most 32,767 characters, and -EncodedCommand doubles them and more.
 */
const HOST_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([HiveJobs]::Answer($line)) }
`
const HOST_INPUT = Buffer.from(HOST_SOURCE, 'utf8').toString('base64') + '\n'

interface JobList {
  total: number
  /** How many of its processes the host adopted after they escaped the job (Sweep, #543). */
  adopted?: number
  processes: { pid: number; name: string; cmd: string; created?: string }[]
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
      problem = 'PowerShell refused to run its helper (HIVE_TEST_PROCESS_TRACKER)' // i18n-ignore: test copies only
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
        problem = withValues(TRACKER.noPowerShell, { error: (e as Error).message })
        this.failed = true
        return resolve(false)
      }
      this.proc = p
      p.stdin.write(HOST_INPUT)
      // A helper that doesn't say it is ready in time is taken for broken, for the rest of this run: launches go on
      // untracked (decision B), rather than waiting for it.
      const readyBy = setTimeout(() => {
        if (up || this.proc !== p) return
        this.proc = null
        this.ready = null
        p.kill()
        log.warn(`the process job host didn't start within ${Math.round(waitMs() / 1000)} s: agents\u2019 leftover processes are not tracked`)
        problem = withValues(TRACKER.slowHelper, { seconds: Math.round(waitMs() / 1000) })
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
          problem = /language mode|ConstrainedLanguage|Add-Type/i.test(err) ? TRACKER.refused : withValues(TRACKER.helperFailed, { why })
          this.failed = true
          resolve(false)
        } else {
          // Its jobs went with it: what they held is no longer tracked (and keeps running).
          log.warn(`the process job host ended (${why})`)
          jobsLost(why)
        }
      }
      p.on('error', (e) => ended(e.message))
      p.on('exit', (code) => ended(`exit ${code}`)) // i18n-ignore: how the helper ended, a technical detail kept as it came (the log, Diagnostics)
      p.stdin.on('error', () => undefined)
    })
    return this.ready
  }

  /**
   * One request's reply (null: no host, or none). Starting the host is bounded by its own wait (start); once it runs,
   * a reply that doesn't come within waitMs() means it is stuck: it is closed, its jobs lost (jobsLost), and the next
   * request starts a new one. So nothing (a launch, End, quitting) waits on it for longer.
   */
  async request(command: 'add' | 'list' | 'kill' | 'forget' | 'identify' | 'endexact' | 'memory', job: string, pid?: number): Promise<unknown> {
    // A job's id, or (identify, endexact) a list of processes by id and start time: "pid:created,…", or (memory) of jobs: "job,job,…".
    if (this.failed || !/^[\w:,-]+$/.test(job)) return null
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
/**
 * What stopped launches left running, per launch, newest last. `restored`: kept from before Hive restarted (#614), with
 * no job: its processes are known by their ids and start times only.
 */
const left = new Map<string, Launch & { processes: AgentProcess[]; more: number; since: string; restored?: boolean }>()
let poll: ReturnType<typeof setInterval> | null = null

const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}\n${agentId}`

/** Why a launch doesn't start: stopped while it was being tracked (the launch gate prints it in English, launchGate.ts). */
export const STOPPED_BEFORE_START = 'it was stopped before it started' // i18n-ignore: the launch gate's reason, printed in the terminal by its script in English (CLI-facing)

/**
 * Whether a launch's processes are tracked, and if not, why: in English (`reason`, for the log and the launch gate) and as
 * text for the notice (`text`, when it isn't the English). Stopped meanwhile, it doesn't start (STOPPED_BEFORE_START).
 */
export type TrackResult = { tracked: true } | { tracked: false; reason: string; text?: TextPart }

/**
 * Puts a launch's terminal process (its gate, launchGate.ts) in the launch's job, so everything it starts is tracked.
 * Resolves once it is, or with why not. `cancelled` aborted meanwhile (the terminal exited): the job is let go, so
 * nothing is assigned to it after.
 */
export async function trackLaunch(launch: Launch, pid: number, cancelled?: AbortSignal): Promise<TrackResult> {
  if (process.platform !== 'win32') return { tracked: false, reason: englishText(TRACKER.windowsOnly), text: TRACKER.windowsOnly }
  running.set(launch.runId, launch)
  const r = await host.request('add', launch.runId, pid)
  if (r === 'ok' && !cancelled?.aborted) {
    if (host.usable) problem = null
    return { tracked: true }
  }
  if (r === 'ok') {
    running.delete(launch.runId)
    void host.request('forget', launch.runId)
    return { tracked: false, reason: STOPPED_BEFORE_START }
  }
  const text: TextPart = r === null ? (host.usable ? TRACKER.noAnswer : (problem ?? TRACKER.noStart)) : String(r)
  const reason = englishText(text)
  log.warn(`could not track the processes of ${userText(launch.agentName)}: ${reason}`)
  problem = text
  return { tracked: false, reason, text }
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

/**
 * The memory running agents take now (#562): each running launch's processes (its CLI and all it started), measured by
 * the job host. Null when it can't be told (no agent running, not Windows, the tracker not working).
 */
export async function agentsMemory(): Promise<{ agents: number; bytes: number } | null> {
  const ids = [...running.keys()]
  if (process.platform !== 'win32' || !ids.length || !host.usable) return null
  const r = await host.request('memory', ids.join(','))
  if (!Array.isArray(r)) return null
  const each = r.filter((n): n is number => typeof n === 'number' && n > 0)
  return each.length ? { agents: each.length, bytes: each.reduce((a, b) => a + b, 0) } : null
}

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
  log.info(`${userText(launch.agentName)} left ${list.processes.length + list.more} process(es) running: ${userText(list.processes.map((p) => p.label).join('; '))}${list.adopted ? ` (${list.adopted} adopted after leaving the job, #543)` : ''}`)
  bound(launch)
  // Kept once within the bounds, so the file never holds a launch just forgotten.
  persist()
  startPolling()
  const now = leftoversOf(launch.projectPath, launch.agentId)
  emit({ type: 'agent-leftovers', leftovers: now })
  return now
}

async function listJob(runId: string): Promise<{ processes: AgentProcess[]; more: number; adopted: number } | null> {
  const r = (await host.request('list', runId)) as JobList | string | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.processes)) return null
  const processes = r.processes
    // A console window's host belongs to a process of the job and ends with it: not one to list.
    .filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name))
    .map((p) => ({ pid: p.pid, name: p.name, label: processLabel(p.name, p.cmd), ...(p.created && p.created !== '0' ? { created: p.created } : {}) }))
    .sort((a, b) => a.pid - b.pid)
    .slice(0, MAX_LISTED)
  const hosts = r.processes.length - r.processes.filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name)).length
  return { processes, more: Math.max(0, r.total - hosts - processes.length), adopted: Number(r.adopted) || 0 }
}

/** Keeps the newest launches' leftovers within the bounds, forgetting (not ending) the oldest. */
function bound(launch: Launch): void {
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === agentKey(launch.projectPath, launch.agentId))
  const over = [...mine.slice(0, Math.max(0, mine.length - MAX_JOBS_PER_AGENT)), ...[...left.values()].slice(0, Math.max(0, left.size - MAX_JOBS))]
  for (const l of over) {
    left.delete(l.runId)
    if (!l.restored) void host.request('forget', l.runId)
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
    const list = l.restored ? await stillRunning(l.processes) : await listJob(l.runId)
    if (!left.has(l.runId)) continue
    if (list && !list.processes.length) {
      left.delete(l.runId)
      if (!l.restored) void host.request('forget', l.runId)
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
  if (changed.size) persist()
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
    if (how === 'end' && (killFailsForTests() || !(l.restored ? await endExactly(l.processes) : (await host.request('kill', l.runId)) === true))) {
      failed += l.processes.length + l.more
      continue
    }
    left.delete(l.runId)
    if (!l.restored) void host.request('forget', l.runId)
    done += l.processes.length + l.more
  }
  persist()
  const name = mine[0].agentName
  if (done) log.info(`${how === 'end' ? 'ended' : 'kept'} ${done} process(es) ${userText(name)} left running`)
  emit({ type: 'agent-leftovers', leftovers: leftoversOf(mine[0].projectPath, agentId) })
  if (failed) {
    log.warn(`could not end ${failed} process(es) ${userText(name)} left running`)
    throw hiveError(msg({ id: 'session.leftovers.notEnded', defaultMessage: "{n, plural, one {# process is still running: Windows didn't let Hive end it. It stays listed in the ⋯ menu on the agent's pane, to try again or keep.} other {# processes are still running: Windows didn't let Hive end them. They stay listed in the ⋯ menu on the agent's pane, to try again or keep.}}", description: "Ending the processes an agent left running failed. {n} is how many are still running; the ⋯ menu on the agent's pane lists them with End and Keep." }), { n: failed })
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
let problem: TextPart | null = null

/** Why agents' processes aren't tracked, as the notice says it (Diagnostics has the English). */
const TRACKER = {
  noPowerShell: msg({ id: 'session.tracker.noPowerShell', defaultMessage: "PowerShell couldn't be started ({error})", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {error} is Windows' error, as it came." }),
  slowHelper: msg({ id: 'session.tracker.slowHelper', defaultMessage: "The PowerShell helper of Hive's process tracker didn't start within {seconds, plural, one {# second} other {# seconds}}", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {seconds} is how many seconds Hive waited." }),
  refused: msg({ id: 'session.tracker.refused', defaultMessage: 'PowerShell refused to run its helper (Constrained Language Mode or a policy)', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). Constrained Language Mode is PowerShell's term." }),
  helperFailed: msg({ id: 'session.tracker.helperFailed', defaultMessage: "The PowerShell helper of Hive's process tracker didn't start ({why})", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." }),
  windowsOnly: msg({ id: 'session.tracker.windowsOnly', defaultMessage: 'Tracking processes needs Windows', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  noAnswer: msg({ id: 'session.tracker.noAnswer', defaultMessage: "Hive's process tracker didn't answer", description: "Why Hive couldn't track the processes an agent starts (a notice's first sentence, without its full stop)." }),
  noStart: msg({ id: 'session.tracker.noStart', defaultMessage: "Hive's process tracker couldn't start", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  stopped: msg({ id: 'session.tracker.stopped', defaultMessage: "Hive's process tracker stopped ({why})", description: "Why Hive no longer tracks the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." })
}

/**
 * Whether launches can be tracked now: on Windows, with the job host running (started here if it isn't). A launch
 * waits for this, so it knows whether to go through its gate (launchGate.ts) or start directly, untracked.
 */
export async function trackingReady(): Promise<boolean> {
  return process.platform === 'win32' && (await host.ensure())
}

/** Why agents' processes aren't being tracked, for Diagnostics (in English); null when they are. */
export function trackingProblem(): string | null {
  return process.platform !== 'win32' || problem === null ? null : englishText(problem)
}

/** The same as text, for the notice (noteUntracked). */
export function trackingProblemText(): TextPart | null {
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
 * are no longer tracked (and keep running; nothing is ended). What was listed as left running stays listed, and kept,
 * by identity (#614): each process whose start time is known is still told from a later one with its id, so the next
 * host (started by the next request) lists and ends exactly it, as after a restart; the rest can't be, and go.
 */
function jobsLost(why: string): void {
  const launches = running.size
  running.clear()
  let listed = 0
  const agents = new Map<string, { projectPath: string; agentId: string }>()
  for (const l of [...left.values()]) {
    if (l.restored) continue
    const known = l.processes.filter((p) => p.created)
    listed += l.processes.length - known.length + l.more
    agents.set(agentKey(l.projectPath, l.agentId), { projectPath: l.projectPath, agentId: l.agentId })
    if (known.length) left.set(l.runId, { ...l, processes: known, more: 0, restored: true })
    else left.delete(l.runId)
  }
  persist()
  for (const a of agents.values()) emit({ type: 'agent-leftovers', leftovers: leftoversOf(a.projectPath, a.agentId) })
  // i18n-ignore: Copy Diagnostics' report, in English (the design keeps diagnostics content English)
  lost = `the process tracker stopped at ${new Date().toISOString()} (${why}): ${launches} running launch(es) and ${listed} listed process(es) were no longer tracked`
  noteUntracked(withValues(TRACKER.stopped, { why }), listed ? withValues(LOST_LISTED, { listed, launches }) : withValues(LOST, { launches }))
}

/** What the tracker stopping leaves untracked: what running agents start, until they restart; and what was listed. */
const LOST = msg({ id: 'session.tracker.lost', defaultMessage: "{launches, plural, =0 {What agents start isn't tracked until they restart.} one {What the running agent starts isn't tracked until it restarts.} other {What the # running agents start isn't tracked until they restart.}}", description: "The notice after Hive's process tracker stopped: what is no longer tracked. {launches} is how many agents were running." })
const LOST_LISTED = msg({ id: 'session.tracker.lostListed', defaultMessage: "{listed, plural, one {# process listed as left running is no longer tracked (it is still running).} other {# processes listed as left running are no longer tracked (they are still running).}} {launches, plural, =0 {Nor is what agents start until they restart.} one {Nor is what the running agent starts until it restarts.} other {Nor is what the # running agents start until they restart.}}", description: "The notice after Hive's process tracker stopped: what is no longer tracked. {listed} is how many processes agents left running were listed in their panes; {launches} how many agents were running." })

/** Diagnostics: the tracker stopped earlier in this run, losing what it held; null if it never did. */
let lost: string | null = null

/** The once-a-run notice that agents' processes aren't (all) tracked has been shown. */
let told = false

/**
 * Agents' processes can't be tracked, or some no longer are (#507): said once a Hive run, in a notification, and in
 * Diagnostics (trackingProblem, trackingLost). Agents start and run all the same (decision B).
 */
export function noteUntracked(reason: TextPart | null, detail?: TextPart): void {
  if (told) return
  told = true
  log.warn(`agents' processes aren't tracked: ${userText(reason === null ? 'unknown' : englishText(reason))}`)
  toast(
    'warning',
    tr(msg({ id: 'session.tracker.title', defaultMessage: "Hive can't keep track of agents' processes", description: "A notice's title: Hive can't track the processes agents start, so those they leave running aren't listed." })),
    tr(msg({ id: 'session.tracker.body', defaultMessage: '{reason}. {detail} Help → Copy Diagnostics says why.', description: "The notice that Hive can't track agents' processes. {reason} says why (a clause, without its full stop); {detail} is one or two sentences on what that means. Help → Copy Diagnostics is a menu command." }), {
      reason: shownText(reason ?? msg({ id: 'session.tracker.unavailable', defaultMessage: "Its process tracker isn't available", description: "Why Hive can't track the processes agents start, when it doesn't know why (a notice's first sentence, without its full stop)." })),
      detail: shownText(detail ?? msg({ id: 'session.tracker.detail', defaultMessage: "Agents start as usual, but processes they leave running when they stop aren't listed or offered to end.", description: "The notice that Hive can't track agents' processes: what that means." }))
    })
  )
}

/** Diagnostics: what the tracker lost earlier in this run when it stopped, or null. */
export function trackingLost(): string | null {
  return lost
}

/** Where what agents left running is kept for the next start (#614): Hive's profile. */
const savedFile = (): string => join(app.getPath('userData'), 'leftovers.json')

/** A stopped launch's leftovers as kept (#614): its own record, so the bounds hold across restarts. */
interface SavedLaunch {
  runId: string
  projectPath: string
  agentId: string
  agentName: string
  since: string
  processes: AgentProcess[]
}

interface SavedLeftovers {
  version: 1
  launches: SavedLaunch[]
}

/** The latest write of the kept list (writes go one after another, the newest last). */
let saving: Promise<void> = Promise.resolve()
/** Whether the kept list on disk may hold something (written with processes, or read with some at the start). */
let keptAny = false

/**
 * Keeps what is listed now for the next start (#614): each launch apart, as listed (so within the bounds: bound runs
 * first), each process by id and start time (one whose start time couldn't be read can't be told from a later process
 * with its id, so it isn't kept).
 */
function persist(): void {
  const launches: SavedLaunch[] = []
  for (const l of left.values()) {
    const processes = l.processes.filter((p) => p.created)
    if (processes.length) launches.push({ runId: l.runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName, since: l.since, processes })
  }
  // A Hive whose agents never left anything writes no file.
  if (!launches.length && !keptAny) return
  keptAny = launches.length > 0
  const data: SavedLeftovers = { version: 1, launches }
  saving = saving.then(() => writeJsonAtomic(savedFile(), data)).catch((e) => log.warn('could not keep the list of processes agents left running', e))
}

/** Once the kept list is written (Hive quitting). */
export function leftoversSaved(): Promise<void> {
  return saving
}

const identity = (p: AgentProcess): string => `${p.pid}:${p.created}`
const identities = (processes: AgentProcess[]): string => processes.filter((p) => p.created).map(identity).join(',')

/**
 * Which of the processes still run as the same processes: their ids and start times, as pairs (an id alone may name a
 * later process, #614). Null when the host can't say.
 */
async function stillRunning(processes: AgentProcess[]): Promise<{ processes: AgentProcess[]; more: number } | null> {
  const list = identities(processes)
  if (!list) return { processes: [], more: 0 }
  const r = await host.request('identify', list)
  if (!Array.isArray(r)) return null
  const alive = new Set(r.map(String))
  return { processes: processes.filter((p) => p.created && alive.has(identity(p))), more: 0 }
}

/** Ends the processes, each only while it is still the same process: whether none still runs. */
async function endExactly(processes: AgentProcess[]): Promise<boolean> {
  const list = identities(processes)
  if (!list) return true
  const r = (await host.request('endexact', list)) as { ended?: number; failed?: number } | null
  return !!r && typeof r === 'object' && r.failed === 0
}

/** The kept launches that can be read, within the bounds as Hive keeps them: the newest, and each list cut. */
function boundedSaved(saved: Partial<SavedLeftovers> | null): SavedLaunch[] {
  const valid = (Array.isArray(saved?.launches) ? saved.launches : [])
    .filter((l) => l && typeof l.runId === 'string' && typeof l.projectPath === 'string' && typeof l.agentId === 'string' && Array.isArray(l.processes))
    .map((l) => ({
      ...l,
      agentName: String(l.agentName ?? ''),
      since: String(l.since ?? new Date().toISOString()),
      processes: l.processes.filter((p) => p && Number.isSafeInteger(p.pid) && p.pid > 0 && /^\d+$/.test(String(p.created))).slice(0, MAX_LISTED)
    }))
    .filter((l) => l.processes.length)
  const perAgent = new Map<string, number>()
  const kept: SavedLaunch[] = []
  // Newest last, as listed: counted from the newest.
  for (const l of valid.reverse()) {
    const k = agentKey(l.projectPath, l.agentId)
    const n = perAgent.get(k) ?? 0
    if (n >= MAX_JOBS_PER_AGENT || kept.length >= MAX_JOBS) continue
    perAgent.set(k, n + 1)
    kept.push(l)
  }
  return kept.reverse()
}

/**
 * What agents left running before Hive last closed (#614): the kept launches' processes still running as the same ones,
 * each launch listed again on its own (the agent's pane's ⋯, `session:leftovers`) within the usual bounds, and
 * returned (per agent) for Hive to offer as when an agent stops. Without the host, nothing is restored and the list
 * stays kept for the next start.
 */
export async function restoreLeftovers(): Promise<AgentLeftovers[]> {
  const launches = boundedSaved(await readJson<Partial<SavedLeftovers> | null>(savedFile(), null))
  const all = launches.flatMap((l) => l.processes)
  if (!all.length || !(await trackingReady())) return []
  const now = await stillRunning(all)
  if (!now) return []
  // Written again below, without those that have ended or are other processes by now.
  keptAny = true
  const alive = new Set(now.processes.map(identity))
  const agents = new Map<string, { projectPath: string; agentId: string }>()
  for (const l of launches) {
    const processes = l.processes.filter((p) => alive.has(identity(p))).map((p) => ({ pid: p.pid, name: String(p.name ?? ''), label: String(p.label ?? p.name ?? ''), created: String(p.created) }))
    const runId = l.runId.startsWith('restored:') ? l.runId : `restored:${l.runId}`
    if (!processes.length || left.has(runId)) continue
    const launch = { runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName }
    left.set(runId, { ...launch, processes, more: 0, since: l.since, restored: true })
    bound(launch)
    agents.set(agentKey(l.projectPath, l.agentId), { projectPath: l.projectPath, agentId: l.agentId })
    log.info(`${userText(l.agentName)} left ${processes.length} process(es) running before Hive restarted: ${userText(processes.map((p) => p.label).join('; '))}`)
  }
  persist()
  const found = [...agents.values()].map((a) => leftoversOf(a.projectPath, a.agentId)).filter((l) => l.processes.length)
  if (found.length) startPolling()
  for (const l of found) emit({ type: 'agent-leftovers', leftovers: l })
  return found
}

/** Tests: the helper's process id while it runs. */
export function trackerPid(): number | null {
  return host.pid
}
