// The Load template dialog's detail (#268): same-name replacements marked, each new agent's settings in short (inherited
// ones as what they resolve to, marked "(default)"), each new worktree's branch and folder, and the setup command.
import { describe, expect, it } from 'vitest'
import { templateAgentSettings, templateLoadDetail } from '../src/shared/templateLoad'
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
    // Nothing removed: no Removed list and nothing about removed agents.
    const fresh = templateLoadDetail({ ...plan, remove: [] }, cfg, settings, () => info)
    expect(fresh.startsWith('Created:')).toBe(true)
    expect(fresh).not.toMatch(/replaced|\(new\)|conversations stay/)
  })
})
