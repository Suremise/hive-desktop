// What still runs of a test once its Hive has closed (#542): a command an agent started (Codex through the profile's
// hive-progress shim, a shell command Claude Code ran in the folder) can outlive its session and hold the folder. Only
// what is the test's own, never by name: what its Hive started (its process tree, taken before it closes, each by pid
// and start time, so a reused pid is never taken), and what names its folder on the command line (a path boundary, so
// `scenario` never takes `scenario-2`'s) and started after the test did.
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { baseEnv } = require('./runContext.cjs')

/** A folder or command line in one spelling: lower case, backslashes, no trailing separator. */
const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase()

/** Does `commandLine` name `folder` itself or something inside it (not a folder whose name only starts the same)? */
function namesFolder(commandLine, folder) {
  const cmd = norm(commandLine)
  const dir = norm(path.resolve(folder)).replace(/\\+$/, '')
  for (let i = cmd.indexOf(dir); i >= 0; i = cmd.indexOf(dir, i + 1)) {
    const next = cmd[i + dir.length]
    if (next === undefined || next === '\\' || next === '"' || next === "'" || /\s/.test(next)) return true
  }
  return false
}

/**
 * The processes `list` ({ pid, commandLine, started (ms) }) that are the test's own: they name `folder` and started at
 * or after `since` (ms; 0 for any). Never `self`.
 */
const ownedBy = (list, folder, since = 0, self = process.pid) =>
  list.filter((p) => p.pid > 0 && p.pid !== self && p.commandLine && namesFolder(p.commandLine, folder) && !(since && p.started < since)).map((p) => p.pid)

/**
 * Every process: { pid, parent, started, commandLine } (empty when Windows doesn't show it). A line each, the command line in base64:
 * PowerShell 5.1's ConvertTo-Json leaves some control characters in a command line unescaped (a prompt's, say).
 */
function processes() {
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: baseEnv(), maxBuffer: 64 * 1024 * 1024 })
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter((p) => p.length >= 3 && Number(p[0]) > 0)
    .map(([pid, parent, started, cmd = '']) => ({ pid: Number(pid), parent: Number(parent), started: Number(started), commandLine: Buffer.from(cmd, 'base64').toString('utf8') }))
}

/** `root`'s descendants in `list` (not `root` itself), each { pid, started }; a child started before its parent is a reused pid's, not a child. */
function descendantsIn(list, root) {
  const byParent = new Map()
  for (const p of list) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
  const rootStarted = list.find((p) => p.pid === root)?.started ?? 0
  const out = []
  const walk = (pid, started) => {
    for (const k of byParent.get(pid) ?? []) {
      if (k.pid === pid || k.started < started || out.some((x) => x.pid === k.pid)) continue
      out.push({ pid: k.pid, started: k.started })
      walk(k.pid, k.started)
    }
  }
  walk(root, rootStarted)
  return out
}

/** The process tree under `pid` (a test Hive's main process), to stop what of it is left once it closed. [] off Windows. */
function processTree(pid) {
  if (process.platform !== 'win32' || !pid) return []
  try {
    return descendantsIn(processes(), pid)
  } catch {
    return []
  }
}

/** Of `tree` (processTree's), those still running as the same process (pid and start time): in `list`. */
const stillRunning = (list, tree) => tree.filter((t) => list.some((p) => p.pid === t.pid && p.started === t.started)).map((t) => t.pid)

/**
 * Stops the processes that are the test's own (above), each with its children: those naming `folder` that started at
 * or after `since`, and those of `tree` (processTree's, taken before its Hive closed) still running. Returns how many.
 */
function stopProcessesIn(folder, since = 0, tree = []) {
  if (process.platform !== 'win32') return 0
  let pids
  try {
    const list = processes()
    pids = [...new Set([...ownedBy(list, folder, since), ...stillRunning(list, tree)])].filter((pid) => pid !== process.pid)
  } catch {
    return 0
  }
  for (const pid of pids) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', env: baseEnv() })
  return pids.length
}

module.exports = { namesFolder, ownedBy, descendantsIn, stillRunning, processTree, stopProcessesIn }
