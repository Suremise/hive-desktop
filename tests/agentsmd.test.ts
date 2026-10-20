// The repository's agent notes: AGENTS.md holds them for every agent, and CLAUDE.md only imports it, so Claude Code
// and Codex read the same rules. Codex reads at most project_doc_max_bytes (32 KiB by default) of the AGENTS.md files
// from the git root down to its folder, together, and silently drops the rest. It counts the file's raw bytes, with no
// newline normalisation (codex-rs/core/src/agents_md.rs, read_agents_md, in Codex 0.163.0), so a Windows checkout's
// CRLF counts two bytes a line: #1165 found the Git blob (LF) at 32,763 bytes and the working tree at 32,896, the last
// 128 bytes never read. The check measures the bytes on disk and the CRLF form, whichever is larger, and keeps 1 KiB
// spare so a rule added later isn't cut off unnoticed.
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const CODEX_BUDGET = 32 * 1024
const HEADROOM = 1024

/** What Codex counts of a file, as delivered to a Windows checkout: its bytes on disk, or with CRLF, if more. */
function deliveredBytes(raw: Buffer): number {
  const crlf = raw.toString('utf8').replace(/\r?\n/g, '\r\n')
  return Math.max(raw.length, Buffer.byteLength(crlf, 'utf8'))
}

describe("the repository's agent notes", () => {
  it('CLAUDE.md imports AGENTS.md and holds no rules of its own', () => {
    const lines = read('CLAUDE.md')
      .split(/\r?\n/)
      .filter((l) => l.trim())
    expect(lines).toEqual(['@AGENTS.md'])
  })

  it('AGENTS.md fits what Codex reads (32 KiB of raw bytes, CRLF included), with 1 KiB spare', () => {
    const raw = readFileSync(new URL('../AGENTS.md', import.meta.url))
    const bytes = deliveredBytes(raw)
    expect(bytes, `AGENTS.md is ${bytes} bytes as Codex reads it on Windows; keep it to ${CODEX_BUDGET - HEADROOM} at most (move reference material to docs/)`).toBeLessThanOrEqual(CODEX_BUDGET - HEADROOM)
  })

  it('counts CRLF as Codex does: an LF file that fits is over once each line ends in CRLF', () => {
    const lines = Array.from({ length: 300 }, () => 'x'.repeat(108)).join('\n') + '\n'
    const lf = Buffer.from(lines, 'utf8')
    expect(lf.length).toBe(32_700)
    expect(deliveredBytes(lf)).toBe(33_000)
    expect(deliveredBytes(Buffer.from(lines.replace(/\n/g, '\r\n'), 'utf8'))).toBe(33_000)
  })
})
