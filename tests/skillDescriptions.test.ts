import { join } from 'path'
import { readdirSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { parseSkillFrontmatter } from '../src/main/skills'
import { SHIPPED_SKILL_DESCRIPTIONS } from '../src/shared/skillDescriptions'

// The window shows a shipped skill's description translated while the workspace's copy has Hive's words (#1104): each
// message's English must be its SKILL.md's description, or the skill falls back to English without anyone noticing.
const SKILLS = join(__dirname, '..', 'resources', 'skills')
const shipped = Object.fromEntries(readdirSync(SKILLS).map((name) => [name, parseSkillFrontmatter(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')).description]))

describe('shipped skill descriptions', () => {
  it('has a message for each skill Hive ships, with its SKILL.md description as the English', () => {
    const messages = Object.fromEntries(Object.entries(SHIPPED_SKILL_DESCRIPTIONS).map(([name, m]) => [name, m.defaultMessage]))
    // On a failure: change the message in src/shared/skillDescriptions.ts to the description shown here.
    expect(messages).toEqual(shipped)
  })
})
