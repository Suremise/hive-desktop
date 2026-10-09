// The same folder by another name (#455): a workspace, project or worktree reached through a junction (or an 8.3 short
// name, as on GitHub's runner) is the same place as its real path. Opening a workspace, telling whether one moved (and
// Repair's Locate), project removal's guards (and Delete) and resuming a session compare places
// (`samePlace`/`containsPlace`), not spellings. Each test uses a junction, which makes another name on any machine
// (tests/pathAliases.ts). Windows (windowShowing, switching a window's workspace) are in the e2e suite `windows`.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { AgentDef } from '../src/shared/types'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const base = tempDir('hive-places-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { movePlan } = await import('../src/main/workspaceMove')
const { checkedWorktrees, removeProject } = await import('../src/main/projectRemoval')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')
const { containsPlace, samePlace } = await import('../src/main/fsutil')

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' })
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
/** A worktree of proj that is also a project of the workspace (a folder in it). */
const other = join(wsPath, 'other')
/** An agent worktree of proj, in the workspace's worktree folder. */
const tree = join(base, 'ws.worktrees', 'proj', 'a')
const aliases = join(base, 'aliases')
/** Another name for `target`: a junction in the aliases folder. */
const alias = (target: string, name: string): string => junction(target, join(aliases, name))
let w: ReturnType<typeof createWorkspaceService>
/** An agent with a worktree at `path`. */
const agent = (id: string, path: string): AgentDef => ({ id, name: id.toUpperCase(), provider: 'claude-code', worktree: { path, branch: `hive/${id}`, base: 'main' } }) as AgentDef

beforeAll(async () => {
  mkdirSync(proj, { recursive: true })
  mkdirSync(aliases, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  writeFileSync(join(proj, 'a.txt'), 'a\n')
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'a')
  git(proj, 'worktree', 'add', '-q', '-b', 'other', other)
  git(proj, 'worktree', 'add', '-q', '-b', 'hive/a', tree)
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  await disposeWorkspaceService(w)
})

describe('places by real path (#455)', () => {
  it('containsPlace and samePlace see through a junction', () => {
    const ws = alias(wsPath, 'ws-places')
    expect(samePlace(ws, wsPath)).toBe(true)
    expect(containsPlace(ws, proj)).toBe(true)
    expect(containsPlace(wsPath, join(ws, 'proj'))).toBe(true)
    expect(containsPlace(proj, ws)).toBe(false)
  })

  it('refuses a workspace open in another window, or inside or around one, by another name', async () => {
    const second = createWorkspaceService()
    try {
      await expect(second.open(alias(wsPath, 'ws-open'))).rejects.toThrow(/already open in another window/)
      await expect(second.open(alias(proj, 'proj-open'))).rejects.toThrow(/is inside the workspace/)
      await expect(second.open(alias(base, 'base-open'))).rejects.toThrow(/open in another window, is inside/)
      expect(second.path).toBeNull()
    } finally {
      await disposeWorkspaceService(second)
    }
  })

  it("a workspace reopened by another name hasn't moved; one opened in another folder has", async () => {
    const was = w.config.lastPath
    try {
      const ws = alias(wsPath, 'ws-moved')
      w.config.lastPath = ws
      await w.mutateProjectConfig(proj, () => ({ lastPath: join(ws, 'proj') }))
      expect(await movePlan(w)).toBeNull()
      // The check still sees a real move.
      w.config.lastPath = join(base, 'elsewhere', 'ws')
      expect((await movePlan(w))?.from).toBe(join(base, 'elsewhere', 'ws'))
    } finally {
      w.config.lastPath = was
      await w.mutateProjectConfig(proj, () => ({ lastPath: proj }))
    }
  })

  it("Repair's Locate of an agent's own worktree by another name changes nothing; another worktree is located", async () => {
    try {
      // The project moved (its recorded folder is elsewhere), so Repair looks at its agents' worktrees.
      await w.mutateProjectConfig(proj, () => ({ lastPath: join(base, 'elsewhere', 'proj'), agents: [{ id: 'l', name: 'L', provider: 'claude-code', worktree: { path: tree, branch: 'hive/a', base: 'main' } } as AgentDef] }))
      const worktrees = async (picked: string): Promise<unknown[]> => (await movePlan(w, { locate: { [`${proj}#l`]: picked } }))!.hosts.find((h) => samePlace(h.path, proj))!.worktrees
      expect(await worktrees(alias(tree, 'tree-locate'))).toEqual([])
      expect(await worktrees(other)).toEqual([expect.objectContaining({ agentId: 'l', how: 'located', to: other })])
    } finally {
      await w.mutateProjectConfig(proj, () => ({ lastPath: proj, agents: [] }))
    }
  })

  it("project removal won't take a worktree that is another project, named through a junction", async () => {
    const { ok, refused } = await checkedWorktrees(w, proj, [agent('x', alias(other, 'other-rm')), agent('a', alias(tree, 'tree-rm'))])
    expect(refused).toEqual([expect.stringMatching(/^X's worktree .* \(it is another project of the workspace\)$/)])
    expect(ok.map((a) => a.id)).toEqual(['a'])
  })

  describe('project removal, in a workspace inside a repository it is a worktree of', () => {
    // outer is a repository whose main worktree holds the workspace ws2; its projects q and q2 are worktrees of outer, so
    // git lists outer (containing the workspace and q) and q itself among q's worktrees. A worktree of outer's outside
    // the workspace (spare) is one an agent may have.
    const outer = join(base, 'outer')
    const ws2 = join(outer, 'ws2')
    const q = join(ws2, 'q')
    const q2 = join(ws2, 'q2')
    const spare = join(base, 'outer-wt', 'spare')
    let w2: ReturnType<typeof createWorkspaceService>
    beforeAll(async () => {
      mkdirSync(outer, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', outer])
      writeFileSync(join(outer, 'a.txt'), 'a\n')
      git(outer, 'add', '-A')
      git(outer, 'commit', '-qm', 'a')
      for (const [at, branch] of [[q, 'q'], [q2, 'q2'], [spare, 'spare']]) git(outer, 'worktree', 'add', '-q', '-b', branch, at)
      w2 = createWorkspaceService()
      await w2.open(ws2)
    })
    afterAll(async () => {
      await disposeWorkspaceService(w2)
    })

    it('refuses, by real path, a worktree that is the project, contains it or the workspace, or is another project', async () => {
      const { ok, refused } = await checkedWorktrees(w2, q, [agent('z', alias(q, 'q-guard')), agent('y', alias(outer, 'outer-guard')), agent('x', alias(q2, 'q2-guard')), agent('s', alias(spare, 'spare-guard'))])
      expect(refused).toEqual([
        expect.stringMatching(/^Z's worktree .* \(it contains the project or the workspace\)$/),
        expect.stringMatching(/^Y's worktree .* \(it contains the project or the workspace\)$/),
        expect.stringMatching(/^X's worktree .* \(it is another project of the workspace\)$/)
      ])
      expect(ok.map((a) => a.id)).toEqual(['s'])
    })

    it('Delete moves the project and its own worktree to the trash, never a folder those guards protect', async () => {
      const trashDir = join(base, 'trash')
      const was = process.env.HIVE_TEST_TRASH_DIR
      process.env.HIVE_TEST_TRASH_DIR = trashDir
      try {
        const agents = [agent('z', alias(q, 'q-delete')), agent('y', alias(outer, 'outer-delete')), agent('x', alias(q2, 'q2-delete')), agent('s', alias(spare, 'spare-delete'))]
        writeFileSync(join(q, '.hive', 'project.json'), JSON.stringify({ version: 2, agents }))
        const { warnings } = await inWorkspace(w2, () => removeProject(q, 'delete'))
        expect(warnings).toEqual([expect.stringMatching(/^Left alone: Z's worktree .*contains the project/), expect.stringMatching(/^Left alone: Y's worktree .*contains the project/), expect.stringMatching(/^Left alone: X's worktree .*another project/)])
        // What went: the project, and the one worktree that was safe (by the name the agent had for it).
        const gone = readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l).from as string)
        expect(gone.map((p) => p.toLowerCase())).toEqual([q, join(aliases, 'spare-delete')].map((p) => p.toLowerCase()))
        for (const kept of [outer, ws2, q2, join(outer, 'a.txt'), join(aliases, 'outer-delete'), join(aliases, 'q2-delete')]) expect(existsSync(kept)).toBe(true)
      } finally {
        if (was === undefined) delete process.env.HIVE_TEST_TRASH_DIR
        else process.env.HIVE_TEST_TRASH_DIR = was
      }
    })
  })

  it('resumes a session whose recorded folder is its worktree by another name', async () => {
    const info = providerService.info
    const enabled = config.settings.providers['claude-code'].enabled
    providerService.info = ((id: string) => ({ provider: id, found: true, path: join(base, 'no-cli.exe') })) as never
    config.settings.providers['claude-code'].enabled = true
    try {
      const named = alias(tree, 'tree-resume')
      await w.mutateProjectConfig(proj, () => ({ worktreeSetup: 'echo setup', agents: [{ id: 'r', name: 'R', provider: 'claude-code', needsSetup: true, worktree: { path: named, branch: 'hive/a', base: 'main' } } as AgentDef] }))
      const id = '6f1d3b52-1c1e-4a39-9d5e-2f7a1b0c4d11'
      await w.upsertSession(proj, { id, agent: 'claude-code', agentId: 'r', name: 'Earlier', cwd: tree, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), archived: false })
      // Stopped just before its terminal would start (the worktree's setup), past every check of the folder.
      const past = new Error('past the checks')
      const start = inWorkspace(w, () => sessions.start(proj, { agentId: 'r', resumeId: id, name: 'Later', allowed: () => { throw past } }))
      await expect(start).rejects.toBe(past)
    } finally {
      providerService.info = info
      config.settings.providers['claude-code'].enabled = enabled
      await w.mutateProjectConfig(proj, () => ({ agents: [] }))
    }
  })
})
