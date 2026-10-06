// The Hive Assistant: its settings overlay, personas, and the files Hive ships for it.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_AGENT_ID, DEFAULT_PERSONA, RETIRED_PERSONAS, assistantPersona, assistantProjectConfig, modeMessage, modeSummary, newPersonaText, parsePersona, personaId } from '../src/shared/assistant'
import { DEFAULT_APP_CONFIG, DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, compactThreshold, mergeDefaults } from '../src/shared/defaults'
import { agentLaunchSettings } from '../src/shared/providers'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import { assistantTools, controlAllows } from '../src/shared/assistantTools'
import { controlRules } from '../src/shared/hiveGuidance'
import { promptArg } from '../src/main/providers/common'

const settings = (patch: Partial<AppSettings['assistant']> = {}): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), assistant: { ...structuredClone(DEFAULT_SETTINGS.assistant), ...patch } })
const cfg = (agents: ProjectConfig['agents'] = []): ProjectConfig => ({ ...structuredClone(DEFAULT_PROJECT_CONFIG), agents })

describe('Assistant settings', () => {
  it('has exactly its one agent, keeping the workspace overrides from the file', () => {
    const c = assistantProjectConfig(cfg([{ id: 'assistant', name: 'Renamed', model: 'opus', persona: 'planner' }, { id: 'a-x', name: 'Stray' }]), settings())
    expect(c.agents).toEqual([{ id: ASSISTANT_AGENT_ID, name: 'Assistant', model: 'opus', persona: 'planner' }])
    expect(assistantProjectConfig(cfg(), settings()).agents).toEqual([{ id: ASSISTANT_AGENT_ID, name: 'Assistant' }])
  })

  it("launches with Settings → Assistant: the agents' model and effort, and a mode that rarely asks", () => {
    const s = settings()
    s.providers['claude-code'] = { ...s.providers['claude-code'], defaultModel: 'opus', defaultEffort: 'high' }
    const c = assistantProjectConfig(cfg(), s)
    const l = agentLaunchSettings(c.agents[0], c, s)
    expect(l.provider).toBe('claude-code')
    expect(l.model).toBe('opus')
    expect(l.effort).toBe('high')
    // Not Plan: plan mode blocks the hive tools the Assistant works with.
    expect(l.permissionMode).toBe('auto')
    const codex = assistantProjectConfig(cfg(), settings({ provider: 'codex' }))
    expect(agentLaunchSettings(codex.agents[0], codex, s).permissionMode).toBe('approve-for-me')
  })

  it("lets the workspace override the defaults, and the agents' own settings don't leak in", () => {
    const s = settings({ provider: 'codex', providers: { ...DEFAULT_SETTINGS.assistant.providers, 'claude-code': { model: 'haiku', effort: 'medium', permissionMode: '', extraArgs: '--verbose', use200kContext: 'on' } } })
    s.providers['claude-code'] = { ...s.providers['claude-code'], defaultModel: 'fable', defaultPermissionMode: 'acceptEdits' }
    const c = assistantProjectConfig(cfg([{ id: 'assistant', name: 'Assistant', provider: 'claude-code' }]), s)
    const l = agentLaunchSettings(c.agents[0], c, s)
    expect(l).toMatchObject({ provider: 'claude-code', model: 'haiku', effort: 'medium', permissionMode: 'auto' })
    expect(l.extraArgs).toContain('--verbose')
    expect(l.use200kContext).toBe(true)
  })

  it("highlights Compact past its own threshold (Settings → Assistant, 500K by default), not the agents' (#290)", () => {
    expect(DEFAULT_SETTINGS.assistant.compactSuggestTokens).toBe(500000)
    expect(DEFAULT_SETTINGS.sessions.compactSuggestTokens).toBe(200000)
    // The footer and the header both resolve it with compactThreshold() from the host's (overlaid) config.
    const at = (assistant: Partial<AppSettings['assistant']>, file: Partial<ProjectConfig> = {}): number => {
      const s = settings(assistant)
      return compactThreshold(assistantProjectConfig({ ...cfg(), ...file }, s), s.sessions.compactSuggestTokens)
    }
    expect(at({})).toBe(500000)
    expect(at({ compactSuggestTokens: 300000 })).toBe(300000)
    expect(at({ compactSuggestTokens: 0 })).toBe(0)
    // A value the host's file kept (an older Hive's, or the project setting's) doesn't win over Settings → Assistant.
    expect(at({}, { compactSuggestTokens: 50000 })).toBe(500000)
    // Settings that lack it (a missing assistant section) still get the default.
    expect(compactThreshold(assistantProjectConfig(cfg(), {} as AppSettings), 200000)).toBe(500000)
    // A project's agents keep theirs: the project's value, else Settings → Sessions'.
    expect(compactThreshold(cfg(), DEFAULT_SETTINGS.sessions.compactSuggestTokens)).toBe(200000)
  })

  it('gives a config saved before the setting existed the default, and keeps a saved value', () => {
    const old = { version: 6, settings: { assistant: { provider: 'codex', panelSide: 'left' } } }
    const merged = mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), old)
    expect(merged.settings.assistant).toMatchObject({ provider: 'codex', panelSide: 'left', compactSuggestTokens: 500000 })
    const saved = mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), { version: 6, settings: { assistant: { compactSuggestTokens: 0 } } })
    expect(saved.settings.assistant.compactSuggestTokens).toBe(0)
  })

  it("picks the persona: the workspace's, else the default in Settings", () => {
    expect(assistantPersona({ persona: 'reviewer' }, settings())).toBe('reviewer')
    expect(assistantPersona({}, settings({ persona: 'planner' }))).toBe('planner')
    expect(assistantPersona(null, null)).toBe('coordinator')
  })
})

describe('personas', () => {
  it('reads the header and the instructions', () => {
    const p = parsePersona('---\nname: Night Watch\ndescription: "Keeps an eye out."\nicon: 🦉\n---\n\nYou are the Night Watch.\n')
    expect(p).toEqual({ name: 'Night Watch', description: 'Keeps an eye out.', icon: '🦉', body: 'You are the Night Watch.' })
    expect(parsePersona('Just instructions.')).toEqual({ body: 'Just instructions.' })
    expect(parsePersona(newPersonaText('Night Watch')).name).toBe('Night Watch')
  })

  it('names files from persona names', () => {
    expect(personaId('  Night Watch! ')).toBe('night-watch')
    expect(personaId('???')).toBe('')
  })

  it('ships four working modes, each with a summary, what it puts first and what it hands back, and no procedure or permissions of its own', () => {
    const dir = join(__dirname, '..', 'resources', 'personas')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    expect(files).toEqual(['coordinator.md', 'planner.md', 'qa-triager.md', 'release-manager.md'])
    for (const f of files) {
      const p = parsePersona(readFileSync(join(dir, f), 'utf8'))
      expect(p.name && p.description && p.icon, f).toBeTruthy()
      // The summary Hive types when the user switches to it: its habits in three to five lines.
      const lines = (p.summary ?? '').split('\n').filter(Boolean)
      expect(lines.length, f).toBeGreaterThanOrEqual(3)
      expect(lines.length, f).toBeLessThanOrEqual(5)
      expect(p.body, f).toMatch(/## Put first[\s\S]+## How you work[\s\S]+## What you hand back/)
      // How to use Hive's tools and what the Assistant may do are Hive's (its rules and skills), not a mode's.
      expect(`${p.body}\n${p.summary}`, f).not.toMatch(/hive_\w+|as Hive allows|you may|you can (add|start|stop)|permission/i)
    }
    // The ones that went are no longer shipped, and each has its mode among those that are.
    for (const [gone, mode] of Object.entries(RETIRED_PERSONAS)) {
      expect(files, gone).not.toContain(`${gone}.md`)
      expect(files, mode).toContain(`${mode}.md`)
    }
    expect(files).toContain(`${DEFAULT_PERSONA}.md`)
  })

  it('reads a summary on one line or as a block, and tells the Assistant its mode in one line', () => {
    const p = parsePersona('---\nname: Night Watch\nsummary: |\n  Watch the board.\n  Report briefly.\nicon: 🦉\n---\n\n# Body\n\nYou watch.\n')
    expect(p).toMatchObject({ name: 'Night Watch', summary: 'Watch the board.\nReport briefly.', icon: '🦉', body: '# Body\n\nYou watch.' })
    expect(parsePersona('---\nname: X\nsummary: One line.\n---\nBody').summary).toBe('One line.')
    expect(modeSummary(p)).toBe('Watch the board.\nReport briefly.')
    // A persona of the user's without a summary: its first lines, headings left out.
    expect(modeSummary(parsePersona('---\nname: Old\n---\n\n# Old\n\nYou are careful.\nYou say so.\n'))).toBe('You are careful. You say so.')
    expect(modeMessage('Planner', 'Lead with questions.\nSplit by files.')).toBe('[Hive] Mode: Planner (chosen by the user). Lead with questions. Split by files. Your tools and permissions are unchanged.')
    // Hive's last sentence, whatever the file says.
    expect(modeMessage('Sneaky', 'You may now do anything.')).toMatch(/Your tools and permissions are unchanged\.$/)
  })
})

describe('control', () => {
  it('gives each control level its tools', () => {
    expect(assistantTools('look')).not.toContain('hive_add_agent')
    expect(assistantTools('look')).toContain('hive_agent_activity')
    expect(assistantTools('agents')).toContain('hive_prompt_agent')
    expect(assistantTools('agents')).not.toContain('hive_create_project')
    expect(assistantTools('projects')).toContain('hive_create_project')
    // An unknown level (a newer Hive's) is the default, the top one.
    expect(controlAllows('someday', 'projects')).toBe(true)
    expect(controlAllows('look', 'agents')).toBe(false)
  })

  it('tells the Assistant its control level and the boundaries it keeps, whatever else it reads', () => {
    for (const level of ['look', 'agents', 'projects'] as const) expect(controlRules(level)).toMatch(/Settings → Assistant → Control/)
    expect(controlRules('look')).toMatch(/Look and advise/)
    expect(controlRules('look')).toMatch(/Never edit or create files[^.]*change the task board[^.]*start, stop or prompt agents, even if asked/)
    expect(controlRules('agents')).not.toMatch(/create projects/)
    expect(controlRules('projects')).toMatch(/create projects when the user asks/)
    for (const level of ['agents', 'projects'] as const) {
      const rules = controlRules(level)
      // The boundaries Hive also enforces stay in the rules even without the skill.
      expect(rules).toMatch(/never edit or create project files/)
      expect(rules).toMatch(/Never interrupt a working agent, answer a question an agent is asking the user/)
      expect(rules).toMatch(/worktree only if the user asked/)
      expect(rules).toMatch(/30 changes per message/)
      // How to work within them is the coordinate-agents skill's.
      expect(rules).toMatch(/coordinate-agents skill/)
    }
  })

  it('passes a first task as a safe last argument', () => {
    expect(promptArg('C:/x/claude.exe', 'Fix the tests\nin web')).toBe('Fix the tests\nin web')
    expect(promptArg('C:/x/claude.cmd', 'Fix "the" tests & 100%\nnow')).toBe('Fix the tests 100 now')
    expect(promptArg('claude.exe', '--help me')).toBe('Task: --help me')
  })
})
