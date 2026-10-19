// config.json kept small (#1111): written compact, its .bak once a run, and the board's folds and the model catalogs
// (UI state and caches) in ui-state.json beside it, written only when they change; an older config.json's move out.
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, parseUiState, splitUiState } from '../src/main/config'
import { writeKeptJson } from '../src/main/fsutil'
import { DEFAULT_APP_CONFIG } from '../src/shared/defaults'
import type { AppConfig } from '../src/shared/types'
import { tempDir } from './tempDir'

afterEach(() => vi.restoreAllMocks())

const FOLD = { 'c:\\ws': { collapsed: ['done'], folded: [12] } } as unknown as NonNullable<AppConfig['ui']['boardFold']>
const CATALOGS = { 'claude-code': { version: '2.1.300', models: [] } } as unknown as NonNullable<AppConfig['modelCatalogs']>

describe('kept files written compact, their .bak once a run (#1111)', () => {
  it('writes compact JSON, and the .bak only at the first save of the run when asked', async () => {
    const f = join(tempDir('kept-compact-'), 'config.json')
    await writeKeptJson(f, { a: 1 }, { compact: true, bakOncePerRun: true })
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n')
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('{"a":1}\n')
    await writeKeptJson(f, { a: 2 }, { compact: true, bakOncePerRun: true })
    expect(readFileSync(f, 'utf8')).toBe('{"a":2}\n')
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('{"a":1}\n')
    // Other kept files are unchanged: indented, a .bak every save.
    const g = join(tempDir('kept-plain-'), 'project.json')
    await writeKeptJson(g, { b: 1 })
    await writeKeptJson(g, { b: 2 })
    expect(readFileSync(`${g}.bak`, 'utf8')).toBe('{\n  "b": 2\n}\n')
  })
})

describe('UI state beside config.json (#1111)', () => {
  it('splits the folds and catalogs out of what config.json keeps, without changing the config', () => {
    const c = { ...structuredClone(DEFAULT_APP_CONFIG), modelCatalogs: CATALOGS }
    c.ui.boardFold = FOLD
    const { saved, state } = splitUiState(c)
    expect(saved.modelCatalogs).toBeUndefined()
    expect(saved.ui.boardFold).toBeUndefined()
    expect(saved.ui.sidebarWidth).toBe(c.ui.sidebarWidth)
    expect(state).toEqual({ boardFold: FOLD, modelCatalogs: CATALOGS })
    expect(c.ui.boardFold).toBe(FOLD)
    expect(c.modelCatalogs).toBe(CATALOGS)
    expect(splitUiState(structuredClone(DEFAULT_APP_CONFIG)).state).toEqual({})
  })

  it('reads ui-state.json, taking a missing, damaged or odd one as none', () => {
    expect(parseUiState(JSON.stringify({ boardFold: FOLD, modelCatalogs: CATALOGS }))).toEqual({ boardFold: FOLD, modelCatalogs: CATALOGS })
    expect(parseUiState(null)).toEqual({})
    expect(parseUiState('{"boardFold": [')).toEqual({})
    expect(parseUiState('[1]')).toEqual({})
    expect(parseUiState(JSON.stringify({ boardFold: [1], modelCatalogs: 'x' }))).toEqual({})
  })

  it("moves an older config.json's folds and catalogs out at its first save, keeps them across a restart, and writes ui-state.json only when they change", async () => {
    const dir = tempDir('config-state-')
    vi.spyOn(app, 'getPath').mockReturnValue(dir)
    const older = { ...structuredClone(DEFAULT_APP_CONFIG), modelCatalogs: CATALOGS }
    older.ui.boardFold = FOLD
    writeFileSync(join(dir, 'config.json'), JSON.stringify(older, null, 2))
    config.load()
    expect(config.get().ui.boardFold).toEqual(FOLD)
    await config.flush()
    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(saved.ui.boardFold).toBeUndefined()
    expect(saved.modelCatalogs).toBeUndefined()
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('\n  ')
    expect(JSON.parse(readFileSync(join(dir, 'ui-state.json'), 'utf8'))).toEqual({ boardFold: FOLD, modelCatalogs: CATALOGS })
    // A settings save that leaves them alone doesn't write ui-state.json again.
    const before = statSync(join(dir, 'ui-state.json')).mtimeMs
    writeFileSync(join(dir, 'ui-state.json'), readFileSync(join(dir, 'ui-state.json'), 'utf8'))
    const marked = statSync(join(dir, 'ui-state.json')).mtimeMs
    config.update((c) => void (c.ui.sidebarWidth = 333))
    await config.flush()
    expect(statSync(join(dir, 'ui-state.json')).mtimeMs).toBe(marked)
    expect(marked).toBeGreaterThanOrEqual(before)
    // A fold changes: written.
    config.update((c) => void (c.ui.boardFold = {}))
    await config.flush()
    expect(JSON.parse(readFileSync(join(dir, 'ui-state.json'), 'utf8'))).toEqual({ boardFold: {}, modelCatalogs: CATALOGS })
    // Read back at the next start.
    config.load()
    expect(config.get().ui.sidebarWidth).toBe(333)
    expect(config.get().modelCatalogs).toEqual(CATALOGS)
    expect(existsSync(join(dir, 'config.json.bak'))).toBe(true)
  })
})
