// Moving a project's agents: where a move, a drop or a page drop puts an agent, and the saved order in project.json
// (under its lock, keeping each agent's settings and anything changed meanwhile).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { dropIndex, moveAgentTo, pageEndIndex } from '../src/shared/defaults'

const base = mkdtempSync(join(tmpdir(), 'hive-order-'))
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const ids = (list: { id: string }[]): string => list.map((a) => a.id).join('')
const abc = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))

describe('agent order', () => {
  it('moves an agent to its new position, others shifting along', () => {
    expect(ids(moveAgentTo(abc, 'a', 2))).toBe('bcade')
    expect(ids(moveAgentTo(abc, 'e', 0))).toBe('eabcd')
    expect(ids(moveAgentTo(abc, 'c', 99))).toBe('abdec')
    expect(ids(moveAgentTo(abc, 'c', -3))).toBe('cabde')
    expect(ids(moveAgentTo(abc, 'nope', 1))).toBe('abcde')
  })

  it('puts a dropped agent before the one it was dropped on, or at the end', () => {
    const order = abc.map((a) => a.id)
    expect(ids(moveAgentTo(abc, 'a', dropIndex(order, 'a', 'd')))).toBe('bcade')
    expect(ids(moveAgentTo(abc, 'e', dropIndex(order, 'e', 'b')))).toBe('aebcd')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', null)))).toBe('acdeb')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', 'b')))).toBe('abcde')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', 'c')))).toBe('abcde')
  })

  it("drops on a page button at that page's last place", () => {
    const eight = 'abcdefgh'.split('').map((id) => ({ id }))
    // To page 2 from page 1: the end of the list (page 2 has room).
    expect(ids(moveAgentTo(eight, 'a', pageEndIndex(8, 1, 6)))).toBe('bcdefgha')
    // To a full page 1 from page 2: its last place; the agent there moves on to page 2.
    expect(ids(moveAgentTo(eight, 'h', pageEndIndex(8, 0, 6)))).toBe('abcdehfg')
    expect(pageEndIndex(3, 0, 6)).toBe(2)
  })
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { moveAgent } = await import('../src/main/projectAgents')

describe('saving the order', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const file = join(alpha, '.hive', 'project.json')
  beforeAll(async () => {
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    const agents = [
      { id: 'a1', name: 'Agent 1', model: 'opus' },
      { id: 'a2', name: 'Agent 2' },
      { id: 'a3', name: 'Agent 3', worktree: { path: join(base, 'wt'), branch: 'hive/three', base: 'main' } }
    ]
    writeFileSync(file, JSON.stringify({ version: 2, agents, worktreeSetup: 'npm ci' }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const saved = () => JSON.parse(readFileSync(file, 'utf8'))

  it('saves the new order in project.json, keeping each agent and the other settings', async () => {
    expect(await inWorkspace(w, () => moveAgent(alpha, 'a3', 0))).toEqual(['a3', 'a1', 'a2'])
    const cfg = saved()
    expect(cfg.agents.map((a: { id: string }) => a.id)).toEqual(['a3', 'a1', 'a2'])
    expect(cfg.agents[0].worktree.branch).toBe('hive/three')
    expect(cfg.agents[1]).toMatchObject({ name: 'Agent 1', model: 'opus' })
    expect(cfg.worktreeSetup).toBe('npm ci')
  })

  it('moves and changes at the same time both land', async () => {
    await Promise.all([inWorkspace(w, () => moveAgent(alpha, 'a2', 0)), w.updateAgent(alpha, 'a1', { model: 'sonnet' })])
    const cfg = saved()
    expect(cfg.agents.map((a: { id: string }) => a.id)).toEqual(['a2', 'a3', 'a1'])
    expect(cfg.agents[2].model).toBe('sonnet')
  })

  it("refuses an agent that isn't there", async () => {
    await expect(inWorkspace(w, () => moveAgent(alpha, 'gone', 0))).rejects.toThrow(/no longer exists/)
  })
})
