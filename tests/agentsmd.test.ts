// The repository's agent notes: AGENTS.md holds them for every agent, and CLAUDE.md only imports it, so Claude Code
// and Codex read the same rules. Codex reads at most 32 KiB of a project's AGENTS.md by default
// (project_doc_max_bytes) and silently drops the rest, so the file stays under that.
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

describe("the repository's agent notes", () => {
  it('CLAUDE.md imports AGENTS.md and holds no rules of its own', () => {
    const lines = read('CLAUDE.md')
      .split(/\r?\n/)
      .filter((l) => l.trim())
    expect(lines).toEqual(['@AGENTS.md'])
  })

  it('AGENTS.md stays within what Codex reads (32 KiB)', () => {
    const bytes = Buffer.byteLength(read('AGENTS.md').replace(/\r\n/g, '\n'), 'utf8')
    expect(bytes).toBeLessThan(32 * 1024)
  })
})
