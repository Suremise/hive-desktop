// What sessions are told about Hive holds together: the always-present contract names skills that exist and reach
// that role, keeps the boundaries a session needs without its skills, and stays short; the bundled skills are valid
// (frontmatter, audience, links, the skills and hive tools they name, for their audience); the Hive development
// skills are the same for both providers.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { controlRules, hiveInstructions, withLatestHandover } from '../src/shared/hiveGuidance'
import { taskPrompt } from '../src/shared/tasks'
import { ASSISTANT_ONLY_TOOLS, assistantTools } from '../src/shared/assistantTools'
import { parseSkillFrontmatter, skillFor } from '../src/main/skills'
import type { SkillAudience, TaskCard } from '../src/shared/types'

const ROOT = join(__dirname, '..')
const SKILLS = join(ROOT, 'resources', 'skills')
const catalog = new Map<string, { audience: SkillAudience; description: string; text: string }>()
for (const name of readdirSync(SKILLS)) {
  const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
  const fm = parseSkillFrontmatter(text)
  catalog.set(name, { audience: fm.audience!, description: fm.description ?? '', text })
}
/** Every hive tool the MCP server defines. */
const TOOLS = [...readFileSync(join(ROOT, 'src', 'main', 'mcp', 'hive-mcp.ts'), 'utf8').matchAll(/name: '(hive_\w+)'/g)].map((m) => m[1])
const skillsNamed = (text: string): string[] => [...text.matchAll(/\b([a-z]+(?:-[a-z]+)+) skill/g)].map((m) => m[1])
const toolsNamed = (text: string): string[] => [...new Set([...text.matchAll(/\bhive_[a-z_]+/g)].map((m) => m[0]))]

describe('the session contract', () => {
  const agent = hiveInstructions('web')
  const assistant = hiveInstructions('', 'assistant')

  it('routes to skills that exist and reach that role', () => {
    /** The catalog's hyphenated names a text mentions (plain words like "handover" are too common to count). */
    const named = (text: string): string[] => [...catalog.keys()].filter((n) => n.includes('-') && new RegExp(`\\b${n}\\b`).test(text))
    expect(named(agent)).toEqual(expect.arrayContaining(['work-on-card', 'review-agent-work']))
    for (const n of named(agent)) expect(skillFor(catalog.get(n)!.audience, 'agent'), n).toBe(true)
    const forAssistant = [assistant, controlRules('agents'), controlRules('projects')].flatMap(named)
    expect(forAssistant).toEqual(expect.arrayContaining(['coordinate-agents', 'split-work', 'pick-up', 'workspace-note']))
    for (const n of forAssistant) expect(skillFor(catalog.get(n)!.audience, 'assistant'), n).toBe(true)
    // Unknown names written as "<name> skill" fail too.
    for (const n of [agent, assistant, controlRules('agents')].flatMap(skillsNamed)) expect(catalog.has(n), n).toBe(true)
  })

  it('keeps the board boundaries a session needs when its skills are missing', () => {
    expect(agent).toMatch(/or if it is missing/)
    expect(agent).toMatch(/Working on a card: move it to doing first \(also when it is back from review\), then to review with a comment saying what you did/)
    expect(agent).toMatch(/Reviewing a card is not working on it: it stays in review with its agent/)
    expect(agent).toMatch(/If it leaves review meanwhile, your review is over: leave the card where it is \(not back to review, not on to done\)/)
    expect(agent).toMatch(/move a card to done only when the user asks/)
    expect(agent).toMatch(/Add cards for follow-up work rather than doing it unasked/)
    expect(agent).toMatch(/use the hive tools for them, not the file system/)
  })

  it('names only hive tools that exist', () => {
    for (const text of [agent, assistant, controlRules('look'), controlRules('agents'), controlRules('projects')]) for (const t of toolsNamed(text)) expect(TOOLS, t).toContain(t)
  })

  it('stays short: the procedures are in the skills', () => {
    // Measured for #102 (2,007 characters before): a guard against procedure creeping back in, not a target.
    expect(withLatestHandover(agent, 'handovers/2026-10-03-web-auth-refactor.md').length).toBeLessThan(1400)
    expect(assistant.length).toBeLessThan(400)
    for (const level of ['look', 'agents', 'projects'] as const) expect(controlRules(level).length).toBeLessThan(1200)
    const card = { number: 7, title: 'T', description: 'D', blockedBy: [], comments: [] } as unknown as TaskCard
    expect(taskPrompt(card, true).length - taskPrompt(card, false).length).toBeLessThan(40)
  })
})

describe('the bundled skills', () => {
  it('each names itself after its folder, says who it is for, and has a description that says when to use it', () => {
    for (const [name, s] of catalog) {
      expect(parseSkillFrontmatter(s.text).name, name).toBe(name)
      expect(['agents', 'assistant', 'all'], name).toContain(s.audience)
      expect(s.description.length, name).toBeGreaterThan(80)
      expect(s.description.length, name).toBeLessThan(260)
      expect(s.description, name).toMatch(/\bUse (when|only when)\b/)
    }
    // Every session sees each name and description: together they stay small.
    expect([...catalog.values()].reduce((n, s) => n + s.description.length, 0)).toBeLessThan(2000)
  })

  it('name only skills that exist and reach the same audience', () => {
    for (const [name, s] of catalog) {
      for (const other of skillsNamed(s.text)) {
        expect(catalog.has(other), `${name} names ${other}`).toBe(true)
        const reaches = (['agent', 'assistant'] as const).filter((r) => skillFor(s.audience, r))
        // A skill pointing to another expects its reader to have it too (or at least one role that has both).
        expect(reaches.some((r) => skillFor(catalog.get(other)!.audience, r)), `${name} → ${other}`).toBe(true)
      }
    }
  })

  it("name only hive tools that exist, and that their audience has", () => {
    const anyAssistant = new Set(assistantTools('projects'))
    for (const [name, s] of catalog) {
      for (const t of toolsNamed(s.text)) {
        expect(TOOLS, `${name}: ${t}`).toContain(t)
        if (s.audience === 'agents') expect(ASSISTANT_ONLY_TOOLS, `${name} is for agents but names ${t}`).not.toContain(t)
        if (s.audience === 'assistant') expect(anyAssistant.has(t) || !ASSISTANT_ONLY_TOOLS.includes(t), `${name}: ${t}`).toBe(true)
      }
    }
  })

  it('link only to files inside their own folder', () => {
    for (const [name, s] of catalog) {
      for (const m of s.text.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
        const target = m[1]
        if (/^[a-z]+:/i.test(target)) continue
        expect(target, name).not.toMatch(/^\/|\.\./)
        expect(existsSync(join(SKILLS, name, target)), `${name}: ${target}`).toBe(true)
      }
    }
  })
})

describe("Hive's development skills", () => {
  const claude = join(ROOT, '.claude', 'skills')
  const agents = join(ROOT, '.agents', 'skills')
  const files = (dir: string, rel = ''): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort()

  it('are the same for Claude Code (.claude/skills) and Codex (.agents/skills)', () => {
    expect(files(claude)).toEqual(files(agents))
    for (const f of files(claude)) expect(readFileSync(join(agents, f), 'utf8').replace(/\r\n/g, '\n'), f).toBe(readFileSync(join(claude, f), 'utf8').replace(/\r\n/g, '\n'))
  })

  it("don't start with hive-, the prefix of Hive's git-excluded copies in .agents/skills", () => {
    for (const name of [...readdirSync(claude), ...readdirSync(agents)]) expect(name, name).not.toMatch(/^\.?hive-/)
  })

  it('are valid skills that link only inside the repository', () => {
    const names = readdirSync(claude)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const text = readFileSync(join(claude, name, 'SKILL.md'), 'utf8')
      const fm = parseSkillFrontmatter(text)
      expect(fm.name, name).toBe(name)
      expect(fm.description ?? '', name).toMatch(/\bUse when\b/)
      // They point at the repository's own docs (from the skill's folder), which must exist.
      for (const m of text.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) if (!/^[a-z]+:/i.test(m[1])) expect(existsSync(join(claude, name, m[1])), `${name}: ${m[1]}`).toBe(true)
    }
  })
})
