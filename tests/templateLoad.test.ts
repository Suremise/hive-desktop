// The Load template dialog's detail (#268): same-name replacements marked, each new agent's settings in short (inherited
// ones as what they resolve to, marked "(default)"), each new worktree's branch and folder, and the setup command.
import { describe, expect, it } from 'vitest'
import { oldWorktreesNotice, templateAgentSettings, templateLoadDetail } from '../src/shared/templateLoad'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import type { ModelInfo } from '../src/shared/models'

const cfg = { providers: {}, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { enabled: true, defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default' } } } as unknown as AppSettings
const info: ModelInfo = { defaultModel: 'claude-opus-5-5', catalog: { source: 'cli', version: null, at: '', models: [{ value: 'opus', resolved: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } } as unknown as ModelInfo

describe('the Load template dialog (#268)', () => {
  it("shows a created agent's model, effort and mode; what it leaves to the defaults as what that is, marked", () => {
    const own = templateAgentSettings({ name: 'B', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', worktree: false }, cfg, settings, info)
    expect(own).toMatch(/^Opus 5\.5 · High · \S.*$/)
    expect(own).not.toMatch(/default/)
    const inherited = templateAgentSettings({ name: 'R', provider: 'claude-code', worktree: false }, cfg, settings, info)
    expect(inherited.split(' · ')).toHaveLength(3)
    expect(inherited.split(' · ').every((part) => part.endsWith('(default)'))).toBe(true)
    expect(inherited).toMatch(/^Opus 5\.5 \(default\) · Medium \(default\)/)
  })

  it("marks agents a new one of the same name replaces, gives each new worktree's branch and folder, and the setup command", () => {
    const plan = {
      remove: [
        { id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } },
        { id: 'b', name: 'Old', running: false, dirty: 0 }
      ],
      create: [
        { name: 'claude', role: 'builder', provider: 'claude-code' as const, worktree: true },
        { name: 'Reviewer', provider: 'claude-code' as const, worktree: false }
      ],
      worktrees: [{ branch: 'hive/claude-2', path: 'D:/x/site/claude-2', base: 'main' }, null],
      setup: 'npm install'
    }
    const text = templateLoadDetail(plan, cfg, settings, () => info)
    expect(text).toContain('• Claude (its worktree and branch hive/claude stay): replaced by a new agent with the same name')
    expect(text).toContain('• Old\n')
    expect(text).toMatch(/• claude — builder \(new\): Claude Code, Opus 5\.5 \(default\)/)
    expect(text).toContain('    own worktree on hive/claude-2 (from main) in D:/x/site/claude-2')
    expect(text).toMatch(/• Reviewer: Claude Code, [^\n]*\n\n/)
    expect(text).toContain("Each new worktree runs the project's setup command (npm install) before its agent first starts.")
    // No worktrees, or no setup command: no setup line.
    expect(templateLoadDetail({ ...plan, setup: null }, cfg, settings, () => info)).not.toContain('setup command')
    expect(templateLoadDetail({ ...plan, worktrees: [null, null] }, cfg, settings, () => info)).not.toContain('setup command')
    // #289: a worktree a created agent works in again goes on with it; a merged, clean one can be removed (the tick box);
    // one with unmerged work stays, saying why.
    const reuse = templateLoadDetail({ ...plan, worktrees: [{ branch: 'hive/claude', path: 'D:/x/site/claude', base: 'main', reuse: true }, null] }, cfg, settings, () => info)
    expect(reuse).toContain('• Claude (its worktree on hive/claude goes on with the new Claude): replaced by a new agent with the same name')
    expect(reuse).toContain('    reuses its worktree on hive/claude in D:/x/site/claude (clean; its branch is left as it is)')
    expect(reuse).not.toContain('setup command')
    const old = { ...plan, remove: [{ id: 'c', name: 'Codex', running: false, dirty: 0, worktree: { path: 'D:/x/site/codex', branch: 'hive/codex' } }, { id: 'd', name: 'Dev', running: false, dirty: 0, worktree: { path: 'D:/x/site/dev', branch: 'hive/dev' } }], mergedInto: 'main', oldWorktrees: [{ agent: 'Codex', path: 'D:/x/site/codex', branch: 'hive/codex', removable: true }, { agent: 'Dev', path: 'D:/x/site/dev', branch: 'hive/dev', removable: false, why: '2 commits not merged into main' }] }
    const both = templateLoadDetail(old, cfg, settings, () => info)
    expect(both).toContain('• Codex (its worktree and branch hive/codex, merged into main and clean, stay unless you tick below)')
    expect(both).toContain('• Dev (its worktree and branch hive/dev stay: 2 commits not merged into main)')
    expect(templateLoadDetail({ ...plan, worktrees: [{ branch: 'hive/claude-2', path: 'D:/x/site/claude-2', base: 'main', notReused: 'hive/claude has 1 uncommitted file' }, null] }, cfg, settings, () => info)).toContain('in D:/x/site/claude-2 (new: hive/claude has 1 uncommitted file)')
    // Nothing removed: no Removed list and nothing about removed agents.
    const fresh = templateLoadDetail({ ...plan, remove: [] }, cfg, settings, () => info)
    expect(fresh.startsWith('Created:')).toBe(true)
    expect(fresh).not.toMatch(/replaced|\(new\)|conversations stay/)
  })

  it("the notice after removing old worktrees says what went whole, whose branch stayed and why, and what was kept (#313)", () => {
    expect(oldWorktreesNotice([])).toBeNull()
    expect(oldWorktreesNotice([{ branch: 'hive/a', removed: true }, { branch: 'hive/b', removed: true }])).toEqual({ level: 'success', title: 'Removed 2 old worktrees', detail: 'hive/a, hive/b, with their branches: merged and clean.' })
    // The folder went, the branch stayed: not "with its branch".
    const partly = oldWorktreesNotice([{ branch: 'hive/a', removed: true }, { branch: 'hive/b', removed: true, branchKept: true, why: 'main changed since it was checked' }])
    expect(partly).toEqual({ level: 'warning', title: "An old worktree's branch was kept", detail: 'Removed with its branch: hive/a.\nhive/b: its folder was removed, but the branch was kept (main changed since it was checked).' })
    expect(partly!.detail).not.toMatch(/hive\/b, with/)
    const mixed = oldWorktreesNotice([{ branch: 'hive/b', removed: true, branchKept: true }, { branch: 'hive/c', removed: false, why: 'an agent works in it now' }])
    expect(mixed).toEqual({ level: 'warning', title: 'An old worktree was kept', detail: 'hive/b: its folder was removed, but the branch was kept.\nhive/c: kept (an agent works in it now).' })
  })
})
