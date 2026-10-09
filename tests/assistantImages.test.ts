// The Hive Assistant's images (#243): listed from its home (a session host, not a project), grouped by conversation;
// deleting one, or a conversation's group, has the checks of deleting sessions (#239): none while the conversation
// runs, and none if another program has one open (all or nothing).
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-aimages-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the file; `duringTrash` runs at the first one (something happening meanwhile).
const trashed: string[] = []
let duringTrash: (() => Promise<void>) | null = null
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => {
  const fn = duringTrash
  duringTrash = null
  await fn?.()
  rmSync(p, { force: true })
  trashed.push(p)
}

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const files = await import('../src/main/files')
const { sessions } = await import('../src/main/sessions')

const wsPath = join(base, 'ws')
const home = join(wsPath, '.hive', 'assistant')
const s = sessions as unknown as { live: Map<string, unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const conv = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const imagesOf = (id: string): string => join(home, '.hive', 'images', id)
const png = (id: string, name: string): string => {
  const p = join(imagesOf(id), name)
  mkdirSync(imagesOf(id), { recursive: true })
  writeFileSync(p, 'png')
  return p
}

const holders: ChildProcess[] = []
async function hold(file: string): Promise<void> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  holders.push(child)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => String(d).includes('held') && (clearTimeout(t), resolve()))
    child.on('exit', () => reject(new Error('the holder exited')))
  })
}

describe.runIf(process.platform === 'win32')("the Assistant's images", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, 'api'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
    await run(() => workspace.upsertSession(home, { id: conv, agent: 'claude-code', name: 'Planning the week' }))
  })
  afterEach(() => {
    s.live.clear()
    for (const h of holders.splice(0)) h.kill()
    trashed.length = 0
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })

  it('lists them from its home, by conversation, with its name', async () => {
    png(conv, '2026-10-05T10-00-00.png')
    png(conv, '2026-10-05T11-00-00.png')
    const groups = await run(() => files.listImages(home))
    expect(groups.map((g) => [g.sessionId, g.name, g.images.length])).toEqual([[conv, 'Planning the week', 2]])
    expect(groups[0].images[0].name).toBe('2026-10-05T11-00-00.png')
  })

  it('one image held by another program is not deleted; a conversation group goes all or none', async () => {
    const a = png(other, '2026-10-05T09-00-00.png')
    const b = png(other, '2026-10-05T09-30-00.png')
    await hold(b)
    await expect(run(() => files.trashImage(home, b))).rejects.toThrow(/Another program has this image open/)
    await expect(run(() => files.trashImageGroup(home, other))).rejects.toThrow(/one of these images open/)
    expect(existsSync(a) && existsSync(b)).toBe(true)
    expect(trashed).toEqual([])
    for (const h of holders.splice(0)) h.kill()
    await new Promise((r) => setTimeout(r, 300))
    expect(await run(() => files.trashImageGroup(home, other))).toBe(2)
    expect(existsSync(imagesOf(other))).toBe(false)
    expect(readdirSync(join(home, '.hive', 'images'))).toEqual([conv])
  })

  it('not while the conversation runs: neither one image nor its group', async () => {
    s.live.set('assistant', { state: { provider: 'claude-code', runId: 'r', projectPath: home, agentId: 'assistant', sessionId: conv, status: 'ready' } })
    await expect(run(() => files.trashImageGroup(home, conv))).rejects.toThrow(/running/)
    const one = join(imagesOf(conv), readdirSync(imagesOf(conv))[0])
    await expect(run(() => files.trashImage(home, one))).rejects.toThrow(/running/)
    expect(readdirSync(imagesOf(conv)).length).toBe(2)
  })

  it("the conversation can't resume while its images go (it would paste more)", async () => {
    const id = '00000000-0000-4000-8000-000000000003'
    png(id, '2026-10-05T08-00-00.png')
    png(id, '2026-10-05T08-10-00.png')
    let refused: unknown = null
    duringTrash = async () => {
      refused = await run(() => sessions.start(home, { resumeId: id, agentId: 'assistant' })).catch((e) => e)
    }
    expect(await run(() => files.trashImageGroup(home, id))).toBe(2)
    expect(String(refused)).toMatch(/archiving, deleting or cleaning up this session's files/)
    expect(s.live.size).toBe(0)
  })

  it('never deletes through a link out of the images folder: a linked group, or a linked images folder', async () => {
    // A group folder that is a junction to a folder of the user's.
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'personal.png'), 'mine')
    const linked = '00000000-0000-4000-8000-000000000004'
    mkdirSync(join(home, '.hive', 'images'), { recursive: true })
    symlinkSync(outside, imagesOf(linked), 'junction')
    await expect(run(() => files.trashImageGroup(home, linked))).rejects.toThrow(/Not one of the session images/)
    await expect(run(() => files.trashImage(home, join(imagesOf(linked), 'personal.png')))).rejects.toThrow(/Not one of the session images/)
    expect((await run(() => files.listImages(home))).some((g) => g.sessionId === linked)).toBe(false)
    expect(readFileSync(join(outside, 'personal.png'), 'utf8')).toBe('mine')
    expect(trashed).toEqual([])
    // A project whose whole .hive/images is a junction elsewhere: not listed, nothing deleted.
    const api = join(wsPath, 'api')
    mkdirSync(join(api, '.hive'), { recursive: true })
    const outsideRoot = join(base, 'outside-root')
    mkdirSync(join(outsideRoot, linked), { recursive: true })
    writeFileSync(join(outsideRoot, linked, 'personal.png'), 'mine too')
    symlinkSync(outsideRoot, join(api, '.hive', 'images'), 'junction')
    expect(await run(() => files.listImages(api))).toEqual([])
    await expect(run(() => files.trashImageGroup(api, linked))).rejects.toThrow(/Not one of the session images/)
    await expect(run(() => files.trashImage(api, join(api, '.hive', 'images', linked, 'personal.png')))).rejects.toThrow(/Not a session image/)
    expect(readFileSync(join(outsideRoot, linked, 'personal.png'), 'utf8')).toBe('mine too')
  })

  it('refuses ids and paths that are not its images', async () => {
    await expect(run(() => files.trashImageGroup(home, '../x'))).rejects.toThrow()
    await expect(run(() => files.trashImage(home, join(home, '.hive', 'sessions.json')))).rejects.toThrow(/Not a session image/)
    await expect(run(() => files.listImages(join(base, 'elsewhere')))).rejects.toThrow()
  })
})
