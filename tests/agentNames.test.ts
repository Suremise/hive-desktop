// Agent names unique across the workspace (#702): the rules (a project's prefix, a suggested name, a prefix for a
// template's names, duplicates from before), and Hive keeping them — Add Agent and its default name, a rename (its own
// name kept), a template's load (renamed, refused while a name is another project's, a name taken while it stages) and
// one of its agents, adds and renames in two projects at once (only one gets the name), duplicates from before flagged
// once, and why a template couldn't be loaded into a project without git.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { duplicateAgentNames, nameTaken, prefixedNames, projectPrefix, suggestAgentName } from '../src/shared/agentNames'
import type { AgentDef, HiveEvent } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-agentnames-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { addAgent, updateAgent } = await import('../src/main/projectAgents')
const { onHiveEvent } = await import('../src/main/events')

describe('the name rules', () => {
  it("a project's prefix is its initials", () => {
    expect(['hive', 'hive-desktop', 'amberLight', 'Amberlight', '2nd go', '---'].map(projectPrefix)).toEqual(['H', 'HD', 'AL', 'A', '2G', 'P'])
  })

  it('suggests a free name: the prefix before a short code, then longer ones, a word with its project, else a number', () => {
    expect(suggestAgentName('B1', 'hive', ['B1'])).toBe('HB1')
    expect(suggestAgentName('B1', 'amberlight', ['B1', 'AB1'])).toBe('AMB1')
    expect(suggestAgentName('B1', 'amberlight', ['b1', 'ab1', 'amb1'])).toBe('AMBB1')
    expect(suggestAgentName('Builder', 'beta', ['Builder'])).toBe('Builder (beta)')
    expect(suggestAgentName('Builder', 'beta', ['Builder', 'builder (BETA)'])).toBe('Builder (beta) 2')
    expect(suggestAgentName('X', 'x', ['X', 'XX'])).toBe('XX 2')
  })

  it("a prefix goes in front of a template's names; none leaves them", () => {
    expect(prefixedNames('AM', ['B1', 'R1'])).toEqual(['AMB1', 'AMR1'])
    expect(prefixedNames('  QA ', ['Builder'])).toEqual(['QA Builder'])
    expect(prefixedNames('', ['B1'])).toEqual(['B1'])
  })

  it('finds a name taken (case and spacing aside), not by the agent being renamed; lists duplicates by project', () => {
    const all = [{ project: 'hive', name: 'B1', id: 'a' }, { project: 'amber', name: 'b1 ', id: 'b' }, { project: 'hive', name: 'R1', id: 'c' }]
    expect(nameTaken(' B1', all)?.project).toBe('hive')
    expect(nameTaken('r1', all, { project: 'HIVE', id: 'c' })).toBeNull()
    expect(nameTaken('r1', all, { project: 'amber', id: 'c' })?.id).toBe('c')
    expect(duplicateAgentNames(all)).toEqual([{ name: 'B1', agents: [all[1], all[0]] }])
  })
})

describe('Hive keeps agent names unique across the workspace', () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const plain = join(wsPath, 'plain')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8'))
  const names = (p: string): string[] => cfgOf(p).agents.map((a: AgentDef) => a.name)
  const ids = (p: string): string[] => cfgOf(p).agents.map((a: AgentDef) => a.id)
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const add = (p: string, name?: string) => run(() => addAgent(p, { ...(name ? { name } : {}), location: 'project', provider: 'claude-code' }))
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

  beforeAll(async () => {
    for (const p of [alpha, beta]) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', p])
      writeFileSync(join(p, 'a.txt'), 'a')
      git(p, 'add', '.')
      git(p, 'commit', '-qm', 'a')
    }
    // A folder that isn't a git repository.
    mkdirSync(join(plain, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'a1', name: 'B1', provider: 'claude-code' }, { id: 'a2', name: 'R1', provider: 'claude-code' }] }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'b1', name: 'Old', provider: 'claude-code' }] }))
    writeFileSync(join(plain, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [] }))
    mkdirSync(join(wsPath, '.hive', 'templates'), { recursive: true })
    writeFileSync(join(wsPath, '.hive', 'templates', 'pair.json'), JSON.stringify({ version: 1, name: 'Pair', layout: 'auto', agents: [{ name: 'B1', provider: 'claude-code', worktree: false }, { name: 'R1', provider: 'claude-code', worktree: false }] }))
    writeFileSync(join(wsPath, '.hive', 'templates', 'trees.json'), JSON.stringify({ version: 1, name: 'Trees', layout: 'auto', agents: [{ name: 'T1', provider: 'claude-code', worktree: true }, { name: 'Folder', provider: 'claude-code', worktree: false }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    config.settings.providers['claude-code'].enabled = true
    providerService.info = ((id: string) => ({ provider: id, found: true })) as never
  })
  afterAll(async () => disposeWorkspaceService(w))
  beforeEach(() => {
    templates.testHooks.staged = undefined
  })

  it("refuses another project's agent's name, saying whose and suggesting one; numbers the default past every project's", async () => {
    await expect(add(beta, 'b1')).rejects.toThrow('There is already an agent called "B1" in alpha. Agent names are unique across the workspace: try "BB1".')
    expect(names(beta)).toEqual(['Old'])
    // alpha has two agents: beta's second would be "Agent 2", which is free; "Agent 3" taken in alpha moves it on.
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: [...c.agents, { id: 'a3', name: 'Agent 2', provider: 'claude-code' }] })))
    expect((await add(beta)).name).toBe('Agent 3')
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.filter((a) => a.id !== 'a3') })))
  })

  it('a rename to a name taken elsewhere is refused; its own name again is no change, even one it shares from before', async () => {
    const oldId = ids(beta)[0]
    await expect(run(() => updateAgent(beta, oldId, { name: 'r1' }))).rejects.toThrow(/already an agent called "R1" in alpha/)
    // A duplicate from before (written as an older Hive might have): it keeps working, and saves its other settings.
    await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.map((a) => (a.id === oldId ? { ...a, name: 'B1' } : a)) })))
    expect((await run(() => updateAgent(beta, oldId, { name: 'B1', role: 'builder' }))).role).toBe('builder')
    await run(() => updateAgent(beta, oldId, { name: 'Old' }))
  })

  it('adds and renames in two projects at once: only one gets the name', async () => {
    const both = await Promise.all([outcome(add(alpha, 'Same')), outcome(add(beta, 'Same'))])
    expect(both.filter((r) => r === 'ok')).toHaveLength(1)
    expect(both.find((r) => r !== 'ok')).toMatch(/already an agent called "Same" in (alpha|beta)/)
    expect([...names(alpha), ...names(beta)].filter((n) => n === 'Same')).toHaveLength(1)
    const races = await Promise.all([outcome(run(() => updateAgent(alpha, 'a2', { name: 'Racer' }))), outcome(add(beta, 'Racer'))])
    expect(races.filter((r) => r === 'ok')).toHaveLength(1)
    expect([...names(alpha), ...names(beta)].filter((n) => n === 'Racer')).toHaveLength(1)
    // Put back for the tests after.
    for (const p of [alpha, beta]) await run(() => w.mutateProjectConfig(p, (c) => ({ agents: c.agents.filter((a) => a.name !== 'Same' && (a.name !== 'Racer' || a.id === 'a2')).map((a) => (a.id === 'a2' ? { ...a, name: 'R1' } : a)) })))
    expect(names(alpha)).toEqual(['B1', 'R1'])
  })

  it("a template's load takes the names chosen for it, and is refused while one is another project's", async () => {
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect([plan.templateNames, plan.taken]).toEqual([['B1', 'R1'], [{ name: 'B1', project: 'alpha' }, { name: 'R1', project: 'alpha' }]])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta)))).rejects.toThrow(/B1, R1 are already agents in alpha/)
    // Names that can't be used: refused, saying why.
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X']))).rejects.toThrow(/no longer match the template/)
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X', ' x ']))).rejects.toThrow(/Two of its agents would be called "x"/)
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X', ' ']))).rejects.toThrow(/Enter a name for each of its agents/)
    // Renamed with a prefix: loaded so. This project's own names don't count (the load replaces its agents).
    const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta), undefined, undefined, prefixedNames('BE', ['B1', 'R1'])))
    expect(r.created).toEqual(['BEB1', 'BER1'])
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['BEB1', 'BER1']))).taken).toEqual([])
  })

  it('a name another project takes while the load stages refuses it, and nothing changes', async () => {
    const before = cfgOf(beta)
    templates.testHooks.staged = async (name) => {
      if (name === 'NB1') await add(alpha, 'NR1')
    }
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta), undefined, undefined, ['NB1', 'NR1']))).rejects.toThrow(/NR1 is already an agent in alpha.*Nothing was changed/)
    expect(cfgOf(beta)).toEqual(before)
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.filter((a) => a.name !== 'NR1') })))
  })

  it("one agent from a template: numbered when this project has its name, the project's prefix when another has", async () => {
    // beta has BEB1 and BER1; alpha has B1.
    expect((await run(() => templates.addAgentFromTemplate(beta, 'workspace', 'pair.json', 0))).name).toBe('BB1')
    expect((await run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 0))).name).toBe('B1 2')
  })

  it('says why a template with worktree agents can\'t be loaded into a project without git; one without them loads', async () => {
    const plan = await run(() => templates.templatePlan(plain, 'workspace', 'trees.json'))
    expect(plan.blocked).toEqual(["plain isn't a git repository, so its worktree agent (T1) can't have worktrees of their own. Make it a repository with a first commit, or edit the template to put them in the project folder."])
    expect((await run(() => templates.templatePlan(plain, 'workspace', 'pair.json', undefined, ['PB1', 'PR1']))).blocked).toEqual([])
    // A repository with no commit yet has no branch to start from.
    const fresh = join(wsPath, 'fresh')
    mkdirSync(join(fresh, '.hive'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', fresh])
    expect((await run(() => templates.templatePlan(fresh, 'workspace', 'trees.json'))).blocked).toEqual([expect.stringMatching(/^fresh isn't on a branch \(a detached HEAD, or no commit yet\)/)])
  })

  it('names two projects shared from before are flagged once, with a rename to make, while they last', async () => {
    const toasts: string[] = []
    const off = onHiveEvent((e: HiveEvent) => void (e.type === 'toast' && toasts.push(`${e.toast.title} | ${e.toast.message} | ${e.toast.actions?.[0]?.label}`)))
    try {
      await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'dup', name: 'R1', provider: 'claude-code' }] })))
      await run(() => w.refresh())
      await run(() => w.refresh())
      expect(toasts).toEqual(["Two agents are called R1 | Agent names are unique across the workspace now, so each agent can be told apart. R1 is in alpha and beta: they keep working, but rename one of each, e.g. beta's R1 to BR1. | Rename beta's R1…"])
      expect(JSON.parse(readFileSync(join(wsPath, '.hive', 'workspace.json'), 'utf8')).flaggedAgentNames).toEqual(['r1'])
      // Renamed: forgotten, so a new clash of that name is said again.
      await run(() => updateAgent(beta, 'dup', { name: 'BR1' }))
      await run(() => w.refresh())
      expect(JSON.parse(readFileSync(join(wsPath, '.hive', 'workspace.json'), 'utf8')).flaggedAgentNames).toBeUndefined()
      expect(toasts).toHaveLength(1)
    } finally {
      off()
    }
  })
})
