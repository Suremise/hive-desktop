// Workspace MCP servers are available, projects turn them on (#713): a project's own choice wins, else a server on for
// all projects is on; adding one turns it on where the user chose (a project, all projects or none yet), only as the
// add dialog showed it; a name used before starts with no project's choice; a server copied from a project's own config
// is on there; and nothing that was on before the change (workspace.json's enabled list, project.json's disabled list)
// changes at upgrade. Each case has a workspace of its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { strToU8, zipSync } from 'fflate'
import { mcpOnInProject, serverOnIn } from '../src/shared/agentMcp'
import type { McpTurnOn } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-mcp-projects-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// Never the user's own CLI homes: the Codex and Copilot adapters read their config for a project's own servers.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')

describe('whether a server is on in a project', () => {
  it("follows the project's own choice, else the workspace's all projects", () => {
    expect(mcpOnInProject('godot', [], { disabled: [], enabled: [] })).toBe(false)
    expect(mcpOnInProject('godot', [], { disabled: [], enabled: ['godot'] })).toBe(true)
    expect(mcpOnInProject('godot', ['godot'], { disabled: [], enabled: [] })).toBe(true)
    expect(mcpOnInProject('godot', ['godot'], { disabled: ['godot'], enabled: [] })).toBe(false)
    // A project.json from before #713 has no enabled list: what the workspace has on stays on.
    expect(mcpOnInProject('godot', ['godot'], { disabled: [] })).toBe(true)
    expect(mcpOnInProject('godot', ['godot'], null)).toBe(true)
  })

  it("turns nothing on from a list Hive can't read", () => {
    expect(mcpOnInProject('godot', [], { enabled: 'godot' as never })).toBe(false)
    expect(mcpOnInProject('godot', ['godot'], { disabled: 'godot' as never })).toBe(true)
  })

  it('needs a definition that can be read', () => {
    expect(serverOnIn({ name: 'godot', def: null, globallyEnabled: true }, null)).toBe(false)
    expect(serverOnIn({ name: 'godot', def: { command: 'node' }, globallyEnabled: false }, { disabled: [], enabled: ['godot'] })).toBe(true)
  })
})

describe('MCP servers per project', () => {
  const trashDir = join(base, 'trash')
  const was = process.env.HIVE_TEST_TRASH_DIR
  const godot = { description: 'Godot', command: 'node', args: ['godot.js'] }
  // Each case's own workspace, as 0.7 left it: github on for all projects and turned off in apiary; notes deployed
  // and off. Nothing a case does reaches another.
  let wsPath: string
  let amber: string
  let apiary: string
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
  const mcpDir = (): string => join(wsPath, '.hive', 'mcp')

  /** Which projects have the server on, as a launch decides it. */
  const onIn = async (name: string): Promise<string[]> =>
    run(async () => {
      const m = (await mcp.listMcp()).find((x) => x.name === name)
      if (!m) return []
      const out: string[] = []
      for (const [label, p] of [['amberlight', amber], ['apiary', apiary]] as const) if (serverOnIn(m, (await w.projectConfig(p)).mcp)) out.push(label)
      return out
    })
  const listed = async (name: string) => (await run(() => mcp.listMcp())).find((m) => m.name === name)!

  /** A server's file to add, in a folder of its own. */
  const file = (name: string, data: unknown): string => {
    const dir = tempDir('hive-mcp-projects-file-')
    writeFileSync(join(dir, name), data instanceof Uint8Array ? data : JSON.stringify(data))
    return join(dir, name)
  }
  /** Adds a file as the add dialog does: previewed, then added with the copy it showed. */
  const add = async (path: string, name: string, turnOn: McpTurnOn, replace = false) => {
    const shown = await run(() => mcp.previewMcpFile(path))
    return run(() => mcp.addMcpFromFile(path, name, replace, turnOn, shown.hash))
  }
  const notesZip = (code: string): Uint8Array => zipSync({ 'notes2/hive-mcp.json': strToU8(JSON.stringify({ command: 'node', args: ['${HIVE_MCP_DIR}/notes2/server.js'] })), 'notes2/server.js': strToU8(code) })

  beforeAll(() => {
    process.env.HIVE_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    if (was === undefined) delete process.env.HIVE_TEST_TRASH_DIR
    else process.env.HIVE_TEST_TRASH_DIR = was
  })
  beforeEach(async () => {
    wsPath = tempDir('hive-mcp-projects-ws-')
    amber = join(wsPath, 'amberlight')
    apiary = join(wsPath, 'apiary')
    mkdirSync(mcpDir(), { recursive: true })
    for (const p of [amber, apiary]) mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(wsPath, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['github'] } }))
    writeFileSync(join(mcpDir(), 'github.json'), JSON.stringify({ command: 'npx', args: ['github-mcp'] }))
    writeFileSync(join(mcpDir(), 'notes.json'), JSON.stringify({ command: 'node', args: ['notes.js'] }))
    writeFileSync(join(amber, '.hive', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [] } }))
    writeFileSync(join(apiary, '.hive', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: ['github'] } }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterEach(async () => {
    await disposeWorkspaceService(w)
  })

  it('changes nothing at upgrade: what was on stays on, what was off stays off', async () => {
    expect(await onIn('github')).toEqual(['amberlight'])
    expect(await onIn('notes')).toEqual([])
  })

  it('turns a server on in one project only, and off there again', async () => {
    const notes = await listed('notes')
    await run(() => mcp.setMcpProject(apiary, 'notes', true, { def: notes.def, revision: notes.revision }))
    expect(await onIn('notes')).toEqual(['apiary'])
    await run(() => mcp.setMcpProject(apiary, 'notes', false))
    expect(await onIn('notes')).toEqual([])
    expect((await run(() => w.projectConfig(apiary))).mcp).toEqual({ disabled: ['github', 'notes'], enabled: [] })
  })

  it("keeps a project's own choice when all projects is turned on or off", async () => {
    await run(() => mcp.setMcpProject(amber, 'notes', true))
    await run(() => mcp.setMcpProject(apiary, 'notes', false))
    await run(() => mcp.setMcpGlobal('notes', true))
    expect(await onIn('notes')).toEqual(['amberlight'])
    await run(() => mcp.setMcpGlobal('notes', false))
    expect(await onIn('notes')).toEqual(['amberlight'])
  })

  it("refuses to turn on a server that has changed since it was shown, or that isn't there", async () => {
    const shown = await listed('github')
    writeFileSync(join(mcpDir(), 'github.json'), JSON.stringify({ command: 'npx', args: ['other-mcp'] }))
    await expect(run(() => mcp.setMcpProject(apiary, 'github', true, { def: shown.def, revision: shown.revision }))).rejects.toThrow('has changed since')
    await expect(run(() => mcp.setMcpProject(apiary, 'missing', true))).rejects.toThrow('no MCP server named missing')
    expect(await onIn('github')).toEqual(['amberlight'])
  })

  it('adds a server on where the user chose: one project, all projects or none yet', async () => {
    await add(file('godot.json', godot), 'godot', { project: amber })
    expect(await onIn('godot')).toEqual(['amberlight'])
    await add(file('godot-all.json', godot), 'godot-all', 'all')
    expect(await onIn('godot-all')).toEqual(['amberlight', 'apiary'])
    await run(() => mcp.addMcpFromFile(file('godot-none.json', godot), 'godot-none'))
    expect(await onIn('godot-none')).toEqual([])
  })

  it('refuses to add a file changed after it was shown, writing and turning on nothing', async () => {
    const json = file('godot.json', godot)
    const shown = await run(() => mcp.previewMcpFile(json))
    writeFileSync(json, JSON.stringify({ ...godot, args: ['changed-after-preview.js'] }))
    await expect(run(() => mcp.addMcpFromFile(json, 'godot', false, { project: amber }, shown.hash))).rejects.toThrow('has changed since it was shown')
    // A zip whose code changed, its definition the same, is refused too.
    const zip = file('notes2.zip', notesZip('// v1'))
    const zipShown = await run(() => mcp.previewMcpFile(zip))
    writeFileSync(zip, notesZip('// v2'))
    await expect(run(() => mcp.addMcpFromFile(zip, 'notes2', false, 'all', zipShown.hash))).rejects.toThrow('has changed since it was shown')
    // Turning one on anywhere needs the copy that was shown.
    await expect(run(() => mcp.addMcpFromFile(json, 'godot', false, 'all'))).rejects.toThrow('has changed since it was shown')
    expect(['godot.json', 'notes2.json', 'notes2'].filter((f) => existsSync(join(mcpDir(), f)))).toEqual([])
    expect([await onIn('godot'), await onIn('notes2')]).toEqual([[], []])
    expect((await run(() => w.projectConfig(amber))).mcp.enabled).toEqual([])
  })

  it("starts a server added under a name used before with no project's choice", async () => {
    await add(file('godot.json', godot), 'godot', { project: amber })
    await run(() => mcp.setMcpProject(apiary, 'godot', false))
    // Replaced: the new definition is on only where this add says, whatever the projects chose for the old one.
    await add(file('godot.json', { ...godot, args: ['godot2.js'] }), 'godot', 'all', true)
    expect(await onIn('godot')).toEqual(['amberlight', 'apiary'])
    // Deleted: every project forgets it, so one added by hand under the name later is on nowhere.
    await run(() => mcp.setMcpGlobal('godot', false))
    await run(() => mcp.setMcpProject(amber, 'godot', true))
    await run(() => mcp.setMcpProject(apiary, 'godot', false))
    await run(() => mcp.deleteMcp('godot'))
    for (const p of [amber, apiary]) {
      const own = JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8')).mcp
      expect([...own.enabled, ...own.disabled]).not.toContain('godot')
    }
    writeFileSync(join(mcpDir(), 'godot.json'), JSON.stringify(godot))
    expect(await onIn('godot')).toEqual([])
  })

  it('creates a new server from the template off everywhere', async () => {
    await run(() => mcp.setMcpProject(amber, 'fresh', false))
    await run(() => mcp.createMcp('fresh'))
    expect(await onIn('fresh')).toEqual([])
    expect((await run(() => w.projectConfig(amber))).mcp.disabled).not.toContain('fresh')
  })

  it("copies a server from a project's own config on in that project when it is what was shown", async () => {
    const sandbox = { command: 'node', args: ['sandbox.js'] }
    const docs = { command: 'node', args: ['docs.js'] }
    writeFileSync(join(apiary, '.mcp.json'), JSON.stringify({ mcpServers: { sandbox, docs } }))
    const offered = await run(() => mcp.projectMcpServers(apiary))
    expect(offered.map((s) => [s.name, s.runs])).toEqual([
      ['docs', ['Runs: node docs.js']],
      ['sandbox', ['Runs: node sandbox.js']]
    ])
    // docs changed after it was shown: copied, but off.
    const r = await run(() => mcp.importFromProject(apiary, ['sandbox', 'docs'], { sandbox, docs: { command: 'node', args: ['old.js'] } }))
    expect(r).toEqual({ copied: ['sandbox', 'docs'], on: ['sandbox'] })
    expect(await onIn('sandbox')).toEqual(['apiary'])
    expect(await onIn('docs')).toEqual([])
    expect(await run(() => mcp.projectMcpServers(apiary))).toEqual([])
  })
})
