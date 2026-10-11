// What an agent's launch leaves running (#507): its CLI joins a job as it starts, everything it starts joins with it
// (detached, through a process that has exited since), and only the job's processes are ever listed or ended. The real
// job host (PowerShell) on Windows; the labels shown for them anywhere.
import { createRequire } from 'module'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
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
else {
  fs.appendFileSync(out, role + ' ' + process.pid + '\\n')
  if (role === 'child') start('grandchild')
  setTimeout(() => process.exit(0), 120000)
}
`
  )
  const since = Date.now()
  const pidsIn = (file: string): Record<string, number> => (existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.split(' ')[0], Number(l.split(' ')[1])])) : {})

  async function launch(runId: string, out: string): Promise<ChildProcess> {
    const { trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, [script, 'cli', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(await trackLaunch({ runId, projectPath: dir, agentId: 'a1', agentName: 'Website' }, cli.pid!)).toEqual({ tracked: true })
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

  it('lists nothing for a launch that left nothing running, nor for one it never tracked', async () => {
    const { launchEnded, trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true })
    expect(await trackLaunch({ runId: 'run3', projectPath: dir, agentId: 'a3', agentName: 'Quiet' }, cli.pid!)).toEqual({ tracked: true })
    await new Promise((r) => cli.once('exit', r))
    expect(await launchEnded('run3')).toBeNull()
    expect(await launchEnded('never')).toBeNull()
  }, 30000)
})
