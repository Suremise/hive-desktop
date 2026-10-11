import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

type Proc = { pid: number; parent?: number; commandLine: string; started: number }
type Tree = { pid: number; started: number }[]
const req = createRequire(import.meta.url)
const { namesFolder, ownedBy, descendantsIn, stillRunning, stopProcessesIn } = req('./e2e/folderProcesses.cjs') as {
  namesFolder: (cmd: string, folder: string) => boolean
  ownedBy: (list: Proc[], folder: string, since?: number, self?: number) => number[]
  descendantsIn: (list: Proc[], root: number) => Tree
  stillRunning: (list: Proc[], tree: Tree) => number[]
  stopProcessesIn: (folder: string, since?: number, tree?: Tree) => number
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
})
