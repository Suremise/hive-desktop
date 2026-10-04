// The Hive Assistant: its settings overlay, personas, and the files Hive ships for it.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_AGENT_ID, assistantPersona, assistantProjectConfig, newPersonaText, parsePersona, personaId } from '../src/shared/assistant'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS } from '../src/shared/defaults'
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

  it("picks the persona: the workspace's, else the default in Settings", () => {
    expect(assistantPersona({ persona: 'reviewer' }, settings())).toBe('reviewer')
    expect(assistantPersona({}, settings({ persona: 'planner' }))).toBe('planner')
    expect(assistantPersona(null, null)).toBe('overseer')
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

  it('ships four, each a character and a focus, with no procedure or permissions of its own', () => {
    const dir = join(__dirname, '..', 'resources', 'personas')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    expect(files).toEqual(['orchestrator.md', 'overseer.md', 'planner.md', 'reviewer.md'])
    for (const f of files) {
      const p = parsePersona(readFileSync(join(dir, f), 'utf8'))
      expect(p.name && p.description && p.icon, f).toBeTruthy()
      expect(p.body, f).toMatch(/## Your character[\s\S]+## Your focus/)
      // How to use Hive's tools and what the Assistant may do are Hive's (its rules and skills), not a persona's.
      expect(p.body, f).not.toMatch(/hive_\w+|as Hive allows|you may|you can (add|start|stop)/i)
    }
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
