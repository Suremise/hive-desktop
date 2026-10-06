// Agent templates (#126): what a template holds and leaves out, reading one as untrusted input, saving and loading
// round trips in both scopes, names clashing across scopes and within one, a damaged file, the load's checks (running
// or starting agents, uncommitted or unreadable worktrees, missing providers, agents changed meanwhile), the fence on
// starts for the whole load, staging then publishing at once (a failure or a change meanwhile leaves the project as it
// is now), and adding one agent. #127: listing every scope, rename, duplicate, delete, export then import (a round trip,
// nothing personal in the file), an import checked first and refused saying why, name clashes (replace, keep both), an
// unknown coding agent kept but blocking a load, a project's template loaded into another project, and changes at once
// to one place (imports, duplicates, saves) serialised.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TEMPLATE_VERSION, exportFileName, readTemplate, templateFile, templateFrom, uniqueName, uniqueTemplateName, unknownProviders } from '../src/shared/templates'
import type { AgentDef } from '../src/shared/types'

const base = mkdtempSync(join(tmpdir(), 'hive-templates-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/** Makes the worktree check throw (rather than report a git failure). */
let statusThrows = false
/** Holds the next listing of a project's worktrees, once git has given it, until the test lets it go (#289). */
let holdNextListing: ((listed: unknown) => Promise<unknown>) | null = null
/** Removing this branch's worktree goes as when a ref moves in the last step: the folder goes, the branch stays (#313). */
let branchStaysFor: string | null = null
vi.mock('../src/main/worktrees', async (original) => {
  const real = await original<typeof import('../src/main/worktrees')>()
  return {
    ...real,
    branchStatus: async (...a: Parameters<typeof real.branchStatus>) => (statusThrows ? Promise.reject(new Error('git exploded')) : real.branchStatus(...a)),
    removeCheckedWorktree: async (...a: Parameters<typeof real.removeCheckedWorktree>) => {
      if (a[1].branch !== branchStaysFor) return real.removeCheckedWorktree(...a)
      await real.removeWorktree(a[0], a[1], false)
      return { deleted: true, branchKept: true, reason: 'main changed since it was checked' }
    },
    listWorktrees: async (...a: Parameters<typeof real.listWorktrees>) => {
      const listed = await real.listWorktrees(...a)
      const hold = holdNextListing
      holdNextListing = null
      return hold ? ((await hold(listed)) as typeof listed) : listed
    }
  }
})

/** The next listing is held once git has given it: `reached` when it is, `release` lets it go on. */
function holdListing(): { reached: Promise<void>; release: () => void } {
  let reached!: () => void
  let release!: () => void
  const r = new Promise<void>((res) => (reached = res))
  const gate = new Promise<void>((res) => (release = res))
  holdNextListing = async (listed) => {
    reached()
    await gate
    return listed
  }
  return { reached: r, release }
}

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { sessions } = await import('../src/main/sessions')
const tasks = await import('../src/main/tasks')
const { addAgent, claimMark, removedSince, reserveForRemoval } = await import('../src/main/projectAgents')

describe('the template format', () => {
  const agents: AgentDef[] = [
    { id: 'a1', name: 'Builder', role: 'builder', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', use200kContext: true, lastSessionId: 's1', worktree: { path: 'C:/w/b', branch: 'hive/builder', base: 'main' }, needsSetup: true },
    { id: 'a2', name: 'Reviewer', persona: 'x' } as AgentDef
  ]
  it("saves each agent's settings, role, provider and whether it has a worktree, and the layout; never sessions, paths, setup state or personas", () => {
    const t = templateFrom('  Build and review ', agents, 'columns2', () => 'codex', new Date('2026-10-05T10:00:00Z'))
    expect(t).toEqual({
      version: TEMPLATE_VERSION,
      name: 'Build and review',
      savedAt: '2026-10-05T10:00:00.000Z',
      layout: 'columns2',
      agents: [
        { name: 'Builder', role: 'builder', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', use200kContext: true, worktree: true },
        // An agent without its own provider: the one it runs now.
        { name: 'Reviewer', provider: 'codex', worktree: false }
      ]
    })
    expect(JSON.stringify(t)).not.toMatch(/s1|C:\/w\/b|hive\/builder|needsSetup|persona|"id"/)
    expect(readTemplate(JSON.parse(JSON.stringify(t)))).toEqual(t)
  })

  it('reads a file as untrusted: what it can use, else why not', () => {
    const ok = { version: 1, name: 'T', savedAt: 'x', layout: 'mosaic', agents: [{ name: 'A', provider: 'claude-code', role: '  a   b ', extra: 1 }] }
    expect(readTemplate(ok)).toEqual({ version: 1, name: 'T', savedAt: '', layout: 'auto', agents: [{ name: 'A', role: 'a b', provider: 'claude-code', worktree: false }] })
    expect(readTemplate({ ...ok, version: TEMPLATE_VERSION + 1 })).toMatch(/newer version of Hive/)
    expect(readTemplate({ ...ok, version: undefined })).toMatch(/no version/)
    expect(readTemplate({ ...ok, agents: [] })).toMatch(/no agents/)
    expect(readTemplate({ ...ok, agents: Array.from({ length: 13 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code' })) })).toMatch(/up to 12/)
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code' }, { name: 'a', provider: 'claude-code' }] })).toMatch(/Two agents are called/)
    // A provider this Hive doesn't know is kept (shown flagged; loading it is refused), if it looks like a provider's id.
    const later = readTemplate({ ...ok, agents: [{ name: 'A', provider: 'gemini' }, { name: 'B', provider: 'claude-code' }] })
    expect(typeof later !== 'string' && later.agents.map((a) => a.provider)).toEqual(['gemini', 'claude-code'])
    expect(typeof later !== 'string' && unknownProviders(later.agents)).toEqual(['gemini'])
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: '../x' }] })).toMatch(/coding agent isn't one Hive can use/)
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code', model: 'rm -rf /' }] })).toMatch(/model isn't one/)
    expect(readTemplate('nope')).toMatch(/isn't a Hive agent template/)
  })

  it('names files safely and makes taken names unique', () => {
    expect(exportFileName('Build: review?')).toBe('Build review.hive-template.json')
    expect(exportFileName('...')).toBe('template.hive-template.json')
    expect(uniqueTemplateName('Pair', ['pair', 'Pair (2)'])).toBe('Pair (3)')
    expect(uniqueTemplateName('x'.repeat(60), ['x'.repeat(60)])).toBe(`${'x'.repeat(56)} (2)`)
    expect(templateFile('Build & Review!')).toBe('build-review.json')
    expect(templateFile('Build & Review!', 2)).toBe('build-review-2.json')
    expect(templateFile('日本語')).toBe('template.json')
    expect(uniqueName('Builder', ['builder', 'Builder 2'])).toBe('Builder 3')
    expect(uniqueName('Reviewer', ['Builder'])).toBe('Reviewer')
  })
})

describe('claims on a worktree being removed (#289)', () => {
  it('refuses a claim whose removal went on at any time since it looked, not one that looked after it ended', () => {
    const p = join(base, 'claimed')
    const before = claimMark()
    const release = reserveForRemoval(p)
    const during = claimMark()
    expect([removedSince(p, before), removedSince(p, during)]).toEqual([true, true])
    expect(() => reserveForRemoval(p)).toThrow(/already being removed/)
    release()
    const after = claimMark()
    expect([removedSince(p, before), removedSince(p, during), removedSince(p, after)]).toEqual([true, true, false])
    // Another worktree, and paths written differently, are matched as the same folder only when they are.
    expect(removedSince(join(base, 'other'), before)).toBe(false)
    expect(removedSince(p.toUpperCase(), before)).toBe(true)
  })
})

describe('saving and loading templates', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8'))
  const names = (p: string) => cfgOf(p).agents.map((a: AgentDef) => a.name)
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const live = new Set<string>()
  /** Starts held part-way (reserved, not yet live) until released. */
  const held: (() => void)[] = []
  beforeAll(async () => {
    for (const p of [alpha, beta]) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', p])
      writeFileSync(join(p, 'a.txt'), 'a')
      git(p, 'add', '.')
      git(p, 'commit', '-qm', 'a')
    }
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'columns2', agents: [{ id: 'a1', name: 'Builder', role: 'builder', provider: 'claude-code', model: 'opus' }, { id: 'a2', name: 'Reviewer', provider: 'claude-code' }] }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'b1', name: 'Old', provider: 'claude-code' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    config.settings.providers['claude-code'].enabled = true
    providerService.info = ((id: string) => ({ provider: id, found: true })) as never
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (live.has(id) ? ({ projectPath: p, agentId: id, status: 'ready' } as never) : null),
      // A start that takes its time: reserved until the test lets it go, then it "fails" (nothing is spawned).
      startReserved: () => new Promise((_, reject) => held.push(() => reject(new Error('released'))))
    })
  })
  afterAll(async () => disposeWorkspaceService(w))
  beforeEach(() => {
    live.clear()
    templates.testHooks.staged = undefined
    templates.testHooks.beforeRemoval = undefined
    templates.testHooks.removing = undefined
  })

  it('saves in either scope; a name in both is listed twice, and saving over a name asks first', async () => {
    const saved = await run(() => templates.saveTemplate(alpha, 'workspace', 'Pair'))
    expect('saved' in saved && saved.saved).toMatchObject({ scope: 'workspace', file: 'pair.json', name: 'Pair', layout: 'columns2' })
    await run(() => templates.saveTemplate(alpha, 'project', 'pair'))
    const listed = await run(() => templates.listTemplates(alpha))
    expect(listed.map((t) => `${t.scope}:${t.name}`)).toEqual(['workspace:Pair', 'project:pair'])
    // The project's are its own: beta sees only the workspace's.
    expect((await run(() => templates.listTemplates(beta))).map((t) => t.name)).toEqual(['Pair'])
    // The same name again (case aside): it exists, unless replacing is asked for.
    expect(await run(() => templates.saveTemplate(alpha, 'workspace', 'PAIR'))).toEqual({ exists: 'pair.json' })
    const again = await run(() => templates.saveTemplate(alpha, 'workspace', 'PAIR', true))
    expect('saved' in again && again.saved.name).toBe('PAIR')
    // Another name whose file name would be the same: a file of its own.
    const other = await run(() => templates.saveTemplate(alpha, 'workspace', 'pair!'))
    expect('saved' in other && other.saved.file).toBe('pair-2.json')
    expect(existsSync(join(wsPath, '.hive', 'templates', 'pair.json.bak'))).toBe(true)
  })

  it('a damaged template is recovered from its copy; one past saving is listed with why it cannot be used', async () => {
    const dir = join(wsPath, '.hive', 'templates')
    writeFileSync(join(dir, 'pair.json'), '{ damaged')
    const listed = await run(() => templates.listTemplates(alpha))
    const recovered = listed.find((t) => t.file === 'pair.json')
    expect([recovered?.name, recovered?.problem]).toEqual(['PAIR', undefined])
    expect(readdirSync(dir).some((f) => f.startsWith('pair.json.corrupt-'))).toBe(true)
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ version: 99, name: 'Future', agents: [] }))
    expect((await run(() => templates.listTemplates(alpha))).find((t) => t.file === 'broken.json')).toMatchObject({ name: 'Future', problem: expect.stringMatching(/newer version/) })
    await expect(run(() => templates.templatePlan(alpha, 'workspace', 'broken.json'))).rejects.toThrow(/can't be used: It was made by a newer version/)
    await expect(run(() => templates.templatePlan(alpha, 'workspace', '../project.json'))).rejects.toThrow(/no longer there/)
  })

  it('loading replaces the agents and the layout, recreating them exactly; their open cards go back', async () => {
    await run(() => tasks.createTask({ title: 'Old work', project: 'beta', agent: 'b1', column: 'doing' }, { kind: 'user' }))
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'pair-2.json'))
    expect(plan.blocked).toEqual([])
    expect(plan.remove.map((a) => a.name)).toEqual(['Old'])
    expect(plan.create.map((a) => a.name)).toEqual(['Builder', 'Reviewer'])
    const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair-2.json', ['b1']))
    expect(r).toEqual({ created: ['Builder', 'Reviewer'], removed: ['Old'], oldWorktrees: [] })
    const cfg = cfgOf(beta)
    expect(cfg.layout).toBe('columns2')
    expect(cfg.agents.map((a: AgentDef) => [a.name, a.role, a.model, a.provider])).toEqual([['Builder', 'builder', 'opus', 'claude-code'], ['Reviewer', undefined, undefined, 'claude-code']])
    expect(cfg.agents.some((a: AgentDef) => a.id === 'b1')).toBe(false)
    const card = (await run(() => tasks.allTasks())).find((c) => c.title === 'Old work')!
    expect([card.agent, card.column]).toEqual([null, 'todo'])
  })

  it('refuses while an agent runs, a worktree has uncommitted work, a provider is off, or the agents changed meanwhile', async () => {
    const ids = () => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const first = ids()[0]
    live.add(first)
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([expect.stringMatching(/Builder is running or starting: stop it first/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))).rejects.toThrow(/can't be loaded yet/)
    live.clear()
    config.settings.providers['claude-code'].enabled = false
    const off = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(off.missing).toEqual([{ provider: 'claude-code', reason: expect.stringMatching(/turned off/), agents: ['Builder', 'Reviewer'] }])
    config.settings.providers['claude-code'].enabled = true
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ['someone-else']))).rejects.toThrow(/changed since you looked/)
    expect(ids()).toHaveLength(2)
    // A worktree agent with uncommitted work.
    const wtPath = join(base, 'beta-wt')
    git(beta, 'worktree', 'add', '-q', '-b', 'hive/wt', wtPath, 'main')
    writeFileSync(join(wtPath, 'b.txt'), 'uncommitted')
    await w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'wt1', name: 'Tree', provider: 'claude-code', worktree: { path: wtPath, branch: 'hive/wt', base: 'main' } }] }))
    const dirty = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(dirty.blocked).toEqual([expect.stringMatching(/Tree has uncommitted work in its worktree/)])
  })

  it("can't tell whether a worktree is clean: blocked, whether git fails in it or the check throws", async () => {
    const wtPath = join(base, 'beta-wt')
    writeFileSync(join(wtPath, 'b.txt'), 'a')
    git(wtPath, 'add', '.')
    git(wtPath, 'commit', '-qm', 'b')
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([])
    // Git fails in the worktree's folder (its link to the repository is broken).
    // (Moved aside, not overwritten: Windows won't open a hidden file to replace it.)
    renameSync(join(wtPath, '.git'), join(wtPath, '.git-aside'))
    writeFileSync(join(wtPath, '.git'), 'gitdir: C:/nowhere/at/all')
    const failed = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(failed.blocked).toEqual([expect.stringMatching(/couldn't check Tree's worktree .*Git couldn't check hive\/wt/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', failed.remove.map((a) => a.id)))).rejects.toThrow(/can't be loaded yet/)
    rmSync(join(wtPath, '.git'))
    renameSync(join(wtPath, '.git-aside'), join(wtPath, '.git'))
    // The check itself throws.
    statusThrows = true
    const threw = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    statusThrows = false
    expect(threw.blocked).toEqual([expect.stringMatching(/couldn't check Tree's worktree .*: git exploded/)])
    // Tree goes, so later loads into beta aren't blocked.
    await w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.filter((a) => a.id !== 'wt1') }))
  })

  it('a start under way blocks the load; one tried during the load is refused; the fence goes however the load ends', async () => {
    const ids = (): string[] => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    // A start that began before the load and hasn't finished (reserved, not live yet).
    const slow = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true))
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([expect.stringMatching(/Builder is running or starting/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))).rejects.toThrow(/can't be loaded yet/)
    held.shift()!()
    expect(await slow).toBe('released')
    // The failed load lifted its fence: a start goes ahead.
    const next = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true))
    held.shift()!()
    expect(await next).toBe('released')
    // During a load, the project's agents can't start (old or new); after it, they can.
    const before = ids()
    const refused: string[] = []
    templates.testHooks.staged = async () => {
      for (const id of before) refused.push(await run(() => sessions.start(beta, { agentId: id })).then(() => 'started', (e: Error) => e.message))
    }
    await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', before))
    expect(refused.length).toBeGreaterThan(0)
    expect(new Set(refused)).toEqual(new Set(["A template is being loaded into this project, so its agents can't start now."]))
    const after = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true))
    held.shift()!()
    expect(await after).toBe('released')
  })

  it('staged, then published at once: a failure part-way leaves the project as it was and removes the worktrees made for it', async () => {
    mkdirSync(join(alpha, '.hive', 'templates'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'templates', 'trees.json'), JSON.stringify({ version: 1, name: 'Trees', layout: 'rows2', agents: [{ name: 'Tree A', provider: 'claude-code', worktree: true }, { name: 'Tree B', provider: 'claude-code', worktree: true }] }))
    const before = cfgOf(alpha)
    const trees = (): number => git(alpha, 'worktree', 'list', '--porcelain').toString().split('\n').filter((l) => l.startsWith('worktree ')).length
    const treesBefore = trees()
    const seen: string[] = []
    templates.testHooks.staged = async (name) => {
      // Nothing of the load shows until it is published.
      seen.push(...names(alpha))
      if (name === 'Tree B') throw new Error('git ran out of disk')
    }
    await expect(run(() => templates.loadTemplate(alpha, 'project', 'trees.json', before.agents.map((a: AgentDef) => a.id)))).rejects.toThrow(/Nothing was changed: git ran out of disk/)
    expect(seen).toEqual([...names(alpha), ...names(alpha)])
    expect(cfgOf(alpha)).toEqual(before)
    expect(trees()).toBe(treesBefore)
  })

  it('an agent added while the load was staging is kept, and the load refused', async () => {
    const before = cfgOf(alpha)
    templates.testHooks.staged = async (name) => {
      if (name === 'Builder') await run(() => addAgent(alpha, { name: 'Concurrent', location: 'project' }))
    }
    await expect(run(() => templates.loadTemplate(alpha, 'workspace', 'pair.json', before.agents.map((a: AgentDef) => a.id)))).rejects.toThrow(/changed while the template was loading: nothing was changed/)
    expect(names(alpha)).toEqual([...before.agents.map((a: AgentDef) => a.name), 'Concurrent'])
    expect(cfgOf(alpha).layout).toBe(before.layout)
  })

  it('adds one agent of a template, the others left alone; a taken name gets a number', async () => {
    const before = names(alpha)
    const def = await run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 0))
    expect(def.name).toBe('Builder 2')
    expect(def.role).toBe('builder')
    expect(names(alpha)).toEqual([...before, 'Builder 2'])
    await expect(run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 9))).rejects.toThrow(/no longer in the template/)
  })

  // --- #127: the Templates view and tab, rename, duplicate, delete, export and import.

  it('lists every template of the workspace: the workspace\'s, then each project\'s with its project', async () => {
    const all = await run(() => templates.listAllTemplates())
    const ws = all.filter((t) => t.scope === 'workspace')
    expect(ws.length).toBeGreaterThan(0)
    expect(ws.every((t) => t.project === undefined)).toBe(true)
    expect(all.findIndex((t) => t.scope === 'project')).toBe(ws.length)
    expect(all.filter((t) => t.scope === 'project').map((t) => [t.project, t.file])).toEqual([[alpha, 'pair.json'], [alpha, 'trees.json']])
    // A project's tab lists its own with their project too.
    expect((await run(() => templates.listTemplates(alpha))).find((t) => t.scope === 'project')?.project).toBe(alpha)
  })

  it("renames where it is kept (a name taken there is refused); duplicates anywhere, numbering a taken name; deletes to the Recycle Bin", async () => {
    const trashed: string[] = []
    ;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p: string) => {
      trashed.push(p)
      rmSync(p)
    }
    const saved = await run(() => templates.saveTemplate(alpha, 'project', 'Solo'))
    const solo = 'saved' in saved ? saved.saved : null
    const ref = { scope: 'project' as const, project: alpha, file: solo!.file }
    await expect(run(() => templates.renameTemplate(ref, 'PAIR'))).rejects.toThrow(/already a template called "PAIR" there/)
    const renamed = await run(() => templates.renameTemplate(ref, '  Solo   act '))
    expect([renamed.name, renamed.file]).toEqual(['Solo act', solo!.file])
    // Into the workspace (free there), then into the same place again: numbered.
    const copy = await run(() => templates.duplicateTemplate(ref, { scope: 'workspace' }))
    expect([copy.scope, copy.name, copy.project]).toEqual(['workspace', 'Solo act', undefined])
    const again = await run(() => templates.duplicateTemplate(ref, { scope: 'project', project: alpha }))
    expect(again.name).toBe('Solo act (2)')
    expect(again.agents).toEqual(renamed.agents)
    // Into another project: beta's own.
    expect((await run(() => templates.duplicateTemplate(ref, { scope: 'project', project: beta }))).project).toBe(beta)
    await run(() => templates.deleteTemplate({ scope: 'project', project: alpha, file: again.file }))
    expect(trashed.map((p) => basename(p))).toEqual([again.file, `${again.file}.bak`])
    expect((await run(() => templates.listTemplates(alpha))).some((t) => t.name === 'Solo act (2)')).toBe(false)
    await expect(run(() => templates.deleteTemplate({ scope: 'project', project: alpha, file: again.file }))).rejects.toThrow(/no longer there/)
    // Never a path for a file, nor a project outside the workspace.
    await expect(run(() => templates.renameTemplate({ scope: 'workspace', file: '../project.json' }, 'x'))).rejects.toThrow(/no longer there/)
    await expect(run(() => templates.duplicateTemplate(ref, { scope: 'project', project: base }))).rejects.toThrow()
  })

  it('export then import round-trips a template exactly; the file holds no paths, ids, sessions or names of people', async () => {
    const out = join(base, 'exports')
    mkdirSync(out, { recursive: true })
    const file = join(out, exportFileName('Solo act'))
    expect(basename(file)).toBe('Solo act.hive-template.json')
    await run(() => templates.exportTemplate({ scope: 'workspace', file: 'solo-act.json' }, file))
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/[A-Za-z]:\\\\|hive-templates-|"id"|lastSessionId|worktree"\s*:\s*\{|needsSetup|persona/)
    const exported = JSON.parse(text)
    expect(Object.keys(exported).sort()).toEqual(['agents', 'layout', 'name', 'savedAt', 'version'])
    const before = (await run(() => templates.listAllTemplates())).find((t) => t.scope === 'workspace' && t.file === 'solo-act.json')!
    // Into beta, which already has one of that name (the duplicate): a clash, until told what to do.
    expect(await run(() => templates.inspectImport(file))).toEqual({ path: file, name: 'Solo act', agents: before.agents.length, unknown: [] })
    expect(await run(() => templates.importTemplate(file, { scope: 'project', project: beta }))).toEqual({ clash: 'Solo act' })
    const kept = await run(() => templates.importTemplate(file, { scope: 'project', project: beta }, 'keep'))
    expect('imported' in kept && kept.imported.name).toBe('Solo act (2)')
    const replaced = await run(() => templates.importTemplate(file, { scope: 'project', project: beta }, 'replace'))
    const r = 'imported' in replaced ? replaced.imported : null
    expect(r).toMatchObject({ scope: 'project', project: beta, name: before.name, savedAt: before.savedAt, layout: before.layout, agents: before.agents })
    expect((await run(() => templates.listTemplates(beta))).filter((t) => t.scope === 'project').map((t) => t.name).sort()).toEqual(['Solo act', 'Solo act (2)'])
    // Exported again, the same file.
    const twice = join(out, 'twice.json')
    await run(() => templates.exportTemplate({ scope: 'project', project: beta, file: r!.file }, twice))
    expect(readFileSync(twice, 'utf8')).toBe(text)
  })

  it('an import is checked first and refused, saying why; nothing is written. An unknown coding agent is kept, flagged, and blocks loading', async () => {
    const dir = join(base, 'imports')
    mkdirSync(dir, { recursive: true })
    const f = (name: string, body: string): string => {
      writeFileSync(join(dir, name), body)
      return join(dir, name)
    }
    const good = { version: 1, name: 'Shared', savedAt: '2026-10-05T10:00:00.000Z', layout: 'columns2', agents: [{ name: 'A', provider: 'claude-code', worktree: false }] }
    const where = { scope: 'workspace' as const }
    const count = async (): Promise<number> => (await run(() => templates.listAllTemplates())).length
    const n = await count()
    await expect(run(() => templates.importTemplate(f('notjson.json', '{ nope'), where))).rejects.toThrow(/not JSON/)
    await expect(run(() => templates.importTemplate(f('newer.json', JSON.stringify({ ...good, version: 2 })), where))).rejects.toThrow(/newer version of Hive/)
    await expect(run(() => templates.importTemplate(f('many.json', JSON.stringify({ ...good, agents: Array.from({ length: 13 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code' })) })), where))).rejects.toThrow(/up to 12/)
    await expect(run(() => templates.importTemplate(f('big.json', JSON.stringify({ ...good, pad: 'x'.repeat(300 * 1024) })), where))).rejects.toThrow(/over 256 KB/)
    await expect(run(() => templates.importTemplate(join(dir, 'missing.json'), where))).rejects.toThrow(/isn't there/)
    expect(await count()).toBe(n)
    // With a BOM, extra keys and a provider from a newer Hive: imported (the extras dropped), flagged.
    const later = f('later.json', '﻿' + JSON.stringify({ ...good, name: 'Later', author: 'someone', agents: [...good.agents, { name: 'G', provider: 'gemini', model: 'g-1' }] }))
    expect((await run(() => templates.inspectImport(later))).unknown).toEqual(['gemini'])
    const imported = await run(() => templates.importTemplate(later, where))
    const t = 'imported' in imported ? imported.imported : null
    expect(t?.agents.map((a) => a.provider)).toEqual(['claude-code', 'gemini'])
    expect(readFileSync(join(wsPath, '.hive', 'templates', t!.file), 'utf8')).not.toMatch(/author|someone/)
    const plan = await run(() => templates.templatePlan(beta, 'workspace', t!.file))
    expect(plan.blocked).toEqual([expect.stringMatching(/doesn't know the coding agent "gemini".*needed by G/)])
    await expect(run(() => templates.addAgentFromTemplate(beta, 'workspace', t!.file, 1))).rejects.toThrow(/doesn't know the coding agent "gemini"/)
  })

  it("a project's template loads into another project (from the Templates view), its worktrees new ones in that project only (#268)", async () => {
    // alpha has its own worktree agent "Tree A" (on alpha's hive/tree-a); beta already has a hive/tree-b branch, and a setup command.
    const source = await run(() => addAgent(alpha, { name: 'Tree A', location: 'new-worktree' }))
    git(beta, 'branch', 'hive/tree-b')
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), worktreeSetup: 'npm install' }))
    const ids = cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const plan = await run(() => templates.templatePlan(beta, 'project', 'trees.json', alpha))
    expect([plan.name, plan.blocked]).toEqual(['Trees', []])
    expect(plan.setup).toBe('npm install')
    // Where each new worktree goes: beta's own branches (taken ones numbered) and folders under beta's name.
    expect(plan.worktrees.map((tree) => tree?.branch)).toEqual(['hive/tree-a', 'hive/tree-b-2'])
    expect(plan.worktrees.every((tree) => !!tree && basename(join(tree.path, '..')) === 'beta' && tree.base === 'main')).toBe(true)
    expect(plan.worktrees[0]!.path.toLowerCase()).not.toBe(source.worktree!.path.toLowerCase())
    // Without `from`, beta's own folder: it has no trees.json.
    await expect(run(() => templates.templatePlan(beta, 'project', 'trees.json'))).rejects.toThrow(/no longer there/)
    const r = await run(() => templates.loadTemplate(beta, 'project', 'trees.json', ids, alpha))
    expect(r.created).toEqual(['Tree A', 'Tree B'])
    expect(cfgOf(beta).layout).toBe(plan.layout)
    // What the plan showed is what was made: new worktrees on new branches of beta's repository, set up on first start.
    const made = cfgOf(beta).agents.map((a: AgentDef) => a.worktree)
    expect(made.map((tree: AgentDef['worktree']) => [tree!.branch, tree!.path.toLowerCase()])).toEqual(plan.worktrees.map((tree) => [tree!.branch, tree!.path.toLowerCase()]))
    expect(cfgOf(beta).agents.every((a: AgentDef) => a.needsSetup)).toBe(true)
    const betaTrees = git(beta, 'worktree', 'list', '--porcelain').toString().toLowerCase()
    for (const tree of made) expect(betaTrees).toContain(tree!.path.toLowerCase().replace(/\\/g, '/'))
    expect(git(beta, 'branch', '--list', 'hive/tree-a').toString()).toMatch(/hive\/tree-a/)
    // Nothing points at alpha's: its worktree and branch are alpha's alone, untouched.
    expect(made.some((tree: AgentDef['worktree']) => tree!.path.toLowerCase() === source.worktree!.path.toLowerCase())).toBe(false)
    expect(git(alpha, 'worktree', 'list', '--porcelain').toString().toLowerCase()).not.toContain('/beta/')
    expect(cfgOf(alpha).agents.find((a: AgentDef) => a.id === source.id)?.worktree).toEqual(source.worktree)
  })

  it('loading the same template again works in the same worktrees; switching templates and back reattaches them; a dirty one gets a new worktree, saying why (#289)', async () => {
    const ids = (): string[] => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const places = (): string[][] => cfgOf(beta).agents.map((a: AgentDef) => [a.name, a.worktree?.branch ?? '', a.worktree?.path.toLowerCase() ?? ''])
    const branches = (): string[] => git(beta, 'branch', '--list', 'hive/*').toString().split('\n').map((s) => s.replace('*', '').trim()).filter(Boolean).sort()
    // From the test before: Tree A on hive/tree-a, Tree B on hive/tree-b-2 (hive/tree-b was taken).
    const trees = places()
    expect(trees.map((p) => p[1])).toEqual(['hive/tree-a', 'hive/tree-b-2'])
    const known = branches()
    let plan = await run(() => templates.templatePlan(beta, 'project', 'trees.json', alpha))
    expect(plan.worktrees.map((t) => [t?.reuse, t?.branch])).toEqual([[true, 'hive/tree-a'], [true, 'hive/tree-b-2']])
    // Neither has started yet, so neither has run beta's setup command (npm install): loaded again, both still will.
    const setup = (): boolean[] => cfgOf(beta).agents.map((a: AgentDef) => !!a.needsSetup)
    const pending = (): string[] => (cfgOf(beta).setupPending ?? []).map((p: string) => p.toLowerCase())
    expect(setup()).toEqual([true, true])
    await run(() => templates.loadTemplate(beta, 'project', 'trees.json', ids(), alpha))
    expect(places()).toEqual(trees)
    expect(branches()).toEqual(known)
    expect(setup()).toEqual([true, true])
    // Tree A's setup has run (its first start); Tree B's hasn't.
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), agents: cfgOf(beta).agents.map((a: AgentDef) => (a.name === 'Tree A' ? { ...a, needsSetup: false } : a)) }))
    // Another template replaces them (their worktrees stay, Tree B's remembered as still to set up), then back: the same
    // worktrees, found by name (Tree B's numbered); Tree B sets up on its first start, Tree A doesn't again.
    await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))
    expect(names(beta)).toEqual(['Builder', 'Reviewer'])
    expect(pending()).toEqual([trees[1][2]])
    plan = await run(() => templates.templatePlan(beta, 'project', 'trees.json', alpha))
    expect(plan.worktrees.map((t) => t?.reuse)).toEqual([true, true])
    await run(() => templates.loadTemplate(beta, 'project', 'trees.json', ids(), alpha))
    expect(places()).toEqual(trees)
    expect(branches()).toEqual(known)
    expect(setup()).toEqual([false, true])
    expect(pending()).toEqual([])
    // A worktree with uncommitted work isn't reused: a new one instead, saying why. Nothing is ever removed.
    await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))
    const wip = join(trees[0][2], 'wip.txt')
    writeFileSync(wip, 'unfinished')
    plan = await run(() => templates.templatePlan(beta, 'project', 'trees.json', alpha))
    expect(plan.worktrees[0]).toMatchObject({ branch: 'hive/tree-a-2', notReused: 'hive/tree-a has 1 uncommitted file' })
    expect(plan.worktrees[0]?.reuse).toBeUndefined()
    expect(plan.worktrees[1]?.reuse).toBe(true)
    rmSync(wip)
    expect(existsSync(trees[0][2]) && existsSync(trees[1][2])).toBe(true)
    // Add Agent from Template: a free, clean worktree of that name is worked in again; one an agent uses never is.
    expect(pending()).toEqual([trees[1][2]])
    const added = await run(() => templates.addAgentFromTemplate(beta, 'project', 'trees.json', 0, alpha))
    expect([added.name, added.reused, added.worktree?.path.toLowerCase(), !!added.needsSetup]).toEqual(['Tree A', true, trees[0][2], false])
    // Tree B's worktree, never set up, given to an agent again (Add Agent → Existing worktree): it sets up first.
    const b = await run(() => addAgent(beta, { name: 'Tree B', location: 'existing-worktree', worktreePath: trees[1][2] }))
    expect(!!b.needsSetup).toBe(true)
    expect(pending()).toEqual([])
    const again = await run(() => templates.addAgentFromTemplate(beta, 'project', 'trees.json', 0, alpha))
    expect([again.name, again.reused, again.worktree?.branch]).toEqual(['Tree A 2', undefined, 'hive/tree-a-2'])
  })

  it("offers the replaced agents' merged, clean worktrees for removal; removes only those asked for and still merged and clean, and only once the load is published (#289)", async () => {
    const ids = (): string[] => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const tree = (name: string): NonNullable<AgentDef['worktree']> => cfgOf(beta).agents.find((a: AgentDef) => a.name === name).worktree
    // From the test before: Tree A (hive/tree-a, nothing of its own: merged) and Tree A 2 (hive/tree-a-2, given a commit of its own).
    const merged = tree('Tree A')
    const unmerged = tree('Tree A 2')
    writeFileSync(join(unmerged.path, 'own.txt'), 'work')
    git(unmerged.path, 'add', '.')
    git(unmerged.path, 'commit', '-qm', 'own work')
    const orphan = cfgOf(alpha).agents.find((a: AgentDef) => a.name === 'Tree A')?.worktree?.path ?? join(base, 'nowhere')
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(plan.mergedInto).toBe('main')
    // Tree B (the test before gave its worktree back to an agent) is merged and clean too, but isn't asked for below.
    expect(plan.oldWorktrees.map((o) => [o.branch, o.removable, o.why])).toEqual([['hive/tree-a', true, undefined], ['hive/tree-b-2', true, undefined], ['hive/tree-a-2', false, '1 commit not merged into main']])
    const ask = { paths: [merged.path, unmerged.path, orphan], mergedInto: plan.mergedInto }
    // A refused load (the agents changed since they were shown) removes nothing.
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids().slice(1), undefined, ask))).rejects.toThrow(/changed since you looked/)
    expect(existsSync(merged.path) && existsSync(unmerged.path)).toBe(true)
    // Agents given the worktrees while they are being removed: one given hive/tree-a-2 before it is reserved keeps it (it
    // isn't removed); one asking for hive/tree-a once it is reserved, paused just before it goes, is refused.
    const claims: string[] = []
    // And two that saw hive/tree-a while it was still there, held after looking (as a slow machine might), finishing only
    // once it is gone: one that looked before its removal began, one while it was going on. Both are refused.
    const outcome = (name: string) => (p: Promise<AgentDef>) => p.then(() => `${name} added`, (e: Error) => `${name} refused: ${e.message}`)
    const stale: Promise<string>[] = []
    const holds: { release: () => void }[] = []
    const claimHeld = async (name: string): Promise<void> => {
      const hold = holdListing()
      stale.push(outcome(name)(run(() => addAgent(beta, { name, location: 'existing-worktree', worktreePath: merged.path }))))
      await hold.reached
      holds.push(hold)
    }
    templates.testHooks.beforeRemoval = async (branch) => {
      if (branch === 'hive/tree-a') await claimHeld('Before')
      if (branch === 'hive/tree-a-2') claims.push((await run(() => addAgent(beta, { name: 'Early', location: 'existing-worktree', worktreePath: unmerged.path }))).name)
    }
    templates.testHooks.removing = async (branch) => {
      if (branch !== 'hive/tree-a') return
      claims.push(await outcome('Late')(run(() => addAgent(beta, { name: 'Late', location: 'existing-worktree', worktreePath: merged.path }))))
      await claimHeld('During')
    }
    // Published: the merged, clean one goes with its branch; the unmerged one, asked for too, is kept (here because Early
    // works in it now); a path that was no replaced agent's (alpha's own worktree) isn't touched.
    const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(), undefined, ask))
    expect(claims).toEqual(['Late refused: That worktree is being removed, or was just removed.', 'Early'])
    // hive/tree-a is gone now; the held claims go on, and are refused.
    expect(existsSync(merged.path)).toBe(false)
    for (const h of holds) h.release()
    expect(await Promise.all(stale)).toEqual(['Before refused: That worktree is being removed, or was just removed.', 'During refused: That worktree is being removed, or was just removed.'])
    expect(names(beta)).toEqual(['Builder', 'Reviewer', 'Early'])
    expect(r.oldWorktrees).toEqual([{ branch: 'hive/tree-a', removed: true }, { branch: 'hive/tree-a-2', removed: false, why: 'an agent works in it now' }])
    // No agent works in a worktree that is gone.
    expect(cfgOf(beta).agents.every((a: AgentDef) => !a.worktree || existsSync(a.worktree.path))).toBe(true)
    expect(existsSync(merged.path)).toBe(false)
    expect(git(beta, 'branch', '--list', 'hive/tree-a').toString().trim()).toBe('')
    expect(existsSync(join(unmerged.path, 'own.txt'))).toBe(true)
    expect(git(beta, 'branch', '--list', 'hive/tree-a-2').toString()).toMatch(/hive\/tree-a-2/)
    if (orphan !== join(base, 'nowhere')) expect(existsSync(orphan)).toBe(true)
    // Not asked: nothing is removed.
    expect((await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))).oldWorktrees).toEqual([])
  })

  it('edits a template where it is kept (#271): agents added, changed, reordered and removed, its name, description and layout; checked first; refused if it changed meanwhile or the name is taken', async () => {
    const dir = join(alpha, '.hive', 'templates')
    writeFileSync(join(dir, 'edit-me.json'), JSON.stringify({ version: 1, name: 'Edit me', savedAt: '2026-10-06T10:00:00.000Z', layout: 'auto', agents: [{ name: 'One', provider: 'claude-code', worktree: false }, { name: 'Two', provider: 'claude-code', role: 'reviewer', worktree: true }, { name: 'Three', provider: 'claude-code', worktree: false }] }))
    const ref = { scope: 'project' as const, project: alpha, file: 'edit-me.json' }
    const edited = {
      name: '  Edited   pair ',
      description: '  Builds, then reviews. ',
      layout: 'columns2' as const,
      agents: [
        { name: 'Two', provider: 'claude-code', role: 'reviewer', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', worktree: false },
        { name: 'Builder', provider: 'claude-code', role: 'builder', use200kContext: true, worktree: true }
      ]
    }
    const saved = await run(() => templates.updateTemplate(ref, edited, '2026-10-06T10:00:00.000Z'))
    expect([saved.file, saved.name, saved.description, saved.layout]).toEqual(['edit-me.json', 'Edited pair', 'Builds, then reviews.', 'columns2'])
    expect(saved.agents).toEqual([
      { name: 'Two', role: 'reviewer', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', worktree: false },
      { name: 'Builder', role: 'builder', provider: 'claude-code', use200kContext: true, worktree: true }
    ])
    expect(saved.savedAt).not.toBe('2026-10-06T10:00:00.000Z')
    expect(JSON.parse(readFileSync(join(dir, 'edit-me.json'), 'utf8')).description).toBe('Builds, then reviews.')
    // It changed since this editor opened it (the old savedAt): refused, nothing written.
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: 'Late' }, '2026-10-06T10:00:00.000Z'))).rejects.toThrow(/changed since you started editing it/)
    expect(JSON.parse(readFileSync(join(dir, 'edit-me.json'), 'utf8')).name).toBe('Edited pair')
    // Checked as an import is, whatever the window sends.
    const now = saved.savedAt
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: 'Trees' }, now))).rejects.toThrow(/already a template called "Trees"/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [] }, now))).rejects.toThrow(/no agents/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: Array.from({ length: 13 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code', worktree: false })) }, now))).rejects.toThrow(/up to 12/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [edited.agents[0], { ...edited.agents[1], name: 'two' }] }, now))).rejects.toThrow(/Two agents are called "two"/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [{ ...edited.agents[0], provider: '../x' }] }, now))).rejects.toThrow(/coding agent isn't one/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: ' ' }, now))).rejects.toThrow(/Enter a name/)
    await expect(run(() => templates.updateTemplate({ ...ref, file: '../project.json' }, edited, now))).rejects.toThrow(/no longer there/)
    // A description too long (only a window that ignores the field's limit sends one) is left out; none removes it.
    expect((await run(() => templates.updateTemplate(ref, { ...edited, description: 'x'.repeat(501) }, now))).description).toBeUndefined()
    // Loaded into a project: exactly those agents, in that order, with that layout.
    const after = await run(() => templates.listTemplates(alpha))
    const t = after.find((e) => e.file === 'edit-me.json')!
    const plan = await run(() => templates.templatePlan(beta, 'project', 'edit-me.json', alpha))
    expect([plan.name, plan.layout, plan.create.map((a) => [a.name, a.role, a.model, a.worktree])]).toEqual([t.name, 'columns2', [['Two', 'reviewer', 'opus', false], ['Builder', 'builder', undefined, true]]])
  })

  it("Remove Agent keeping its worktree keeps a setup that never ran (#319): the next agent there runs it; a done one isn't run again; a deleted worktree is forgotten", async () => {
    const { removeAgent } = await import('../src/main/projectAgents')
    const pending = (): string[] => (cfgOf(beta).setupPending ?? []).map((p: string) => p.toLowerCase())
    const agent = (name: string): AgentDef => cfgOf(beta).agents.find((a: AgentDef) => a.name === name)
    expect(cfgOf(beta).worktreeSetup).toBe('npm install')
    // Never started: its setup is still to run. Removed, its worktree kept: remembered, and run by the next agent there.
    const keeper = await run(() => addAgent(beta, { name: 'Keeper', location: 'new-worktree' }))
    expect(keeper.needsSetup).toBe(true)
    await run(() => removeAgent(beta, keeper.id, { deleteWorktree: false }))
    expect(pending()).toContain(keeper.worktree!.path.toLowerCase())
    const again = await run(() => addAgent(beta, { name: 'Keeper again', location: 'existing-worktree', worktreePath: keeper.worktree!.path }))
    expect(again.needsSetup).toBe(true)
    expect(pending()).not.toContain(keeper.worktree!.path.toLowerCase())
    // Its setup done (its first start): removed and given again, it doesn't run again.
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), agents: cfgOf(beta).agents.map((a: AgentDef) => (a.id === again.id ? { ...a, needsSetup: false } : a)) }))
    await run(() => removeAgent(beta, again.id, { deleteWorktree: false }))
    expect(pending()).not.toContain(keeper.worktree!.path.toLowerCase())
    const third = await run(() => addAgent(beta, { name: 'Keeper 3', location: 'existing-worktree', worktreePath: keeper.worktree!.path }))
    expect(!!third.needsSetup).toBe(false)
    // A worktree another agent still works in is that agent's: nothing is remembered for it.
    const shared = await run(() => addAgent(beta, { name: 'Sharer', location: 'new-worktree' }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), agents: [...cfgOf(beta).agents, { ...agent('Sharer'), id: 'a-twin', name: 'Twin' }] }))
    await run(() => removeAgent(beta, shared.id, { deleteWorktree: false }))
    expect(pending()).not.toContain(shared.worktree!.path.toLowerCase())
    // Remove All (#291): one with work of its own is kept, so remembered; a merged, clean one is deleted, and forgotten.
    const busy = await run(() => addAgent(beta, { name: 'Busy', location: 'new-worktree' }))
    writeFileSync(join(busy.worktree!.path, 'own.txt'), 'work')
    git(busy.worktree!.path, 'add', '.')
    git(busy.worktree!.path, 'commit', '-qm', 'own work')
    const busyGone = await run(() => removeAgent(beta, busy.id, { deleteWorktree: 'merged-clean', mergedInto: 'main' }))
    expect(busyGone.worktree?.deleted).toBe(false)
    expect(pending()).toContain(busy.worktree!.path.toLowerCase())
    const neat = await run(() => addAgent(beta, { name: 'Neat', location: 'new-worktree' }))
    await run(() => removeAgent(beta, neat.id, { deleteWorktree: false }))
    expect(pending()).toContain(neat.worktree!.path.toLowerCase())
    const neatAgain = await run(() => addAgent(beta, { name: 'Neat again', location: 'existing-worktree', worktreePath: neat.worktree!.path }))
    // (Listed again, as a worktree kept from before would be: deleting it takes it off the list.)
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), setupPending: [...(cfgOf(beta).setupPending ?? []), neat.worktree!.path] }))
    expect(pending()).toContain(neat.worktree!.path.toLowerCase())
    const neatGone = await run(() => removeAgent(beta, neatAgain.id, { deleteWorktree: 'merged-clean', mergedInto: 'main' }))
    expect(neatGone.worktree?.deleted).toBe(true)
    expect(pending()).not.toContain(neat.worktree!.path.toLowerCase())
  })

  it("says when an old worktree's folder went but its branch stayed (#313)", async () => {
    const branchy = await run(() => addAgent(beta, { name: 'Branchy', location: 'new-worktree' }))
    const ids = cfgOf(beta).agents.map((a: AgentDef) => a.id)
    branchStaysFor = branchy.worktree!.branch
    try {
      const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids, undefined, { paths: [branchy.worktree!.path], mergedInto: 'main' }))
      expect(r.oldWorktrees).toEqual([{ branch: 'hive/branchy', removed: true, branchKept: true, why: 'main changed since it was checked' }])
    } finally {
      branchStaysFor = null
    }
    expect(existsSync(branchy.worktree!.path)).toBe(false)
    expect(git(beta, 'branch', '--list', 'hive/branchy').toString()).toMatch(/hive\/branchy/)
  })

  it('changes at once to one place never pick the same file or miss a name: imports, duplicates, saves', async () => {
    const dir = join(base, 'parallel')
    mkdirSync(dir, { recursive: true })
    const file = (name: string): string => {
      const f = join(dir, `${name.replace(/\W+/g, '-')}.json`)
      writeFileSync(f, JSON.stringify({ version: 1, name, savedAt: '', layout: 'auto', agents: [{ name: 'A', provider: 'claude-code' }] }))
      return f
    }
    const wsDir = join(wsPath, '.hive', 'templates')
    const namesIn = (d: string): string[] => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')).name).sort()
    // Two names whose file name is the same ("concurrent-one.json"): two files, both kept.
    const [one, two] = await Promise.all([run(() => templates.importTemplate(file('Concurrent One'), { scope: 'workspace' })), run(() => templates.importTemplate(file('Concurrent One!'), { scope: 'workspace' }))])
    const files = [one, two].map((r) => ('imported' in r ? r.imported.file : r.clash))
    expect(new Set(files).size).toBe(2)
    expect(['imported' in one && one.imported.name, 'imported' in two && two.imported.name]).toEqual(['Concurrent One', 'Concurrent One!'])
    expect(namesIn(wsDir).filter((n) => n.startsWith('Concurrent One'))).toEqual(['Concurrent One', 'Concurrent One!'])
    // The same name twice at once: one imported, the other a clash (never a silent replace).
    const same = file('Same Time')
    const both = await Promise.all([run(() => templates.importTemplate(same, { scope: 'workspace' })), run(() => templates.importTemplate(same, { scope: 'workspace' }))])
    expect(both.map((r) => ('imported' in r ? 'imported' : 'clash')).sort()).toEqual(['clash', 'imported'])
    // Keep Both three times at once: three names, three files.
    await Promise.all([1, 2, 3].map(() => run(() => templates.importTemplate(same, { scope: 'workspace' }, 'keep'))))
    expect(namesIn(wsDir).filter((n) => n.startsWith('Same Time'))).toEqual(['Same Time', 'Same Time (2)', 'Same Time (3)', 'Same Time (4)'])
    // Duplicates into the workspace from two projects at once (the same folder): two copies.
    const src = { scope: 'workspace' as const, file: 'pair.json' }
    const name = (await run(() => templates.listAllTemplates())).find((t) => t.scope === 'workspace' && t.file === 'pair.json')!.name
    const copies = await Promise.all([run(() => templates.duplicateTemplate(src, { scope: 'workspace', project: alpha })), run(() => templates.duplicateTemplate(src, { scope: 'workspace', project: beta }))])
    expect(new Set(copies.map((c) => c.file)).size).toBe(2)
    expect(copies.map((c) => c.name).sort()).toEqual([`${name} (2)`, `${name} (3)`])
    expect(namesIn(wsDir).filter((n) => n === `${name} (2)` || n === `${name} (3)`)).toHaveLength(2)
    // Saves of two names with the same file name, from two projects at once: both kept.
    const saves = await Promise.all([run(() => templates.saveTemplate(alpha, 'workspace', 'Racing')), run(() => templates.saveTemplate(beta, 'workspace', 'racing!'))])
    expect(new Set(saves.map((r) => ('saved' in r ? r.saved.file : r.exists))).size).toBe(2)
    expect(namesIn(wsDir).filter((n) => /^racing/i.test(n))).toEqual(['Racing', 'racing!'])
  })
})
