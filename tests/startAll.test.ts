// The session strip's batch actions and the Project menu (#216): Start New (All) and Archive and Start New (All) decide
// which agents and sessions from the agents as they are, flag busy ones as the quit dialog does, and go one agent at a
// time past failures; the title bar's Project menu lists every tab the strip has, in its order, from the same list.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PROJECT_MENU, PROJECT_TABS, tabCommand } from '../src/shared/projectTabs'
import { batchLine, busyNote, eachAgent, sessionsToArchive, type BatchAgent } from '../src/shared/startAll'

const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

describe('the Project menu is the tab strip', () => {
  it('lists all 13 tabs in the strip order, each with a command, from the list the strip uses', () => {
    const tabs = PROJECT_MENU.filter((x) => x.startsWith('project.tab.'))
    expect(tabs).toEqual(PROJECT_TABS.map((t) => tabCommand(t.id)))
    expect(tabs).toHaveLength(13)
    expect(tabs).toContain('project.tab.performance')
    const commands = src('src/renderer/src/commands.ts')
    for (const id of tabs) expect(commands, id).toContain(`id: '${id}'`)
    // The strip and the menu read the shared list (not copies of it).
    expect(src('src/renderer/src/views/ProjectView.tsx')).toMatch(/const TABS = PROJECT_TABS\b/)
    expect(src('src/renderer/src/components/TitleBar.tsx')).toMatch(/items: PROJECT_MENU\b/)
    // Explorer and Terminal stay in the menu.
    expect(PROJECT_MENU).toEqual(expect.arrayContaining(['project.openExplorer', 'project.openTerminal']))
  })
})

describe('Start New (All) and Archive and Start New (All)', () => {
  const agent = (id: string, over: Partial<BatchAgent> = {}): BatchAgent => ({ id, name: id.toUpperCase(), live: null, resume: null, ...over })

  it('archives a running agent its current session, a stopped one its last if not archived yet, and leaves out agents with none', () => {
    const agents = [
      agent('w', { live: { sessionId: 's1', status: 'working' } }),
      agent('i', { lastSessionId: 's2', resume: { id: 's2' } }),
      agent('a', { lastSessionId: 's3' }),
      agent('r', { resume: { id: 's4' } }),
      agent('n'),
      agent('g', { lastSessionId: 'gone' })
    ]
    const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3', archived: true }, { id: 's4' }]
    expect(sessionsToArchive(agents, sessions).map((x) => [x.agent.id, x.sessionId])).toEqual([
      ['w', 's1'],
      ['i', 's2'],
      ['r', 's4']
    ])
    expect(sessionsToArchive([agent('n')], sessions)).toEqual([])
  })

  it('flags what stopping a running agent costs, as the quit dialog does; idle and stopped ones get no flag', () => {
    const text = (l: NonNullable<BatchAgent['live']>) => l.status
    expect(batchLine(agent('w', { live: { sessionId: 's', status: 'working' } }), text)).toBe('• W — working (will be interrupted)')
    expect(batchLine(agent('b', { live: { sessionId: 's', status: 'background' } }), text)).toBe('• B — background (background tasks will stop)')
    expect(batchLine(agent('q', { live: { sessionId: 's', status: 'waiting' } }), text)).toBe('• Q — waiting (waiting for you)')
    expect(batchLine(agent('i', { live: { sessionId: 's', status: 'ready' } }), text)).toBe('• I — ready')
    expect(batchLine(agent('s'), text)).toBe('• S — not running')
    for (const s of ['ready', 'finished', 'starting', 'error'] as const) expect(busyNote(s)).toBeNull()
  })

  it('goes one agent at a time: a failure is reported with its reason and the rest still start', async () => {
    const order: string[] = []
    const r = await eachAgent([agent('a'), agent('b'), agent('c')], async (x) => {
      order.push(x.id)
      if (x.id === 'b') throw new Error('Claude Code is turned off')
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(r).toEqual({ done: ['A', 'C'], failed: [{ name: 'B', error: 'Claude Code is turned off' }] })
  })
})
