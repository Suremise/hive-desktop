// A workspace's own settings through the catalog and the settings tools (#412): Settings → Workspace → Card loop rounds
// and wait, kept in its workspace.json, and Project Settings → Card loops overriding them (null inherits).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { settingDefault, settingEntry, settingPatch, settingValue } from '../src/shared/settingsCatalog'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

describe('Settings → Workspace → Card loops (#412)', async () => {
  const base = tempDir('hive-settings-ws-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const { applySetting, entryOf, settingDetail, settingRows } = await import('../src/main/settingsTools')

  it('the catalog: workspace values (10 and 6 by default) and project overrides that inherit', () => {
    const rounds = settingEntry('workspace.loopRounds')!
    const wait = settingEntry('workspace.loopWaitHours')!
    expect([rounds.scope, wait.scope]).toEqual(['workspace', 'workspace'])
    expect([settingDefault(rounds), settingDefault(wait)]).toEqual([10, 6])
    expect(settingValue(rounds, DEFAULT_SETTINGS, null, { loops: { rounds: 4 } })).toBe(4)
    expect(settingValue(wait, DEFAULT_SETTINGS, null, null)).toBe(6)
    expect(settingPatch(wait, 3)).toEqual({ workspace: { waitHours: 3 } })
    const own = settingEntry('project.loopRounds')!
    expect(own.inherits).toBe(true)
    expect(settingDefault(own)).toBeNull()
  })

  it('the settings tools read and change the open workspace’s, saved in its workspace.json', async () => {
    const path = join(base, 'ws')
    mkdirSync(join(path, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(path, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(path)
    await inWorkspace(w, async () => {
      expect(settingRows({ query: 'card loop' }).find((r) => r.id === 'workspace.loopRounds')).toMatchObject({ value: '10' })
      const changed = await applySetting(entryOf('workspace.loopRounds'), 7, null)
      expect([changed.old, changed.new]).toEqual([10, 7])
      await applySetting(entryOf('workspace.loopWaitHours'), '3', null)
      expect(settingDetail(entryOf('workspace.loopWaitHours'), null)).toMatchObject({ value: '3', default: '6' })
      expect(settingRows({ query: 'card loop' }).find((r) => r.id === 'workspace.loopRounds')).toMatchObject({ value: '7', default: '10' })
      await expect(applySetting(entryOf('workspace.loopRounds'), 99, null)).rejects.toThrow(/1 to 50/)
    })
    expect(JSON.parse(readFileSync(join(path, '.hive', 'workspace.json'), 'utf8')).loops).toEqual({ rounds: 7, waitHours: 3 })
    await disposeWorkspaceService(w)
  })
})
