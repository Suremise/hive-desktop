import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

type Proc = { pid: number; parent?: number; commandLine: string; started: number }
type Tree = { pid: number; started: number }[]
const req = createRequire(import.meta.url)
const { namesFolder, namesFile, ownedBy, descendantsIn, stillRunning, processes, endExactly, childrenFirst, stopProcessesIn, identify, stillSame, endTreeExactly, endChildTree } = req('./e2e/folderProcesses.cjs') as {
  processes: () => Proc[]
  endExactly: (targets: Tree) => number
  childrenFirst: (list: Proc[], targets: Tree) => Tree
  namesFolder: (cmd: string, folder: string) => boolean
  namesFile: (list: Proc[], name: string) => boolean
  ownedBy: (list: Proc[], folder: string, since?: number, self?: number) => number[]
  descendantsIn: (list: Proc[], root: number) => Tree
  stillRunning: (list: Proc[], tree: Tree) => number[]
  stopProcessesIn: (folder: string, since?: number, tree?: Tree) => number
  identify: (pids: number[]) => Tree
  stillSame: (ids: Tree) => number[]
  endTreeExactly: (root: { pid: number; started: number }, list?: Proc[]) => number
  endChildTree: (child: ChildProcess) => number
}
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

describe("a scenario's leftover processes (#542, #402)", () => {
  const dir = 'C:\\hive-test\\scenarios\\lanes\\1\\scenario'
  it('the folder itself or inside it, in any spelling: backslashes, slashes, case, quoted', () => {
    expect(namesFolder(`cmd.exe /c "${dir}\\profile\\bin\\hive-progress.cmd" --title x`, dir)).toBe(true)
    expect(namesFolder('node C:/HIVE-TEST/scenarios/lanes/1/scenario/run.js', dir)).toBe(true)
    expect(namesFolder(`node -e x "${dir}"`, dir)).toBe(true)
    expect(namesFolder(`node -e x ${dir}`, dir + '\\')).toBe(true)
  })
  it("never a sibling whose name only starts the same, nor anything else", () => {
    expect(namesFolder(`node x ${dir}-2\\run.js`, dir)).toBe(false)
    expect(namesFolder(`node x "${dir}-2"`, dir)).toBe(false)
    expect(namesFolder(`node x ${dir}s`, dir)).toBe(false)
    expect(namesFolder('node x C:\\hive-test\\scenarios\\lanes\\1', dir)).toBe(false)
  })
  it("a command naming the run's own file, as a whole name: another suite's file never counts (#658)", () => {
    const own = 'bg-done-4242-mfx1.txt'
    const proc = (commandLine: string) => ({ pid: 10, started: 1, commandLine })
    const ps = (file: string) => `pwsh.exe -Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nStart-Sleep -Seconds 40; Set-Content -Path ${file} -Value done"`
    // Its own command, in either case and by a path too.
    expect(namesFile([proc(ps(own))], own)).toBe(true)
    expect(namesFile([proc(ps(`C:\\demo\\${own.toUpperCase()}`))], own)).toBe(true)
    // The own command never started, while another suite's runs: the run's own name isn't in theirs, nor at the end of a longer one.
    const others = [proc(ps('bg-done.txt')), proc(ps('bg-done-1111-abcd.txt')), proc(`node -e x other-suite-${own}`), proc(ps(`${own}.bak`)), proc('')]
    expect(namesFile(others, own)).toBe(false)
    expect(namesFile([], own)).toBe(false)
  })
  it('only processes started since the scenario did, and never this one', () => {
    const list: Proc[] = [
      { pid: 11, commandLine: `node ${dir}\\a`, started: 2000 },
      { pid: 12, commandLine: `node ${dir}\\b`, started: 500 },
      { pid: 13, commandLine: `node ${dir}-2\\c`, started: 2000 },
      { pid: 14, commandLine: `node ${dir}\\d`, started: 2000 }
    ]
    expect(ownedBy(list, dir, 1000, 14)).toEqual([11])
    expect(ownedBy(list, dir, 0, 14)).toEqual([11, 12])
  })

  it("its Hive's tree: descendants only, a reused pid (started before its parent) never, and only while the same process", () => {
    const list = [
      { pid: 100, parent: 1, started: 1000, commandLine: 'electron .' },
      { pid: 101, parent: 100, started: 1100, commandLine: 'pty host' },
      { pid: 102, parent: 101, started: 1200, commandLine: '' },
      { pid: 103, parent: 102, started: 1300, commandLine: 'node -e x' },
      { pid: 104, parent: 101, started: 900, commandLine: 'reused pid' },
      { pid: 105, parent: 1, started: 1100, commandLine: 'unrelated' }
    ]
    const tree = descendantsIn(list, 100)
    expect(tree.map((t) => t.pid).sort()).toEqual([101, 102, 103])
    // Once Hive closed: 103 still runs, 102 ended, and 101's pid now belongs to another process.
    const after = [list[3], { pid: 101, parent: 7, started: 5000, commandLine: 'someone else' }, list[5]]
    expect(stillRunning(after, tree)).toEqual([103])
  })

  it('children are ended before their parents, which can take them with them (#615)', () => {
    // The GitHub runner's values: a parent naming the folder, its child (a lower pid), each start time as WMI and .NET
    // both gave it. Ending the parent first ended the child with it (Node's kill-on-close job), so it was never reached.
    const parent = { pid: 6440, parent: 1300, started: 1791740931617, commandLine: 'node -e x tree\\child.pid' }
    const child = { pid: 6252, parent: 6440, started: 1791740931655, commandLine: 'node -e y' }
    const grandchild = { pid: 7000, parent: 6252, started: 1791740931700, commandLine: 'node -e z' }
    const list = [child, grandchild, parent]
    const at = (p: Proc) => ({ pid: p.pid, started: p.started })
    expect(childrenFirst(list, [at(parent), at(child)])).toEqual([at(child), at(parent)])
    expect(childrenFirst(list, [at(parent), at(child), at(grandchild)])).toEqual([at(grandchild), at(child), at(parent)])
    expect(childrenFirst(list, [at(grandchild), at(parent), at(child)])).toEqual([at(grandchild), at(child), at(parent)])
    // A parent pid that is now another process (started after its "child") isn't its parent: the order given stays.
    const reused = { ...parent, started: 1791740940000 }
    expect(childrenFirst([child, reused], [at(reused), at(child)])).toEqual([at(reused), at(child)])
    // Unrelated targets keep their order.
    expect(childrenFirst(list, [at(grandchild), at(parent)])).toEqual([at(grandchild), at(parent)])
  })

  const tmp = tempDir('hive-folder-processes-')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  it.runIf(process.platform === 'win32')('stops its own process; a sibling-prefix folder\'s and an unrelated one keep running', async () => {
    const own = join(tmp, 'scenario')
    const sibling = join(tmp, 'scenario-2')
    for (const d of [own, sibling]) mkdirSync(d, { recursive: true })
    const since = Date.now() - 1000
    const start = (arg: string): ChildProcess => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', arg], { env: baseEnv(), stdio: 'ignore' })
    const kids = { own: start(own), sibling: start(sibling), other: start(join(tmp, 'other')) }
    const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null
    try {
      expect(stopProcessesIn(own, since)).toBe(1)
      await vi.waitFor(() => expect(exited(kids.own)).toBe(true), { timeout: 15000, interval: 100 })
      expect(exited(kids.sibling)).toBe(false)
      expect(exited(kids.other)).toBe(false)
      // Started before `since`: not the scenario's, so left alone.
      expect(stopProcessesIn(sibling, Date.now() + 60000)).toBe(0)
      expect(exited(kids.sibling)).toBe(false)
    } finally {
      for (const c of Object.values(kids)) if (!exited(c)) c.kill()
    }
  }, 30000)

  it.runIf(process.platform === 'win32')('never ends a pid that is now another process: only the one it was when listed (#547)', async () => {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: baseEnv(), stdio: 'ignore' })
    const exited = () => kid.exitCode !== null || kid.signalCode !== null
    try {
      const listed = processes().find((p) => p.pid === kid.pid)!
      expect(listed).toBeTruthy()
      // As if the listed process had ended and Windows had given its pid to this one, started later: left alone.
      expect(endExactly([{ pid: kid.pid!, started: listed.started - 5000 }])).toBe(0)
      expect(exited()).toBe(false)
      // The process it was when listed: ended.
      expect(endExactly([{ pid: kid.pid!, started: listed.started }])).toBe(1)
      await vi.waitFor(() => expect(exited()).toBe(true), { timeout: 15000, interval: 100 })
      // Already gone: nothing to end, and no error.
      expect(endExactly([{ pid: kid.pid!, started: listed.started }])).toBe(0)
    } finally {
      if (!exited()) kid.kill()
    }
  }, 30000)

  it.runIf(process.platform === 'win32')('a process of its own and the child it started: each ended once, by what it was when listed', async () => {
    const own = join(tmp, 'tree')
    mkdirSync(own, { recursive: true })
    const childPid = join(own, 'child.pid')
    const since = Date.now() - 1000
    // A parent naming the folder, whose child doesn't (as a shell and the command it runs).
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    // Still that process (pid and start): a pid given to another process since counts as gone.
    const alive = (t: { pid: number; started: number }) => processes().some((p) => p.pid === t.pid && p.started === t.started)
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const childPidNow = Number(readFileSync(childPid, 'utf8'))
      const child = processes().find((p) => p.pid === childPidNow)!
      expect(child).toBeTruthy()
      // The child is in a job that ends with its parent (Node's): only ending it first reaches it (#615).
      expect(stopProcessesIn(own, since)).toBe(2)
      await vi.waitFor(() => expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true), { timeout: 15000, interval: 100 })
      expect(alive(child)).toBe(false)
      expect(stopProcessesIn(own, since)).toBe(0)
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill()
    }
  }, 60000)

  it("a tree ends only from the root's own identity: a root whose pid names another process by now ends nothing (#603)", () => {
    // The root as it was when taken (pid 100, started 1000); its pid is now an unrelated process's, with a child of its own.
    const now = [
      { pid: 100, parent: 4, started: 9000, commandLine: 'node worker.js' },
      { pid: 101, parent: 100, started: 9100, commandLine: 'node worker-child.js' }
    ]
    expect(endTreeExactly({ pid: 100, started: 1000 }, now)).toBe(0)
    // Gone, or never given an identity: nothing either.
    expect(endTreeExactly({ pid: 100, started: 1000 }, [])).toBe(0)
    expect(endTreeExactly({ pid: 100, started: 0 }, now)).toBe(0)
  })

  it.runIf(process.platform === 'win32')("ends a root that is still itself and its child, children first; a stale identity of it, or an exited ChildProcess, ends nothing (#603)", async () => {
    const childPid = join(tmp, 'tree-603.pid')
    // A parent and the child it starts, the child in a job that ends with its parent (Node's): only ending it first reaches it.
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const [root, child] = identify([parent.pid!, Number(readFileSync(childPid, 'utf8'))])
      expect(root && child).toBeTruthy()
      // As if the root had ended and Windows had given its pid to this process, started later: it and its child are left alone.
      expect(endTreeExactly({ pid: root.pid, started: root.started - 5000 })).toBe(0)
      expect(stillSame([root, child])).toEqual([root.pid, child.pid])
      // Its own identity: both ended, the child first (ending the parent first would take the child with it: 1).
      expect(endTreeExactly(root)).toBe(2)
      await vi.waitFor(() => expect(exited(parent)).toBe(true), { timeout: 15000, interval: 100 })
      expect(stillSame([root, child])).toEqual([])
      // Gone: nothing to end, and no error; an exited ChildProcess is never looked up by its pid.
      expect(endTreeExactly(root)).toBe(0)
      expect(endChildTree(parent)).toBe(0)
    } finally {
      if (!exited(parent)) parent.kill()
    }
  }, 60000)

  it.runIf(process.platform === 'win32')('ends a ChildProcess it holds, with what it started (#603)', async () => {
    const childPid = join(tmp, 'held-603.pid')
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    const exited = () => parent.exitCode !== null || parent.signalCode !== null
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const [child] = identify([Number(readFileSync(childPid, 'utf8'))])
      expect(endChildTree(parent)).toBe(2)
      await vi.waitFor(() => expect(exited()).toBe(true), { timeout: 15000, interval: 100 })
      expect(stillSame([child])).toEqual([])
    } finally {
      if (!exited()) parent.kill()
    }
  }, 60000)
})

// #603: a remembered pid ended after its process had gone can be another's by then (a concurrent run's Vitest worker,
// which exits with code 1); taskkill /T follows parent ids that may be stale. Test tooling ends processes by identity
// (folderProcesses.cjs: identify, stillSame, endExactly, endTreeExactly, stopProcessesIn) or through a handle it holds
// (a ChildProcess's kill()). A line that must use a pid says why, with "its handle is held".
describe('test tooling ends processes by identity, never by a remembered pid (#603)', () => {
  const root = join(__dirname, '..')
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (['node_modules', 'fixtures'].includes(e.name) ? [] : files(join(dir, e.name))) : /\.(c|m)?[jt]s$/.test(e.name) ? [join(dir, e.name)] : []
    )
  // And in Hive itself: hive-progress ends its command's tree by identity too (wrapper.ts endTree, #655).
  it('no process.kill on a pid (other than signal 0) and no taskkill, in tests, scripts or src', () => {
    const found: string[] = []
    for (const f of [...files('tests'), ...files('scripts'), ...files('src')]) {
      readFileSync(join(root, f), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '')
          if (/^\s*\*/.test(line) || /its handle is held/.test(line)) return
          if (/process\.kill\((?![^)]*,\s*0\))/.test(code) || /['"`]taskkill/.test(code)) found.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(found).toEqual([])
  })
})
