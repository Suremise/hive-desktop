// Agent templates (#126): what a template holds and leaves out, reading one as untrusted input, saving and loading
// round trips in both scopes, names clashing across scopes and within one, a damaged file, the load's checks (running
// or starting agents, uncommitted or unreadable worktrees, missing providers, agents changed meanwhile), the fence on
// starts for the whole load, staging then publishing at once (a failure or a change meanwhile leaves the project as it
// is now), and adding one agent.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TEMPLATE_VERSION, readTemplate, templateFile, templateFrom, uniqueName } from '../src/shared/templates'
import type { AgentDef } from '../src/shared/types'

const base = mkdtempSync(join(tmpdir(), 'hive-templates-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/** Makes the worktree check throw (rather than report a git failure). */
let statusThrows = false
vi.mock('../src/main/worktrees', async (original) => {
  const real = await original<typeof import('../src/main/worktrees')>()
  return { ...real, branchStatus: async (...a: Parameters<typeof real.branchStatus>) => (statusThrows ? Promise.reject(new Error('git exploded')) : real.branchStatus(...a)) }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { sessions } = await import('../src/main/sessions')
const tasks = await import('../src/main/tasks')
const { addAgent } = await import('../src/main/projectAgents')

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
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'gemini' }] })).toMatch(/doesn't know \(gemini\)/)
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code', model: 'rm -rf /' }] })).toMatch(/model isn't one/)
    expect(readTemplate('nope')).toMatch(/isn't a Hive agent template/)
  })

  it('names files safely and makes taken names unique', () => {
    expect(templateFile('Build & Review!')).toBe('build-review.json')
    expect(templateFile('Build & Review!', 2)).toBe('build-review-2.json')
    expect(templateFile('日本語')).toBe('template.json')
    expect(uniqueName('Builder', ['builder', 'Builder 2'])).toBe('Builder 3')
    expect(uniqueName('Reviewer', ['Builder'])).toBe('Reviewer')
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
    expect(r).toEqual({ created: ['Builder', 'Reviewer'], removed: ['Old'] })
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
})
