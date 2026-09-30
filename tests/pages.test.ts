// Agent pages: up to twelve agents, six to a page, each page with its own layout (automatic until chosen).
import { describe, expect, it } from 'vitest'
import { MAX_AGENTS, agentPageCount, layoutForAgents, migrateProjectConfig, pageAgents, pageLayout, pageOfAgent, withPageLayout } from '../src/shared/defaults'
import type { PageLayout } from '../src/shared/types'

const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, name: `Agent ${i + 1}` }))
const cfg = (n: number, layouts: PageLayout[] = []) => ({ agents: agents(n), layouts })

describe('agent pages', () => {
  it('holds twelve agents, six to a page', () => {
    expect(MAX_AGENTS).toBe(12)
    expect([0, 1, 6, 7, 12].map(agentPageCount)).toEqual([1, 1, 1, 2, 2])
    expect([0, 5, 6, 11].map(pageOfAgent)).toEqual([0, 0, 1, 1])
    expect(pageAgents(agents(8), 1).map((a) => a.id)).toEqual(['a7', 'a8'])
  })

  it('lays each page out to show its agents until a layout is chosen for it', () => {
    expect([1, 2, 3, 4, 5, 6].map(layoutForAgents)).toEqual(['single', 'columns2', 'columns3', 'grid', 'grid6', 'grid6'])
    // Seven agents: a full first page, and the seventh alone on page 2.
    expect(pageLayout(cfg(7), 0)).toBe('grid6')
    expect(pageLayout(cfg(7), 1)).toBe('single')
    expect(pageLayout(cfg(9), 1)).toBe('columns3')
    // "Fullscreen" on page 1, automatic on page 2.
    expect(pageLayout(cfg(9, ['single']), 0)).toBe('single')
    expect(pageLayout(cfg(9, ['single']), 1)).toBe('columns3')
  })

  it("keeps a page's chosen layout as agents are added, and choosing the one that fits makes it automatic again", () => {
    const chosen = withPageLayout(cfg(2), 0, 'single')
    expect(chosen).toEqual(['single'])
    expect(pageLayout(cfg(3, chosen), 0)).toBe('single')
    expect(withPageLayout(cfg(3, chosen), 0, 'columns3')).toEqual(['auto'])
    // Page 2's layout, with page 1 left automatic.
    expect(withPageLayout(cfg(8), 1, 'single')).toEqual(['auto', 'single'])
  })

  it('moves the single layout of earlier projects to page 1: automatic when it showed every agent', () => {
    expect(migrateProjectConfig({ version: 2, agents: agents(4), sessionLayout: 'grid' })).toMatchObject({ layouts: ['auto'] })
    expect(migrateProjectConfig({ version: 2, agents: agents(3), sessionLayout: 'single' })).toMatchObject({ layouts: ['single'] })
    expect(migrateProjectConfig({ version: 2, agents: agents(2) })).toMatchObject({ layouts: ['auto'] })
    expect('sessionLayout' in migrateProjectConfig({ version: 2, agents: [], sessionLayout: 'grid' })).toBe(false)
    // Already moved: left alone.
    expect(migrateProjectConfig({ version: 2, agents: agents(2), layouts: ['columns3'] })).toMatchObject({ layouts: ['columns3'] })
  })
})
