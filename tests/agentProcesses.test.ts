// What an agent's launch leaves running (#507): its CLI joins a job as it starts, everything it starts joins with it
// (detached, through a process that has exited since), and only the job's processes are ever listed or ended. The real
// job host (PowerShell) on Windows; the labels shown for them anywhere.
import { createRequire } from 'module'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { leftoversSummary, processLabel } from '../src/shared/agentProcesses'
import { tempDir } from './tempDir'
// What the test started that is still running: stopped by its command line (it names the test's folder) and start,
// never by a pid remembered from earlier, which Windows may have given another process since: under load that could
// be a concurrent run's Vitest worker (#547: a likely cause of one exiting with code 1, not reproduced).
const { stopProcessesIn } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as { stopProcessesIn: (folder: string, since?: number) => number }

const events: unknown[] = []
vi.mock('../src/main/events', () => ({ emit: (e: unknown) => events.push(e) }))
// Hive's profile, where what is listed is kept across a restart (#614): this file's own, never the shared test root.
const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => profile.dir } }
})
profile.dir = tempDir('hive-agentproc-profile-')

describe('a process as the user recognises it', () => {
  it('drops the executable path and cuts paths in arguments to their last part', () => {
    expect(processLabel('node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js" run serve')).toBe('node npm-cli.js run serve')
    expect(processLabel('tail.exe', 'C:\\Program Files\\Git\\usr\\bin\\tail.exe -f .cache/capture-1.log')).toBe('tail -f .cache/capture-1.log')
    expect(processLabel('bash.exe', '/usr/bin/bash -c "npm run serve > .cache/serve.log 2>&1"')).toBe('bash -c "npm run serve > .cache/serve.log 2>&1"')
  })

  it('is the name alone without a command line, and short', () => {
    expect(processLabel('grep.exe', '')).toBe('grep')
    const long = processLabel('node.exe', `node.exe ${'x'.repeat(200)}`)
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('sums several up in a line: each label once with its count, the rest counted', () => {
    const p = (label: string, pid: number) => ({ pid, name: 'x.exe', label })
    expect(leftoversSummary({ processes: [p('node serve.js', 1), p('tail -f a.log', 2), p('tail -f a.log', 3)], more: 0 })).toBe('node serve.js, 2 × tail -f a.log')
    expect(leftoversSummary({ processes: [p('a', 1), p('b', 2), p('c', 3)], more: 2 }, 2)).toBe('a, b and 3 processes more')
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return fn()
}

describe.runIf(process.platform === 'win32')('the processes a launch leaves running', () => {
  const dir = tempDir('hive-agentproc-')
  // A stand-in CLI: waits for "go", then starts a detached child that starts a detached grandchild (each writes its pid),
  // and exits, as an agent leaving a server behind does. A lingering process sleeps (at most 2 minutes, in case).
  const script = join(dir, 'proc.cjs')
  writeFileSync(
    script,
    `const { spawn } = require('child_process'), fs = require('fs'), path = require('path')
const [role, out] = process.argv.slice(2)
const start = (r) => spawn(process.execPath, [__filename, r, out], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
if (role === 'cli') process.stdin.once('data', () => { start('child'); setTimeout(() => process.exit(0), 800) })
// What the Store's PowerShell does (#543): its children start outside every job. Stood in for by starting the child
// before this CLI joins its job: the child's parent is in the job, the child in none.
else if (role === 'escaper') { start('child'); process.stdin.once('data', () => process.exit(0)) }
// The real Store PowerShell (where it is installed), as Codex runs a background command: on "go", it runs a process
// that keeps running, and this CLI exits once that has started.
else if (role === 'storepwsh') process.stdin.once('data', () => {
  const ps = spawn(process.env.STORE_PWSH, ['-NoProfile', '-Command', '& $env:LONE_NODE $env:LONE_SCRIPT lone $env:LONE_OUT'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LONE_NODE: process.execPath, LONE_SCRIPT: __filename, LONE_OUT: out } })
  // Windows may refuse to start it (#585): said, for the test to tell from a tracking failure.
  ps.on('error', (e) => { fs.appendFileSync(out, 'pwsh-error ' + JSON.stringify(e.message) + '\\n'); process.exit(3) })
  ps.on('exit', (code) => { fs.appendFileSync(out, 'pwsh-exit ' + code + '\\n'); process.exit(4) })
  const started = setInterval(() => { if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('lone ')) { clearInterval(started); process.exit(0) } }, 100)
})
else {
  fs.appendFileSync(out, role + ' ' + process.pid + '\\n')
  if (role === 'child') start('grandchild')
  setTimeout(() => process.exit(0), 120000)
}
`
  )
  const since = Date.now()
  const pidsIn = (file: string): Record<string, number> => (existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.split(' ')[0], Number(l.split(' ')[1])])) : {})

  async function launch(runId: string, out: string, agentId = 'a1'): Promise<ChildProcess> {
    const { trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, [script, 'cli', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(await trackLaunch({ runId, projectPath: dir, agentId, agentName: 'Website' }, cli.pid!)).toEqual({ tracked: true })
    cli.stdin!.write('go\n')
    await new Promise((r) => cli.once('exit', r))
    expect(await until(() => Object.keys(pidsIn(out)).length === 2, 10000)).toBe(true)
    return cli
  }

  afterAll(async () => {
    const { closeProcessTracking } = await import('../src/main/agentProcesses')
    closeProcessTracking()
    stopProcessesIn(dir, since)
  })

  it('lists what a stopped launch left running, ends only that, and leaves a process it did not start alone', async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    // Started by someone else, in the same folder, at the same time: never the launch's.
    const other = join(dir, 'other.txt')
    spawn(process.execPath, [script, 'stranger', other], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    expect(await until(() => !!pidsIn(other).stranger, 10000)).toBe(true)
    const stranger = pidsIn(other).stranger

    const out = join(dir, 'run1.txt')
    await launch('run1', out)
    const { child, grandchild } = pidsIn(out)
    const left = await launchEnded('run1')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(left?.processes.every((p) => p.label.startsWith('node proc.cjs'))).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', agentName: 'Website' } })

    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(alive(stranger)).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', processes: [] } })
    // Another agent's call, or the same again, ends nothing more.
    expect(await settleLeftovers(dir, 'a2', 'end')).toBe(0)
    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(0)
  }, 60000)

  it('keeps them running when asked, and stops listing them', async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run2.txt')
    await launch('run2', out)
    const { child, grandchild } = pidsIn(out)
    expect((await launchEnded('run2'))?.processes).toHaveLength(2)
    expect(await settleLeftovers(dir, 'a1', 'keep')).toBe(2)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
    expect(alive(child) && alive(grandchild)).toBe(true)
  }, 60000)

  it("keeps listing what it couldn't end, says so, and ends it when tried again", async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run4.txt')
    await launch('run4', out)
    const { child, grandchild } = pidsIn(out)
    expect((await launchEnded('run4'))?.processes).toHaveLength(2)
    process.env.HIVE_TEST_JOB_KILL_FAILS = '1'
    try {
      await expect(settleLeftovers(dir, 'a1', 'end')).rejects.toThrow(/2 processes are still running/)
    } finally {
      delete process.env.HIVE_TEST_JOB_KILL_FAILS
    }
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', processes: [{}, {}] } })
    expect(alive(child) && alive(grandchild)).toBe(true)
    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
  }, 60000)

  it('adopts what escaped the job (#543): a child outside every job whose parent is in it, and its own child, listed and ended', async () => {
    const { launchEnded, leftoversOf, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run5.txt')
    const cli = spawn(process.execPath, [script, 'escaper', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    // Both started before the CLI joins its job: neither is in it.
    expect(await until(() => Object.keys(pidsIn(out)).length === 2, 10000)).toBe(true)
    const { child, grandchild } = pidsIn(out)
    expect(await trackLaunch({ runId: 'run5', projectPath: dir, agentId: 'a5', agentName: 'Escaper' }, cli.pid!)).toEqual({ tracked: true })
    // The CLI exits at once: they are adopted as it ends (its id held meanwhile), not left to a later look.
    cli.stdin!.write('go\n')
    await new Promise((r) => cli.once('exit', r))
    const left = await launchEnded('run5')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(await settleLeftovers(dir, 'a5', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(leftoversOf(dir, 'a5').processes).toHaveLength(0)
  }, 60000)

  // The Store's PowerShell 7 is a packaged app: what it starts leaves every job (#543). Only where it is installed.
  const storePwsh = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  // An app execution alias: lstat, which stat (existsSync) can't follow.
  const hasStorePwsh = ((): boolean => {
    try {
      return !!lstatSync(storePwsh)
    } catch {
      return false
    }
  })()
  it.runIf(hasStorePwsh)("adopts the Store's PowerShell and what it runs, left running by a CLI that has exited", async (ctx) => {
    const { launchEnded, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run6.txt')
    const cli = spawn(process.execPath, [script, 'storepwsh', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, STORE_PWSH: storePwsh } })
    expect(await trackLaunch({ runId: 'run6', projectPath: dir, agentId: 'a6', agentName: 'Store shell' }, cli.pid!)).toEqual({ tracked: true })
    cli.stdin!.write('go\n')
    const code = await new Promise<number | null>((r) => cli.once('exit', r))
    const said = existsSync(out) ? readFileSync(out, 'utf8') : ''
    // The Store's PowerShell didn't start, or ended before what it runs had: Windows', not the tracker's (#585).
    if (code !== 0) {
      await launchEnded('run6')
      ctx.skip(`the Store's PowerShell didn't run its command (exit ${code}): ${said.trim()}`)
    }
    const { lone } = pidsIn(out)
    const left = await launchEnded('run6')
    // What was running then, if it wasn't listed: the shell and the process it ran, with their parents.
    const seen = (): string => (left ? '' : String(execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${lone} -or $_.Name -eq 'pwsh.exe' } | ForEach-Object { "$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name)" }`], { windowsHide: true })))
    expect(left?.processes.map((p) => p.pid) ?? [], `CLI ${cli.pid}, lone ${lone}: ${seen()}`).toContain(lone)
    expect(left?.processes.some((p) => /^pwsh/i.test(p.label))).toBe(true)
    expect(await settleLeftovers(dir, 'a6', 'end')).toBe(2)
    expect(await until(() => !alive(lone), 5000)).toBe(true)
  }, 60000)

  // The host's C# driven directly, in a PowerShell of the test's own, with identities a late snapshot or a late port
  // notification could carry (#543): an id that names another process by now is never taken in, and a followed
  // process Windows won't end keeps End failing, and listed, until it is ended.
  it('never takes in a process by a stale id, and End fails while a followed process it could not end runs', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'stale.ps1')
    writeFileSync(
      probe,
      `param($src, $node)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
$sleeper = { $s = [System.Diagnostics.ProcessStartInfo]::new($node, '-e "setTimeout(() => {}, 60000)"'); $s.UseShellExecute = $false; $s.CreateNoWindow = $true; [System.Diagnostics.Process]::Start($s) }
$r = [ordered]@{}
$m = & $sleeper
$r.added = [HiveJobs]::Add('t', $m.Id)
# The port holds the member it reports.
for ($i = 0; $i -lt 100 -and -not [HiveJobs]::IsHeld($m.Id); $i++) { Start-Sleep -Milliseconds 50 }
$r.memberHeld = [HiveJobs]::IsHeld($m.Id)
$before = [DateTime]::UtcNow.ToFileTimeUtc()
# Windows stamps a process's creation from a clock that moves in ticks of about 15.6 ms: one created within a tick of
# $before can carry an earlier time. Started once the clock is past that, the stamp is surely later.
while ([DateTime]::UtcNow.ToFileTimeUtc() - $before -lt 500000) { }
# Started after "the snapshot", by this shell: no child of the member's, whatever a stale snapshot said.
$u = & $sleeper
$after = [DateTime]::UtcNow.ToFileTimeUtc()
$r.unrelatedHeld = [HiveJobs]::Hold('t', $u.Id)
$r.staleTaken = [HiveJobs]::Take('t', $u.Id, $m.Id, $before)
# The same pair, from a snapshot taken after it started, is taken: it is the snapshot's time that refuses it above.
$r.freshTaken = [HiveJobs]::Take('t', $u.Id, $m.Id, $after)
# Followed: one through a handle that can't end it, one that can.
$v = & $sleeper
$w = & $sleeper
$r.followed = [HiveJobs]::Follow('t', $v.Id, 0) -and [HiveJobs]::Follow('t', $w.Id, 1)
$r.kill = [HiveJobs]::Kill('t')
$r.endedOne = $w.WaitForExit(10000)
$r.survivorRuns = -not $v.HasExited
$r.survivorFollowed = [HiveJobs]::IsFollowed($v.Id)
$r.survivorListed = [HiveJobs]::Members('t') -contains $v.Id
$r.followedAgain = [HiveJobs]::Follow('t', $v.Id, 1)
$r.killAgain = [HiveJobs]::Kill('t')
$r.survivorEnded = $v.WaitForExit(10000)
$r.othersEnded = $m.WaitForExit(10000) -and $u.WaitForExit(10000)
foreach ($p in @($m, $u, $v, $w)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)
    expect(r).toEqual({
      added: 'ok',
      memberHeld: true,
      unrelatedHeld: false,
      staleTaken: false,
      freshTaken: true,
      followed: true,
      kill: false,
      endedOne: true,
      survivorRuns: true,
      survivorFollowed: true,
      survivorListed: true,
      followedAgain: true,
      killAgain: true,
      survivorEnded: true,
      othersEnded: true
    })
  }, 150000)

  it('lists nothing for a launch that left nothing running, nor for one it never tracked', async () => {
    const { launchEnded, trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true })
    expect(await trackLaunch({ runId: 'run3', projectPath: dir, agentId: 'a3', agentName: 'Quiet' }, cli.pid!)).toEqual({ tracked: true })
    await new Promise((r) => cli.once('exit', r))
    expect(await launchEnded('run3')).toBeNull()
    expect(await launchEnded('never')).toBeNull()
  }, 30000)

  it('keeps what is listed across a restart, by pid and start time, and ends exactly those processes (#614)', async () => {
    const kept = join(profile.dir, 'leftovers.json')
    const before = await import('../src/main/agentProcesses')
    const out = join(dir, 'run7.txt')
    await launch('run7', out, 'a7')
    const { child, grandchild } = pidsIn(out)
    const left = await before.launchEnded('run7')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(left?.processes.every((p) => /^\d+$/.test(p.created ?? ''))).toBe(true)
    await before.leftoversSaved()
    const saved = JSON.parse(readFileSync(kept, 'utf8'))
    expect(saved.launches).toHaveLength(1)
    expect(saved.launches[0]).toMatchObject({ runId: 'run7', projectPath: dir, agentId: 'a7', agentName: 'Website' })
    expect(saved.launches[0].processes.map((p: { pid: number }) => p.pid).sort()).toEqual([child, grandchild].sort())

    // Someone else's process, which a kept record names by its pid with another start time: as if the pid were reused.
    const other = join(dir, 'other7.txt')
    spawn(process.execPath, [script, 'stranger', other], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    expect(await until(() => !!pidsIn(other).stranger, 10000)).toBe(true)
    const stranger = pidsIn(other).stranger
    saved.launches[0].processes.push({ pid: stranger, name: 'node.exe', label: 'node old.js', created: '116444736000000000' })
    // An older launch's record of the child's pid with another start time (a process the pid named before): two
    // records share the pid, and only the one that is the same process is listed.
    const [first] = saved.launches[0].processes
    const older = String(BigInt(saved.launches[0].processes.find((p: { pid: number }) => p.pid === child).created) - 10_000_000n)
    saved.launches.unshift({ runId: 'run-old', projectPath: dir, agentId: 'a8', agentName: 'Old', since: saved.launches[0].since, processes: [{ ...first, pid: child, created: older }] })
    // More launches for one agent than Hive keeps (5 an agent): the newest are kept, however often Hive restarts.
    for (let i = 1; i <= 7; i++) saved.launches.push({ runId: `many${i}`, projectPath: dir, agentId: 'a9', agentName: 'Many', since: saved.launches[1].since, processes: saved.launches[1].processes.filter((p: { pid: number }) => p.pid === grandchild) })
    writeFileSync(kept, JSON.stringify(saved))

    // Hive restarts: its tracker and its memory go (the processes keep running), the kept list stays.
    const restart = async (mod: typeof before): Promise<typeof before> => {
      mod.closeProcessTracking()
      vi.resetModules()
      return import('../src/main/agentProcesses')
    }
    let after = await restart(before)
    expect(after.leftoversOf(dir, 'a7').processes).toHaveLength(0)
    const found = await after.restoreLeftovers()
    expect(found.map((l) => l.agentId).sort()).toEqual(['a7', 'a9'])
    expect(after.leftoversOf(dir, 'a7').processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(after.leftoversOf(dir, 'a8').processes).toHaveLength(0)
    const keptNow = async (): Promise<{ runId: string; agentId: string }[]> => {
      await after.leftoversSaved()
      return JSON.parse(readFileSync(kept, 'utf8')).launches
    }
    const many = async (): Promise<string[]> => (await keptNow()).filter((l) => l.agentId === 'a9').map((l) => l.runId)
    expect(after.leftoversOf(dir, 'a9').processes).toHaveLength(5)
    expect(await many()).toEqual(['restored:many3', 'restored:many4', 'restored:many5', 'restored:many6', 'restored:many7'])
    // Again: still the same five, not more.
    after = await restart(after)
    await after.restoreLeftovers()
    expect(after.leftoversOf(dir, 'a9').processes).toHaveLength(5)
    expect(await many()).toEqual(['restored:many3', 'restored:many4', 'restored:many5', 'restored:many6', 'restored:many7'])
    expect((await keptNow()).some((l) => l.agentId === 'a8')).toBe(false)

    expect(await after.settleLeftovers(dir, 'a9', 'keep')).toBe(5)
    expect(await after.settleLeftovers(dir, 'a7', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(alive(stranger)).toBe(true)
    expect(after.leftoversOf(dir, 'a7').processes).toHaveLength(0)
    expect(await keptNow()).toEqual([])
    after.closeProcessTracking()
  }, 90000)
})
