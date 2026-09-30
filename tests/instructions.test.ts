import { describe, expect, it } from 'vitest'
import { instructionFiles, instructionsShared, shareInstructions } from '../src/shared/instructions'
import { providerDescriptor } from '../src/shared/providers'

const both = [providerDescriptor('claude-code'), providerDescriptor('codex')]
const files = (claude: string | null, agents: string | null) => instructionFiles(both, (f) => (f === 'CLAUDE.md' ? claude : agents))

describe('shared instructions', () => {
  it('knows when CLAUDE.md imports AGENTS.md', () => {
    expect(instructionsShared(files('# P\n', '# A\n'))).toBe(false)
    expect(instructionsShared(files('@AGENTS.md\n\nClaude only.\n', '# A\n'))).toBe(true)
    expect(instructionsShared(files(null, '# A\n'))).toBe(false)
  })
  it('moves CLAUDE.md into a new AGENTS.md', () => {
    const w = shareInstructions(files('# P\n\nUse tabs.\n', null), null, 'p')
    expect(w['AGENTS.md']).toBe('# P\n\nUse tabs.\n')
    expect(w['CLAUDE.md']).toBe('@AGENTS.md\n')
  })
  it('keeps both files when AGENTS.md exists', () => {
    const w = shareInstructions(files('Claude only.\n', '# A\n'), '# A\n', 'p')
    expect(w['AGENTS.md']).toBeUndefined()
    expect(w['CLAUDE.md']).toBe('@AGENTS.md\n\nClaude only.\n')
  })
  it('creates what is missing, and does nothing twice', () => {
    const w = shareInstructions(files(null, null), null, 'demo')
    expect(w['AGENTS.md']).toContain('# demo')
    expect(w['CLAUDE.md']).toBe('@AGENTS.md\n')
    expect(shareInstructions(files('@AGENTS.md\n', '# A\n'), '# A\n', 'p')).toEqual({})
  })
})
